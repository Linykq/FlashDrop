import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import { BugError } from './errors';

/*
 * Deterministic identities (design §4.5). Node-only, so this module is the `@flashdrop/domain/identity`
 * entry point rather than part of the main one, which browser bundles reach through the contracts.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The RFC 9562 name-based uuid (version 5, SHA-1): the same name in the same namespace always gives the same
 * id, so a retried write lands on the same row.
 */
export function uuidv5(name: string, namespace: string): string {
  if (!UUID.test(namespace)) throw new BugError(`uuidv5 namespace is not a uuid: ${namespace}`);
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 9562 variant
  const hex = hash.toString('hex', 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sha256 = (value: unknown): Buffer => createHash('sha256').update(canonicalJson(value)).digest();

/**
 * The reserve fingerprint, `orders.request_hash`: `sha256(canonicalJson({dropId, qty}))`. A replayed
 * Idempotency-Key with another body is refused with 422 `IDEMPOTENCY_KEY_REUSED`. The fields are picked
 * one by one, so extra properties on the argument cannot change the hash.
 */
export function requestFingerprint(request: { readonly dropId: string; readonly qty: number }): Buffer {
  return sha256({ dropId: request.dropId, qty: request.qty });
}

/** The checkout fingerprint, `orders.checkout_hash`: `sha256(canonicalJson({orderId, shipping, paymentMethod}))`. */
export function checkoutFingerprint(checkout: {
  readonly orderId: string;
  /** The validated shipping address, a plain JSON object. */
  readonly shipping: unknown;
  readonly paymentMethod: string;
}): Buffer {
  return sha256({
    orderId: checkout.orderId,
    shipping: checkout.shipping,
    paymentMethod: checkout.paymentMethod,
  });
}
