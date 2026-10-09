import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import {
  ApproveListingResponse,
  CreateListingResponse,
  type ImageKey,
  ListingJob,
  ListingJobListResponse,
  type ListingWire,
  ProductDetail,
  type SessionUser,
} from '@flashdrop/contracts';
import { eq, listingJobs, products, users } from '@flashdrop/db';
import { LISTING_PROMPT_VERSION } from '@flashdrop/llm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../../http/api';
import { listingInputHash } from '../../services/admin-listings';
import { ORIGIN, sessionToken } from '../../test/fakes';
import { type MultipartPart, multipartBody } from '../../test/listings-fake';
import { createTestStack, type TestStack } from '../../test/stack';

/*
 * The listing upload and approval against Postgres and the real image pipeline (design §10): the stored
 * photos, the job row and its reuse, the job DTO, and approval into a PUBLISHED product that the catalog
 * serves. Every test uses photos of its own colour, so jobs never collide with another test's.
 */

let stack: TestStack;
let app: Api;
let admin: SessionUser;

beforeAll(async () => {
  stack = await createTestStack();
  app = await stack.build();
});
afterAll(async () => {
  await stack?.close();
});
// A fresh admin per test: the upload limit counts per admin in the shared Redis, across runs and files.
beforeEach(async () => {
  const id = randomUUID();
  admin = { id, email: `${id}@listings.test`, displayName: 'Listing Admin', role: 'admin' };
  await stack.database.db.insert(users).values({ ...admin });
});

let colour = 0;
/** A photo nobody else uploaded. */
function freshColour(): string {
  colour += 1;
  return `#${(0x204060 + colour * 0x0a0b07).toString(16).slice(-6)}`;
}

/** A 3000 x 2000 camera JPEG with orientation 6 (a portrait on display), a camera make and a GPS fix. */
function cameraPhoto(background = freshColour()): Promise<Buffer> {
  return sharp({ create: { width: 3000, height: 2000, channels: 3, background } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: 'FlashCam' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '48/1 51/1 29/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '2/1 17/1 40/1',
      },
    })
    .toBuffer();
}

async function upload(parts: readonly MultipartPart[]) {
  const { body, contentType } = multipartBody(parts);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/listings',
    headers: { origin: ORIGIN, 'content-type': contentType },
    cookies: { [SESSION_COOKIE]: await sessionToken(admin) },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(202);
  return CreateListingResponse.parse(response.json());
}

async function send(method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { origin: ORIGIN },
    cookies: { [SESSION_COOKIE]: await sessionToken(admin) },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function jobRow(id: string) {
  const [row] = await stack.database.db.select().from(listingJobs).where(eq(listingJobs.id, id));
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
}

const LISTING: ListingWire = {
  title: 'Ribbed Ivory Stoneware Vase',
  description:
    'A tall stoneware vase in a warm ivory glaze, shaped with even horizontal rings that catch the light on ' +
    'any shelf or table.',
  highlights: ['Even horizontal rings', 'Matte ivory glaze', 'Tapered neck for single stems'],
  category: 'home',
  attributes: { brand: null, color: 'Ivory', material: 'Stoneware', size: null },
  condition: 'new',
  tags: ['vase', 'stoneware'],
  uncertainties: [{ field: 'size', note: 'How tall is it?' }],
};

/** A job the worker has finished: READY with a draft and one billed call. */
async function readyJob(): Promise<string> {
  const { jobId } = await upload([{ field: 'images', file: await cameraPhoto() }]);
  await stack.database.db
    .update(listingJobs)
    .set({
      status: 'READY',
      provider: 'fixture',
      model: 'claude-sonnet-5-5',
      attempts: 1,
      draft: LISTING,
      issues: { fields: [], failure: null },
      usage: [
        {
          attempt: 1,
          model: 'claude-sonnet-5-5',
          effort: 'low',
          outcome: 'ok',
          stopReason: 'end_turn',
          inputTokens: 1214,
          outputTokens: 386,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 0.006288,
          latencyMs: 2140,
        },
      ],
      costUsd: '0.00629',
      latencyMs: 2140,
    })
    .where(eq(listingJobs.id, jobId));
  return jobId;
}

describe('POST /admin/listings', () => {
  it('stores re-encoded photos without metadata and queues a PENDING job keyed by its input', async () => {
    const png = await sharp({ create: { width: 900, height: 600, channels: 4, background: freshColour() } })
      .png()
      .toBuffer();
    const { jobId, status } = await upload([
      { field: 'images', file: await cameraPhoto() },
      { field: 'images', file: png, filename: 'side.png', type: 'image/png' },
      { field: 'hints', value: 'stoneware, about 22 cm' },
    ]);
    expect(status).toBe('PENDING');

    const row = await jobRow(jobId);
    expect(row).toMatchObject({
      status: 'PENDING',
      createdBy: admin.id,
      hints: 'stoneware, about 22 cm',
      promptVersion: LISTING_PROMPT_VERSION,
      attempts: 0,
    });
    const keys = row.imageKeys as ImageKey[];
    expect(keys).toHaveLength(2);
    expect(row.inputHash.equals(listingInputHash(keys, 'stoneware, about 22 cm'))).toBe(true);

    const camera = await readFile(join(stack.database.uploadDir, keys[0] ?? ''));
    const metadata = await sharp(camera).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 1045, height: 1568 });
    expect(metadata.exif).toBeUndefined();
    expect(camera.includes(Buffer.from('FlashCam'))).toBe(false);
  });

  it('reuses the job of an identical upload, even when both arrive at once', async () => {
    const photo = { field: 'images', file: await cameraPhoto() };
    const parts = [photo, { field: 'hints', value: 'same hints' }];
    const [first, second] = await Promise.all([upload(parts), upload(parts)]);
    expect(second?.jobId).toBe(first?.jobId);
    expect((await upload(parts)).jobId).toBe(first?.jobId);

    // Other hints are another input, and a FAILED job is never reused.
    const otherHints = await upload([photo, { field: 'hints', value: 'other' }]);
    expect(otherHints.jobId).not.toBe(first?.jobId);
    await stack.database.db
      .update(listingJobs)
      .set({ status: 'FAILED' })
      .where(eq(listingJobs.id, first?.jobId ?? ''));
    expect((await upload(parts)).jobId).not.toBe(first?.jobId);
  });
});

describe('GET /admin/listings', () => {
  it('reads a job with its draft, calls and cost', async () => {
    const jobId = await readyJob();
    const response = await send('GET', `/admin/listings/${jobId}`);
    expect(response.statusCode).toBe(200);
    expect(ListingJob.parse(response.json())).toMatchObject({
      id: jobId,
      status: 'READY',
      provider: 'fixture',
      attempts: 1,
      draft: LISTING,
      final: null,
      issues: [],
      failure: null,
      calls: [{ attempt: 1, outcome: 'ok', inputTokens: 1214 }],
      costUsd: 0.00629,
      latencyMs: 2140,
      productId: null,
      editRate: null,
    });
    const list = ListingJobListResponse.parse((await send('GET', '/admin/listings?limit=2')).json());
    expect(list.jobs[0]).toMatchObject({ id: jobId, status: 'READY', title: LISTING.title });
  });
});

describe('POST /admin/listings/:jobId/approve', () => {
  it('publishes the reviewed listing as an llm product the catalog serves, and records the edit rate', async () => {
    const jobId = await readyJob();
    const final = { ...LISTING, attributes: { ...LISTING.attributes, size: 'H 22 cm' } };
    const response = await send('POST', `/admin/listings/${jobId}/approve`, { listing: final });
    expect(response.statusCode, response.body).toBe(200);
    const { job, product } = ApproveListingResponse.parse(response.json());
    expect(product.slug).toMatch(/^ribbed-ivory-stoneware-vase-[0-9a-f]{6}$/);
    expect(job).toMatchObject({
      status: 'APPROVED',
      productId: product.id,
      productSlug: product.slug,
      editRate: 0.1,
    });

    const [row] = await stack.database.db.select().from(products).where(eq(products.id, product.id));
    expect(row).toMatchObject({
      status: 'PUBLISHED',
      source: 'llm',
      listingJobId: jobId,
      title: LISTING.title,
    });

    const page = await app.inject({ method: 'GET', url: `/api/v1/products/${product.slug}` });
    expect(page.statusCode).toBe(200);
    expect(ProductDetail.parse(page.json()).product).toMatchObject({
      title: LISTING.title,
      imageKeys: (await jobRow(jobId)).imageKeys,
      attributes: { category: 'home', size: 'H 22 cm', photoCredits: [] },
    });
  });

  it('approves a job once, only when READY or NEEDS_REVIEW, and never onto a taken slug', async () => {
    const jobId = await readyJob();
    const taken = await send('POST', `/admin/listings/${jobId}/approve`, {
      listing: LISTING,
      slug: 'sage-wireless-headphones',
    });
    expect(taken.statusCode).toBe(409);
    expect((await jobRow(jobId)).status).toBe('READY');

    expect((await send('POST', `/admin/listings/${jobId}/approve`, { listing: LISTING })).statusCode).toBe(
      200,
    );
    expect((await send('POST', `/admin/listings/${jobId}/approve`, { listing: LISTING })).statusCode).toBe(
      409,
    );

    const { jobId: pending } = await upload([{ field: 'images', file: await cameraPhoto() }]);
    expect((await send('POST', `/admin/listings/${pending}/approve`, { listing: LISTING })).statusCode).toBe(
      409,
    );
    expect(
      (await send('POST', `/admin/listings/${randomUUID()}/approve`, { listing: LISTING })).statusCode,
    ).toBe(404);
  });
});
