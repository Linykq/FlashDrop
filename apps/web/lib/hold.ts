import type { CloseReason, OrderView } from '@flashdrop/contracts';

/*
 * The checkout hold (SD §8.3, design-system §10.4): how much of it is left, when it turns to the warning
 * colour, and the four moments a screen reader hears about it. Pure, so the timing rules are tested without a
 * clock.
 */

/** The UI ends the hold this much before api does, so a buyer never acts on a hold Postgres already ended. */
export const HOLD_MARGIN_MS = 2_000;
/** From here on the countdown and the bar take the warning colour (§10.4). */
const WARNING_MS = 60_000;

export type HoldClock = {
  /** When the UI ends the hold, in epoch ms. */
  deadline: number;
  /** The visible length of the whole hold, for the bar. */
  total: number;
};

/**
 * The hold as the UI runs it. Postgres set `expires_at = created_at + hold_seconds` in the insert (SD §5.2),
 * so the two timestamps give the hold's full length without asking the drop.
 */
export function holdClock(createdAt: string, expiresAt: string): HoldClock {
  const deadline = Date.parse(expiresAt) - HOLD_MARGIN_MS;
  return { deadline, total: Math.max(1, deadline - Date.parse(createdAt)) };
}

export type HoldState = {
  remainingMs: number;
  /** What `formatCountdown` shows: whole seconds, rounded up. */
  seconds: number;
  /** Of the bar, 1 when the hold starts, 0 when it ends. */
  fraction: number;
  warning: boolean;
  expired: boolean;
};

export function holdState(now: number, { deadline, total }: HoldClock): HoldState {
  const remainingMs = Math.max(0, deadline - now);
  return {
    remainingMs,
    seconds: Math.ceil(remainingMs / 1000),
    fraction: Math.min(1, remainingMs / total),
    warning: remainingMs <= WARNING_MS,
    expired: remainingMs === 0,
  };
}

const ANNOUNCEMENTS: readonly (readonly [seconds: number, text: string])[] = [
  [10, '10 seconds left.'],
  [30, '30 seconds left.'],
  [60, '1 minute left.'],
  [120, '2 minutes left to check out.'],
];

/**
 * The announcement when the countdown crosses 2:00, 1:00, 0:30 or 0:10 (SD §8.3), and `null` at every other
 * tick. A jump across several (a tab that slept) announces only the latest.
 */
// TODO(M3): "1 minute left. You can add 1 more minute." while the one-time extension is available.
export function holdAnnouncement(before: number, after: number): string | null {
  for (const [seconds, text] of ANNOUNCEMENTS) {
    if (after <= seconds && before > seconds) return text;
  }
  return null;
}

/**
 * Where the announcements start counting from: just above the whole hold, so the first tick names the band
 * the hold is in. The UI's 2 s margin starts a fresh 2-minute hold at 1:58, below 2:00; counted from the first
 * value shown, the 2:00 announcement would never be crossed.
 */
export function announcedFrom(createdAt: string, expiresAt: string): number {
  return Math.round((Date.parse(expiresAt) - Date.parse(createdAt)) / 1000) + 1;
}

/** Whether an order is a hold that is still live at `now` (server time), by the UI's own deadline. */
export function isLiveHold(
  order: Pick<OrderView, 'status' | 'createdAt' | 'expiresAt'>,
  now: number,
): boolean {
  return order.status === 'RESERVED' && !holdState(now, holdClock(order.createdAt, order.expiresAt)).expired;
}

/** A buyer's live hold on a drop, as the product page offers it back (design-system §9.13). */
export type HeldOrder = Pick<OrderView, 'id' | 'qty' | 'createdAt' | 'expiresAt'>;

/**
 * The buyer's live hold on `dropId` among their latest orders, each judged at its own `serverNow`, or `null`.
 * A buyer with two holds on one drop is taken back to the one that ends first.
 */
export function liveHold(orders: readonly OrderView[], dropId: string): HeldOrder | null {
  let soonest: OrderView | null = null;
  for (const order of orders) {
    if (order.dropId !== dropId || !isLiveHold(order, Date.parse(order.serverNow))) continue;
    if (soonest === null || Date.parse(order.expiresAt) < Date.parse(soonest.expiresAt)) soonest = order;
  }
  if (soonest === null) return null;
  const { id, qty, createdAt, expiresAt } = soonest;
  return { id, qty, createdAt, expiresAt };
}

/**
 * The order list's order (design-system §10.6): live holds first, the one ending soonest on top, because they
 * are the only rows with something left to do; then everything else as api listed it, newest first.
 */
export function liveHoldsFirst(orders: readonly OrderView[]): OrderView[] {
  const live = orders.filter((order) => isLiveHold(order, Date.parse(order.serverNow)));
  live.sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  return [...live, ...orders.filter((order) => !live.includes(order))];
}

/** Why a reservation was not made, for buyers (design-system §12.2, Orders). */
export function rejectionText(reason: CloseReason | null): string {
  switch (reason) {
    case 'SOLD_OUT':
      return 'Every unit was claimed before your reservation went through.';
    case 'LIMIT':
      return "You've already claimed the limit for this drop.";
    case 'NOT_LIVE':
      return "The drop wasn't open when your request arrived.";
    default:
      // ORPHANED: the request never finished, so nothing was held.
      return "Your request didn't finish, so nothing was reserved.";
  }
}
