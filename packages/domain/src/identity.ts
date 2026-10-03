import { createHash, randomFillSync } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import { BugError } from './errors';
import { isIdempotencyKey } from './idempotency';

/*
 * Deterministic identities (design §4.5). Node-only, so this module is the `@flashdrop/domain/identity`
 * entry point rather than part of the main one, which browser bundles reach through the contracts.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The namespace of every reservation id. Fixed forever: changing it would give every retried request a new
 * rid, so replays would stop finding their order and a retry could reserve twice.
 */
export const RID_NAMESPACE = 'ab8d6259-5067-4f16-9dd5-f7eac91099c5';

/**
 * The reservation id, `rid = uuidv5(NS, userId:dropId:idempotencyKey)` (§4.5). It is both the Redis `rsv`
 * field and `orders.id`, so the two layers share one identity and a retry lands on the same hold and row.
 */
export function reservationId(ids: {
  readonly userId: string;
  readonly dropId: string;
  readonly idempotencyKey: string;
}): string {
  // The key is part of the name, and ':' cannot appear in it, so distinct triples never share a name.
  if (!isIdempotencyKey(ids.idempotencyKey)) throw new BugError('reservationId: invalid Idempotency-Key');
  if (!UUID.test(ids.userId) || !UUID.test(ids.dropId))
    throw new BugError('reservationId: ids must be uuids');
  return uuidv5(
    `${ids.userId.toLowerCase()}:${ids.dropId.toLowerCase()}:${ids.idempotencyKey}`,
    RID_NAMESPACE,
  );
}

/**
 * An RFC 9562 version-7 uuid: a 48-bit Unix millisecond timestamp followed by random bits, so ids sort by
 * creation time. Event ids (`outbox.event_id`, the consumers' dedupe key) use it.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomFillSync(Buffer.alloc(16));
  bytes.writeUIntBE(now, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6); // version 7
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 9562 variant
  return formatUuid(bytes.toString('hex'));
}

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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
  return formatUuid(hash.toString('hex', 0, 16));
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

/**
 * A fingerprint as Redis stores it: the `fp` of an `rsv` entry is the lowercase hex of the sha256, which is
 * also what Postgres's `encode(request_hash, 'hex')` gives the rebuild (§4.7). Lua compares the strings, so
 * every writer must use this one form.
 */
export function fingerprintHex(fingerprint: Uint8Array): string {
  return Buffer.from(fingerprint).toString('hex');
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
