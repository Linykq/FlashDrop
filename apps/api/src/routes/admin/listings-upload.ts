import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyMultipartBaseOptions } from '@fastify/multipart';
import {
  type ImageKey,
  LISTING_IMAGE_TYPES,
  LISTING_UPLOAD_LIMITS,
  ListingHints,
} from '@flashdrop/contracts';
import { ValidationError, type ValidationIssue } from '@flashdrop/domain';
import { prepareListingImage } from '@flashdrop/llm';
import type { FastifyRequest } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';

/*
 * The listing upload (design §10, §11): multipart with 1-4 photos in `images` and optional `hints`.
 *
 * - Each photo's type comes from its magic bytes (`file-type`), never from the declared content type or
 *   the file name: JPEG, PNG and WebP only.
 * - Limits are explicit: the plugin derives its per-file default from Fastify's 64 KB body limit but does
 *   not enforce that limit across a multipart request, so every count and size is capped here.
 * - Each photo is re-encoded (packages/llm: auto-orient, 1568 px, JPEG q85, no EXIF or GPS) and stored as
 *   `<UPLOAD_DIR>/<sha256>.jpg`, written to a temporary name and renamed, so the worker and
 *   `GET /uploads/:key` never see half a file. Identical photos share a file.
 */

const MAX_HINTS_BYTES = LISTING_UPLOAD_LIMITS.maxHintsLength * 4;

export const LISTING_MULTIPART_OPTIONS: FastifyMultipartBaseOptions = {
  limits: {
    fileSize: LISTING_UPLOAD_LIMITS.maxImageBytes,
    files: LISTING_UPLOAD_LIMITS.maxImages,
    fields: 1,
    // UTF-8 needs up to 4 bytes per character; the character limit itself is checked by ListingHints.
    fieldSize: MAX_HINTS_BYTES,
    fieldNameSize: 32,
    parts: LISTING_UPLOAD_LIMITS.maxImages + 1,
    headerPairs: 50,
  },
};

const MEGABYTES = LISTING_UPLOAD_LIMITS.maxImageBytes / (1024 * 1024);

export interface ListingUpload {
  /** In upload order, without repeats. */
  readonly imageKeys: ImageKey[];
  readonly hints: string | null;
}

function invalid(path: string, message: string, cause?: unknown): ValidationError {
  return new ValidationError([{ path, message }], { cause });
}

async function store(uploadDir: string, key: ImageKey, bytes: Buffer): Promise<void> {
  const temporary = join(uploadDir, `.${key}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes);
  try {
    // Atomic on one filesystem; replacing an existing copy is harmless, the content is the same.
    await rename(temporary, join(uploadDir, key));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function photo(bytes: Buffer, index: number): Promise<{ key: ImageKey; bytes: Buffer }> {
  const path = `images.${index}`;
  const type = await fileTypeFromBuffer(bytes);
  if (type === undefined || !(LISTING_IMAGE_TYPES as readonly string[]).includes(type.mime)) {
    throw invalid(path, 'must be a JPEG, PNG or WebP image');
  }
  try {
    const prepared = await prepareListingImage(bytes);
    return { key: prepared.key, bytes: prepared.bytes };
  } catch (error) {
    // sharp refuses truncated or corrupt data and images above the pixel limit.
    throw invalid(path, 'could not be read as an image (corrupt, or larger than 50 megapixels)', error);
  }
}

/**
 * Reads and stores the upload. Every problem is a 400 `VALIDATION_FAILED` with the part it concerns
 * (`images.2`, `hints`); nothing is recorded for a request that fails, though photos stored before the
 * failure stay (content-addressed, so a retry reuses them).
 */
export async function readListingUpload(request: FastifyRequest, uploadDir: string): Promise<ListingUpload> {
  if (!request.isMultipart()) {
    throw invalid('', 'must be multipart/form-data with 1 to 4 images and optional hints');
  }
  const errors = request.server.multipartErrors;
  const keys = new Set<ImageKey>();
  let hints: string | null = null;
  let files = 0;
  await mkdir(uploadDir, { recursive: true });

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'images') throw invalid(part.fieldname, 'is not an upload field');
        const index = files++;
        const buffer = await part.toBuffer();
        // `toBuffer` throws only when the limit was hit before its last chunk; busboy can flag it after,
        // and the 8 MB prefix of a bigger file must never be decoded or stored.
        if (part.file.truncated) throw invalid(`images.${index}`, `must be at most ${MEGABYTES} MB`);
        const { key, bytes } = await photo(buffer, index);
        if (!keys.has(key)) await store(uploadDir, key, bytes);
        keys.add(key);
      } else {
        if (part.fieldname !== 'hints') throw invalid(part.fieldname, 'is not an upload field');
        const parsed = ListingHints.safeParse(part.value);
        if (part.valueTruncated || !parsed.success) {
          throw invalid('hints', `must be at most ${LISTING_UPLOAD_LIMITS.maxHintsLength} characters`);
        }
        hints = parsed.data;
      }
    }
  } catch (error) {
    const issue = limitIssue(error, errors, files);
    if (issue !== undefined) throw new ValidationError([issue], { cause: error });
    throw error;
  }

  if (keys.size === 0) throw invalid('images', 'must contain at least one photo');
  return { imageKeys: [...keys], hints };
}

/** The plugin's limit errors (413 by default) as field-level issues. */
function limitIssue(
  error: unknown,
  errors: FastifyRequest['server']['multipartErrors'],
  files: number,
): ValidationIssue | undefined {
  if (error instanceof errors.RequestFileTooLargeError) {
    return { path: `images.${files - 1}`, message: `must be at most ${MEGABYTES} MB` };
  }
  if (error instanceof errors.FilesLimitError) {
    return { path: 'images', message: `must contain at most ${LISTING_UPLOAD_LIMITS.maxImages} photos` };
  }
  if (error instanceof errors.FieldsLimitError || error instanceof errors.PartsLimitError) {
    return { path: '', message: 'has more parts than images and hints' };
  }
  return undefined;
}
