import Image, { type StaticImageData } from 'next/image';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { formatCount, formatDuration } from '../../lib/format';
import type { StockState } from '../../lib/stock';
import { DropStatusPill } from '../ui/status-pill';
import { TitleText } from '../ui/title-text';
import { Countdown } from './countdown';
import { LiveBadge } from './live-badge';
import { Price } from './price';
import { StockText } from './stock-text';

type DropCardProps = {
  title: string;
  /** A same-origin `/uploads/<key>` path, or a static import. */
  image: string | StaticImageData;
  priceCents: number;
  currency: string;
  stock: StockState;
  perUserLimit: number;
  holdSeconds: number;
  startsAt: string;
  endsAt: string;
  serverNow: number;
  /** The purchase row: the lg quantity stepper and the lg Buy button, 12 px apart. */
  children: ReactNode;
  className?: string;
};

const cardClass = 'rounded-lg bg-surface p-5 elevation-1 sm:p-6';

/**
 * The purchase unit beside live video and in the home hero (§9.12): product, live stock, the purchase row and
 * the terms, in one card.
 */
export function DropCard({
  title,
  image,
  priceCents,
  currency,
  stock,
  perUserLimit,
  holdSeconds,
  startsAt,
  endsAt,
  serverNow,
  children,
  className,
}: DropCardProps) {
  return (
    <section aria-label={title} className={cx(cardClass, className)}>
      <div className="flex gap-4">
        <div className="relative size-18 shrink-0 overflow-clip rounded-md bg-bg-secondary">
          <Image src={image} alt="" fill sizes="72px" className="object-cover" />
        </div>
        <div className="min-w-0">
          <div className="flex min-h-6 items-center gap-2 text-footnote text-label-secondary">
            {stock.status === 'LIVE' ? (
              <>
                <LiveBadge />
                <Countdown target={endsAt} serverNow={serverNow} verb="Ends" />
              </>
            ) : (
              <DropStatusPill status={stock.status} />
            )}
          </div>
          <h2 className="mt-1 line-clamp-2 text-title-3">
            <TitleText text={title} />
          </h2>
          <p className="mt-0.5">
            <Price cents={priceCents} currency={currency} />
          </p>
        </div>
      </div>
      <StockText className="mt-5" stock={stock} startsAt={startsAt} serverNow={serverNow} meter="sm" />
      <div className="mt-4 flex items-center gap-3">{children}</div>
      <p className="mt-3 text-footnote text-label-secondary">
        Limit {formatCount(perUserLimit)} per person · Held {formatDuration(holdSeconds)} at checkout
      </p>
    </section>
  );
}

/** The card while the room has no pinned drop: same frame, no product, stock or button (§9.12). */
export function DropCardEmpty({ className }: { className?: string }) {
  return (
    <section
      aria-label="Nothing on sale"
      className={cx(cardClass, 'flex min-h-74 flex-col items-center justify-center text-center', className)}
    >
      <h2 className="text-title-3">Nothing on sale right now</h2>
      <p className="mt-2 text-callout text-label-secondary">The next drop appears here when it's pinned.</p>
    </section>
  );
}
