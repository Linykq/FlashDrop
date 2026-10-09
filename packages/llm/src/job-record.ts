import {
  LISTING_FIELDS,
  ListingCall,
  ListingFailure,
  type ListingField,
  ListingIssue,
  type ListingWire,
} from '@flashdrop/contracts';
import { z } from 'zod';

/*
 * The jsonb columns of `listing_jobs` that the worker writes and the api reads (design §3, §10). jsonb is a
 * boundary: both sides parse it with these schemas.
 */

/** `listing_jobs.issues`: what the review must fix, and why a job failed. */
export const StoredListingIssues = z.object({
  fields: z.array(ListingIssue),
  failure: ListingFailure.nullable(),
});
export type StoredListingIssues = z.infer<typeof StoredListingIssues>;

/** `listing_jobs.usage`: one entry per billed model call, in order. */
export const StoredListingCalls = z.array(ListingCall);

const FIELD_VALUE: Readonly<Record<ListingField, (listing: ListingWire) => unknown>> = {
  title: (listing) => listing.title,
  description: (listing) => listing.description,
  highlights: (listing) => listing.highlights,
  category: (listing) => listing.category,
  condition: (listing) => listing.condition,
  brand: (listing) => listing.attributes.brand,
  color: (listing) => listing.attributes.color,
  material: (listing) => listing.attributes.material,
  size: (listing) => listing.attributes.size,
  tags: (listing) => listing.tags,
};

/**
 * The share of a listing's fields the admin changed between the draft and the approved listing: the edit
 * rate quality metric (§10). Null without a draft (nothing was generated to keep).
 */
export function listingEditRate(draft: ListingWire | null, final: ListingWire): number | null {
  if (draft === null) return null;
  const changed = LISTING_FIELDS.filter(
    (field) => JSON.stringify(FIELD_VALUE[field](draft)) !== JSON.stringify(FIELD_VALUE[field](final)),
  );
  return changed.length / LISTING_FIELDS.length;
}
