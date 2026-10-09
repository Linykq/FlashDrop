import { ListingJobListResponse } from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { isToReview, ListingList } from '../../../components/admin/listing-list';
import { PageHeader } from '../../../components/admin/page-header';
import { ButtonLink } from '../../../components/ui/button';
import { Skeleton, SkeletonText } from '../../../components/ui/skeleton';
import { adminRead } from '../_lib/api';

export const metadata: Metadata = { title: 'Listings' };

/** api lists at most this many jobs, newest first. */
const LIMIT = 100;

/*
 * The listing generator's queue (SD §10, design system §10.9): drafts waiting for review first, the way back
 * to every draft once its tab is closed, then everything else, newest first. Reads per request: a draft
 * becomes ready while the admin looks elsewhere.
 */
export default function ListingsPage() {
  return (
    <>
      <PageHeader
        title="Listings"
        actions={
          <ButtonLink href="/admin/listings/new" size="adaptive">
            New listing
          </ButtonLink>
        }
      />
      <Suspense fallback={<ListingsSkeleton />}>
        <Listings />
      </Suspense>
    </>
  );
}

async function Listings() {
  const { jobs } = await adminRead(
    `/api/v1/admin/listings?limit=${LIMIT}`,
    ListingJobListResponse,
    '/admin/listings',
  );
  return (
    <div className="mt-8 flex flex-col gap-12">
      <ListingList
        id="to-review"
        title="To review"
        jobs={jobs.filter(isToReview)}
        empty="Nothing to review. Drafts that need you show up here."
      />
      <ListingList id="all-listings" title="Everything else" jobs={jobs.filter((job) => !isToReview(job))} />
    </div>
  );
}

function ListingsSkeleton() {
  return (
    <div aria-busy="true" className="mt-8 max-w-text">
      <div aria-hidden="true">
        <SkeletonText style="title-3" className="w-32" />
        <Skeleton className="mt-4 h-48 rounded-lg" />
      </div>
    </div>
  );
}
