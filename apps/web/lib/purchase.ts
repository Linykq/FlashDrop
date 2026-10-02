import type { StockState } from './stock';

/**
 * What the Buy button can do for this viewer right now (design-system §9.13), from the same snapshot the
 * stock text shows:
 *
 * - `hidden`: the drop ended; there is no button (§9.9).
 * - `closed`: nothing can be reserved now; the button carries LiveStock's word for why, with the disabled
 *   look, and re-enables by itself when the state changes.
 * - `sign-in`: units are available and the viewer is signed out.
 * - `buy`: units are available and the viewer may reserve.
 */
export type BuyAction =
  | { kind: 'hidden' }
  | { kind: 'closed'; reason: 'opens' | 'paused' | 'all-reserved' | 'sold-out' }
  | { kind: 'sign-in' }
  | { kind: 'buy' };

export function buyAction(stock: StockState, signedIn: boolean): BuyAction {
  switch (stock.status) {
    case 'ENDED':
      return { kind: 'hidden' };
    case 'SCHEDULED':
      return { kind: 'closed', reason: 'opens' };
    case 'PAUSED':
      return { kind: 'closed', reason: 'paused' };
    case 'LIVE':
      if (stock.avail > 0) return { kind: signedIn ? 'buy' : 'sign-in' };
      return { kind: 'closed', reason: stock.held > 0 ? 'all-reserved' : 'sold-out' };
  }
}

/**
 * The most one buyer can choose: the drop's per-person limit, and never more than is left, so the stepper
 * cannot offer a quantity the drop would refuse as sold out.
 */
export function maxQuantity(stock: StockState, perUserLimit: number): number {
  return Math.max(1, Math.min(perUserLimit, stock.avail));
}
