import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from '@flashdrop/config';
import {
  type ApproveListingBody,
  type ApproveListingResponse,
  type ImageKey,
  type ListingJob,
  type ListingJobSummary,
  ListingWire,
  type ProductAttributesInput,
  SLUG_MAX_LENGTH,
  StoredListingCalls,
  StoredListingIssues,
} from '@flashdrop/contracts';
import {
  approveListingJob,
  type Db,
  getListingJob,
  type ListingJobRow,
  listListingJobs,
  type SubmittedListing,
  submitListingJob,
} from '@flashdrop/db';
import { BugError, NotFoundError } from '@flashdrop/domain';
import { LISTING_PROMPT_VERSION, listingEditRate } from '@flashdrop/llm';

/*
 * The admin side of listing jobs (design §10): the api submits them and approves them, the worker's
 * `listing` role runs them. Every statement of the job state machine is in `@flashdrop/db` (listings.ts);
 * this service hashes the input, maps rows to DTOs and turns a reviewed listing into a product. The upload's
 * photos are already stored under their content keys when a job is submitted.
 */

export interface NewListingUpload {
  readonly createdBy: string;
  readonly imageKeys: readonly ImageKey[];
  readonly hints: string | null;
}

export interface ListingService {
  /** A new PENDING job, or the identical earlier one (same photos, hints and prompt) unless that FAILED. */
  submit(job: NewListingUpload): Promise<SubmittedListing>;
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

function toListingJob(row: ListingJobRow): ListingJob {
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
export function createAdminListings(deps: { readonly db: Db; readonly logger: Logger }): ListingService {
  const { db } = deps;

  const get = async (jobId: string): Promise<ListingJob> => {
    const row = await getListingJob(db, jobId);
    if (row === undefined) throw new NotFoundError('Listing job');
    return toListingJob(row);
  };

  return {
    submit: ({ createdBy, imageKeys, hints }) =>
      submitListingJob(db, {
        createdBy,
        imageKeys,
        hints,
        inputHash: listingInputHash(imageKeys, hints),
        promptVersion: LISTING_PROMPT_VERSION,
      }),

    async list(limit) {
      const rows = await listListingJobs(db, limit);
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
      const attributes: ProductAttributesInput = {
        category: listing.category,
        condition: listing.condition,
        ...listing.attributes,
        highlights: listing.highlights,
        tags: listing.tags,
        photoCredits: [],
      };
      await approveListingJob(
        db,
        jobId,
        {
          id: productId,
          slug: productSlug,
          title: listing.title,
          description: listing.description,
          attributes,
        },
        listing,
      );
      deps.logger.info({ jobId, productId, slug: productSlug }, 'listing approved and published');
      return { job: await get(jobId), product: { id: productId, slug: productSlug } };
    },
  };
}
