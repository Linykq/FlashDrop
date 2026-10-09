import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ListingJobView } from '../../../../components/admin/listing-job-view';
import { PageHeader } from '../../../../components/admin/page-header';
import { Skeleton } from '../../../../components/ui/skeleton';
import { readListingJob } from '../../_lib/reads';

export async function generateMetadata({ params }: PageProps<'/admin/listings/[jobId]'>): Promise<Metadata> {
  const job = await readListingJob((await params).jobId);
  return { title: job.final?.title ?? job.draft?.title ?? 'Listing' };
}

/*
 * One listing job (SD §10, design system §10.9): generating, failed, under review or published. Its first
 * state is server-rendered with the admin's session; the page follows the job from there.
 */
export default function ListingJobPage({ params }: PageProps<'/admin/listings/[jobId]'>) {
  return (
    <Suspense
      fallback={
        <div aria-busy="true">
          <PageHeader title="Listing" />
          <Skeleton className="mt-8 h-80 max-w-text rounded-lg" />
        </div>
      }
    >
      <Job params={params} />
    </Suspense>
  );
}

async function Job({ params }: Pick<PageProps<'/admin/listings/[jobId]'>, 'params'>) {
  return <ListingJobView initial={await readListingJob((await params).jobId)} />;
}
