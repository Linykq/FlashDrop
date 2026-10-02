import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import { buildTestApp, IMAGE_KEY } from '../test/fakes';
import { matchesEtag } from './uploads';

const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const ETAG = `"${'ab'.repeat(32)}"`;
const DIRECTORY_KEY = `${'cd'.repeat(32)}.jpg`;

let app: Api;
let uploadDir: string;

beforeAll(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), 'fd-api-uploads-'));
  await writeFile(join(uploadDir, IMAGE_KEY), BYTES);
  await mkdir(join(uploadDir, DIRECTORY_KEY));
  app = await buildTestApp({ uploadDir });
});
afterAll(async () => {
  await app.close();
  await rm(uploadDir, { recursive: true, force: true });
});

describe('GET /uploads/:key', () => {
  it('serves the file as an immutable JPEG', async () => {
    const response = await app.inject({ url: `/uploads/${IMAGE_KEY}` });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(BYTES);
    expect(response.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'content-length': String(BYTES.length),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: ETAG,
      'x-content-type-options': 'nosniff',
    });
  });

  it('answers HEAD with the headers only', async () => {
    const response = await app.inject({ method: 'HEAD', url: `/uploads/${IMAGE_KEY}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe(String(BYTES.length));
    expect(response.body).toBe('');
  });

  it('answers a matching If-None-Match with 304', async () => {
    const response = await app.inject({ url: `/uploads/${IMAGE_KEY}`, headers: { 'if-none-match': ETAG } });
    expect(response.statusCode).toBe(304);
    expect(response.body).toBe('');
    expect(response.headers.etag).toBe(ETAG);
  });

  it('answers 404 for a well-formed key with no file, without caching the miss', async () => {
    for (const key of [`${'0'.repeat(64)}.jpg`, DIRECTORY_KEY]) {
      const response = await app.inject({ url: `/uploads/${key}` });
      expect(response.statusCode).toBe(404);
      expect(response.headers['cache-control']).toBeUndefined();
      expect(response.json()).toMatchObject({ code: 'NOT_FOUND', detail: 'Image not found' });
    }
  });

  it.each([
    '..%2F..%2Fpackage.json',
    '..%5C..%5Cpackage.json',
    `${'AB'.repeat(32)}.jpg`,
    `${'ab'.repeat(32)}.png`,
    `${'ab'.repeat(31)}.jpg`,
  ])('refuses the key %s before touching the disk', async (key) => {
    const response = await app.inject({ url: `/uploads/${key}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'key' }] });
  });
});

describe('matchesEtag', () => {
  it.each([
    [ETAG, true],
    [`W/${ETAG}`, true],
    [`"other", ${ETAG}`, true],
    ['*', true],
    ['"other"', false],
    [undefined, false],
  ])('If-None-Match %s -> %s', (header, expected) => {
    expect(matchesEtag(header, ETAG)).toBe(expected);
  });
});
