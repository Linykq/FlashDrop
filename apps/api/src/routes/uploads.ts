import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageKey } from '@flashdrop/contracts';
import { NotFoundError } from '@flashdrop/domain';
import { z } from 'zod';
import type { Api } from '../http/api';

const UploadParams = z.object({ key: ImageKey });

// Keys are content addresses (<sha256>.jpg): the bytes behind a URL never change.
const IMMUTABLE = 'public, max-age=31536000, immutable';

const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && MISSING_FILE_CODES.has(String(error.code));
}

/** True when an `If-None-Match` list names `etag` (weak or strong, RFC 9110 §13.1.2) or is `*`. */
export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch.split(',').some((tag) => {
    const value = tag.trim();
    return value === '*' || value === etag || value === `W/${etag}`;
  });
}

/**
 * `GET /uploads/:key`: product photos from `UPLOAD_DIR` (design §10, §2: Caddy routes `/uploads/*` here).
 * The key pattern admits only `<64 hex>.jpg`, so a request can never name a path outside the directory.
 */
export function uploadRoutes(app: Api, uploadDir: string): void {
  app.get('/uploads/:key', { schema: { params: UploadParams } }, async (request, reply) => {
    const { key } = request.params;
    const etag = `"${key.slice(0, key.indexOf('.'))}"`;
    const cacheHeaders = { 'cache-control': IMMUTABLE, etag };
    if (matchesEtag(request.headers['if-none-match'], etag)) {
      return reply.code(304).headers(cacheHeaders).send();
    }

    let file: FileHandle;
    try {
      file = await open(join(uploadDir, key), 'r');
    } catch (error) {
      if (isMissingFile(error)) throw new NotFoundError('Image');
      throw error;
    }
    try {
      // Stat the open handle, not the path: the size sent is the size of the file being streamed.
      const stats = await file.stat();
      if (!stats.isFile()) throw new NotFoundError('Image');
      return reply
        .headers({ ...cacheHeaders, 'content-length': stats.size, 'x-content-type-options': 'nosniff' })
        .type('image/jpeg')
        .send(file.createReadStream());
    } catch (error) {
      await file.close();
      throw error;
    }
  });
}
