'use client';

import type { ViewerClaim } from '../../lib/hold';
import { type LiveLevel, useLiveStock } from '../../lib/live-stock';
import type { NextDrop } from '../../lib/purchase';
import { useStockAnnouncements } from '../../lib/use-stock-announcements';
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
  claim: ViewerClaim;
  next: NextDrop | null;
};

/**
 * LiveStock and the purchase row of the product page (§9.9, §10.2), on the drop's live stock: the number, the
 * meter and the Buy button follow Redis while the page is open, and the Buy button re-enables by itself when
 * held units come back. The visible block is not a live region; threshold crossings are announced instead.
 */
export function LivePurchasePanel({ dropId, seed, startsAt, ...rest }: LivePurchasePanelProps) {
  const { level, paused, quiet } = useLiveStock(dropId, seed);
  useStockAnnouncements(level, paused, quiet);
  return (
    <>
      <StockText
        className="mt-6"
        stock={level}
        startsAt={startsAt}
        serverNow={rest.serverNow}
        paused={paused}
      />
      <PurchasePanel dropId={dropId} stock={level} {...rest} />
    </>
  );
}
