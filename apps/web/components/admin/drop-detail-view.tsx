'use client';

import type { AdminDropListing, AdminProductOption, AdminRoom, StockLevel } from '@flashdrop/contracts';
import { ArrowUpRight, ChevronRight, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { focusPageStart } from '../../lib/focus';
import { formatCount, formatDuration, formatMoney, shortId } from '../../lib/format';
import { Banner } from '../ui/banner';
import { Button } from '../ui/button';
import { CopyId } from '../ui/copy-id';
import { KeyValueList } from '../ui/key-value-list';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { DropStatusPill } from '../ui/status-pill';
import { TitleText } from '../ui/title-text';
import { AdminTime, DropWindow } from './admin-time';
import { DropActions } from './drop-actions';
import { DropSheet, type DropSheetMode } from './drop-sheet';
import { useLiveStock } from './live';
import { PageHeader } from './page-header';
import type { ActionFailure } from './problem-copy';
import { ProductThumb } from './product-thumb';
import { StockSummary } from './stock-summary';

type DropDetailViewProps = {
  drop: AdminDropListing;
  /** The live Redis level at render time; `null` for a draft or while the drop is being rebuilt. */
  stock: StockLevel | null;
  /** The sheet's choices, for editing a draft. */
  products: readonly AdminProductOption[];
  rooms: readonly AdminRoom[];
};

/** Refusals that mean the page shows an outdated drop (§12.2 "Refresh to see its current state"). */
const STALE: readonly string[] = ['DROP_ARMED', 'CONFLICT', 'NOT_FOUND'];

const cardClass = 'rounded-lg bg-surface p-5 elevation-1 sm:p-6';

/**
 * One drop (design system §10.8): the title row with its status and the actions its status allows, then live
 * stock and settings beside the links that leave the page. The status shown is Postgres's, the drop's record;
 * the stock is Redis's while the drop is armed, since Redis admits every reservation (SD §4.3).
 */
export function DropDetailView({ drop, stock, products, rooms }: DropDetailViewProps) {
  const [sheet, setSheet] = useState<DropSheetMode | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const router = useRouter();
  const armed = drop.status !== 'DRAFT';
  const selling = drop.status === 'LIVE' || drop.status === 'PAUSED';
  const live = useLiveStock(armed ? drop.id : null, stock);
  const rebuilding = live.level?.status === 'RECONCILING';

  // The banner leaves with the button pressed in it, Dismiss or Refresh: focus goes back to the header's
  // actions rather than falling to the page (WCAG 2.4.3). A click commits before the next frame.
  function closeFailure() {
    setFailure(null);
    requestAnimationFrame(focusPageStart);
  }

  return (
    <>
      <PageHeader
        leading={<ProductThumb imageKey={drop.product.imageKeys[0]} size="md" />}
        title={<TitleText text={drop.product.title} />}
        actions={
          <DropActions
            drop={drop}
            onEdit={() => setSheet({ kind: 'edit', drop })}
            onRunAgain={() => setSheet({ kind: 'copy', drop })}
            onFailure={setFailure}
          />
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-footnote text-label-secondary">
          <DropStatusPill status={rebuilding ? 'RECONCILING' : drop.status} />
          <DropWindow startsAt={drop.startsAt} endsAt={drop.endsAt} />
          {/* While it sells, the dashboard is where the admin is headed: up here, not under Settings. */}
          {selling && (
            <Link
              href={`/admin/dashboard/${drop.id}`}
              className="-my-3 inline-flex min-h-11 items-center gap-1 text-accent-label"
            >
              Open dashboard
              <ChevronRight size={14} />
            </Link>
          )}
        </div>
      </PageHeader>
      {failure && (
        // The admin's own action was refused and focus stays where it was, so this is an alert (§9.15): a
        // warning for a conflict that waiting or refreshing resolves, danger for anything else.
        <Banner
          tone={['DROP_ARMED', 'DROP_BUSY', 'CONFLICT'].includes(failure.code) ? 'warning' : 'danger'}
          alert
          onDismiss={() => closeFailure()}
          action={
            // The drop changed under the page: the way to its current state is one press away.
            STALE.includes(failure.code) && (
              <Button
                variant="plain"
                size="sm"
                onClick={() => {
                  closeFailure();
                  router.refresh();
                }}
                className="-ml-3"
              >
                Refresh
              </Button>
            )
          }
          className="mt-6 animate-fade-in"
        >
          {failure.message}
        </Banner>
      )}
      <div className="mt-8 grid gap-(--grid-gap) md:grid-cols-12">
        <div className="flex flex-col gap-(--grid-gap) md:col-span-8">
          <StockCard drop={drop} level={live.level} paused={live.paused} />
          <section aria-labelledby="drop-settings" className={cardClass}>
            <h2 id="drop-settings" className="text-headline">
              Settings
            </h2>
            <KeyValueList className="mt-2" rows={settingsRows(drop)} />
          </section>
        </div>
        <nav aria-labelledby="drop-links" className={`${cardClass} self-start md:col-span-4`}>
          <h2 id="drop-links" className="text-headline">
            Links
          </h2>
          <ul className="mt-2 divide-y divide-separator text-callout">
            <LinkRow href={`/p/${drop.product.slug}`} label="View product page" leaves />
            {drop.room && <LinkRow href={`/live/${drop.room.slug}`} label="Open live room" leaves />}
            {armed && <LinkRow href={`/admin/dashboard/${drop.id}`} label="Open dashboard" />}
          </ul>
        </nav>
      </div>
      <DropSheet mode={sheet} onClose={() => setSheet(null)} products={products} rooms={rooms} />
    </>
  );
}

function settingsRows(drop: AdminDropListing) {
  return [
    { key: 'Price', value: formatMoney(drop.priceCents, drop.currency, 'exact') },
    { key: 'Total units', value: formatCount(drop.inventory.total) },
    { key: 'Limit per person', value: String(drop.perUserLimit) },
    { key: 'Hold at checkout', value: formatDuration(drop.holdSeconds) },
    { key: 'Payment window', value: formatDuration(drop.paymentSeconds) },
    { key: 'Starts', value: <AdminTime iso={drop.startsAt} /> },
    { key: 'Ends', value: <AdminTime iso={drop.endsAt} /> },
    { key: 'Live room', value: drop.room?.title ?? 'None' },
    // Shortened as an order id is (§10.5): the full UUID wrapped mid-string in a narrow card.
    {
      key: 'Drop id',
      value: (
        <span title={drop.id} className="inline-flex items-center gap-2 font-mono text-footnote">
          {shortId(drop.id)}
          <CopyId id={drop.id} noun="drop" />
        </span>
      ),
    },
    // The generation of the drop's Redis state (SD §4.7): every rebuild bumps it.
    { key: 'Redis generation', value: drop.status === 'DRAFT' ? null : String(drop.inventory.redisGen) },
  ];
}

function LinkRow({ href, label, leaves = false }: { href: string; label: string; leaves?: boolean }) {
  const Icon = leaves ? ArrowUpRight : ChevronRight;
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-11 items-center justify-between gap-4 rounded-sm text-accent-label hover:underline hover:underline-offset-4"
      >
        {label}
        <Icon size={14} className="shrink-0" />
      </Link>
    </li>
  );
}

/**
 * Live stock (design system §10.8): the lg meter with a legend of every number. A draft has no live stock
 * yet; its card says so and shows what it will sell. An ended drop's card is its final stock.
 */
function StockCard({
  drop,
  level,
  paused,
}: {
  drop: AdminDropListing;
  level: StockLevel | null;
  paused: boolean;
}) {
  const { total, reserved, sold } = drop.inventory;
  const stock = level ?? { avail: total - reserved - sold, held: reserved, sold };
  const ended = drop.status === 'ENDED';
  return (
    <section aria-labelledby="drop-stock" className={cardClass}>
      <div className="flex items-center justify-between gap-4">
        <h2 id="drop-stock" className="text-headline">
          {ended ? 'Final stock' : 'Live stock'}
        </h2>
        {paused && drop.status !== 'DRAFT' && !ended && (
          <p className="inline-flex items-center gap-1.5 text-footnote text-label-secondary">
            <WifiOff size={16} />
            Live updates paused
          </p>
        )}
      </div>
      {drop.status === 'DRAFT' ? (
        <p className="mt-2 text-callout text-label-secondary">
          Live stock starts when you arm the drop. It will sell {formatCount(total)} units.
        </p>
      ) : (
        <StockSummary avail={stock.avail} held={stock.held} sold={stock.sold} total={total} ended={ended} />
      )}
    </section>
  );
}

/** The page's exact box while the drop loads (§9.16). */
export function DropDetailSkeleton() {
  return (
    <div aria-busy="true">
      <div aria-hidden="true" className="flex items-center gap-4 pt-8 sm:pt-12">
        <Skeleton className="size-14 rounded-md" />
        <div className="w-80 max-w-full">
          <SkeletonText style="title-1" />
          <SkeletonText style="footnote" className="mt-2 w-1/2" />
        </div>
      </div>
      <div aria-hidden="true" className="mt-8 grid gap-(--grid-gap) md:grid-cols-12">
        <div className="flex flex-col gap-(--grid-gap) md:col-span-8">
          <Skeleton className="h-44 rounded-lg" />
          <Skeleton className="h-112 rounded-lg" />
        </div>
        <Skeleton className="h-40 rounded-lg md:col-span-4" />
      </div>
    </div>
  );
}
