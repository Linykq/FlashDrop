import { randomBytes } from 'node:crypto';
import type {
  PspChargeRequest,
  PspChargeResponse,
  PspLedgerCharge,
  PspLedgerResponse,
} from '@flashdrop/contracts';
import {
  asc,
  type Db,
  eq,
  parseRows,
  pspCharges,
  pspReferences,
  sql,
  type Tx,
  transaction,
} from '@flashdrop/db';
import {
  BugError,
  PSP_CHARGE_STATUSES,
  type PspChargeStatus,
  REFERENCE_CLOSED_DECLINE_CODE,
} from '@flashdrop/domain';
import { z } from 'zod';
import { CARD_DECLINED, newChargeStatus } from './simulation';

/*
 * The PSP's book in `psp.charges` and `psp.references` (design §3, §6.5): the evidence for INV-4.
 *
 * Serialization. Every write to a reference's charges first holds that reference's row lock: a charge with
 * `SELECT ... FOR UPDATE`, a close with `INSERT ... ON CONFLICT DO UPDATE`. A charge and a close of one
 * reference are therefore strictly ordered: either the charge commits first and the close refunds it, or
 * the close commits first and the charge sees `closed_at` and is refused. No charge can succeed on a closed
 * reference, so no orphaned charge is possible. A transaction holds one reference lock at most, so there is
 * no lock order to get wrong and no deadlock.
 *
 * Idempotency. `idempotency_key` is UNIQUE. One reference's attempts are serialized by its lock, so a
 * replay reads the committed original; the same key on two references races only on that index, and the
 * loser's `ON CONFLICT DO NOTHING` waits for the winner and then answers 422. A refused attempt
 * (`reference_closed`) writes nothing: closing is permanent, so a retry is refused the same way.
 */

export interface ChargeCommand extends PspChargeRequest {
  readonly idempotencyKey: string;
}

/** How the ledger answered. Only a `created` success may be withheld (timeout-after-success). */
export type ChargeResult =
  | { readonly kind: 'created' | 'replayed' | 'fenced'; readonly response: PspChargeResponse }
  | { readonly kind: 'key_reused' };

export interface Refund {
  readonly chargeId: string;
  readonly amountCents: number;
}

export interface Ledger {
  charge(command: ChargeCommand): Promise<ChargeResult>;
  /**
   * Closes the reference and returns every refund it holds, oldest first: those of an earlier close too,
   * so a replay answers like the original. One or none, unless a caller charged it under two keys.
   */
  close(reference: string): Promise<readonly Refund[]>;
  chargesFor(reference: string): Promise<PspLedgerCharge[]>;
  summary(): Promise<PspLedgerResponse>;
}

export function createLedger(db: Db): Ledger {
  return {
    charge: (command) => transaction(db, (tx) => chargeIn(tx, command)),
    close: (reference) => transaction(db, (tx) => closeIn(tx, reference)),
    chargesFor: async (reference) => {
      const rows = await db
        .select()
        .from(pspCharges)
        .where(eq(pspCharges.reference, reference))
        .orderBy(asc(pspCharges.createdAt), asc(pspCharges.id));
      return rows.map(toLedgerCharge);
    },
    summary: () => summarize(db),
  };
}

const KeyedCharge = z.object({
  id: z.string(),
  reference: z.string(),
  amount_cents: z.int(),
  method: z.string(),
  status: z.enum(PSP_CHARGE_STATUSES),
});
type KeyedCharge = z.infer<typeof KeyedCharge>;

const FENCED: PspChargeResponse = { status: 'reference_closed', declineCode: REFERENCE_CLOSED_DECLINE_CODE };

async function chargeIn(tx: Tx, command: ChargeCommand): Promise<ChargeResult> {
  const { reference, idempotencyKey } = command;
  // A first charge creates its reference. If a close is inserting the same new reference, this waits for
  // it and then does nothing; the lock below then reads closed_at.
  await tx.execute(sql`
    INSERT INTO ${pspReferences} (reference) VALUES (${reference}) ON CONFLICT (reference) DO NOTHING`);
  const { rows } = await tx.execute(sql`
    SELECT closed_at IS NOT NULL AS closed FROM ${pspReferences} WHERE reference = ${reference} FOR UPDATE`);
  const [lock] = parseRows(z.object({ closed: z.boolean() }), rows, 'lock reference');
  // The psp role has no DELETE, so the row inserted or found above is still there.
  if (lock === undefined) throw new BugError(`reference ${reference} vanished under its lock`);

  // Before the fence: a charge recorded before its reference closed replays as recorded.
  const original = await findByKey(tx, idempotencyKey);
  if (original !== undefined) return replay(original, command);
  if (lock.closed) return { kind: 'fenced', response: FENCED };

  const id = `ch_${randomBytes(12).toString('hex')}`;
  const status = newChargeStatus(command.paymentMethod);
  const inserted = await tx.execute(sql`
    INSERT INTO ${pspCharges} (id, idempotency_key, reference, amount_cents, method, status)
    VALUES (${id}, ${idempotencyKey}, ${reference}, ${command.amountCents}, ${command.paymentMethod}, ${status})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`);
  if (inserted.rows.length === 0) {
    // A charge of another reference took the key meanwhile; ON CONFLICT waited until it committed, so this
    // statement's fresh snapshot (READ COMMITTED) sees it.
    const winner = await findByKey(tx, idempotencyKey);
    if (winner === undefined) throw new BugError(`idempotency key conflict without a row: ${idempotencyKey}`);
    return replay(winner, command);
  }
  return { kind: 'created', response: responseFor(id, status) };
}

async function findByKey(tx: Tx, idempotencyKey: string): Promise<KeyedCharge | undefined> {
  const { rows } = await tx.execute(sql`
    SELECT id, reference, amount_cents, method, status FROM ${pspCharges}
    WHERE idempotency_key = ${idempotencyKey}`);
  return parseRows(KeyedCharge, rows, 'charge by idempotency key')[0];
}

/** The original result, if the key is reused for the same request; Stripe's rule otherwise (422). */
function replay(original: KeyedCharge, command: ChargeCommand): ChargeResult {
  const same =
    original.reference === command.reference &&
    original.amount_cents === command.amountCents &&
    original.method === command.paymentMethod;
  if (!same) return { kind: 'key_reused' };
  // Only a succeeded charge is ever refunded, so a refunded row was answered `succeeded`.
  return { kind: 'replayed', response: responseFor(original.id, original.status) };
}

function responseFor(id: string, status: PspChargeStatus): PspChargeResponse {
  return status === 'declined' ? { status, id, declineCode: CARD_DECLINED } : { status: 'succeeded', id };
}

async function closeIn(tx: Tx, reference: string): Promise<readonly Refund[]> {
  // Creates the reference closed, or closes it, and either way takes its row lock: an in-flight charge of
  // the reference commits first, and every later one waits for this transaction and then sees closed_at.
  await tx.execute(sql`
    INSERT INTO ${pspReferences} AS r (reference, closed_at) VALUES (${reference}, now())
    ON CONFLICT (reference) DO UPDATE SET closed_at = coalesce(r.closed_at, excluded.closed_at)`);
  await tx.execute(sql`
    UPDATE ${pspCharges} SET status = 'refunded', refunded_at = now()
    WHERE reference = ${reference} AND status = 'succeeded'`);
  const { rows } = await tx.execute(sql`
    SELECT id, amount_cents FROM ${pspCharges}
    WHERE reference = ${reference} AND status = 'refunded'
    ORDER BY created_at, id`);
  return parseRows(z.object({ id: z.string(), amount_cents: z.int() }), rows, 'refunds of reference').map(
    (row) => ({ chargeId: row.id, amountCents: row.amount_cents }),
  );
}

function toLedgerCharge(row: typeof pspCharges.$inferSelect): PspLedgerCharge {
  return {
    id: row.id,
    reference: row.reference,
    amountCents: row.amountCents,
    paymentMethod: row.method,
    status: row.status,
    ...(row.status === 'declined' ? { declineCode: CARD_DECLINED } : {}),
    createdAt: row.createdAt.toISOString(),
    refundedAt: row.refundedAt?.toISOString() ?? null,
  };
}

/** Sums are bigint, which node-postgres returns as strings. */
const Cents = z.coerce.number().pipe(z.int().nonnegative());

const DOUBLE_CAPTURED_SHOWN = 100;

async function summarize(db: Db): Promise<PspLedgerResponse> {
  const [charges, references, doubleCaptured] = await Promise.all([
    db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
             count(*) FILTER (WHERE status = 'declined')::int AS declined,
             count(*) FILTER (WHERE status = 'refunded')::int AS refunded,
             coalesce(sum(amount_cents) FILTER (WHERE status = 'succeeded'), 0) AS captured_cents,
             coalesce(sum(amount_cents) FILTER (WHERE status = 'refunded'), 0) AS refunded_cents
      FROM ${pspCharges}`),
    db.execute(sql`
      SELECT count(*) FILTER (WHERE closed_at IS NULL)::int AS open,
             count(*) FILTER (WHERE closed_at IS NOT NULL)::int AS closed
      FROM ${pspReferences}`),
    db.execute(sql`
      SELECT reference, count(*)::int AS charges, sum(amount_cents) AS captured_cents
      FROM ${pspCharges} WHERE status = 'succeeded'
      GROUP BY reference HAVING count(*) > 1
      ORDER BY reference LIMIT ${DOUBLE_CAPTURED_SHOWN}`),
  ]);
  const [totals] = parseRows(
    z.object({
      succeeded: z.int(),
      declined: z.int(),
      refunded: z.int(),
      captured_cents: Cents,
      refunded_cents: Cents,
    }),
    charges.rows,
    'ledger totals',
  );
  const [refs] = parseRows(z.object({ open: z.int(), closed: z.int() }), references.rows, 'reference totals');
  // An aggregate without GROUP BY always returns one row.
  if (totals === undefined || refs === undefined) throw new BugError('ledger aggregates returned no row');
  return {
    charges: { succeeded: totals.succeeded, declined: totals.declined, refunded: totals.refunded },
    capturedCents: totals.captured_cents,
    refundedCents: totals.refunded_cents,
    references: refs,
    doubleCaptured: parseRows(
      z.object({ reference: z.string(), charges: z.int(), captured_cents: Cents }),
      doubleCaptured.rows,
      'double-captured references',
    ).map((row) => ({ reference: row.reference, charges: row.charges, capturedCents: row.captured_cents })),
  };
}
