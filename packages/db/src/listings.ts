import { randomUUID } from 'node:crypto';
import type { LlmProvider } from '@flashdrop/config';
import {
  ImageKey,
  type ListingCall,
  type ListingJobStatus,
  type ListingWire,
  type ProductAttributesInput,
  StoredListingCalls,
  type StoredListingIssues,
} from '@flashdrop/contracts';
import { ConflictError, DomainError, NotFoundError } from '@flashdrop/domain';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './client';
import { constraintOf } from './errors';
import { PgUuid, parseRows } from './rows';
import { listingJobs, products } from './schema';
import { transaction } from './transaction';

/*
 * The listing job state machine (design §10), every statement of it in one place: the api submits and
 * approves jobs, the worker's `listing` role claims and runs them.
 *
 *   PENDING --claim--> RUNNING --finish--> READY | NEEDS_REVIEW | FAILED
 *      ^                  |                  |
 *      +----release-------+                  +--approve (READY, NEEDS_REVIEW)--> APPROVED
 *
 * `listing_jobs` is a queue, not an event stream, so it has no Kafka topic. It is claimed with `FOR UPDATE
 * SKIP LOCKED`, so any number of workers share it without double work.
 *
 * A claim takes a lease: `status = 'RUNNING'` and `locked_until` two minutes ahead, renewed every 30 s while
 * the run lives and before every model call. One call can take 3 x 5 minutes with the SDK's retries, so the
 * heartbeat, not the call boundary, keeps the lease: a worker that is killed (SIGKILL, OOM, `docker kill`)
 * hands its job to the next one within two minutes instead of the twenty a lease covering a whole call would
 * need. The lease value is also the fencing token: every later write of the run is a compare-and-set on
 * `locked_until = <lease>`, so a worker that stalled past its lease and lost the job to another cannot
 * overwrite that one's result. The token travels as Postgres's own text form of the timestamp, which
 * round-trips exactly (a JS Date would drop the microseconds).
 */

export const LEASE_SECONDS = 120;

export interface NewListingJob {
  readonly createdBy: string;
  readonly imageKeys: readonly ImageKey[];
  readonly hints: string | null;
  /** sha256 over the photos, the hints and the prompt version: identical uploads share a job. */
  readonly inputHash: Buffer;
  readonly promptVersion: string;
}

export interface SubmittedListing {
  readonly jobId: string;
  readonly status: ListingJobStatus;
  /** An identical earlier upload's job was returned instead of a new one. */
  readonly reused: boolean;
}

/**
 * A new PENDING job, or the newest identical one (same input hash) unless that one FAILED. Identical uploads
 * (a double click, two admins with the same photos) serialize on a transaction-scoped advisory lock keyed by
 * the hash, so they get one job and one bill.
 */
export async function submitListingJob(db: Db, job: NewListingJob): Promise<SubmittedListing> {
  return transaction(db, async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fd.listing.${job.inputHash.toString('hex')}`}, 0))`,
    );
    const [earlier] = await tx
      .select({ id: listingJobs.id, status: listingJobs.status })
      .from(listingJobs)
      .where(and(eq(listingJobs.inputHash, job.inputHash), ne(listingJobs.status, 'FAILED')))
      .orderBy(desc(listingJobs.createdAt))
      .limit(1);
    if (earlier !== undefined) return { jobId: earlier.id, status: earlier.status, reused: true };
    const id = randomUUID();
    await tx.insert(listingJobs).values({
      id,
      createdBy: job.createdBy,
      status: 'PENDING',
      imageKeys: [...job.imageKeys],
      hints: job.hints,
      inputHash: job.inputHash,
      promptVersion: job.promptVersion,
    });
    return { jobId: id, status: 'PENDING', reused: false };
  });
}

export interface ClaimedJob {
  readonly id: string;
  readonly createdBy: string;
  readonly imageKeys: readonly ImageKey[];
  readonly hints: string | null;
  /** Model calls already billed to this job, by an earlier run that was interrupted. */
  readonly attempts: number;
  readonly priorCalls: readonly ListingCall[];
  /** Whether an earlier run's lease expired: the job is being resumed. */
  readonly resumed: boolean;
  readonly lease: string;
}

const ClaimRow = z.object({
  id: PgUuid,
  created_by: PgUuid,
  image_keys: z.array(ImageKey).min(1),
  hints: z.string().nullable(),
  attempts: z.int().nonnegative(),
  usage: StoredListingCalls.nullable(),
  was: z.enum(['PENDING', 'RUNNING']),
  lease: z.string(),
});

/**
 * The oldest job that is due: PENDING (and past any retry delay a transient failure set), or RUNNING with
 * an expired lease. The job's provider, model and prompt version become the ones this worker runs with.
 */
export async function claimListingJob(
  db: Db,
  runner: { readonly provider: LlmProvider; readonly model: string; readonly promptVersion: string },
): Promise<ClaimedJob | null> {
  const { rows } = await db.execute(sql`
    WITH next AS (
      SELECT id, status
      FROM listing_jobs
      WHERE (status = 'PENDING' AND (locked_until IS NULL OR locked_until <= now()))
         OR (status = 'RUNNING' AND locked_until <= now())
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE listing_jobs AS job
    SET status = 'RUNNING',
        locked_until = now() + make_interval(secs => ${LEASE_SECONDS}),
        provider = ${runner.provider},
        model = ${runner.model},
        prompt_version = ${runner.promptVersion}
    FROM next
    WHERE job.id = next.id
    RETURNING job.id, job.created_by, job.image_keys, job.hints, job.attempts, job.usage,
              next.status AS was, job.locked_until::text AS lease`);
  const [row] = parseRows(ClaimRow, rows, 'claimListingJob');
  if (row === undefined) return null;
  return {
    id: row.id,
    createdBy: row.created_by,
    imageKeys: row.image_keys,
    hints: row.hints,
    attempts: row.attempts,
    priorCalls: row.usage ?? [],
    resumed: row.was === 'RUNNING',
    lease: row.lease,
  };
}

const LeaseRow = z.object({ lease: z.string() });

/** The run no longer owns its job: its lease expired and another run claimed it. */
export class LeaseLostError extends ConflictError {
  override name = 'LeaseLostError';
}

function leased(rows: readonly unknown[], statement: string, jobId: string): string {
  const [row] = parseRows(LeaseRow, rows, statement);
  if (row === undefined) throw new LeaseLostError(`listing job ${jobId} is no longer leased by this run`);
  return row.lease;
}

/** Extends the lease by another `LEASE_SECONDS`; returns the new token. */
export async function renewListingLease(db: Db, jobId: string, lease: string): Promise<string> {
  const { rows } = await db.execute(sql`
    UPDATE listing_jobs
    SET locked_until = now() + make_interval(secs => ${LEASE_SECONDS})
    WHERE id = ${jobId} AND status = 'RUNNING' AND locked_until = ${lease}::timestamptz
    RETURNING locked_until::text AS lease`);
  return leased(rows, 'renewListingLease', jobId);
}

/**
 * Bills one model call to the job as soon as it returns, whatever happens to the run afterwards. The model
 * answered, so the job is no longer waiting on an unavailable one.
 */
export async function recordListingCall(
  db: Db,
  jobId: string,
  lease: string,
  call: ListingCall,
): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE listing_jobs
    SET attempts = attempts + 1,
        usage = coalesce(usage, '[]'::jsonb) || jsonb_build_array(${JSON.stringify(call)}::jsonb),
        unavailable_since = NULL
    WHERE id = ${jobId} AND status = 'RUNNING' AND locked_until = ${lease}::timestamptz
    RETURNING locked_until::text AS lease`);
  leased(rows, 'recordListingCall', jobId);
}

export interface JobResult {
  readonly status: Extract<ListingJobStatus, 'READY' | 'NEEDS_REVIEW' | 'FAILED'>;
  readonly draft: ListingWire | null;
  readonly issues: StoredListingIssues;
  readonly costUsd: number | null;
  readonly latencyMs: number | null;
}

/** Ends the run with its outcome and drops the lease. */
export async function finishListingJob(
  db: Db,
  jobId: string,
  lease: string,
  result: JobResult,
): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE listing_jobs
    SET status = ${result.status},
        draft = ${result.draft === null ? null : JSON.stringify(result.draft)}::jsonb,
        issues = ${JSON.stringify(result.issues)}::jsonb,
        cost_usd = ${result.costUsd},
        latency_ms = ${result.latencyMs},
        locked_until = NULL
    WHERE id = ${jobId} AND status = 'RUNNING' AND locked_until = ${lease}::timestamptz
    RETURNING id`);
  if (rows.length === 0) throw new LeaseLostError(`listing job ${jobId} is no longer leased by this run`);
}

const WaitedRow = z.object({ waited_seconds: z.number() });

/**
 * Records that the model was unavailable to the job (rate limits, overload, the network) and returns how
 * long it has been, in seconds: since the first such failure after the job's last answered call. Throws
 * `LeaseLostError` when the run no longer owns the job.
 */
export async function markModelUnavailable(db: Db, jobId: string, lease: string): Promise<number> {
  const { rows } = await db.execute(sql`
    UPDATE listing_jobs SET unavailable_since = coalesce(unavailable_since, now())
    WHERE id = ${jobId} AND status = 'RUNNING' AND locked_until = ${lease}::timestamptz
    RETURNING extract(epoch FROM now() - unavailable_since)::float8 AS waited_seconds`);
  const [row] = parseRows(WaitedRow, rows, 'markModelUnavailable');
  if (row === undefined) throw new LeaseLostError(`listing job ${jobId} is no longer leased by this run`);
  return row.waited_seconds;
}

/**
 * Puts the job back in the queue: at once after a shutdown, after `delaySeconds` when the model was
 * unavailable. Calls already made stay billed and count against the job's three. False when the run no
 * longer owns the job.
 */
export async function releaseListingJob(
  db: Db,
  jobId: string,
  lease: string,
  delaySeconds: number,
): Promise<boolean> {
  const { rows } = await db.execute(sql`
    UPDATE listing_jobs
    SET status = 'PENDING',
        locked_until = CASE WHEN ${delaySeconds} > 0 THEN now() + make_interval(secs => ${delaySeconds}) END
    WHERE id = ${jobId} AND status = 'RUNNING' AND locked_until = ${lease}::timestamptz
    RETURNING id`);
  return rows.length > 0;
}

/** A job row with the slug of the product it became, if approved. */
export type ListingJobRow = typeof listingJobs.$inferSelect & { readonly productSlug: string | null };

export async function getListingJob(db: Db, jobId: string): Promise<ListingJobRow | undefined> {
  const [row] = await db
    .select({ job: listingJobs, productSlug: products.slug })
    .from(listingJobs)
    .leftJoin(products, eq(products.id, listingJobs.productId))
    .where(eq(listingJobs.id, jobId));
  return row === undefined ? undefined : { ...row.job, productSlug: row.productSlug };
}

/** The newest `limit` jobs, newest first, with what a list row shows. */
export async function listListingJobs(db: Db, limit: number) {
  return db
    .select({
      id: listingJobs.id,
      status: listingJobs.status,
      imageKeys: listingJobs.imageKeys,
      draft: listingJobs.draft,
      final: listingJobs.final,
      createdAt: listingJobs.createdAt,
      productSlug: products.slug,
    })
    .from(listingJobs)
    .leftJoin(products, eq(products.id, listingJobs.productId))
    .orderBy(desc(listingJobs.createdAt), desc(listingJobs.id))
    .limit(limit);
}

/** The product an approval publishes; its photos are the job's own. */
export interface ApprovedProduct {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly attributes: ProductAttributesInput;
}

/**
 * Publishes the reviewed listing as a PUBLISHED `llm` product and marks the job APPROVED with its final
 * listing, in one transaction. Throws `NotFoundError`; 409 `CONFLICT` for a job that is not READY or
 * NEEDS_REVIEW (approved already, still running, failed), or for a slug that is taken.
 */
export async function approveListingJob(
  db: Db,
  jobId: string,
  product: ApprovedProduct,
  final: ListingWire,
): Promise<void> {
  await transaction(db, async (tx) => {
    // The job row, never a product or drop row (§3): approving twice at once is decided here.
    const [job] = await tx
      .select({ status: listingJobs.status, imageKeys: listingJobs.imageKeys })
      .from(listingJobs)
      .where(eq(listingJobs.id, jobId))
      .for('update');
    if (job === undefined) throw new NotFoundError('Listing job');
    if (job.status !== 'READY' && job.status !== 'NEEDS_REVIEW') {
      throw new DomainError('CONFLICT', `A ${job.status} listing job cannot be approved`);
    }
    try {
      await tx.insert(products).values({
        ...product,
        imageKeys: job.imageKeys,
        status: 'PUBLISHED',
        source: 'llm',
        listingJobId: jobId,
      });
    } catch (error) {
      if (constraintOf(error) === 'products_slug_key') {
        throw new DomainError('CONFLICT', `The slug ${product.slug} is taken`, { cause: error });
      }
      throw error;
    }
    await tx
      .update(listingJobs)
      .set({ status: 'APPROVED', final, productId: product.id })
      .where(eq(listingJobs.id, jobId));
  });
}
