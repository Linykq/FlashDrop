'use client';

import { uploadPath } from '@flashdrop/contracts';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { cx } from '../../lib/cx';
import type { ShowSegment } from '../../lib/server/show';
import { LiveBadge } from '../commerce/live-badge';
import { LocalTime } from '../commerce/local-time';
import { Price } from '../commerce/price';

type ShowRailProps = {
  segments: readonly ShowSegment[];
  /** The product on screen now (the current cue's id), or `null` before the first cue. */
  onScreen: string | null;
  className?: string;
};

/**
 * "In this show" (design-system §10.3): one tile per product the stream presents, in its order, so a viewer
 * can tell what is on screen and open any of it. The tile on screen carries a 2 px `label` ring and says "On
 * screen" (and `aria-current`, which forced colours draw as an outline). A horizontal scroll-snap rail: its
 * links are the tab stops, and the rail follows the tile on screen sideways unless the viewer is using it.
 */
export function ShowRail({ segments, onScreen, className }: ShowRailProps) {
  const rail = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const list = rail.current;
    const tile = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !tile || list.matches(':hover, :focus-within')) return;
    const left = tile.offsetLeft - list.offsetLeft;
    if (left >= list.scrollLeft && left + tile.offsetWidth <= list.scrollLeft + list.clientWidth) return;
    // Sideways only: the page itself never scrolls for the stream (§13.2).
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ left, behavior: calm ? 'auto' : 'smooth' });
  }, [onScreen]);

  return (
    <section aria-labelledby="show-rail" className={className}>
      <h2 id="show-rail" className="text-title-3">
        In this show
      </h2>
      <ul
        ref={rail}
        className="-mx-1 mt-4 flex snap-x snap-mandatory scroll-px-1 gap-4 overflow-x-auto px-1 pt-1 pb-2"
      >
        {segments.map((segment) => {
          const current = segment.slug === onScreen;
          return (
            <li key={segment.slug} className="w-24 shrink-0 snap-start">
              <Link
                href={segment.href}
                aria-current={current || undefined}
                className="group block rounded-md focus-visible:outline-offset-4"
              >
                <span
                  className={cx(
                    'relative block size-24 overflow-clip rounded-md bg-bg-secondary transition-shadow duration-200 ease-standard',
                    current && 'ring-2 ring-label ring-offset-2 ring-offset-bg',
                  )}
                >
                  {segment.imageKey && (
                    <Image
                      src={uploadPath(segment.imageKey)}
                      alt=""
                      fill
                      sizes="96px"
                      className="object-cover"
                    />
                  )}
                </span>
                <span className="mt-2 line-clamp-2 text-footnote text-label">{segment.title}</span>
                <span className="mt-1 flex min-h-5 items-center text-caption text-label-secondary tabular-nums">
                  <SegmentState segment={segment} current={current} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "On screen", or what the product's own drop is doing: LIVE, when it opens, or its price. */
function SegmentState({ segment, current }: { segment: ShowSegment; current: boolean }) {
  const { drop } = segment;
  if (current) return <span className="font-semibold text-label">On screen</span>;
  if (drop?.status === 'LIVE') return <LiveBadge size="sm" />;
  if (drop?.status === 'SCHEDULED') {
    return (
      <span>
        Opens <LocalTime iso={drop.startsAt} format="at" />
      </span>
    );
  }
  return drop ? <Price cents={drop.priceCents} currency={drop.currency} /> : null;
}
