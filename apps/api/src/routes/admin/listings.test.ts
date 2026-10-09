import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  ApproveListingResponse,
  CreateListingResponse,
  ListingJob,
  ListingJobListResponse,
  ProblemDetails,
} from '@flashdrop/contracts';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServices } from '../../app';
import type { Api } from '../../http/api';
import { ADMIN, BUYER, buildTestApp, fakeServices, fakeState, ORIGIN, sessionToken } from '../../test/fakes';
import {
  createFakeListings,
  type FakeListings,
  type MultipartPart,
  multipartBody,
} from '../../test/listings-fake';
import { LISTING_UPLOADS_PER_MINUTE } from './listings';

/*
 * The listing routes over an in-memory job store (design §10, §11): multipart parsing, magic-byte checks,
 * limits, the per-admin rate limit and the approve validation. The Postgres side is listings.int.test.ts.
 */

let app: Api;
let listings: FakeListings;
let uploadDir: string;

beforeEach(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), 'fd-listings-'));
  listings = createFakeListings();
  const services: AppServices = { ...fakeServices(fakeState()), listings };
  app = await buildTestApp({ services, uploadDir });
});
afterEach(async () => {
  await app.close();
  await rm(uploadDir, { recursive: true, force: true });
});

const jpeg = (color = '#5a7d6c', width = 64) =>
  sharp({ create: { width, height: 48, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

async function upload(parts: readonly MultipartPart[], user: typeof ADMIN | null = ADMIN) {
  const { body, contentType } = multipartBody(parts);
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/listings',
    headers: { origin: ORIGIN, 'content-type': contentType },
    cookies: user === null ? {} : { [SESSION_COOKIE]: await sessionToken(user) },
    payload: body,
  });
}

function problemOf(response: { json(): unknown }) {
  return ProblemDetails.parse(response.json());
}

describe('POST /admin/listings', () => {
  it('stores each photo re-encoded under its content key and queues one job: 202', async () => {
    const [green, red] = [await jpeg(), await jpeg('#a33', 3000)];
    const response = await upload([
      { field: 'images', file: green },
      { field: 'images', file: red },
      { field: 'images', file: green },
      { field: 'hints', value: '  linen,\n size M ' },
    ]);
    expect(response.statusCode).toBe(202);
    const { jobId, status } = CreateListingResponse.parse(response.json());
    expect(status).toBe('PENDING');

    const [submitted] = listings.submitted;
    expect(submitted).toMatchObject({ createdBy: ADMIN.id, hints: 'linen, size M' });
    // The repeated photo is stored and listed once, in upload order.
    expect(submitted?.imageKeys).toHaveLength(2);
    expect((await readdir(uploadDir)).sort()).toEqual([...(submitted?.imageKeys ?? [])].sort());
    const stored = await sharp(await readFile(join(uploadDir, submitted?.imageKeys[1] ?? ''))).metadata();
    expect([stored.format, stored.width]).toEqual(['jpeg', 1568]);
    expect(listings.jobs.has(jobId)).toBe(true);
  });

  it('accepts PNG and WebP by their magic bytes, whatever they are called', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fff0' } })
      .png()
      .toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } })
      .webp()
      .toBuffer();
    const response = await upload([
      { field: 'images', file: png, filename: 'scan.gif', type: 'application/octet-stream' },
      { field: 'images', file: webp, filename: 'x.jpg' },
    ]);
    expect(response.statusCode).toBe(202);
  });

  it('refuses anything but JPEG, PNG and WebP by content, at the photo it concerns', async () => {
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
    const response = await upload([
      { field: 'images', file: await jpeg() },
      { field: 'images', file: gif, filename: 'photo.jpg', type: 'image/jpeg' },
    ]);
    expect(response.statusCode).toBe(400);
    expect(problemOf(response)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'images.1', message: 'must be a JPEG, PNG or WebP image' }],
    });
    expect(listings.submitted).toEqual([]);
  });

  it('refuses a JPEG that does not decode', async () => {
    const response = await upload([
      { field: 'images', file: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
    ]);
    expect(problemOf(response).errors?.[0]?.path).toBe('images.0');
  });

  it('caps each photo at 8 MB and the upload at 4 photos', async () => {
    const huge = Buffer.concat([await jpeg(), Buffer.alloc(8 * 1024 * 1024)]);
    const tooBig = await upload([{ field: 'images', file: huge }]);
    expect(tooBig.statusCode).toBe(400);
    expect(problemOf(tooBig).errors).toEqual([{ path: 'images.0', message: 'must be at most 8 MB' }]);
    expect(await readdir(uploadDir)).toEqual([]);

    const photo = await jpeg();
    const five = await upload(Array.from({ length: 5 }, () => ({ field: 'images', file: photo })));
    expect(five.statusCode).toBe(400);
    expect(problemOf(five).errors).toEqual([{ path: 'images', message: 'must contain at most 4 photos' }]);
  });

  it('needs a photo, bounded hints and only the fields it knows', async () => {
    const none = await upload([{ field: 'hints', value: 'just text' }]);
    expect(problemOf(none).errors).toEqual([{ path: 'images', message: 'must contain at least one photo' }]);

    const photo = { field: 'images', file: await jpeg() };
    const long = await upload([photo, { field: 'hints', value: 'x'.repeat(501) }]);
    expect(problemOf(long).errors?.[0]?.path).toBe('hints');

    const stray = await upload([photo, { field: 'price', value: '1' }]);
    expect(problemOf(stray).errors?.[0]).toEqual({ path: 'price', message: 'is not an upload field' });
  });

  it('refuses a JSON body: uploads are multipart only', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/listings',
      headers: { origin: ORIGIN },
      cookies: { [SESSION_COOKIE]: await sessionToken(ADMIN) },
      payload: { images: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(problemOf(response).errors?.[0]?.path).toBe('');
  });

  it('is for admins only, from an allowed origin', async () => {
    const photo = [{ field: 'images', file: await jpeg() }];
    expect((await upload(photo, null)).statusCode).toBe(401);
    expect((await upload(photo, BUYER)).statusCode).toBe(403);
    const { body, contentType } = multipartBody(photo);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/listings',
      headers: { origin: 'https://evil.example', 'content-type': contentType },
      cookies: { [SESSION_COOKIE]: await sessionToken(ADMIN) },
      payload: body,
    });
    expect(crossSite.statusCode).toBe(403);
    expect(listings.submitted).toEqual([]);
  });

  it(`allows ${LISTING_UPLOADS_PER_MINUTE} uploads per admin per minute, then 429 with Retry-After`, async () => {
    const photo = [{ field: 'images', file: await jpeg() }];
    for (let i = 0; i < LISTING_UPLOADS_PER_MINUTE; i++) expect((await upload(photo)).statusCode).toBe(202);
    const limited = await upload(photo);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(problemOf(limited).code).toBe('RATE_LIMITED');
  });
});

describe('reading and approving jobs', () => {
  const LISTING = {
    title: 'Ribbed Ivory Stoneware Vase',
    description:
      'A tall stoneware vase in a warm ivory glaze, shaped with even horizontal rings that catch the light ' +
      'on any shelf.',
    highlights: ['Even horizontal rings', 'Matte ivory glaze', 'Tapered neck for single stems'],
    category: 'home',
    attributes: { brand: null, color: 'Ivory', material: 'Stoneware', size: null },
    condition: 'new',
    tags: ['vase'],
    uncertainties: [],
  };

  async function readyJob(): Promise<string> {
    const { jobId } = await listings.submit({
      createdBy: ADMIN.id,
      imageKeys: [`${'a'.repeat(64)}.jpg`],
      hints: null,
    });
    const job = listings.jobs.get(jobId);
    if (job !== undefined)
      listings.jobs.set(jobId, { ...job, status: 'READY', draft: ListingJob.shape.draft.parse(LISTING) });
    return jobId;
  }

  const send = async (method: 'GET' | 'POST', url: string, payload?: object, user = ADMIN) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { origin: ORIGIN },
      cookies: { [SESSION_COOKIE]: await sessionToken(user) },
      ...(payload === undefined ? {} : { payload }),
    });

  it('lists and reads jobs; an unknown job is 404', async () => {
    const jobId = await readyJob();
    expect(ListingJobListResponse.parse((await send('GET', '/admin/listings')).json()).jobs).toEqual([
      expect.objectContaining({ id: jobId, status: 'READY', title: LISTING.title }),
    ]);
    expect(ListingJob.parse((await send('GET', `/admin/listings/${jobId}`)).json()).status).toBe('READY');
    expect((await send('GET', '/admin/listings/0199a3b0-0000-7000-8000-000000000000')).statusCode).toBe(404);
    expect((await send('GET', `/admin/listings/${jobId}`, undefined, BUYER)).statusCode).toBe(403);
  });

  it('re-validates the reviewed listing with ListingDraft before approving it', async () => {
    const jobId = await readyJob();
    const invalid = await send('POST', `/admin/listings/${jobId}/approve`, {
      listing: { ...LISTING, title: 'NOW ONLY $1', category: 'apparel' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(problemOf(invalid).errors?.map((error) => error.path)).toEqual([
      'listing.title',
      'listing.title',
      'listing.attributes.size',
    ]);

    const approved = await send('POST', `/admin/listings/${jobId}/approve`, {
      listing: LISTING,
      slug: 'ivory-vase',
    });
    expect(approved.statusCode).toBe(200);
    expect(ApproveListingResponse.parse(approved.json())).toMatchObject({
      job: { status: 'APPROVED' },
      product: { slug: 'ivory-vase' },
    });
  });
});
