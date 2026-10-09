'use client';

import { type DropSummary, uploadPath } from '@flashdrop/contracts';
import Image from 'next/image';
import { useEffect, useEffectEvent, useId } from 'react';
import { useLiveStock } from '../../lib/live-stock';
import { buyAction } from '../../lib/purchase';
import { reserveNote } from '../../lib/reserve-copy';
import { checkoutHref } from '../../lib/routes';
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
 * time. Everything on the material is white: the word "Only" carries urgency, never red (§2.5). A hold that
 * takes the whole limit leads back to checkout instead. A refusal's note is announced once and describes Buy,
 * as the inline panel's does: in fullscreen this card is all there is to buy with.
 */
export function DockedDropCard({
  drop,
  serverNow,
  signedIn,
  returnTo,
  heldOrder,
}: RoomPurchase & { drop: DropSummary }) {
  const { level } = useLiveStock(drop.id, toLiveSeed(drop.stock, drop.status));
  const { state, buy } = useReserve(drop.id, returnTo, { prefetch: false });
  const action = buyAction(level, signedIn);
  const photo = drop.product.imageKeys[0];
  const fullHold = heldOrder !== null && heldOrder.qty >= drop.perUserLimit ? heldOrder : null;
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
      {action.kind !== 'hidden' && (
        <div className="mt-3 flex">
          {fullHold ? (
            <ButtonLink href={checkoutHref(fullHold.id)} className="flex-1">
              Go to checkout
            </ButtonLink>
          ) : (
            <BuyButton
              action={action}
              reserve={state}
              quantity={1}
              maxQuantity={1}
              onBuy={() => buy(1)}
              startsAt={drop.startsAt}
              serverNow={serverNow}
              returnTo={returnTo}
              size="md"
              describedBy={note ? noteId : undefined}
              className="flex-1"
            />
          )}
        </div>
      )}
      {note && (
        <p id={noteId} className="mt-2 animate-fade-in text-footnote">
          {note.text}
        </p>
      )}
    </section>
  );
}
