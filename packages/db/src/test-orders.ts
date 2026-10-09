import { randomUUID } from 'node:crypto';
import type { PaymentMethod, ShippingAddress } from '@flashdrop/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { submitCheckout } from './checkout';
import type { Db } from './client';
import { OUTBOX_CHANNEL } from './outbox';
import { reservation } from './test-fixtures';
import { recordReservation } from './transitions';

/*
 * Integration-test helpers for the order transitions after reserve (not exported from the package): orders
 * in a given status through the real transitions, and a LISTEN client that counts relay wake-ups.
 */

/** The seeded orders' shape; `ShippingAddress` parses it unchanged. */
export const SHIPPING: ShippingAddress = {
  name: 'Ada Buyer',
  line1: '1 Market Street',
  city: 'San Francisco',
  postalCode: '94105',
  country: 'US',
};

/** A RESERVED order of `qty` units, recorded by the real reserve transaction. Returns its id. */
export async function holdOrder(db: Db, dropId: string, userId: string, qty = 1): Promise<string> {
  const r = reservation(userId, dropId, qty);
  const outcome = await recordReservation(db, { ...r, gen: 0 });
  if (outcome.kind !== 'created') throw new Error(`hold refused: ${JSON.stringify(outcome)}`);
  return r.id;
}

/** A PENDING_PAYMENT order: held, then submitted with a fresh checkout key. */
export async function placeOrder(
  db: Db,
  dropId: string,
  userId: string,
  options: { readonly qty?: number; readonly paymentMethod?: PaymentMethod } = {},
): Promise<{ readonly orderId: string; readonly checkoutKey: string }> {
  const orderId = await holdOrder(db, dropId, userId, options.qty);
  const checkoutKey = randomUUID();
  const outcome = await submitCheckout(db, {
    orderId,
    userId,
    checkoutKey,
    shipping: SHIPPING,
    paymentMethod: options.paymentMethod ?? 'pm_ok',
  });
  if (outcome.kind !== 'submitted') throw new Error(`submit refused: ${JSON.stringify(outcome)}`);
  return { orderId, checkoutKey };
}

/** Moves the order's deadline into the past by Postgres time, as if its hold or payment window ran out. */
export async function lapse(db: Db, orderId: string): Promise<void> {
  await db.execute(sql`UPDATE orders SET expires_at = now() - interval '1 second' WHERE id = ${orderId}`);
}

export interface OutboxListener {
  /** Notifications on `outbox` so far, sentinels excluded. */
  readonly count: () => number;
  /**
   * Resolves once every notification committed before this call has arrived: it sends a sentinel and waits
   * for it, and Postgres delivers notifications in commit order.
   */
  readonly drain: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** A dedicated LISTEN connection on the relay's channel, as the relay holds one (§5.4). */
export async function listenOutbox(db: Db, url: string): Promise<OutboxListener> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
  let count = 0;
  const sentinels = new Map<string, () => void>();
  client.on('notification', (message) => {
    const done = sentinels.get(message.payload ?? '');
    if (done === undefined) count++;
    else done();
  });
  return {
    count: () => count,
    drain: async () => {
      const token = `sentinel-${randomUUID()}`;
      const arrived = new Promise<void>((resolve) => sentinels.set(token, resolve));
      await db.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, ${token})`);
      await arrived;
    },
    close: () => client.end(),
  };
}
