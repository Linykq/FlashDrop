import type { HeldOrder, ViewerClaim } from './hold';
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

/**
 * What the purchase row leads with for this viewer (design-system §9.13), from what they already have of the
 * drop. Any live hold leads to its checkout: paying for it is the next step while its clock runs, so "Go to
 * checkout" is the filled action and reserving more is secondary, with `room` units left under the limit.
 * A buyer whose placed orders take the whole limit, or whom api just refused at the limit, is told they have
 * their units: a Buy there could only be refused.
 */
export type PurchaseRow =
  | { kind: 'checkout'; held: HeldOrder; room: number }
  | { kind: 'have-limit'; lastPlacedId: string | null }
  | { kind: 'buy'; room: number };

export function purchaseRow(claim: ViewerClaim, perUserLimit: number, refusedAtLimit: boolean): PurchaseRow {
  const { held, placedQty, lastPlacedId } = claim;
  if (held) return { kind: 'checkout', held, room: Math.max(0, perUserLimit - placedQty - held.qty) };
  if (refusedAtLimit || placedQty >= perUserLimit) return { kind: 'have-limit', lastPlacedId };
  return { kind: 'buy', room: perUserLimit - placedQty };
}

/** Where a sold-out drop sends the buyer next: another drop's page, or the list of upcoming ones (§9.13). */
export type NextDrop = { title: string; href: string };

export const UPCOMING_HREF = '/#upcoming';
