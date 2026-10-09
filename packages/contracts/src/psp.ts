import { PSP_CHARGE_STATUSES, REFERENCE_CLOSED_DECLINE_CODE } from '@flashdrop/domain';
import { z } from 'zod';
import { PaymentMethod } from './checkout';
import { IsoDateTime } from './common';

/*
 * The simulated PSP's HTTP API (`apps/payment-mock`, design §6.5), validated on both sides: by the mock on
 * every request and by the payment consumer on every answer. `GET /health` and `/health/live` answer the
 * shared `HealthResponse`.
 *
 *   POST /v1/charges                       Idempotency-Key, PspChargeRequest -> 200 PspChargeResponse
 *   POST /v1/references/:reference/close   Idempotency-Key, no body          -> 200 PspCloseResponse
 *   GET  /v1/charges?reference=                                              -> 200 PspChargeList
 *   GET  /v1/admin/ledger                                                    -> 200 PspLedgerResponse
 *
 * FlashDrop's reference is the order id, and its keys are `charge:<orderId>` and `close:<orderId>`
 * (`pspChargeKey`, `pspCloseKey` in `@flashdrop/domain`). The mock serializes calls per reference, so a close
 * and an in-flight charge are strictly ordered: the charge came first and is refunded, or it comes second and
 * is refused. Errors answer `PspErrorBody`; a 503, a 5xx or a timeout is an unknown outcome, which the
 * consumer retries with the same key (§6.4).
 *
 * Requests are strict (the mock refuses what it does not know); the two answers the consumer acts on are
 * tolerant readers that drop unknown fields. A PSP adding a field to its answer is an additive change; a
 * strict parse would turn it into a contract error on every charge and every close, which the consumer
 * cannot retry its way out of.
 */

/** Required on both POSTs. */
export const PSP_IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Printable ASCII without spaces, as PSPs accept; wider than the order API's `IdempotencyKey`. */
export const PspIdempotencyKey = z
  .string()
  .regex(/^[\x21-\x7e]{1,255}$/, 'must be 1-255 printable characters');

/** Header validation for the POSTs. Loose, so the request's other headers pass through. */
export const PspIdempotencyHeaders = z.looseObject({ [PSP_IDEMPOTENCY_KEY_HEADER]: PspIdempotencyKey });

/** Any short token to the PSP; FlashDrop's order id. A URL path segment too, hence the charset. */
export const PspReference = z.string().regex(/^[\w.:-]{1,128}$/, 'must be 1-128 of A-Z a-z 0-9 _ . : -');

/** `psp.charges.amount_cents` is an int4. */
const PspAmountCents = z.int().positive().max(2_147_483_647);

/** `POST /v1/charges`. */
export const PspChargeRequest = z.strictObject({
  reference: PspReference,
  amountCents: PspAmountCents,
  paymentMethod: PaymentMethod,
});
export type PspChargeRequest = z.infer<typeof PspChargeRequest>;

/**
 * The outcome of a charge, the same for every retry under its key: a charge that close-by-reference refunded
 * later still replays as `succeeded`, as an idempotent replay must. Both refusals carry a `declineCode`, so
 * the consumer records PAYMENT_FAILED from either the same way. A `reference_closed` refusal has no `id`:
 * the reference was closed first (the order ended unpaid), the PSP created no charge, and the reference stays
 * fenced, so a retry gets the same answer.
 */
export const PspChargeResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), id: z.string().min(1) }),
  z.object({ status: z.literal('declined'), id: z.string().min(1), declineCode: z.string().min(1) }),
  z.object({
    status: z.literal('reference_closed'),
    declineCode: z.literal(REFERENCE_CLOSED_DECLINE_CODE),
  }),
]);
export type PspChargeResponse = z.infer<typeof PspChargeResponse>;

export const PspReferenceParams = z.strictObject({ reference: PspReference });
export type PspReferenceParams = z.infer<typeof PspReferenceParams>;

/**
 * `POST /v1/references/:reference/close`: the reference refuses every later charge, and its succeeded charge,
 * if any, was refunded, by this call or by an earlier close (a replay returns the same refund), so the
 * consumer can record a REFUNDED payment. Empty when nothing was captured.
 */
export const PspCloseResponse = z
  .object({ refundedChargeId: z.string().min(1).optional(), amountCents: PspAmountCents.optional() })
  .refine((r) => (r.refundedChargeId === undefined) === (r.amountCents === undefined), {
    message: 'refundedChargeId and amountCents come together',
  });
export type PspCloseResponse = z.infer<typeof PspCloseResponse>;

/** `GET /v1/charges?reference=`. */
export const PspChargesQuery = z.strictObject({ reference: PspReference });
export type PspChargesQuery = z.infer<typeof PspChargesQuery>;

/** A ledger row (`psp.charges`) as it stands now: unlike the charge answer, a refunded charge shows `refunded`. */
export const PspLedgerCharge = z.strictObject({
  id: z.string(),
  reference: z.string(),
  amountCents: z.int(),
  paymentMethod: z.string(),
  status: z.enum(PSP_CHARGE_STATUSES),
  declineCode: z.string().optional(),
  createdAt: IsoDateTime,
  refundedAt: IsoDateTime.nullable(),
});
export type PspLedgerCharge = z.infer<typeof PspLedgerCharge>;

/** Every charge of one reference, oldest first. */
export const PspChargeList = z.strictObject({ charges: z.array(PspLedgerCharge) });
export type PspChargeList = z.infer<typeof PspChargeList>;

const Count = z.int().nonnegative();

/** `GET /v1/admin/ledger`: the whole book, for audits and demos (`verify:invariants` reads `psp.charges`). */
export const PspLedgerResponse = z.strictObject({
  charges: z.strictObject({ succeeded: Count, declined: Count, refunded: Count }),
  /** Held now: succeeded charges that were not refunded. */
  capturedCents: Count,
  refundedCents: Count,
  references: z.strictObject({ open: Count, closed: Count }),
  /**
   * INV-4's PSP half: references holding more than one succeeded charge (at most 100). The mock reports this
   * rather than preventing it; FlashDrop charges a reference under one key only.
   */
  doubleCaptured: z.array(z.strictObject({ reference: z.string(), charges: Count, capturedCents: Count })),
});
export type PspLedgerResponse = z.infer<typeof PspLedgerResponse>;

export const PSP_ERROR_CODES = [
  'unauthorized',
  'validation_failed',
  'not_found',
  'idempotency_key_reused',
  'unavailable',
  'internal',
] as const;
export type PspErrorCode = (typeof PSP_ERROR_CODES)[number];

/**
 * Every PSP error answer: 400, 401 (no or a wrong API key), 404, 422 (a key reused with another body), 503
 * (with Retry-After), 500.
 */
export const PspErrorBody = z.strictObject({
  error: z.strictObject({
    code: z.enum(PSP_ERROR_CODES),
    message: z.string(),
    issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type PspErrorBody = z.infer<typeof PspErrorBody>;
