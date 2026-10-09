'use client';

import { type LiveLevel, useLiveStock } from '../../lib/live-stock';
import { useStockAnnouncements } from '../../lib/use-stock-announcements';
import { StockText } from './stock-text';

type LiveStockTextProps = {
  dropId: string;
  /** The server's snapshot: rendered as is, then replaced by anything newer (SD §8.2). */
  seed: LiveLevel;
  startsAt: string;
  serverNow: number;
  layout?: 'stacked' | 'compact';
  className?: string;
};

/**
 * LiveStock on its own (design-system §9.9), for the home hero: the stock block on the drop's live stock,
 * with its threshold announcements and the paused note.
 */
export function LiveStockText({ dropId, seed, ...display }: LiveStockTextProps) {
  const { level, paused, quiet } = useLiveStock(dropId, seed);
  useStockAnnouncements(level, paused, quiet);
  return <StockText stock={level} paused={paused} {...display} />;
}
