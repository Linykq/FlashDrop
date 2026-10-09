import { LIVE_ORDER_STATUSES, PAYMENT_METHODS } from '@flashdrop/domain';
import { z } from 'zod';
import { OrderResponse, OrderView } from './reservations';

/*
 * Checkout submit, cancel and the hold extension (design §5.1, §5.2, §8.3). Submit takes an
 * `Idempotency-Key` (kept per order in sessionStorage, §8.2); its fingerprint is
 * `sha256(canonicalJson({orderId, shipping, paymentMethod}))` of the *parsed* body below, so whitespace,
 * letter case of the country and unknown fields never turn a retry into a 422.
 */

export const PaymentMethod = z.enum(PAYMENT_METHODS, { error: 'Choose a payment method' });
export type PaymentMethod = z.infer<typeof PaymentMethod>;

const requiredLine = (max: number, missing: string) =>
  z.string({ error: missing }).trim().min(1, missing).max(max, `Use at most ${max} characters`);

/** An optional line: blank is the same as absent, so it neither shows on the order nor changes the hash. */
const optionalLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .transform((value) => (value === '' ? undefined : value))
    .optional();

/**
 * Where a paid order would ship (fulfillment itself is a non-goal). The fields follow the checkout form
 * (design-system §10.4) and its `autocomplete` tokens; the form may check more (a US ZIP code, a state from
 * its list), this is what api accepts. `line2` and `state` are optional, so the seeded PAID orders'
 * `{name, line1, city, postalCode, country}` parse unchanged and keep their checkout hash. Unknown fields
 * are dropped.
 */
export const ShippingAddress = z.object({
  /** `shipping name` */
  name: requiredLine(100, 'Enter a name'),
  /** `shipping address-line1` */
  line1: requiredLine(200, 'Enter a street address'),
  /** `shipping address-line2`: apartment, suite. */
  line2: optionalLine(200),
  /** `shipping address-level2` */
  city: requiredLine(100, 'Enter a city'),
  /** `shipping address-level1`: state, province or region. */
  state: optionalLine(100),
  /** `shipping postal-code` */
  postalCode: z
    .string({ error: 'Enter a ZIP or postal code' })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9 -]{0,15}$/, 'Enter a valid ZIP or postal code'),
  /** `shipping country`: ISO 3166-1 alpha-2. */
  country: z
    .string({ error: 'Choose a country' })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Choose a country'),
});
export type ShippingAddress = z.output<typeof ShippingAddress>;

/** `POST /api/v1/orders/:orderId/checkout` with `Idempotency-Key`. */
export const CheckoutBody = z.object({ shipping: ShippingAddress, paymentMethod: PaymentMethod });
export type CheckoutBody = z.output<typeof CheckoutBody>;

/**
 * Checkout submit: **202** with the order in PENDING_PAYMENT; **200** with `Idempotency-Replayed: true` and
 * the order as it is now when the same key and body were submitted before.
 */
export const CheckoutResponse = OrderResponse;
export type CheckoutResponse = OrderResponse;

/**
 * `POST /api/v1/orders/:orderId/cancel?from=RESERVED`: a precondition. Without it, a cancel takes a RESERVED
 * or PENDING_PAYMENT order; with it, only an order still in that status, and 409 otherwise. The checkout
 * page's Leave sends `from=RESERVED`: a tab left open from before payment must not cancel the order another
 * tab has meanwhile placed and is paying (design-system §10.4).
 */
export const CancelQuery = z.object({ from: z.enum(LIVE_ORDER_STATUSES).optional() });
export type CancelQuery = z.output<typeof CancelQuery>;

/**
 * `POST /api/v1/orders/:orderId/cancel`: 200 with the CANCELLED order, also when it was already cancelled
 * (a repeated cancel); 409 `CONFLICT` when the order was paid, failed or expired first, or is no longer in
 * the `from` status.
 */
export const CancelResponse = OrderResponse;
export type CancelResponse = OrderResponse;

/**
 * `POST /api/v1/orders/:orderId/extend`: 200 with the order, its `expiresAt` 60 s later and `extensions` 1;
 * 409 `CONFLICT` when the hold is no longer RESERVED, has run out, or was extended already.
 */
export const ExtendResponse = OrderResponse;
export type ExtendResponse = OrderResponse;

/**
 * An order with its checkout details, for its owner's order page (`GET /api/v1/orders/:orderId`,
 * design-system §10.5). Lists and the reserve answer use the shorter `OrderView`.
 */
export const OrderDetail = OrderView.extend({
  /** Null until checkout was submitted. */
  shipping: ShippingAddress.nullable(),
  paymentMethod: PaymentMethod.nullable(),
  /**
   * The PSP's decline code of a PAYMENT_FAILED order. `reference_closed` means the payment window closed
   * before the charge went through: shown as a timeout, not as a declined card.
   */
  declineCode: z.string().nullable(),
});
export type OrderDetail = z.output<typeof OrderDetail>;

export const OrderDetailResponse = z.object({ order: OrderDetail });
export type OrderDetailResponse = z.output<typeof OrderDetailResponse>;
