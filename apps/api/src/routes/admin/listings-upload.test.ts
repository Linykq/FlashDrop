import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '@flashdrop/domain';
import type { FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readListingUpload } from './listings-upload';

/*
 * The upload reader's own guard on truncated parts. @fastify/multipart's `toBuffer()` throws only when the
 * size limit was flagged before its last chunk; when busboy flags it after, `toBuffer()` hands back the first
 * 8 MB, and that depends on chunk timing over a real socket. So the part is faked here, deterministically.
 */

let uploadDir: string;
beforeEach(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), 'fd-upload-'));
});
afterEach(async () => {
  await rm(uploadDir, { recursive: true, force: true });
});

/** A request whose only part is a file `toBuffer()` returns whole, flagged `truncated` as given. */
function requestWith(bytes: Buffer, truncated: boolean): FastifyRequest {
  class Never extends Error {}
  const part = {
    type: 'file' as const,
    fieldname: 'images',
    file: { truncated },
    toBuffer: async () => bytes,
  };
  const request = {
    isMultipart: () => true,
    server: {
      multipartErrors: {
        RequestFileTooLargeError: Never,
        FilesLimitError: Never,
        FieldsLimitError: Never,
        PartsLimitError: Never,
      },
    },
    async *parts() {
      yield part;
    },
  };
  // A structural fake of the three members the reader uses.
  return request as unknown as FastifyRequest;
}

describe('readListingUpload', () => {
  it('refuses a part flagged truncated after its last chunk, before decoding or storing anything', async () => {
    const prefix = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#5a7d6c' } })
      .jpeg()
      .toBuffer();
    const error = await readListingUpload(requestWith(prefix, true), uploadDir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toEqual([
      { path: 'images.0', message: 'must be at most 8 MB' },
    ]);
    expect(await readdir(uploadDir)).toEqual([]);

    await expect(readListingUpload(requestWith(prefix, false), uploadDir)).resolves.toMatchObject({
      hints: null,
    });
    expect(await readdir(uploadDir)).toHaveLength(1);
  });
});
