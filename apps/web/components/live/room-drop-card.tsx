'use client';

import { type DropSummary, uploadPath } from '@flashdrop/contracts';
import { useLayoutEffect, useRef } from 'react';
import type { ViewerClaim } from '../../lib/hold';
import { useLiveStock } from '../../lib/live-stock';
import type { NextDrop } from '../../lib/purchase';
import { toLiveSeed } from '../../lib/stock';
import { useStockAnnouncements } from '../../lib/use-stock-announcements';
import { DropCard, DropCardEmpty } from '../commerce/drop-card';
import { PurchasePanel } from '../commerce/purchase-panel';
import { announce } from '../ui/announcer';

export type RoomPurchase = {
  serverNow: number;
  signedIn: boolean;
  /** The room, to come back to after signing in. */
  returnTo: string;
  /** What the viewer already has of the pinned drop when the page was rendered (§9.13). */
  claim: ViewerClaim;
  /** Where the card points once the pinned drop sells out. */
  next: NextDrop | null;
};

/**
 * The live room's drop card (design-system §9.12): the pinned drop with its live stock and the product page's
 * own reserve flow, or "Nothing on sale right now". When the room pins another drop the card stays in place
 * and its content crossfades over 200 ms (opacity only, so reduced motion keeps it too), focus stays where it
 * was, and the polite region says "Now selling: {title}" (§13.3).
 */
export function RoomDropCard({
  drop,
  onScreen,
  ...purchase
}: RoomPurchase & {
  drop: DropSummary | null;
  /** The stream shows the pinned product right now (its cue), which the status line says. */
  onScreen: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const shown = useRef(drop?.id ?? null);
  const dropId = drop?.id ?? null;
  const title = drop?.product.title ?? null;

  // Before paint, so the new content never flashes in at full opacity first.
  useLayoutEffect(() => {
    if (shown.current === dropId) return;
    shown.current = dropId;
    const element = frame.current;
    if (element) {
      // The token, read where it is defined, so the curve stays the design system's (§6.2).
      const easing = getComputedStyle(element).getPropertyValue('--ease-standard').trim() || 'ease';
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing });
    }
    if (title !== null) announce(`Now selling: ${title}`);
  }, [dropId, title]);

  return (
    <div ref={frame}>
      {drop ? <PinnedDropCard drop={drop} onScreen={onScreen} {...purchase} /> : <DropCardEmpty />}
    </div>
  );
}

function PinnedDropCard({
  drop,
  onScreen,
  serverNow,
  signedIn,
  returnTo,
  claim,
  next,
}: RoomPurchase & { drop: DropSummary; onScreen: boolean }) {
  const { level, paused, quiet } = useLiveStock(drop.id, toLiveSeed(drop.stock, drop.status));
  useStockAnnouncements(level, paused, quiet);
  const photo = drop.product.imageKeys[0];
  return (
    <DropCard
      title={drop.product.title}
      image={photo ? uploadPath(photo) : null}
      priceCents={drop.priceCents}
      currency={drop.currency}
      stock={level}
      perUserLimit={drop.perUserLimit}
      holdSeconds={drop.holdSeconds}
      startsAt={drop.startsAt}
      endsAt={drop.endsAt}
      serverNow={serverNow}
      paused={paused}
      onScreen={onScreen}
    >
      <PurchasePanel
        layout="card"
        dropId={drop.id}
        stock={level}
        perUserLimit={drop.perUserLimit}
        holdSeconds={drop.holdSeconds}
        serverNow={serverNow}
        priceCents={drop.priceCents}
        currency={drop.currency}
        signedIn={signedIn}
        returnTo={returnTo}
        claim={claim}
        next={next}
      />
    </DropCard>
  );
}
