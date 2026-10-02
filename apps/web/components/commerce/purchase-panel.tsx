'use client';

import { type RefObject, useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { formatCount, formatDuration } from '../../lib/format';
import { buyAction, maxQuantity } from '../../lib/purchase';
import { describeStock, type StockState } from '../../lib/stock';
import { useMediaQuery } from '../../lib/use-media-query';
import { QuantityStepper } from '../ui/quantity-stepper';
import { BuyButton } from './buy-button';
import { Price } from './price';

type PurchasePanelProps = {
  stock: StockState;
  perUserLimit: number;
  holdSeconds: number;
  startsAt: string;
  serverNow: number;
  priceCents: number;
  currency: string;
  signedIn: boolean;
  /** This product page, to come back to after signing in. */
  returnTo: string;
};

/**
 * The purchase row of the product page (§10.2): the quantity stepper and the Buy button, the terms under
 * them, and on phones the sticky buy bar that takes over while the row is not wholly on screen, so an
 * available purchase action is always reachable without scrolling (§1.1). Renders nothing once the drop
 * ended.
 */
export function PurchasePanel({
  stock,
  perUserLimit,
  holdSeconds,
  startsAt,
  serverNow,
  priceCents,
  currency,
  signedIn,
  returnTo,
}: PurchasePanelProps) {
  const action = buyAction(stock, signedIn);
  const max = maxQuantity(stock, perUserLimit);
  const [quantity, setQuantity] = useState(1);
  const row = useRef<HTMLDivElement>(null);
  const rowInView = useWhollyInView(row);
  const phone = useMediaQuery('(width < 735px)');

  if (action.kind === 'hidden') return null;
  // Only beside the button that reserves the chosen quantity: signed out, the choice would be lost on the way
  // through sign-in.
  const choosing = action.kind === 'buy';
  // The bar keeps an available action within reach; a closed state has none, so it never pins a dead button.
  // TODO(M2): `buy` as well, once the Buy button reserves.
  const actionable = action.kind === 'sign-in';
  const barShown = !rowInView;
  const buy = { action, startsAt, serverNow, returnTo };

  return (
    <>
      {/* A label longer than the room beside the stepper wraps the button onto its own full-width line. */}
      <div ref={row} className="mt-6 flex flex-wrap items-center gap-3">
        {choosing && (
          <QuantityStepper value={Math.min(quantity, max)} max={max} size="lg" onChange={setQuantity} />
        )}
        <BuyButton {...buy} className="min-w-fit flex-1" />
      </div>
      {/* One footnote under the row, so there is one rhythm below the button. */}
      <p className="mt-3 text-footnote text-label-secondary">
        {/* TODO(M2): goes when the Buy button reserves. */}
        {action.kind === 'buy' && (
          <>
            Reservations aren't open on this page yet.
            <br />
          </>
        )}
        Limit {formatCount(perUserLimit)} per person. We hold your item for {formatDuration(holdSeconds)} at
        checkout.
      </p>
      {phone && actionable && (
        // Mounted while there is an action to keep in reach, so it fades both ways as the row leaves and
        // returns (200 ms, §6.4). `data-bottom-bar` is present only while it shows: base.css then reserves its
        // height below the page and in the scroll padding (§4.5).
        <div
          data-bottom-bar={barShown || undefined}
          inert={!barShown}
          className={cx(
            'material-bar fixed inset-x-0 bottom-0 z-(--z-sticky) border-separator border-t pb-[env(safe-area-inset-bottom)]',
            'transition-[opacity,visibility] duration-200',
            barShown ? 'visible opacity-100 ease-out' : 'invisible opacity-0 ease-in',
          )}
        >
          <div className="page-wide flex h-18 items-center justify-between gap-4">
            {/* Everything on the material is `label`: "Only" carries urgency, never colour (§2.5, §9.9). */}
            <div className="min-w-0 text-label">
              <p className="text-headline">
                <Price cents={priceCents} currency={currency} />
              </p>
              <p className="text-footnote tabular-nums">{describeStock(stock).primary}</p>
            </div>
            <BuyButton {...buy} size="md" />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Whether the whole element is on screen below the navigation bar; `true` until measured, so SSR shows no
 * bar. A row that is cut by the bottom edge, or slides under the translucent bar, doesn't count: the buyer
 * can't use it there, so the buy bar stays (§1.1).
 */
function useWhollyInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The bar's height includes the top safe area, which a CSS length in `rootMargin` can't express.
    const top = document.querySelector('[data-nav-bar]')?.getBoundingClientRect().height ?? 0;
    const observer = new IntersectionObserver(
      // 0.99, not 1: subpixel layout can leave a fully visible row a hair short of a ratio of exactly 1.
      ([entry]) => setInView((entry?.intersectionRatio ?? 1) >= 0.99),
      { rootMargin: `-${Math.round(top)}px 0px 0px 0px`, threshold: [0, 0.99, 1] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}
