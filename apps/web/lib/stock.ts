import type { StockLevel } from '@flashdrop/contracts';
import type { PublicDropStatus } from '@flashdrop/domain';
import { formatCount, plural } from './format';

/**
 * A stock snapshot as the storefront renders it, in the shape of api's stock level: `avail` can be reserved,
 * `held` is in carts, `sold` is paid, and the three add up to the drop's total. It comes from Postgres
 * `drop_inventory` until M2 and from the `(gen, seq)`-ordered live state afterwards (SD §8.2).
 */
export type StockState = {
  status: PublicDropStatus;
  avail: number;
  held: number;
  sold: number;
};

/**
 * Narrows api's stock level to what the storefront renders. RECONCILING is a few seconds of a Redis rebuild
 * (SD §4.7) during which clients keep their last state; a server render has none, so it shows the drop's
 * own status with the levels it was given.
 */
export function toStockState(level: StockLevel, dropStatus: PublicDropStatus): StockState {
  const { avail, held, sold } = level;
  return { status: level.status === 'RECONCILING' ? dropStatus : level.status, avail, held, sold };
}

/** A server snapshot as the seed of the live store (`lib/live-stock.ts`), keeping its `(gen, seq)` version. */
export function toLiveSeed(
  level: StockLevel,
  dropStatus: PublicDropStatus,
): StockState & { gen: number; seq: number } {
  return { ...toStockState(level, dropStatus), gen: level.gen, seq: level.seq };
}

/**
 * Urgent stock: few enough left that "Only" is honest (§9.9, §1.5). A large remainder reads "488 left", never
 * "Only 488 left", so urgency is never invented.
 */
export function isUrgent(avail: number, total: number): boolean {
  return avail > 0 && avail <= Math.max(5, Math.ceil(total / 10));
}

export type StockView = {
  /** `null` before the drop opens: the primary line is then the start countdown, which the caller renders. */
  primary: string | null;
  secondary: string;
  /** Primary text and meter in `danger` (on surfaces; on materials the word "Only" carries it). */
  urgent: boolean;
  showMeter: boolean;
};

/** The text of every LiveStock state in design-system §9.9, from one snapshot. */
export function describeStock(stock: StockState): StockView {
  const { status, avail, held, sold } = stock;
  const total = avail + held + sold;
  const base = { urgent: false, showMeter: true };

  switch (status) {
    case 'SCHEDULED':
      // The limit has its own line wherever stock is shown (the panel's terms, the drop card's footnote).
      return {
        primary: null,
        secondary: `${formatCount(total)} available`,
        urgent: false,
        showMeter: false,
      };
    case 'PAUSED':
      return {
        ...base,
        primary: 'Paused',
        secondary: 'Sales are paused. This page updates when they resume.',
      };
    case 'ENDED':
      return {
        ...base,
        primary: 'Drop ended',
        secondary: `${formatCount(sold)} of ${formatCount(total)} sold`,
      };
    case 'LIVE': {
      if (avail > 0) {
        const urgent = isUrgent(avail, total);
        return {
          ...base,
          urgent,
          primary: `${urgent ? 'Only ' : ''}${formatCount(avail)} left`,
          secondary: `${formatCount(total - avail)} of ${formatCount(total)} claimed`,
        };
      }
      if (held > 0) {
        return {
          ...base,
          primary: 'All reserved',
          secondary: plural(
            held,
            `${formatCount(held)} in a cart, may free up`,
            `${formatCount(held)} in carts, may free up`,
          ),
        };
      }
      return { ...base, primary: 'Sold out', secondary: `All ${formatCount(total)} sold` };
    }
  }
}
