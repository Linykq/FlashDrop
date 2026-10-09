/*
 * The payment vocabulary shared by checkout, the payment consumer and the simulated PSP (design §6.5). The
 * PSP never sees card data, only these test tokens (§11). Browser-safe: the checkout form offers them.
 */

/**
 * Test payment methods. `pm_ok` is approved and `pm_decline` declined; `pm_slow` answers slowly and
 * `pm_flaky` fails transiently at times, so the payment consumer's timeouts and retries are exercised (the
 * PSP mock defines the details).
 */
export const PAYMENT_METHODS = ['pm_ok', 'pm_decline', 'pm_slow', 'pm_flaky'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly unknown[]).includes(value);
}

/** Statuses of a charge in the PSP ledger (`psp.charges.status`). */
export const PSP_CHARGE_STATUSES = ['succeeded', 'declined', 'refunded'] as const;
export type PspChargeStatus = (typeof PSP_CHARGE_STATUSES)[number];

/**
 * The decline code a `reference_closed` charge is recorded with (`payments.decline_code`,
 * `order.payment_failed`). Buyers see it as "payment didn't finish in time", not as a declined card.
 */
export const REFERENCE_CLOSED_DECLINE_CODE = 'reference_closed';

/*
 * PSP idempotency keys (§4.5, §6.5): one charge per order, ever, and one close per order. A redelivered
 * `order.placed` retries with the same key and gets the first charge back, so a timeout whose charge in fact
 * succeeded can never lead to a second one.
 */

export function pspChargeKey(orderId: string): string {
  return `charge:${orderId}`;
}

export function pspCloseKey(orderId: string): string {
  return `close:${orderId}`;
}
