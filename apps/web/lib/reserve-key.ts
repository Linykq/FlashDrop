import { isIdempotencyKey, MAX_ORDER_QTY, MIN_ORDER_QTY } from '@flashdrop/domain';
import { uuidv7 } from './uuidv7';

/*
 * The Buy button's Idempotency-Key, per drop and tab (SD §8.2). api derives the reservation id from (user,
 * drop, key), so the key is what makes a retry safe: it lives in sessionStorage until its request has a final
 * answer, and a retry or a reload sends it again.
 */

type PendingReserve = { key: string; qty: number };

// sessionStorage throws where site data is blocked (some private modes). The key then lives in memory: it
// still covers retries on this page, just not a reload.
const memory = new Map<string, string>();

const storage = {
  get(name: string): string | null {
    try {
      return sessionStorage.getItem(name);
    } catch {
      return memory.get(name) ?? null;
    }
  },
  set(name: string, value: string): void {
    try {
      sessionStorage.setItem(name, value);
    } catch {
      memory.set(name, value);
    }
  },
  remove(name: string): void {
    memory.delete(name);
    try {
      sessionStorage.removeItem(name);
    } catch {
      // Nothing was stored there: `set` fell back to memory, which is already cleared.
    }
  },
};

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
 * so pressing Buy again after a reload sends the very same request and replays its answer.
 */
export function pendingQuantity(dropId: string): number | null {
  return readPending(dropId)?.qty ?? null;
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
