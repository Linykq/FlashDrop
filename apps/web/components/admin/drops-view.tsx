'use client';

import type { AdminDropListing, AdminProductOption, AdminRoom } from '@flashdrop/contracts';
import { ChevronRight, Layers, Plus } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { formatCount, formatMoney } from '../../lib/format';
import { StockMeter } from '../commerce/stock-meter';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { SegmentedControl } from '../ui/segmented-control';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { DropStatusPill } from '../ui/status-pill';
import { SelectField } from '../ui/text-field';
import { DropWindow } from './admin-time';
import { DataTable, Td, Th } from './data-table';
import {
  DROP_FILTER_LABELS,
  DROP_FILTERS,
  type DropFilter,
  EMPTY_FILTER_COPY,
  matchesFilter,
  parseDropFilter,
} from './drop-filter';
import { DropSheet, type DropSheetMode } from './drop-sheet';
import { useLiveStock } from './live';
import { PageHeader } from './page-header';
import { ProductThumb } from './product-thumb';

type DropsViewProps = {
  drops: readonly AdminDropListing[];
  products: readonly AdminProductOption[];
  rooms: readonly AdminRoom[];
  initialFilter: DropFilter;
  /** `?new=<productId>`: the sheet opens with that product chosen. */
  newProductId: string | null;
};

/** Writes the filter and the sheet into the URL without a navigation (Next keeps its router in step). */
function replaceQuery(update: (params: URLSearchParams) => void): void {
  const url = new URL(window.location.href);
  update(url.searchParams);
  window.history.replaceState(window.history.state, '', url);
}

/**
 * The drops list (design system §10.8): large title with "New drop", a filter, and the table. Rows of drops
 * that are selling follow their live stock (SD §7); the rest show the stock of record.
 */
export function DropsView({ drops, products, rooms, initialFilter, newProductId }: DropsViewProps) {
  const id = useId();
  const filterRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<DropFilter>(initialFilter);
  const [sheet, setSheet] = useState<DropSheetMode | null>(
    newProductId ? { kind: 'create', productId: newProductId } : null,
  );
  const visible = drops.filter((drop) => matchesFilter(drop.status, filter));

  function changeFilter(next: DropFilter) {
    setFilter(next);
    replaceQuery((params) => (next === 'all' ? params.delete('status') : params.set('status', next)));
  }

  function showAll() {
    changeFilter('all');
    // The empty state and its button leave with the filter; focus goes to the filter, now on All, rather
    // than falling to the page (WCAG 2.4.3). Whichever of its two forms shows at this width.
    requestAnimationFrame(() => {
      const controls = filterRef.current?.querySelectorAll<HTMLElement>('select, input:checked') ?? [];
      [...controls].find((control) => control.getClientRects().length > 0)?.focus();
    });
  }

  function openSheet() {
    setSheet({ kind: 'create', productId: null });
  }

  function closeSheet() {
    setSheet(null);
    // A reload must not open the sheet again.
    replaceQuery((params) => params.delete('new'));
  }

  return (
    <>
      <PageHeader
        title="Drops"
        actions={
          <Button icon={Plus} onClick={openSheet}>
            New drop
          </Button>
        }
      />
      {drops.length > 0 && (
        // Five equal segments don't fit a phone ("Scheduled" needs about 90 px of its own), and a segmented
        // control that scrolls hides segments: below 735 px the same choice is a native select.
        <div ref={filterRef} className="mt-6 sm:mt-8">
          <SegmentedControl
            legend="Show drops"
            options={DROP_FILTERS.map((value) => ({ value, label: DROP_FILTER_LABELS[value] }))}
            value={filter}
            onChange={changeFilter}
            className="w-max max-sm:hidden"
          />
          <SelectField
            id={`${id}-filter`}
            label="Show"
            value={filter}
            onChange={(event) => changeFilter(parseDropFilter(event.currentTarget.value))}
            className="sm:hidden"
          >
            {DROP_FILTERS.map((value) => (
              <option key={value} value={value}>
                {DROP_FILTER_LABELS[value]}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      <div className="mt-6">
        {drops.length === 0 ? (
          <div className="rounded-lg bg-surface elevation-1">
            <EmptyState
              icon={Layers}
              title="No drops yet"
              description="Create a drop from a published product."
              action={
                <Button variant="tinted" onClick={openSheet}>
                  New drop
                </Button>
              }
            />
          </div>
        ) : visible.length === 0 && filter !== 'all' ? (
          <div className="rounded-lg bg-surface elevation-1">
            <EmptyState
              icon={Layers}
              {...EMPTY_FILTER_COPY[filter]}
              action={
                <Button variant="tinted" onClick={showAll}>
                  Show all
                </Button>
              }
            />
          </div>
        ) : (
          <DropTable drops={visible} caption={`${DROP_FILTER_LABELS[filter]} drops`} />
        )}
      </div>
      <DropSheet mode={sheet} onClose={closeSheet} products={products} rooms={rooms} />
    </>
  );
}

function DropTable({ drops, caption }: { drops: readonly AdminDropListing[]; caption: string }) {
  return (
    <DataTable id="drops" caption={caption}>
      <thead>
        <tr>
          <Th first>Product</Th>
          <Th>Status</Th>
          <Th>Window</Th>
          <Th numeric>Price</Th>
          <Th>Stock</Th>
          <Th numeric>Limit</Th>
          <Th last>
            <span className="sr-only">Open</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {drops.map((drop) => (
          <DropRow key={drop.id} drop={drop} />
        ))}
      </tbody>
    </DataTable>
  );
}

function DropRow({ drop }: { drop: AdminDropListing }) {
  const { total, reserved, sold } = drop.inventory;
  const selling = drop.status === 'LIVE' || drop.status === 'PAUSED';
  // While a drop sells, its Redis level leads (Redis admits, SD §4.3); otherwise the stock of record.
  const { level } = useLiveStock(selling ? drop.id : null, null);
  const stock = level ?? { avail: total - reserved - sold, held: reserved, sold, status: drop.status };
  return (
    <tr>
      <Td first className="sm:min-w-64">
        <Link
          href={`/admin/drops/${drop.id}`}
          className="flex items-center gap-3 rounded-sm py-1 text-label hover:text-label/80"
        >
          <ProductThumb imageKey={drop.product.imageKeys[0]} />
          <span className="min-w-0">
            <span className="line-clamp-2 font-medium">{drop.product.title}</span>
            {/* Capped, so truncation has a width to work against: in an auto-layout cell a long slug would
                otherwise widen the whole column. */}
            <span className="block truncate font-mono text-footnote text-label-secondary sm:max-w-64">
              {drop.product.slug}
            </span>
          </span>
        </Link>
      </Td>
      <Td>
        <DropStatusPill status={stock.status === 'RECONCILING' ? 'RECONCILING' : drop.status} />
      </Td>
      <Td className="whitespace-nowrap">
        <DropWindow startsAt={drop.startsAt} endsAt={drop.endsAt} />
      </Td>
      <Td numeric className="whitespace-nowrap">
        {formatMoney(drop.priceCents, drop.currency, 'exact')}
      </Td>
      <Td className="whitespace-nowrap">
        <span className="flex items-center gap-3">
          {/* A table cell has no width of its own to give: the meter keeps its 64 px (§10.8). */}
          <span className="w-16 shrink-0">
            <StockMeter avail={stock.avail} held={stock.held} sold={stock.sold} size="sm" palette="admin" />
          </span>
          {/* What is left, as the drop page's legend reads it: "0/250" would read as out of stock. */}
          <span className="tabular-nums">
            {formatCount(stock.avail)} left{' '}
            <span className="text-label-secondary">of {formatCount(total)}</span>
          </span>
        </span>
      </Td>
      <Td numeric>{drop.perUserLimit}</Td>
      <Td last className="w-10">
        <ChevronRight size={16} aria-hidden="true" className="text-label-tertiary" />
      </Td>
    </tr>
  );
}

/** The list's exact box while it loads: title row, filter and five skeleton rows (§9.16, §9.22). */
export function DropsSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader title="Drops" />
      <Skeleton className="mt-6 h-14 rounded-md sm:mt-8 sm:h-9 sm:w-100 sm:max-w-full sm:rounded-full" />
      <div aria-hidden="true" className="mt-6 overflow-clip rounded-lg bg-surface elevation-1">
        <div className="h-9 border-separator border-b" />
        {Array.from({ length: 5 }, (_, row) => (
          <div key={row} className="flex h-16 items-center gap-3 border-separator px-4 not-first:border-t">
            <Skeleton className="size-10" />
            <div className="w-56">
              <SkeletonText style="callout" className="w-full" />
              <SkeletonText style="footnote" className="w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
