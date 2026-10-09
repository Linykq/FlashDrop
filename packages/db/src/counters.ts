import { BugError } from '@flashdrop/domain';
import { sql } from 'drizzle-orm';
import type { Tx } from './client';

/*
 * The counter changes of one order's status transition (design §4.4). They run in the transaction of the
 * status CAS, so INV-2 (`reserved` and `sold` equal the orders' units) and INV-3 (`claimed` equals the
 * user's live and paid units) hold at every instant. Global lock order: the caller's CAS has locked the
 * orders row; the quota row comes next; the drop's `drop_inventory` row comes last, so the hot row is held
 * for one statement plus the commit, and a transaction holding it never waits on anything else.
 */

interface Units {
  readonly userId: string;
  readonly dropId: string;
  readonly qty: number;
}

/** Gives the order's units back to the user's quota: `claimed` −q (cancel, payment failure). */
export async function releaseQuota(tx: Tx, order: Units): Promise<void> {
  const { rows } = await tx.execute(sql`
    UPDATE user_drop_quota SET claimed = claimed - ${order.qty}
    WHERE user_id = ${order.userId} AND drop_id = ${order.dropId}
    RETURNING claimed`);
  if (rows.length !== 1) {
    throw new BugError(`no quota row for user ${order.userId} in drop ${order.dropId}`);
  }
}

/** Gives the order's units back to the drop: `reserved` −q. The transaction's last statement. */
export async function releaseStock(tx: Tx, order: Omit<Units, 'userId'>): Promise<void> {
  const { rows } = await tx.execute(sql`
    UPDATE drop_inventory SET reserved = reserved - ${order.qty} WHERE drop_id = ${order.dropId}
    RETURNING drop_id`);
  if (rows.length !== 1) throw new BugError(`no inventory row for drop ${order.dropId}`);
}

/** Turns the order's held units into sold ones: `reserved` −q, `sold` +q. The transaction's last statement. */
export async function sellStock(tx: Tx, order: Omit<Units, 'userId'>): Promise<void> {
  const { rows } = await tx.execute(sql`
    UPDATE drop_inventory SET reserved = reserved - ${order.qty}, sold = sold + ${order.qty}
    WHERE drop_id = ${order.dropId}
    RETURNING drop_id`);
  if (rows.length !== 1) throw new BugError(`no inventory row for drop ${order.dropId}`);
}
