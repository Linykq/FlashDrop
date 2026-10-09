import { isIdempotencyKey, MAX_ORDER_QTY, MIN_ORDER_QTY } from '@flashdrop/domain';
import { sessionStore as storage } from './session-store';
import { uuidv7 } from './uuidv7';

/*
 * The Buy button's Idempotency-Key, per drop and tab (SD §8.2). api derives the reservation id from (user,
 * drop, key), so the key is what makes a retry safe: it lives in sessionStorage until its request has a final
 * answer, and a retry or a reload sends it again.
 */

type PendingReserve = { key: string; qty: number };

const storageName = (dropId: string) => `fd:reserve:${dropId}`;

function readPending(dropId: string): PendingReserve | null {
  const raw = storage.get(storageName(dropId));
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('key' in value) || !('qty' in value)) return null;
  const { key, qty } = value;
  return isIdempotencyKey(key) && isQuantity(qty) ? { key, qty } : null;
}

function isQuantity(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= MIN_ORDER_QTY && Number(value) <= MAX_ORDER_QTY;
}

/**
 * The quantity of this tab's unfinished reserve request for the drop, or `null`. The panel starts from it,
 * so pressing Buy again after a reload sends the very same request and replays its answer. `orderKeys` are
 * the reserve keys of the viewer's orders on the drop (`ViewerClaim`): a request among them made its order,
 * which the page already shows, and only its answer was lost. Its key is forgotten here, so the next press,
 * "Buy 1 more" beside that hold, is a new intent that reserves more instead of replaying the first.
 */
export function pendingQuantity(dropId: string, orderKeys: readonly string[]): number | null {
  const pending = readPending(dropId);
  if (pending === null) return null;
  if (!orderKeys.includes(pending.key)) return pending.qty;
  forgetReserveKey(dropId);
  return null;
}

/**
 * The Idempotency-Key for reserving `qty` units (SD §8.2): the unfinished request's key if it was for the
 * same quantity, otherwise a new uuidv7. A key belongs to one request body; sent with another quantity, api
 * would refuse it as `IDEMPOTENCY_KEY_REUSED`. Choosing another quantity is a new intent, so it gets a new key.
 */
export function reserveKey(dropId: string, qty: number): string {
  const pending = readPending(dropId);
  if (pending?.qty === qty) return pending.key;
  const key = uuidv7();
  storage.set(storageName(dropId), JSON.stringify({ key, qty } satisfies PendingReserve));
  return key;
}

/** Forgets the key once its request has a final answer: the next Buy is a new reservation. */
export function forgetReserveKey(dropId: string): void {
  storage.remove(storageName(dropId));
}
