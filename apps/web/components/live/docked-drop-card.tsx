'use client';

import { type DropSummary, uploadPath } from '@flashdrop/contracts';
import Image from 'next/image';
import { useEffect, useEffectEvent, useId } from 'react';
import { useLiveStock } from '../../lib/live-stock';
import { buyAction, purchaseRow } from '../../lib/purchase';
import { reserveNote } from '../../lib/reserve-copy';
import { checkoutHref, ORDERS_HREF, orderPageHref } from '../../lib/routes';
import { describeStock, toLiveSeed } from '../../lib/stock';
import { useReserve } from '../../lib/use-reserve';
import { BuyButton } from '../commerce/buy-button';
import { Countdown } from '../commerce/countdown';
import { announce } from '../ui/announcer';
import { ButtonLink } from '../ui/button';
import type { RoomPurchase } from './room-drop-card';

/**
 * The drop card docked over the fullscreen player (design-system §9.12): 320 px of `material-overlay` with the
 * thumbnail, the title, the stock's primary line and an md Buy that runs the same reserve flow, one unit at a
 * time. Everything on the material is white: the word "Only" carries urgency, never red (§2.5). A live hold
 * leads back to its checkout instead, and a buyer who has their limit to their order, as in the inline panel
 * (§9.13); before the drop opens the stock line's countdown is all there is. A refusal's note is announced
 * once and describes Buy, as the inline panel's does: in fullscreen this card is all there is to buy with.
 */
export function DockedDropCard({
  drop,
  serverNow,
  signedIn,
  returnTo,
  claim,
}: RoomPurchase & { drop: DropSummary }) {
  const { level } = useLiveStock(drop.id, toLiveSeed(drop.stock, drop.status));
  const { state, buy } = useReserve(drop.id, returnTo, { prefetch: false });
  const action = buyAction(level, signedIn);
  const photo = drop.product.imageKeys[0];
  const row = purchaseRow(claim, drop.perUserLimit, false);
  const note = state.problem && reserveNote(state.problem, { perUserLimit: drop.perUserLimit, stock: level });
  const noteId = useId();
  // Once per refusal, worded from the level it was refused at, like the panel's (`purchase-panel.tsx`).
  const announceNote = useEffectEvent(() => {
    if (note) announce(note.text);
  });
  useEffect(() => {
    if (state.problem) announceNote();
  }, [state.problem]);

  return (
    <section aria-label={drop.product.title} className="material-overlay rounded-lg p-4 elevation-2">
      <div className="flex items-center gap-3">
        <div className="relative size-12 shrink-0 overflow-clip rounded-sm bg-fill-tertiary">
          {photo && <Image src={uploadPath(photo)} alt="" fill sizes="48px" className="object-cover" />}
        </div>
        <div className="min-w-0">
          <h2 className="line-clamp-2 text-headline">{drop.product.title}</h2>
          <p className="text-footnote tabular-nums">
            {describeStock(level).primary ?? (
              <Countdown target={drop.startsAt} serverNow={serverNow} verb="Starts" />
            )}
          </p>
        </div>
      </div>
      {row.kind === 'checkout' ? (
        <div className="mt-3 flex">
          <ButtonLink href={checkoutHref(row.held.id)} className="flex-1">
            Go to checkout
          </ButtonLink>
        </div>
      ) : row.kind === 'have-limit' ? (
        <div className="mt-3 flex">
          <ButtonLink
            href={row.lastPlacedId === null ? ORDERS_HREF : orderPageHref(row.lastPlacedId)}
            className="flex-1"
          >
            View your order
          </ButtonLink>
        </div>
      ) : (
        action.kind !== 'hidden' &&
        !(action.kind === 'closed' && action.reason === 'opens') && (
          <div className="mt-3 flex">
            <BuyButton
              action={action}
              reserve={state}
              quantity={1}
              maxQuantity={1}
              onBuy={() => buy(1)}
              returnTo={returnTo}
              size="md"
              describedBy={note ? noteId : undefined}
              className="flex-1"
            />
          </div>
        )
      )}
      {note && (
        <p id={noteId} className="mt-2 animate-fade-in text-footnote">
          {note.text}
        </p>
      )}
    </section>
  );
}
