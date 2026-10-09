'use client';

import { type LiveLevel, useLiveStock } from '../../lib/live-stock';
import { DropStatusLine } from './drop-status-line';

type LiveDropStatusProps = {
  dropId: string;
  seed: LiveLevel;
  startsAt: string;
  endsAt: string;
  serverNow: number;
  /** The home hero's badge pulses (§9.11); the product page's doesn't. */
  pulse?: boolean;
};

/**
 * The status line above a drop's title (§10.1, §10.2) on the drop's live stock, so it changes with the stock
 * and the purchase panel when the drop opens, sells out, pauses or ends.
 */
export function LiveDropStatus({ dropId, seed, ...line }: LiveDropStatusProps) {
  const { level } = useLiveStock(dropId, seed);
  return (
    <div className="flex min-h-6 items-center gap-2 text-footnote text-label-secondary">
      <DropStatusLine stock={level} {...line} />
    </div>
  );
}
