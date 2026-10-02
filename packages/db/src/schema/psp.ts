import { check, integer, pgSchema, text } from 'drizzle-orm/pg-core';
import { inList, timestamptz } from './columns';

/*
 * payment-mock's own schema (design §3). Its ledger is the evidence for INV-4 (no double charge), so the
 * invariant checks read it next to `payments`.
 */

export const PSP_CHARGE_STATUSES = ['succeeded', 'declined', 'refunded'] as const;

export const psp = pgSchema('psp');

export const pspCharges = psp.table(
  'charges',
  {
    id: text('id').primaryKey(),
    /** `charge:<orderId>`, so a retried charge can never succeed twice. */
    idempotencyKey: text('idempotency_key').notNull().unique('charges_idempotency_key_key'),
    /** The order id: close-by-reference refunds and fences every charge of an order that ended unpaid. */
    reference: text('reference').notNull(),
    amountCents: integer('amount_cents').notNull(),
    method: text('method').notNull(),
    status: text('status', { enum: PSP_CHARGE_STATUSES }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    refundedAt: timestamptz('refunded_at'),
  },
  (t) => [check('charges_status_check', inList(t.status, PSP_CHARGE_STATUSES))],
);

/** A closed reference rejects every later charge. */
export const pspReferences = psp.table('references', {
  reference: text('reference').primaryKey(),
  closedAt: timestamptz('closed_at'),
});
