import { createHash, randomUUID } from 'node:crypto';
import type { ImageKey, ListingCall, ListingWire } from '@flashdrop/contracts';
import { NotFoundError } from '@flashdrop/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './client';
import {
  type ApprovedProduct,
  approveListingJob,
  claimListingJob,
  finishListingJob,
  getListingJob,
  type JobResult,
  LEASE_SECONDS,
  LeaseLostError,
  markModelUnavailable,
  recordListingCall,
  releaseListingJob,
  renewListingLease,
  submitListingJob,
} from './listings';
import { listingJobs, products } from './schema';
import { createTestDatabase, type TestDatabase } from './test-database';
import { createUsers } from './test-fixtures';

/*
 * The listing job state machine (design §10), statement by statement: submit with dedupe, claim with SKIP
 * LOCKED and an expiring lease, the lease as a fencing token on every later write, release, finish, and
 * approve. This file's database holds only the jobs its tests insert; each test finishes or parks the jobs
 * it claims, so the next one's claim sees only its own.
 */

let test: TestDatabase;
let db: Db;
let admin: string;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.db;
  [admin = ''] = await createUsers(db, 1);
});

afterAll(async () => {
  await test?.drop();
});

const RUNNER = { provider: 'fixture', model: 'claude-test', promptVersion: 'listing-v1' } as const;

const imageKey = (): ImageKey => `${createHash('sha256').update(randomUUID()).digest('hex')}.jpg`;

async function submit(keys: readonly ImageKey[] = [imageKey()], hints: string | null = null) {
  return submitListingJob(db, {
    createdBy: admin,
    imageKeys: keys,
    hints,
    inputHash: createHash('sha256')
      .update(JSON.stringify([keys, hints]))
      .digest(),
    promptVersion: RUNNER.promptVersion,
  });
}

/** Claims the job just submitted: tests run one at a time, and each leaves no other job due. */
async function claimed(jobId: string) {
  const job = await claimListingJob(db, RUNNER);
  expect(job?.id).toBe(jobId);
  if (job === null) throw new Error('nothing to claim');
  return job;
}

/** Moves the job's lease (or retry delay) into the past by Postgres time, as if it had run out. */
async function expireLease(jobId: string): Promise<void> {
  await db
    .update(listingJobs)
    .set({ lockedUntil: sql`now() - interval '1 second'` })
    .where(eq(listingJobs.id, jobId));
}

const CALL: ListingCall = {
  attempt: 1,
  model: 'claude-test',
  effort: 'low',
  outcome: 'ok',
  stopReason: 'end_turn',
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0.004,
  latencyMs: 1_200,
};

const LISTING: ListingWire = {
  title: 'Ribbed Ivory Stoneware Vase',
  description:
    'A tall stoneware vase in a warm ivory glaze, shaped with even horizontal rings that catch the light.',
  highlights: ['Even horizontal rings', 'Matte ivory glaze', 'Tapered neck'],
  category: 'home',
  attributes: { brand: null, color: 'Ivory', material: 'Stoneware', size: null },
  condition: 'new',
  tags: ['vase'],
  uncertainties: [],
};

const READY: JobResult = {
  status: 'READY',
  draft: LISTING,
  issues: { fields: [], failure: null },
  costUsd: 0.004,
  latencyMs: 1_200,
};

describe('submit', () => {
  it('queues a PENDING job, and hands an identical upload the same job, even when both arrive at once', async () => {
    const keys = [imageKey(), imageKey()];
    const [first, second] = await Promise.all([submit(keys, 'stoneware'), submit(keys, 'stoneware')]);
    expect([first, second].filter((job) => !job.reused)).toHaveLength(1);
    expect(first.jobId).toBe(second.jobId);
    expect(first.status).toBe('PENDING');
    // Other hints are another input.
    expect((await submit(keys, 'porcelain')).jobId).not.toBe(first.jobId);

    for (const jobId of new Set([first.jobId, (await submit(keys, 'porcelain')).jobId])) {
      const job = await claimed(jobId);
      await finishListingJob(db, job.id, job.lease, READY);
    }
  });

  it('starts over after a FAILED job instead of reusing it', async () => {
    const keys = [imageKey()];
    const failedJob = await submit(keys);
    const job = await claimed(failedJob.jobId);
    await finishListingJob(db, job.id, job.lease, {
      ...READY,
      status: 'FAILED',
      draft: null,
      issues: { fields: [], failure: { reason: 'error', category: null, message: 'boom' } },
    });

    const again = await submit(keys);
    expect(again).toMatchObject({ reused: false, status: 'PENDING' });
    await finishListingJob(db, again.jobId, (await claimed(again.jobId)).lease, READY);
  });
});

describe('claim and lease', () => {
  it('claims each due job once across concurrent workers (SKIP LOCKED), the oldest first', async () => {
    const jobs = [await submit(), await submit(), await submit()];
    const claims = await Promise.all(jobs.map(() => claimListingJob(db, RUNNER)));
    expect(claims.map((job) => job?.id).sort()).toEqual(jobs.map((job) => job.jobId).sort());
    expect(await claimListingJob(db, RUNNER)).toBeNull();

    const row = await getListingJob(db, jobs[0]?.jobId ?? '');
    expect(row).toMatchObject({ status: 'RUNNING', provider: 'fixture', model: 'claude-test' });
    const leaseSeconds = ((row?.lockedUntil?.getTime() ?? 0) - Date.now()) / 1000;
    expect(leaseSeconds).toBeGreaterThan(LEASE_SECONDS - 10);
    expect(leaseSeconds).toBeLessThanOrEqual(LEASE_SECONDS + 1);
    for (const job of claims) if (job !== null) await finishListingJob(db, job.id, job.lease, READY);
  });

  it('resumes a job whose lease expired, with the calls already billed, and fences the run that lost it', async () => {
    const { jobId } = await submit();
    const first = await claimed(jobId);
    await recordListingCall(db, jobId, first.lease, CALL);
    expect(await claimListingJob(db, RUNNER)).toBeNull(); // the lease is live

    await expireLease(jobId);
    const second = await claimed(jobId);
    expect(second).toMatchObject({ resumed: true, attempts: 1, priorCalls: [CALL] });

    // The stalled first run can no longer write anything.
    const stale = first.lease;
    await expect(renewListingLease(db, jobId, stale)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(recordListingCall(db, jobId, stale, CALL)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(markModelUnavailable(db, jobId, stale)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(finishListingJob(db, jobId, stale, READY)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await releaseListingJob(db, jobId, stale, 0)).toBe(false);
    expect((await getListingJob(db, jobId))?.attempts).toBe(1);

    // A renewal hands out a new token and retires the old one.
    const renewed = await renewListingLease(db, jobId, second.lease);
    expect(renewed).not.toBe(second.lease);
    await expect(renewListingLease(db, jobId, second.lease)).rejects.toBeInstanceOf(LeaseLostError);
    await finishListingJob(db, jobId, renewed, READY);
    expect(await getListingJob(db, jobId)).toMatchObject({ status: 'READY', lockedUntil: null });
  });

  it('remembers since when the model was unavailable until a call is answered, and releases with a delay', async () => {
    const { jobId } = await submit();
    const job = await claimed(jobId);
    expect(await markModelUnavailable(db, jobId, job.lease)).toBeLessThan(1);
    await db
      .update(listingJobs)
      .set({ unavailableSince: sql`now() - interval '90 seconds'` })
      .where(eq(listingJobs.id, jobId));
    expect(await markModelUnavailable(db, jobId, job.lease)).toBeGreaterThanOrEqual(90);
    await recordListingCall(db, jobId, job.lease, CALL);
    expect((await getListingJob(db, jobId))?.unavailableSince).toBeNull();

    expect(await releaseListingJob(db, jobId, job.lease, 60)).toBe(true);
    expect(await getListingJob(db, jobId)).toMatchObject({ status: 'PENDING' });
    expect(await claimListingJob(db, RUNNER)).toBeNull(); // not due before its delay

    await expireLease(jobId);
    const again = await claimed(jobId);
    expect(again).toMatchObject({ resumed: false, attempts: 1 });
    await finishListingJob(db, jobId, again.lease, READY);
  });
});

describe('approve', () => {
  async function readyJob(): Promise<string> {
    const { jobId } = await submit();
    const job = await claimed(jobId);
    await finishListingJob(db, jobId, job.lease, READY);
    return jobId;
  }

  const product = (slug = `vase-${randomUUID().slice(0, 8)}`): ApprovedProduct => ({
    id: randomUUID(),
    slug,
    title: LISTING.title,
    description: LISTING.description,
    attributes: {
      category: 'home',
      condition: 'new',
      highlights: LISTING.highlights,
      tags: LISTING.tags,
      photoCredits: [],
    },
  });

  it('publishes the product with the job photos and marks the job APPROVED, once even when raced', async () => {
    const jobId = await readyJob();
    const [a, b] = [product(), product()];
    const results = await Promise.allSettled([
      approveListingJob(db, jobId, a, LISTING),
      approveListingJob(db, jobId, b, LISTING),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    });

    const job = await getListingJob(db, jobId);
    expect(job).toMatchObject({ status: 'APPROVED', final: LISTING });
    const [published] = await db
      .select()
      .from(products)
      .where(eq(products.id, job?.productId ?? ''));
    expect(published).toMatchObject({
      status: 'PUBLISHED',
      source: 'llm',
      listingJobId: jobId,
      imageKeys: job?.imageKeys,
    });
    expect(job?.productSlug).toBe(published?.slug);
  });

  it('refuses a job that is not ready, a taken slug, and an unknown job', async () => {
    const { jobId: running } = await submit();
    const job = await claimed(running);
    await expect(approveListingJob(db, running, product(), LISTING)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A RUNNING listing job cannot be approved',
    });
    await finishListingJob(db, running, job.lease, READY);

    const taken = product();
    await approveListingJob(db, running, taken, LISTING);
    const other = await readyJob();
    await expect(approveListingJob(db, other, product(taken.slug), LISTING)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: `The slug ${taken.slug} is taken`,
    });
    expect(await getListingJob(db, other)).toMatchObject({ status: 'READY', productId: null });

    await expect(approveListingJob(db, randomUUID(), product(), LISTING)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
