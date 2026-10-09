import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ListingEffort, Logger } from '@flashdrop/config';
import type { ImageKey, ListingCall, ListingJobStatus, ListingStatusMessage } from '@flashdrop/contracts';
import {
  type ClaimedJob,
  type Db,
  finishListingJob,
  type JobResult,
  LEASE_SECONDS,
  LeaseLostError,
  markModelUnavailable,
  recordListingCall,
  releaseListingJob,
  renewListingLease,
} from '@flashdrop/db';
import { alert, TransientError, UnprocessableInputError } from '@flashdrop/domain';
import { type FlashdropRedis, REDIS_DEADLINE_MS, userChannel, withDeadline } from '@flashdrop/inventory';
import {
  generateListing,
  type ListingImage,
  type ListingModel,
  type ListingOutcome,
  MAX_LISTING_CALLS,
  NoFixtureError,
} from '@flashdrop/llm';
import { countLlmTokens } from '../metrics';

/*
 * One run of one claimed listing job (design §10): read its stored photos, run the attempt-and-repair loop
 * under the lease, write the outcome, and push each status change to the owner's `user` topic. The admin's
 * review page also polls, so a lost push only delays it.
 *
 * Every model call is recorded the moment it returns (usage, cost, latency), before its answer is acted on,
 * so a crash never loses what was billed; a resumed job spends only the calls the earlier run left.
 *
 * The lease is renewed every `HEARTBEAT_MS` while the run lives, so a model call of any length keeps it,
 * and a killed worker's job is due again within `LEASE_SECONDS` (`@flashdrop/db` listings.ts). Each renewal changes the
 * fencing token, so every write of the run goes through `leaseOf`, one at a time with the current token: a
 * write racing a renewal would fail its compare-and-set and lose the job to nobody. A renewal that finds the
 * job taken aborts the model call in flight.
 *
 * A model that stays unavailable (rate limits, overload, the network, after the SDK's own retries) puts the
 * job back for `RETRY_DELAY_SECONDS` at a time; past `UNAVAILABLE_ALERT_SECONDS` each release alerts
 * `listing_unavailable`, and past `UNAVAILABLE_GIVE_UP_SECONDS` the job FAILS instead of looping forever.
 */

export interface ListingRunDeps {
  readonly db: Db;
  readonly redis: FlashdropRedis;
  readonly logger: Logger;
  readonly model: ListingModel;
  /** `LISTING_EFFORT`. */
  readonly effort: ListingEffort;
  /** `UPLOAD_DIR`, where `api` stored the photos. */
  readonly uploadDir: string;
  /** Lease renewals while a run lives; `HEARTBEAT_MS` unless a test shortens it. */
  readonly heartbeatMs?: number;
}

/** How long a job waits after Anthropic stayed unavailable through the SDK's own retries. */
export const RETRY_DELAY_SECONDS = 60;
/** Unavailable this long, each release of the job alerts: an admin is looking at a spinner. */
export const UNAVAILABLE_ALERT_SECONDS = 10 * 60;
/** Unavailable this long, the job FAILS: the admin can upload again once the model is back. */
export const UNAVAILABLE_GIVE_UP_SECONDS = 30 * 60;
/** Lease renewals while a run lives: four per `LEASE_SECONDS`, so one slow renewal never loses the job. */
export const HEARTBEAT_MS = (LEASE_SECONDS * 1_000) / 4;

/** What a run did with its job. */
export type RunOutcome = Extract<ListingJobStatus, 'READY' | 'NEEDS_REVIEW' | 'FAILED'> | 'RELEASED' | 'LOST';

/** The job cannot be generated from what was uploaded. */
class ListingInputError extends UnprocessableInputError {
  override name = 'ListingInputError';
}

const FAILED_MESSAGE = 'The listing could not be generated. Upload the photos again to retry.';
const UNAVAILABLE_MESSAGE =
  'The model stayed unavailable for 30 minutes, so the listing was not generated. Upload the photos again to retry.';

/** The run's lease: its writes in order, each with the token the renewals before it left. */
interface Lease {
  renew(): Promise<void>;
  use<T>(write: (lease: string) => Promise<T>): Promise<T>;
}

function leaseOf(db: Db, jobId: string, initial: string): Lease {
  let token = initial;
  let tail: Promise<unknown> = Promise.resolve();
  const use = <T>(write: (lease: string) => Promise<T>): Promise<T> => {
    const next = tail.then(() => write(token));
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    renew: () =>
      use(async (lease) => {
        token = await renewListingLease(db, jobId, lease);
      }),
    use,
  };
}

/** Pushes `listing{jobId, status}` to the owner (§7). Best effort, never fails the job. */
async function publishStatus(
  deps: ListingRunDeps,
  job: ClaimedJob,
  status: ListingJobStatus,
  log: Logger,
): Promise<void> {
  const message: ListingStatusMessage = { type: 'listing', jobId: job.id, status };
  try {
    await withDeadline('listing status publish', REDIS_DEADLINE_MS, () =>
      deps.redis.publish(userChannel(job.createdBy), JSON.stringify(message)),
    );
  } catch (err) {
    log.warn({ err, status }, 'listing status push failed; the review page polls');
  }
}

async function loadImages(uploadDir: string, keys: readonly ImageKey[]): Promise<ListingImage[]> {
  return Promise.all(
    keys.map(async (key) => {
      try {
        return { key, data: await readFile(join(uploadDir, key)) };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          throw new ListingInputError(`Photo ${key} is missing from the upload store.`, { cause: error });
        }
        throw error;
      }
    }),
  );
}

/** Totals over every call billed to the job, this run's and an interrupted run's. */
function totals(calls: readonly ListingCall[]): Pick<JobResult, 'costUsd' | 'latencyMs'> {
  if (calls.length === 0) return { costUsd: null, latencyMs: null };
  const costs = calls.map((call) => call.costUsd);
  return {
    costUsd: costs.every((cost) => cost !== null) ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    latencyMs: calls.reduce((sum, call) => sum + call.latencyMs, 0),
  };
}

function resultOf(outcome: ListingOutcome, calls: readonly ListingCall[]): JobResult {
  switch (outcome.status) {
    case 'READY':
      return {
        status: 'READY',
        draft: outcome.draft,
        issues: { fields: [], failure: null },
        ...totals(calls),
      };
    case 'NEEDS_REVIEW':
      return {
        status: 'NEEDS_REVIEW',
        draft: outcome.draft,
        issues: { fields: [...outcome.issues], failure: null },
        ...totals(calls),
      };
    case 'FAILED':
      return {
        status: 'FAILED',
        draft: null,
        issues: { fields: [], failure: outcome.failure },
        ...totals(calls),
      };
  }
}

function failed(reason: 'interrupted' | 'error', message: string, calls: readonly ListingCall[]): JobResult {
  return {
    status: 'FAILED',
    draft: null,
    issues: { fields: [], failure: { reason, category: null, message } },
    ...totals(calls),
  };
}

/** Puts the job back in the queue (see `releaseListingJob`); 'LOST' when it is no longer this run's. */
async function release(
  deps: ListingRunDeps,
  job: ClaimedJob,
  lease: Lease,
  log: Logger,
  err: unknown,
  delaySeconds: number,
): Promise<RunOutcome> {
  if (!(await lease.use((current) => releaseListingJob(deps.db, job.id, current, delaySeconds))))
    return 'LOST';
  log.warn({ err, retryInSeconds: delaySeconds }, 'listing job released back to the queue');
  await publishStatus(deps, job, 'PENDING', log);
  return 'RELEASED';
}

export async function runListingJob(
  deps: ListingRunDeps,
  job: ClaimedJob,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const log = deps.logger.child({ jobId: job.id });
  const calls = [...job.priorCalls];
  const lease = leaseOf(deps.db, job.id, job.lease);
  // Aborted when a renewal finds the job taken: the call in flight is for a job this run no longer owns.
  const lost = new AbortController();
  const heartbeat = setInterval(() => {
    lease.renew().catch((err: unknown) => {
      if (err instanceof LeaseLostError) lost.abort(err);
      else log.warn({ err }, 'listing lease renewal failed; retrying at the next beat');
    });
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await run(deps, job, signal, { log, calls, lease, lost: lost.signal });
  } catch (err) {
    // A write on the way out (the failure, the release) found the job taken.
    if (!(err instanceof LeaseLostError)) throw err;
    log.warn({ err }, 'listing job lease lost; another run owns it now');
    return 'LOST';
  } finally {
    clearInterval(heartbeat);
  }
}

interface RunState {
  readonly log: Logger;
  readonly calls: ListingCall[];
  readonly lease: Lease;
  readonly lost: AbortSignal;
}

async function run(
  deps: ListingRunDeps,
  job: ClaimedJob,
  signal: AbortSignal,
  { log, calls, lease, lost }: RunState,
): Promise<RunOutcome> {
  if (job.resumed) log.warn({ attempts: job.attempts }, 'resuming a listing job whose run was interrupted');
  await publishStatus(deps, job, 'RUNNING', log);

  const finish = async (result: JobResult): Promise<RunOutcome> => {
    await lease.use((current) => finishListingJob(deps.db, job.id, current, result));
    const { failure } = result.issues;
    const context = { status: result.status, attempts: calls.length, costUsd: result.costUsd };
    if (failure?.reason === 'refusal') {
      alert(log, 'listing_refused', { ...context, category: failure.category }, 'listing model refused');
    } else {
      log.info(context, 'listing job finished');
    }
    await publishStatus(deps, job, result.status, log);
    return result.status;
  };

  try {
    const remaining = MAX_LISTING_CALLS - job.attempts;
    if (remaining < 1) {
      return await finish(
        failed('interrupted', 'The generation was interrupted after using all its model calls.', calls),
      );
    }
    const outcome = await generateListing({
      model: deps.model,
      images: await loadImages(deps.uploadDir, job.imageKeys),
      hints: job.hints,
      effort: deps.effort,
      maxCalls: remaining,
      priorCalls: job.attempts,
      signal: AbortSignal.any([signal, lost]),
      // Also a check that the job is still this run's before paying for a call.
      beforeCall: () => lease.renew(),
      onCall: async (call) => {
        calls.push(call);
        countLlmTokens(deps.model.provider, call);
        log.info({ call }, 'listing model call');
        await lease.use((current) => recordListingCall(deps.db, job.id, current, call));
      },
    });
    return await finish(resultOf(outcome, calls));
  } catch (err) {
    if (err instanceof LeaseLostError || lost.aborted) {
      log.warn({ err }, 'listing job lease lost; another run owns it now');
      return 'LOST';
    }
    if (signal.aborted) return await release(deps, job, lease, log, err, 0);
    if (err instanceof TransientError) {
      const waited = await lease.use((current) => markModelUnavailable(deps.db, job.id, current));
      if (waited >= UNAVAILABLE_GIVE_UP_SECONDS) {
        alert(log, 'listing_failed', { err, unavailableSeconds: waited }, 'listing model stayed unavailable');
        return await finish(failed('error', UNAVAILABLE_MESSAGE, calls));
      }
      if (waited >= UNAVAILABLE_ALERT_SECONDS) {
        alert(log, 'listing_unavailable', { err, unavailableSeconds: waited }, 'listing model unavailable');
      }
      return await release(deps, job, lease, log, err, RETRY_DELAY_SECONDS);
    }
    // Expected without a key: the admin uploaded a photo that has no recorded answer.
    if (err instanceof NoFixtureError) {
      log.warn({ err }, 'no listing fixture for these photos');
      return await finish(failed('error', err.message, calls));
    }
    if (err instanceof ListingInputError) {
      alert(log, 'listing_failed', { err }, 'listing job cannot be generated from its input');
      return await finish(failed('error', err.message, calls));
    }
    alert(log, 'listing_failed', { err }, 'listing job failed');
    return await finish(failed('error', FAILED_MESSAGE, calls));
  }
}
