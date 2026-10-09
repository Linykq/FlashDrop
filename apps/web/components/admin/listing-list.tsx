import type { ListingJobStatus, ListingJobSummary } from '@flashdrop/contracts';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { cx } from '../../lib/cx';
import { shortId } from '../../lib/format';
import { ListingJobStatusPill } from '../ui/status-pill';
import { ShortDateTime } from './admin-time';
import { ProductThumb } from './product-thumb';

/** A draft waiting for the admin: the review queue (§10.9) and the sidebar's count. */
export const TO_REVIEW: readonly ListingJobStatus[] = ['READY', 'NEEDS_REVIEW'];

export const isToReview = (job: Pick<ListingJobSummary, 'status'>) => TO_REVIEW.includes(job.status);

/**
 * Listing jobs as a list of rows, each opening its job page, so a draft waiting for review is never lost once
 * its tab is closed. Each row tells its job apart by more than a title the model may give twice: when it was
 * uploaded and the job's short id. Nothing renders for an empty list unless `empty` says what to show.
 */
export function ListingList({
  id,
  title,
  jobs,
  empty,
  className,
}: {
  /** The heading's id, unique on the page. */
  id: string;
  title: string;
  jobs: readonly ListingJobSummary[];
  /** Said in the card when there are no jobs; without it, nothing renders. */
  empty?: string;
  className?: string;
}) {
  if (jobs.length === 0 && empty === undefined) return null;
  return (
    <section aria-labelledby={id} className={cx('max-w-text', className)}>
      <h2 id={id} className="text-title-3">
        {title}
      </h2>
      {jobs.length === 0 ? (
        <p className="mt-4 rounded-lg bg-surface px-4 py-5 text-callout text-label-secondary elevation-1">
          {empty}
        </p>
      ) : (
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
                    <span className="line-clamp-1 font-medium text-label">
                      {job.title ?? 'Untitled draft'}
                    </span>
                    <span className="block text-footnote text-label-secondary">
                      <ShortDateTime iso={job.createdAt} />
                      {' · '}
                      <span className="font-mono">{shortId(job.id)}</span>
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
      )}
    </section>
  );
}
