import { sha1 } from 'k6/crypto';

/*
 * Identities as the browser and api make them (design §4.5): a fresh uuidv7 Idempotency-Key per intent,
 * and the deterministic reservation id `uuidv5(NS, userId:dropId:key)` that a replay must answer with.
 * Mirrors `@flashdrop/domain/identity`, which k6 cannot import (it runs no Node modules).
 */

/** `RID_NAMESPACE` in `packages/domain/src/identity.ts`. Fixed forever. */
const RID_NAMESPACE = 'ab8d6259-5067-4f16-9dd5-f7eac91099c5';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function format(bytes: Uint8Array): string {
  const h = hex(bytes.subarray(0, 16));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** RFC 9562 version 7: 48 bits of Unix ms, then random bits. A valid Idempotency-Key (36 of [0-9a-f-]). */
export function uuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return format(bytes);
}

/** RFC 9562 version 5 (SHA-1, name-based). */
function uuidv5(name: string, namespace: string): string {
  const ns = namespace.replaceAll('-', '');
  const encoded = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + encoded.length);
  for (let i = 0; i < 16; i += 1) input[i] = Number.parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  input.set(encoded, 16);
  const hash = new Uint8Array(sha1(input.buffer, 'binary'));
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return format(hash);
}

/** The order id every request with this (user, drop, key) must answer with, created or replayed. */
export function reservationId(userId: string, dropId: string, idempotencyKey: string): string {
  return uuidv5(`${userId.toLowerCase()}:${dropId.toLowerCase()}:${idempotencyKey}`, RID_NAMESPACE);
}
