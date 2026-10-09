'use client';

import { type ListingJob, ListingJob as ListingJobSchema, type ListingJobStatus } from '@flashdrop/contracts';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';
import { useUserEvents } from '../../lib/realtime/hooks';
import { newDropHref } from '../../lib/routes';
import { announce } from '../ui/announcer';
import { Banner } from '../ui/banner';
import { ButtonLink } from '../ui/button';
import { KeyValueList, type KeyValueRow } from '../ui/key-value-list';
import { ListingJobStatusPill } from '../ui/status-pill';
import { Steps } from '../ui/steps';
import { formatLatency, formatUsdCost } from './format';
import { ListingReview } from './listing-review';
import { PageHeader } from './page-header';
import { IndeterminateProgress } from './progress-bar';
import { usePoll } from './use-poll';

/** design system §10.9: status arrives on the `user` topic, with a 3 s poll as the fallback. */
const POLL_MS = 3_000;

const generating = (status: ListingJobStatus) => status === 'PENDING' || status === 'RUNNING';

/** What each status change says to a screen reader (§13.3: listing job status changes are announced). */
const ANNOUNCEMENTS: Readonly<Partial<Record<ListingJobStatus, string>>> = {
  RUNNING: 'Generating the draft.',
  READY: 'The draft is ready for review.',
  NEEDS_REVIEW: 'The draft is ready. Some fields need attention.',
  FAILED: "We couldn't generate this listing.",
};

const TITLES: Readonly<Record<ListingJobStatus, string>> = {
  PENDING: 'New listing',
  RUNNING: 'New listing',
  READY: 'Review listing',
  NEEDS_REVIEW: 'Review listing',
  FAILED: 'New listing',
  APPROVED: 'Published listing',
};

/**
 * A listing job (SD §10, design system §10.9) from upload to publication: generating, failed, under review,
 * approved. The server renders its first state; while it generates, the page refetches the job whenever the
 * `user` topic says it changed, and every 3 s in case the socket missed it. Each change is announced
 * politely; focus never moves for it (§13.2).
 */
export function ListingJobView({ initial }: { initial: ListingJob }) {
  const [job, setJob] = useState(initial);
  const following = generating(job.status);
  const last = useRef(initial.status);

  const { refresh } = usePoll({
    url: `/api/v1/admin/listings/${initial.id}`,
    schema: ListingJobSchema,
    intervalMs: POLL_MS,
    enabled: following,
    onData: (next) => setJob(next),
  });

  useUserEvents((event) => {
    if (event.type === 'listing' && event.jobId === initial.id) refresh();
  }, following);

  useEffect(() => {
    if (last.current === job.status) return;
    last.current = job.status;
    const text = ANNOUNCEMENTS[job.status];
    if (text) announce(text);
  }, [job.status]);

  const reviewing = job.status === 'READY' || job.status === 'NEEDS_REVIEW';

  return (
    <>
      <PageHeader
        title={job.status === 'APPROVED' ? (job.final?.title ?? TITLES.APPROVED) : TITLES[job.status]}
      >
        <div className="mt-2">
          <ListingJobStatusPill status={job.status} />
        </div>
      </PageHeader>
      {reviewing ? (
        // The photos, the review, then the generation details: secondary metadata comes after the work, so on a
        // phone the form starts in the first screen. From 1069 px the details sit at the foot of the photo
        // column by grid placement (not CSS order: they hold no control, so the focus order is unchanged),
        // and the photo stays in view while the form scrolls: its row takes all the height the details leave.
        <div className="mt-8 grid gap-(--grid-gap) md:grid-cols-12 md:grid-rows-[1fr_auto]">
          <div className="md:col-span-5 md:col-start-1 md:row-start-1">
            <div className="md:sticky md:top-[calc(var(--nav-height)+env(safe-area-inset-top)+--spacing(6))]">
              <PhotoViewer imageKeys={job.imageKeys} />
            </div>
          </div>
          <div className="md:col-span-7 md:col-start-6 md:row-span-2 md:row-start-1">
            <ListingReview job={job} />
          </div>
          <div className="md:col-span-5 md:col-start-1 md:row-start-2">
            <GenerationDetails job={job} />
          </div>
        </div>
      ) : job.status === 'APPROVED' ? (
        <Approved job={job} />
      ) : job.status === 'FAILED' ? (
        <Failed job={job} />
      ) : (
        <Generating job={job} />
      )}
    </>
  );
}

function Thumbnails({ imageKeys, size }: { imageKeys: readonly string[]; size: 'sm' | 'md' }) {
  return (
    <ul className="flex flex-wrap gap-3">
      {imageKeys.map((key, index) => (
        <li
          key={key}
          className={cx(
            'relative overflow-clip rounded-md bg-bg-secondary',
            size === 'sm' ? 'size-16' : 'size-20',
          )}
        >
          <Image
            src={`/uploads/${key}`}
            alt={`Photo ${index + 1} of ${imageKeys.length}`}
            fill
            sizes={size === 'sm' ? '64px' : '80px'}
            className="object-cover"
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * PENDING and RUNNING: the photos, the steps and an indeterminate bar (§9.26, §9.27). This is the page's
 * content, not a placeholder, so it is not `aria-busy`: the progress bar and the current step say it is under
 * way, and the status change is announced.
 */
function Generating({ job }: { job: ListingJob }) {
  const statusId = useId();
  return (
    <section
      aria-labelledby={statusId}
      className="mt-8 max-w-text rounded-lg bg-surface p-5 elevation-1 sm:p-6"
    >
      <Thumbnails imageKeys={job.imageKeys} size="md" />
      <div className="mt-6">
        <Steps
          label="Listing progress"
          steps={[
            { label: 'Uploaded', state: 'done' },
            { label: 'Generating', state: 'running' },
            { label: 'Review', state: 'upcoming' },
          ]}
        />
      </div>
      <IndeterminateProgress labelledBy={statusId} className="mt-6" />
      <p id={statusId} className="mt-3 text-callout text-label-secondary">
        Generating the draft. This usually takes under a minute.
      </p>
    </section>
  );
}

/**
 * FAILED: no steps; what happened and the way to start over (§9.26, §12.2). A refusal's category is the
 * provider's identifier ("general_harms"), said in words.
 */
function Failed({ job }: { job: ListingJob }) {
  const refusal = job.failure?.reason === 'refusal';
  const category = job.failure?.category?.replaceAll('_', ' ');
  return (
    <div className="mt-8 flex max-w-text flex-col gap-6">
      <Banner tone="danger" title="We couldn't generate this listing.">
        {refusal
          ? `The model declined these photos${category ? `, citing ${category}` : ''}. Try different photos.`
          : 'Something went wrong while generating. Start over to try again.'}
      </Banner>
      <Thumbnails imageKeys={job.imageKeys} size="md" />
      <div>
        <ButtonLink href="/admin/listings/new">Start over</ButtonLink>
      </div>
    </div>
  );
}

/** APPROVED: a read-only summary of what was published, and the way to its page (§10.9). */
function Approved({ job }: { job: ListingJob }) {
  const final = job.final;
  const rows: KeyValueRow[] = final
    ? [
        { key: 'Category', value: capitalize(final.category) },
        { key: 'Condition', value: capitalize(final.condition) },
        { key: 'Brand', value: final.attributes.brand },
        { key: 'Color', value: final.attributes.color },
        { key: 'Material', value: final.attributes.material },
        { key: 'Size', value: final.attributes.size },
        { key: 'Tags', value: final.tags.length > 0 ? final.tags.join(', ') : null },
      ]
    : [];
  return (
    // The review's grid, photos on the left, so the photo doesn't change sides when the job is published. The
    // outcome comes first in the DOM, so a phone shows it first.
    <div className="mt-8 grid gap-(--grid-gap) md:grid-cols-12">
      <div className="flex flex-col gap-(--grid-gap) md:col-span-7 md:col-start-6 md:row-start-1">
        <Banner
          tone="success"
          title="Published."
          action={
            <span className="flex flex-wrap gap-x-6 gap-y-2">
              {job.productSlug && (
                <Link
                  href={`/p/${job.productSlug}`}
                  className="inline-flex min-h-6 items-center gap-1 text-callout font-medium text-label underline underline-offset-4"
                >
                  View product page
                  <ArrowUpRight size={14} />
                </Link>
              )}
              {job.productId && (
                <Link
                  href={newDropHref(job.productId)}
                  className="inline-flex min-h-6 items-center gap-1 text-callout font-medium text-label underline underline-offset-4"
                >
                  Create a drop
                  <ChevronRight size={14} />
                </Link>
              )}
            </span>
          }
        >
          Buyers can see it now. It sells once a drop of it opens.
        </Banner>
        {final && (
          <section
            aria-labelledby="published-listing"
            className="rounded-lg bg-surface p-5 elevation-1 sm:p-6"
          >
            {/* The title is the page's own heading already. */}
            <h2 id="published-listing" className="text-headline">
              Listing
            </h2>
            <p className="mt-2 whitespace-pre-line text-callout text-label-secondary">{final.description}</p>
            <ul className="mt-4 list-disc pl-5 text-callout">
              {final.highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
            <KeyValueList className="mt-4" rows={rows} />
          </section>
        )}
      </div>
      <div className="flex flex-col gap-(--grid-gap) md:col-span-5 md:col-start-1 md:row-start-1">
        <PhotoViewer imageKeys={job.imageKeys} />
        <GenerationDetails job={job} />
      </div>
    </div>
  );
}

const capitalize = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

/**
 * The photos under review (§10.9, §11.3): one at a time, whole (`object-contain`) on `bg-secondary`, with
 * 64 px thumbnails that choose which. The well is square, which suits portrait and landscape uploads alike
 * (a 4:5 well left landscape photos floating in wide bands), and on a phone a 256 px band, so the form
 * starts within the first screen.
 */
function PhotoViewer({ imageKeys }: { imageKeys: readonly string[] }) {
  const [shown, setShown] = useState(0);
  const key = imageKeys[shown] ?? imageKeys[0];
  return (
    <div>
      <div className="relative aspect-square overflow-clip rounded-lg bg-bg-secondary elevation-1 max-md:aspect-auto max-md:h-64">
        {key && (
          <Image
            src={`/uploads/${key}`}
            alt={`Photo ${shown + 1} of ${imageKeys.length}`}
            fill
            sizes="(min-width: 1069px) 480px, 100vw"
            // The page's largest image, above the fold: fetched at once, not lazily.
            loading="eager"
            className="object-contain"
          />
        )}
      </div>
      {imageKeys.length > 1 && (
        <ul aria-label="Photos" className="mt-3 flex gap-3">
          {imageKeys.map((imageKey, index) => (
            <li key={imageKey}>
              <button
                type="button"
                aria-label={`Show photo ${index + 1} of ${imageKeys.length}`}
                aria-pressed={index === shown}
                onClick={() => setShown(index)}
                className={cx(
                  'relative block size-16 overflow-clip rounded-sm bg-bg-secondary',
                  'transition-opacity duration-200 ease-standard',
                  index === shown
                    ? 'ring-2 ring-label ring-offset-2 ring-offset-canvas'
                    : 'opacity-70 hover:opacity-100',
                )}
              >
                <Image src={`/uploads/${imageKey}`} alt="" fill sizes="64px" className="object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What the generation cost (SD §10 metrics per job): model, prompt, calls, tokens, cost, latency, edits. A job
 * answered from recorded fixtures (`LLM_PROVIDER=fixture`, the default outside a real key) says so, and its cost
 * is the recording's, not a bill: nobody reading it should believe a model call was paid for.
 */
function GenerationDetails({ job }: { job: ListingJob }) {
  const recorded = job.provider !== null && job.provider !== 'anthropic';
  const tokensIn = job.calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const tokensOut = job.calls.reduce((sum, call) => sum + call.outputTokens, 0);
  const cached = job.calls.reduce((sum, call) => sum + call.cacheReadInputTokens, 0);
  // A server-side fallback answers under another model: every model that answered is listed.
  const models = [...new Set(job.calls.map((call) => call.model))];
  const rows: KeyValueRow[] = [
    // Technical values are mono (§3.1); with tabular figures Inter would space their hyphens out.
    {
      key: 'Model',
      value: (
        <>
          {recorded && 'Recorded fixture ('}
          <span className="font-mono text-footnote">{models.length > 0 ? models.join(', ') : job.model}</span>
          {recorded && ')'}
        </>
      ),
    },
    {
      key: 'Prompt',
      value: (
        <>
          <span className="font-mono text-footnote">{job.promptVersion}</span>
          {` · ${formatCount(job.attempts)} ${job.attempts === 1 ? 'attempt' : 'attempts'}`}
        </>
      ),
    },
    {
      key: 'Tokens',
      value:
        job.calls.length === 0
          ? null
          : `${formatCount(tokensIn)} in · ${formatCount(tokensOut)} out${cached > 0 ? ` · ${formatCount(cached)} cached` : ''}`,
    },
    {
      key: 'Cost',
      value:
        job.costUsd === null
          ? null
          : [
              recorded ? `${formatUsdCost(job.costUsd)} recorded · not billed` : formatUsdCost(job.costUsd),
              job.latencyMs === null ? null : formatLatency(job.latencyMs),
            ]
              .filter(Boolean)
              .join(' · '),
    },
    {
      key: 'Edited',
      value: job.editRate === null ? null : `${Math.round(job.editRate * 100)}% of fields`,
    },
  ];
  return (
    <section aria-labelledby="generation-details" className="rounded-lg bg-surface p-5 elevation-1">
      <h2 id="generation-details" className="text-headline">
        Generation details
      </h2>
      <KeyValueList className="mt-1 [&_dd]:tabular-nums" rows={rows} />
    </section>
  );
}
