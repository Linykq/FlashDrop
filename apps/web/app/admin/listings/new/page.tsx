import { ListingJobListResponse } from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ListingList } from '../../../../components/admin/listing-list';
import { ListingUploadForm } from '../../../../components/admin/listing-upload-form';
import { PageHeader } from '../../../../components/admin/page-header';
import { adminRead } from '../../_lib/api';

export const metadata: Metadata = { title: 'New listing' };

/** Recent jobs under the form: the way back to a draft that is still waiting for review. */
const RECENT_LIMIT = 8;

/*
 * The listing generator's start (SD §10, design system §10.9): photos and hints go straight from the browser
 * to api as multipart, because only XMLHttpRequest reports upload progress; the job page takes it from there.
 */
export default function NewListingPage() {
  return (
    <>
      <PageHeader title="New listing">
        <p className="mt-2 max-w-text text-body text-label-secondary">
          Upload 1–4 photos. We draft the listing; you review it before anything is published.
        </p>
      </PageHeader>
      <ListingUploadForm />
      {/* Below the form, and often empty: it streams in without holding a place. */}
      <Suspense fallback={null}>
        <Recent />
      </Suspense>
    </>
  );
}

async function Recent() {
  const { jobs } = await adminRead(
    `/api/v1/admin/listings?limit=${RECENT_LIMIT}`,
    ListingJobListResponse,
    '/admin/listings/new',
  );
  return <ListingList id="recent-listings" title="Recent listings" jobs={jobs} className="mt-14" />;
}
