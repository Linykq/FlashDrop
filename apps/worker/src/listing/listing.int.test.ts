import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ImageKey,
  type ListingCall,
  StoredListingCalls,
  StoredListingIssues,
} from '@flashdrop/contracts';
import { claimListingJob, eq, LEASE_SECONDS, listingJobs, renewListingLease, sql } from '@flashdrop/db';
import { TransientError } from '@flashdrop/domain';
import { createSubscriber, userChannel } from '@flashdrop/inventory';
import {
  FixtureListingModel,
  LISTING_PROMPT_VERSION,
  type ListingModel,
  type LoadedFixture,
  loadListingFixtures,
  prepareListingImage,
  REPO_FIXTURES_DIR,
} from '@flashdrop/llm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createUsers, createWorkerTestEnv, type WorkerTestEnv } from '../test/harness';
import { startListingWorker } from '.';
import { type ListingRunDeps, RETRY_DELAY_SECONDS, runListingJob } from './run';

/*
 * The listing role against Postgres and Redis, with the fixture provider (design §10): the job lifecycle,
 * the lease and its fencing, SKIP LOCKED between workers, shutdown and the status pushes. The database is
 * this file's own, so the queue holds only the jobs these tests insert; each test leaves its jobs finished
 * or not yet due.
 */

let env: WorkerTestEnv;
let uploadDir: string;
let fixtures: LoadedFixture[];
let fixtureModel: FixtureListingModel;
let owner: string;

beforeAll(async () => {
  env = await createWorkerTestEnv();
  uploadDir = await mkdtemp(join(tmpdir(), 'fd-listing-int-'));
  fixtures = await loadListingFixtures(REPO_FIXTURES_DIR);
  fixtureModel = new FixtureListingModel('claude-sonnet-5-5', fixtures);
  [owner = ''] = await createUsers(env.db, 1);
});
afterAll(async () => {
  await env?.close();
  if (uploadDir !== undefined) await rm(uploadDir, { recursive: true, force: true });
});

function deps(model: ListingModel = fixtureModel): ListingRunDeps {
  return { db: env.db, redis: env.redis, logger: env.deps.logger, model, effort: 'low', uploadDir };
}

/** Stores a fixture's photo as the upload would, and returns its key. */
async function storePhoto(name: string): Promise<ImageKey> {
  const fixture = fixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`no fixture ${name}`);
  const prepared = await prepareListingImage(await readFile(fixture.imagePath));
  await writeFile(join(uploadDir, prepared.key), prepared.bytes);
  return prepared.key;
}

interface JobSeed {
  readonly status?: 'PENDING' | 'RUNNING';
  readonly attempts?: number;
  readonly usage?: ListingCall[];
  /** Seconds from now; negative is an expired lease. */
  readonly lockedFor?: number;
}

async function insertJob(imageKeys: ImageKey[], seed: JobSeed = {}): Promise<string> {
  const id = randomUUID();
  await env.db.insert(listingJobs).values({
    id,
    createdBy: owner,
    status: seed.status ?? 'PENDING',
    imageKeys,
    inputHash: randomBytes(32),
    promptVersion: LISTING_PROMPT_VERSION,
    attempts: seed.attempts ?? 0,
    usage: seed.usage ?? null,
    lockedUntil: seed.lockedFor === undefined ? null : sql`now() + make_interval(secs => ${seed.lockedFor})`,
  });
  return id;
}

async function jobRow(id: string) {
  const [row] = await env.db.select().from(listingJobs).where(eq(listingJobs.id, id));
  if (row === undefined) throw new Error(`no job ${id}`);
  return {
    ...row,
    issues: row.issues === null ? null : StoredListingIssues.parse(row.issues),
    calls: StoredListingCalls.parse(row.usage ?? []),
  };
}

/** Claims the next due job and runs it to the end, as one slot of the role does. */
async function runNext(model?: ListingModel, signal = new AbortController().signal) {
  const job = await claimListingJob(env.db, {
    provider: (model ?? fixtureModel).provider,
    model: (model ?? fixtureModel).model,
    promptVersion: LISTING_PROMPT_VERSION,
  });
  if (job === null) throw new Error('no job was due');
  return { job, outcome: await runListingJob(deps(model), job, signal) };
}

const call = (attempt: number): ListingCall => ({
  attempt,
  model: 'claude-sonnet-5-5',
  effort: 'low',
  outcome: 'invalid',
  stopReason: 'end_turn',
  inputTokens: 1000,
  outputTokens: 300,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0.005,
  latencyMs: 1200,
});

describe('a listing job', () => {
  it('runs to READY: the draft, every call billed, the lease dropped, each status pushed', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    const pushed: unknown[] = [];
    const subscriber = createSubscriber(env.redis, { name: 'listing-test-sub', logger: env.deps.logger });
    await subscriber.connect();
    try {
      await subscriber.subscribe(userChannel(owner), (message) => void pushed.push(JSON.parse(message)));
      expect((await runNext()).outcome).toBe('READY');
      await vi.waitFor(() =>
        expect(pushed).toEqual([
          { type: 'listing', jobId: id, status: 'RUNNING' },
          { type: 'listing', jobId: id, status: 'READY' },
        ]),
      );
    } finally {
      await subscriber.close();
    }

    const row = await jobRow(id);
    expect(row).toMatchObject({
      status: 'READY',
      provider: 'fixture',
      model: 'claude-sonnet-5-5',
      promptVersion: LISTING_PROMPT_VERSION,
      attempts: 1,
      draft: expect.objectContaining({ title: 'Sage Wireless Over-Ear Headphones', category: 'audio' }),
      issues: { fields: [], failure: null },
      costUsd: '0.00629',
      lockedUntil: null,
    });
    expect(row.calls).toEqual([expect.objectContaining({ attempt: 1, outcome: 'ok', inputTokens: 1214 })]);
    expect(row.latencyMs).toBe(row.calls[0]?.latencyMs);
  });

  it('repairs an over-long title in a second call, both billed', async () => {
    const id = await insertJob([await storePhoto('repair-long-title')]);
    expect((await runNext()).outcome).toBe('READY');
    const row = await jobRow(id);
    expect(row.attempts).toBe(2);
    expect(row.calls.map((entry) => entry.outcome)).toEqual(['invalid', 'ok']);
    // (1206 + 1683) x $2 + (371 + 362) x $10 per million tokens.
    expect(row.costUsd).toBe('0.01311');
  });

  it('FAILS on a refusal and keeps its category', async () => {
    const id = await insertJob([await storePhoto('refusal')]);
    expect((await runNext()).outcome).toBe('FAILED');
    expect((await jobRow(id)).issues).toEqual({
      fields: [],
      failure: {
        reason: 'refusal',
        category: 'general_harms',
        message: 'The model declined to describe these photos (general_harms).',
      },
    });
  });

  it('goes to NEEDS_REVIEW with the issues on their fields', async () => {
    const id = await insertJob([await storePhoto('uncertain-size')]);
    expect((await runNext()).outcome).toBe('NEEDS_REVIEW');
    const row = await jobRow(id);
    expect(row.issues?.fields).toEqual([{ path: 'attributes.size', message: 'is required for apparel' }]);
    expect(row.draft).toMatchObject({ category: 'apparel', attributes: { size: null } });
  });

  it('FAILS without inventing anything when no fixture matches the photos', async () => {
    // A catalog photo no fixture was made from.
    const photo = await prepareListingImage(
      await readFile(join(REPO_FIXTURES_DIR, '..', '..', 'assets', 'catalog', 'amber-jar-candle', '2.jpg')),
    );
    await writeFile(join(uploadDir, photo.key), photo.bytes);
    const id = await insertJob([photo.key]);
    expect((await runNext()).outcome).toBe('FAILED');
    expect((await jobRow(id)).issues?.failure).toMatchObject({
      reason: 'error',
      message: expect.stringContaining('No recorded listing matches these photos'),
    });
  });

  it('FAILS when a stored photo is missing', async () => {
    const id = await insertJob([`${'e'.repeat(64)}.jpg`]);
    expect((await runNext()).outcome).toBe('FAILED');
    expect((await jobRow(id)).issues?.failure).toMatchObject({
      reason: 'error',
      message: expect.stringContaining('missing'),
    });
  });
});

describe('the lease', () => {
  it('leaves a job with a live lease alone and resumes one whose lease expired, numbering on', async () => {
    const live = await insertJob([await storePhoto('valid-draft')], { status: 'RUNNING', lockedFor: 600 });
    const expired = await insertJob([await storePhoto('exhausted')], {
      status: 'RUNNING',
      lockedFor: -1,
      attempts: 1,
      usage: [call(1)],
    });
    const { job, outcome } = await runNext();
    expect(job).toMatchObject({ id: expired, resumed: true, attempts: 1 });
    expect(outcome).toBe('NEEDS_REVIEW');
    const row = await jobRow(expired);
    // Two calls left of three: the job never makes more than three, however often it is interrupted.
    expect(row.calls.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    expect(row.attempts).toBe(3);
    expect((await jobRow(live)).status).toBe('RUNNING');
    await env.db
      .update(listingJobs)
      .set({ status: 'FAILED', lockedUntil: null })
      .where(eq(listingJobs.id, live));
  });

  it('FAILS a resumed job that has no calls left', async () => {
    const id = await insertJob([await storePhoto('valid-draft')], {
      status: 'RUNNING',
      lockedFor: -1,
      attempts: 3,
      usage: [call(1), call(2), call(3)],
    });
    expect((await runNext()).outcome).toBe('FAILED');
    const row = await jobRow(id);
    expect(row.issues?.failure).toMatchObject({ reason: 'interrupted' });
    expect(row.costUsd).toBe('0.01500');
  });

  it('is fenced: a run that lost its lease writes nothing more', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    // The model stalls past the lease: meanwhile another run reclaims the job with a new lease.
    const stalled: ListingModel = {
      provider: fixtureModel.provider,
      model: fixtureModel.model,
      usesEffort: true,
      async create(request) {
        await env.db.execute(
          sql`UPDATE listing_jobs SET locked_until = now() + interval '1 hour' WHERE id = ${id}`,
        );
        return fixtureModel.create(request);
      },
    };
    expect((await runNext(stalled)).outcome).toBe('LOST');
    expect(await jobRow(id)).toMatchObject({ status: 'RUNNING', attempts: 0, draft: null });
    await env.db
      .update(listingJobs)
      .set({ status: 'FAILED', lockedUntil: null })
      .where(eq(listingJobs.id, id));
  });

  it('renews only the lease it holds', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    const job = await claimListingJob(env.db, { provider: 'fixture', model: 'm', promptVersion: 'v' });
    if (job === null) throw new Error('no job');
    const renewed = await renewListingLease(env.db, id, job.lease);
    expect(renewed).not.toBe(job.lease);
    await expect(renewListingLease(env.db, id, job.lease)).rejects.toThrow(/no longer leased/);
    await env.db
      .update(listingJobs)
      .set({ status: 'FAILED', lockedUntil: null })
      .where(eq(listingJobs.id, id));
  });
});

describe('the role', () => {
  it('shares the queue between workers: SKIP LOCKED, every job run exactly once', async () => {
    const photos = [
      'valid-draft',
      'refusal',
      'uncertain-size',
      'repair-long-title',
      'invalid-json',
      'max-tokens',
    ];
    const ids: string[] = [];
    for (const name of photos) ids.push(await insertJob([await storePhoto(name)]));
    const workers = [
      startListingWorker(deps(), { everyMs: 20 }),
      startListingWorker(deps(), { everyMs: 20 }),
    ];
    try {
      await vi.waitFor(
        async () => {
          const rows = await Promise.all(ids.map(jobRow));
          expect(rows.every((row) => row.status !== 'PENDING' && row.status !== 'RUNNING')).toBe(true);
        },
        { timeout: 20_000, interval: 50 },
      );
      expect(workers.flatMap((worker) => worker.health()).every((component) => component.healthy)).toBe(true);
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
    const rows = await Promise.all(ids.map(jobRow));
    // A job run twice would have its calls recorded twice.
    expect(rows.map((row) => row.calls.map((entry) => entry.attempt))).toEqual([
      [1],
      [1],
      [1],
      [1, 2],
      [1, 2],
      [1],
    ]);
  });

  it('puts the job back in the queue on shutdown, with the calls it already made', async () => {
    const id = await insertJob([await storePhoto('repair-long-title')]);
    let calls = 0;
    // Answers the first call, then hangs on the second until the shutdown aborts it.
    const hanging: ListingModel = {
      provider: 'fixture',
      model: 'claude-sonnet-5-5',
      usesEffort: true,
      create(request) {
        calls += 1;
        if (calls === 1) return fixtureModel.create(request);
        return new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        });
      },
    };
    const worker = startListingWorker(deps(hanging), { everyMs: 20 });
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 10_000 });
    await worker.stop();
    expect(await jobRow(id)).toMatchObject({ status: 'PENDING', lockedUntil: null, attempts: 1 });
    await env.db.update(listingJobs).set({ status: 'FAILED' }).where(eq(listingJobs.id, id));
  });

  it('retries later when the model stays unavailable', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    const down: ListingModel = {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      usesEffort: true,
      create: async () => {
        throw new TransientError('Anthropic is unavailable: overloaded');
      },
    };
    expect((await runNext(down)).outcome).toBe('RELEASED');
    const row = await jobRow(id);
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0 });
    const waitMs = (row.lockedUntil?.getTime() ?? 0) - Date.now();
    expect(waitMs).toBeGreaterThan((RETRY_DELAY_SECONDS - 10) * 1000);
    // Not due yet: nothing to claim.
    expect(await claimListingJob(env.db, { provider: 'fixture', model: 'm', promptVersion: 'v' })).toBeNull();
    await env.db
      .update(listingJobs)
      .set({ status: 'FAILED', lockedUntil: null })
      .where(eq(listingJobs.id, id));
  });
});

describe('a long or lost run', () => {
  /** A model that answers like the fixtures, after `ms`, or never when aborted first. */
  const slow = (ms: number): ListingModel => ({
    provider: fixtureModel.provider,
    model: fixtureModel.model,
    usesEffort: true,
    create: (request) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(fixtureModel.create(request)), ms);
        request.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(request.signal?.reason);
          },
          { once: true },
        );
      }),
  });
  const leaseOfJob = async (id: string) => (await jobRow(id)).lockedUntil?.getTime() ?? 0;

  it('claims for two minutes, so a killed worker hands its job on quickly', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    const job = await claimListingJob(env.db, { provider: 'fixture', model: 'm', promptVersion: 'v' });
    expect(job?.id).toBe(id);
    expect((await leaseOfJob(id)) - Date.now()).toBeLessThanOrEqual(LEASE_SECONDS * 1000 + 1_000);
    await env.db
      .update(listingJobs)
      .set({ status: 'FAILED', lockedUntil: null })
      .where(eq(listingJobs.id, id));
  });

  it('keeps renewing the lease while a model call runs, then finishes as usual', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    const job = await claimListingJob(env.db, {
      provider: 'fixture',
      model: fixtureModel.model,
      promptVersion: LISTING_PROMPT_VERSION,
    });
    if (job === null) throw new Error('no job was due');
    const claimed = await leaseOfJob(id);
    const running = runListingJob(
      { ...deps(slow(600)), heartbeatMs: 100 },
      job,
      new AbortController().signal,
    );
    await vi.waitFor(async () => expect(await leaseOfJob(id)).toBeGreaterThan(claimed), {
      timeout: 2_000,
      interval: 50,
    });
    expect(await running).toBe('READY');
    expect(await jobRow(id)).toMatchObject({ status: 'READY', lockedUntil: null, attempts: 1 });
  });

  it('aborts the call in flight when a renewal finds the job taken, and writes nothing more', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    const job = await claimListingJob(env.db, {
      provider: 'fixture',
      model: fixtureModel.model,
      promptVersion: LISTING_PROMPT_VERSION,
    });
    if (job === null) throw new Error('no job was due');
    const running = runListingJob(
      { ...deps(slow(60_000)), heartbeatMs: 50 },
      job,
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Another worker takes it over, as after this one stalled past its lease.
    await env.db.execute(
      sql`UPDATE listing_jobs SET locked_until = now() + interval '1 hour' WHERE id = ${id}`,
    );
    expect(await running).toBe('LOST');
    expect(await jobRow(id)).toMatchObject({ status: 'RUNNING', attempts: 0 });
    await env.db
      .update(listingJobs)
      .set({ status: 'FAILED', lockedUntil: null })
      .where(eq(listingJobs.id, id));
  });
});

describe('a model that stays unavailable', () => {
  const down: ListingModel = {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    usesEffort: true,
    create: async () => {
      throw new TransientError('Anthropic is unavailable: rate limited');
    },
  };
  const alertsOf = (jobId: string, name: string) =>
    env.logs.filter((line) => line.alertName === name && line.jobId === jobId);
  const unavailableFor = (id: string, minutes: number) =>
    env.db
      .update(listingJobs)
      .set({ unavailableSince: sql`now() - make_interval(mins => ${minutes})` })
      .where(eq(listingJobs.id, id));

  it('records since when, and an answered call clears it', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    expect((await runNext(down)).outcome).toBe('RELEASED');
    expect((await jobRow(id)).unavailableSince).not.toBeNull();
    expect(alertsOf(id, 'listing_unavailable')).toEqual([]);

    await env.db.update(listingJobs).set({ lockedUntil: null }).where(eq(listingJobs.id, id));
    expect((await runNext()).outcome).toBe('READY');
    expect((await jobRow(id)).unavailableSince).toBeNull();
  });

  it('alerts once a job has waited more than 10 minutes, and FAILS it after 30', async () => {
    const id = await insertJob([await storePhoto('valid-draft')]);
    await unavailableFor(id, 11);
    expect((await runNext(down)).outcome).toBe('RELEASED');
    expect(alertsOf(id, 'listing_unavailable')).toHaveLength(1);

    await env.db.update(listingJobs).set({ lockedUntil: null }).where(eq(listingJobs.id, id));
    await unavailableFor(id, 31);
    expect((await runNext(down)).outcome).toBe('FAILED');
    const row = await jobRow(id);
    expect(row).toMatchObject({ status: 'FAILED', lockedUntil: null });
    expect(row.issues?.failure).toMatchObject({ reason: 'error' });
    expect(row.issues?.failure?.message).toMatch(/unavailable for 30 minutes/);
    expect(alertsOf(id, 'listing_failed')).toHaveLength(1);
  });
});
