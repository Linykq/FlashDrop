'use client';

import { useEffect, useRef } from 'react';
import type { HeldOrder } from '../../lib/hold';
import { type LiveLevel, stockAnnouncement, useLiveStock } from '../../lib/live-stock';
import type { StockState } from '../../lib/stock';
import { announce } from '../ui/announcer';
import { PurchasePanel } from './purchase-panel';
import { StockText } from './stock-text';

type LivePurchasePanelProps = {
  dropId: string;
  /** The server's snapshot: rendered as is, then replaced by anything newer (SD §8.2). */
  seed: LiveLevel;
  perUserLimit: number;
  holdSeconds: number;
  startsAt: string;
  serverNow: number;
  priceCents: number;
  currency: string;
  signedIn: boolean;
  returnTo: string;
  heldOrder: HeldOrder | null;
};

/**
 * LiveStock and the purchase row of the product page (§9.9, §10.2), on the drop's live stock: the number, the
 * meter and the Buy button follow Redis while the page is open, and the Buy button re-enables by itself when
 * held units come back. The visible block is not a live region; threshold crossings are announced instead.
 */
export function LivePurchasePanel({ dropId, seed, ...panel }: LivePurchasePanelProps) {
  const { level, paused, quiet } = useLiveStock(dropId, seed);
  useStockAnnouncements(level, paused, quiet);
  return (
    <>
      <StockText
        className="mt-6"
        stock={level}
        startsAt={panel.startsAt}
        serverNow={panel.serverNow}
        paused={paused}
      />
      <PurchasePanel dropId={dropId} stock={level} {...panel} />
    </>
  );
}

/** At most one stock announcement per 3 s; the latest state wins (design-system §9.9, §13.3). */
const COOLDOWN_MS = 3_000;

function useStockAnnouncements(stock: StockState, paused: boolean, quiet: boolean): void {
  const previous = useRef(stock);
  const lastAt = useRef(Number.NEGATIVE_INFINITY);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wasPaused = useRef(paused);

  useEffect(() => {
    const text = stockAnnouncement(previous.current, stock);
    previous.current = stock;
    // The buyer's own press brought this level in, and its button or note speaks for it. An announcement
    // still waiting out the cooldown is older than this level and would contradict that note: dropped too.
    if (quiet) {
      clearTimeout(pending.current);
      return;
    }
    if (text === null) return;
    clearTimeout(pending.current);
    const say = () => {
      lastAt.current = Date.now();
      announce(text);
    };
    const wait = lastAt.current + COOLDOWN_MS - Date.now();
    if (wait <= 0) say();
    else pending.current = setTimeout(say, wait);
  }, [stock, quiet]);

  useEffect(() => () => clearTimeout(pending.current), []);

  // "Live updates paused" and "resumed", once each (§13.3).
  useEffect(() => {
    if (paused === wasPaused.current) return;
    wasPaused.current = paused;
    announce(paused ? 'Live updates paused.' : 'Live updates resumed.');
  }, [paused]);
}
