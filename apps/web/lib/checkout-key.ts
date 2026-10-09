import { isIdempotencyKey } from '@flashdrop/domain';
import { sessionStore } from './session-store';
import { uuidv7 } from './uuidv7';

/*
 * The checkout Idempotency-Key (SD §5.2, §8.2): created once per order, at its first submit, and kept in this
 * tab's sessionStorage under the order id. Every resubmit of the order sends it again, whatever the form now
 * holds: a reload, or Pay pressed again after a timeout, replays the submit that api may already have taken
 * (200) instead of meeting it as another buyer's (409 ALREADY_SUBMITTED). If the first submit never arrived,
 * the same key simply submits the current details; if it did, a key sent with other details answers 422,
 * which means the order was placed with the first ones.
 */

const storageName = (orderId: string) => `fd:checkout:${orderId}`;

export function checkoutKey(orderId: string): string {
  const stored = sessionStore.get(storageName(orderId));
  if (isIdempotencyKey(stored)) return stored;
  const key = uuidv7();
  sessionStore.set(storageName(orderId), key);
  return key;
}

/** Forgets the key once the order has left checkout: no further submit of it can happen. */
export function forgetCheckoutKey(orderId: string): void {
  sessionStore.remove(storageName(orderId));
}
