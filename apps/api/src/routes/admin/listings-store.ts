import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from '@flashdrop/config';
import {
  type ApproveListingBody,
  type ApproveListingResponse,
  type ImageKey,
  type ListingJob,
  type ListingJobStatus,
  type ListingJobSummary,
  ListingWire,
  type ProductAttributesInput,
  SLUG_MAX_LENGTH,
} from '@flashdrop/contracts';
import {
  and,
  constraintOf,
  type Db,
  desc,
  eq,
  listingJobs,
  ne,
  products,
  sql,
  transaction,
} from '@flashdrop/db';
import { BugError, DomainError, NotFoundError } from '@flashdrop/domain';
import {
  LISTING_PROMPT_VERSION,
  listingEditRate,
  StoredListingCalls,
  StoredListingIssues,
} from '@flashdrop/llm';

/*
 * Listing jobs in Postgres (design §10): the api creates them and approves them, the worker's `listing`
 * role runs them. The upload's photos are already stored under their content keys when a job is submitted.
 */

export interface NewListingJob {
  readonly createdBy: string;
  readonly imageKeys: readonly ImageKey[];
  readonly hints: string | null;
}

export interface SubmittedListing {
  readonly jobId: string;
  readonly status: ListingJobStatus;
  /** An identical earlier upload's job was returned instead of a new one. */
  readonly reused: boolean;
}

export interface ListingService {
  /** A new PENDING job, or the identical earlier one (same photos, hints and prompt) unless that FAILED. */
  submit(job: NewListingJob): Promise<SubmittedListing>;
  /** Newest first. */
  list(limit: number): Promise<ListingJobSummary[]>;
  /** 404 `NOT_FOUND` for an unknown job. */
  get(jobId: string): Promise<ListingJob>;
  /**
   * Publishes the reviewed listing as a product and marks the job APPROVED: 404 for an unknown job,
   * 409 `CONFLICT` for one that is not READY or NEEDS_REVIEW, or for a slug that is taken.
   */
  approve(jobId: string, body: ApproveListingBody): Promise<ApproveListingResponse>;
}

/**
 * sha256 over the photos' content hashes, the hints and the prompt version (§10), length-prefixed by JSON
 * so no two inputs share an encoding. Photo order counts: the first is the hero.
 */
export function listingInputHash(imageKeys: readonly ImageKey[], hints: string | null): Buffer {
  return createHash('sha256')
    .update(JSON.stringify([imageKeys, hints, LISTING_PROMPT_VERSION]))
    .digest();
}

/** `Ribbed Ivory Vase` -> `ribbed-ivory-vase-1a2b3c`; the suffix (from the product id) keeps it unique. */
export function listingSlug(title: string, productId: string): string {
  const suffix = productId.replaceAll('-', '').slice(0, 6);
  const base = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH - suffix.length - 1)
    .replace(/-+$/, '');
  return `${base === '' ? 'product' : base}-${suffix}`;
}

const NullableWire = ListingWire.nullable();

type JobRow = typeof listingJobs.$inferSelect & { readonly productSlug: string | null };

function toListingJob(row: JobRow): ListingJob {
  const draft = NullableWire.parse(row.draft);
  const final = NullableWire.parse(row.final);
  const issues = row.issues === null ? null : StoredListingIssues.parse(row.issues);
  return {
    id: row.id,
    status: row.status,
    imageKeys: row.imageKeys,
    hints: row.hints,
    createdAt: row.createdAt.toISOString(),
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    attempts: row.attempts,
    draft,
    final,
    issues: issues?.fields ?? [],
    failure: issues?.failure ?? null,
    calls: StoredListingCalls.parse(row.usage ?? []),
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    latencyMs: row.latencyMs,
    productId: row.productId,
    productSlug: row.productSlug,
    editRate: final === null ? null : listingEditRate(draft, final),
  };
}

/**
 * Approving revalidates nothing itself: the product is new, so no cached page can hold it yet (`web` caches
 * a miss untagged, for seconds), and the admin's Server Action calls `updateTag('product:' + id)` for
 * read-your-writes (§8.1, §10).
 */
export function createPostgresListings(deps: { readonly db: Db; readonly logger: Logger }): ListingService {
  const { db } = deps;

  const get = async (jobId: string): Promise<ListingJob> => {
    const [row] = await db
      .select({ job: listingJobs, productSlug: products.slug })
      .from(listingJobs)
      .leftJoin(products, eq(products.id, listingJobs.productId))
      .where(eq(listingJobs.id, jobId));
    if (row === undefined) throw new NotFoundError('Listing job');
    return toListingJob({ ...row.job, productSlug: row.productSlug });
  };

  return {
    submit: ({ createdBy, imageKeys, hints }) => {
      const inputHash = listingInputHash(imageKeys, hints);
      return transaction(db, async (tx) => {
        // Serializes identical uploads (a double click, two admins with the same photos): one job, one bill.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fd.listing.${inputHash.toString('hex')}`}, 0))`,
        );
        const [earlier] = await tx
          .select({ id: listingJobs.id, status: listingJobs.status })
          .from(listingJobs)
          .where(and(eq(listingJobs.inputHash, inputHash), ne(listingJobs.status, 'FAILED')))
          .orderBy(desc(listingJobs.createdAt))
          .limit(1);
        if (earlier !== undefined) return { jobId: earlier.id, status: earlier.status, reused: true };
        const id = randomUUID();
        await tx.insert(listingJobs).values({
          id,
          createdBy,
          status: 'PENDING',
          imageKeys: [...imageKeys],
          hints,
          inputHash,
          promptVersion: LISTING_PROMPT_VERSION,
        });
        return { jobId: id, status: 'PENDING', reused: false };
      });
    },

    async list(limit) {
      const rows = await db
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
      return rows.map((row): ListingJobSummary => {
        const listing = NullableWire.parse(row.final) ?? NullableWire.parse(row.draft);
        const [imageKey] = row.imageKeys;
        if (imageKey === undefined) throw new BugError(`listing job ${row.id} has no photos`);
        return {
          id: row.id,
          status: row.status,
          imageKey,
          title: listing?.title ?? null,
          createdAt: row.createdAt.toISOString(),
          productSlug: row.productSlug,
        };
      });
    },

    get,

    async approve(jobId, { listing, slug }) {
      const productId = randomUUID();
      const productSlug = slug ?? listingSlug(listing.title, productId);
      await transaction(db, async (tx) => {
        // A job row, never a product or drop row (§3): approving twice at once is decided here.
        const [job] = await tx
          .select({ status: listingJobs.status, imageKeys: listingJobs.imageKeys })
          .from(listingJobs)
          .where(eq(listingJobs.id, jobId))
          .for('update');
        if (job === undefined) throw new NotFoundError('Listing job');
        if (job.status !== 'READY' && job.status !== 'NEEDS_REVIEW') {
          throw new DomainError('CONFLICT', `A ${job.status} listing job cannot be approved`);
        }
        const { attributes } = listing;
        const productAttributes: ProductAttributesInput = {
          category: listing.category,
          condition: listing.condition,
          ...attributes,
          highlights: listing.highlights,
          tags: listing.tags,
          photoCredits: [],
        };
        try {
          await tx.insert(products).values({
            id: productId,
            slug: productSlug,
            title: listing.title,
            description: listing.description,
            attributes: productAttributes,
            imageKeys: job.imageKeys,
            status: 'PUBLISHED',
            source: 'llm',
            listingJobId: jobId,
          });
        } catch (error) {
          if (constraintOf(error) === 'products_slug_key') {
            throw new DomainError('CONFLICT', `The slug ${productSlug} is taken`, { cause: error });
          }
          throw error;
        }
        await tx
          .update(listingJobs)
          .set({ status: 'APPROVED', final: listing, productId })
          .where(eq(listingJobs.id, jobId));
      });
      deps.logger.info({ jobId, productId, slug: productSlug }, 'listing approved and published');
      return { job: await get(jobId), product: { id: productId, slug: productSlug } };
    },
  };
}
