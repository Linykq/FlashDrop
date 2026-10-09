import type { ListingJobSummary } from '@flashdrop/contracts';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { ListingJobStatusPill } from '../ui/status-pill';
import { ShortDateTime } from './admin-time';
import { ProductThumb } from './product-thumb';

/**
 * The latest listing jobs under the upload form: each opens its job page, so a draft waiting for review is
 * never lost once its tab is closed. Nothing renders before the first job.
 */
export function RecentListings({ jobs }: { jobs: readonly ListingJobSummary[] }) {
  if (jobs.length === 0) return null;
  return (
    <section aria-labelledby="recent-listings" className="mt-14 max-w-text">
      <h2 id="recent-listings" className="text-title-3">
        Recent listings
      </h2>
      <ul className="mt-4 divide-y divide-separator overflow-clip rounded-lg bg-surface elevation-1">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              href={`/admin/listings/${job.id}`}
              className="flex min-h-16 items-center gap-3 px-4 py-2 text-callout transition-colors duration-100 ease-standard hover:bg-fill-quaternary hover:duration-200 active:bg-fill-tertiary"
            >
              <ProductThumb imageKey={job.imageKey} />
              {/* On a phone the status goes under the title, which keeps the room to be read. */}
              <span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-4">
                <span className="block min-w-0 sm:flex-1">
                  <span className="line-clamp-1 font-medium text-label">{job.title ?? 'Untitled draft'}</span>
                  <span className="block text-footnote text-label-secondary">
                    <ShortDateTime iso={job.createdAt} />
                  </span>
                </span>
                <span className="mt-1.5 flex sm:mt-0">
                  <ListingJobStatusPill status={job.status} />
                </span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-label-tertiary" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
