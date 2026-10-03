import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BugError } from './errors';
import {
  checkoutFingerprint,
  fingerprintHex,
  RID_NAMESPACE,
  requestFingerprint,
  reservationId,
  uuidv5,
  uuidv7,
} from './identity';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidv5', () => {
  it('matches the published test vectors', () => {
    // RFC 9562 appendix A.4, and Python's documented uuid5(NAMESPACE_DNS, 'python.org').
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(uuidv5('python.org', DNS_NAMESPACE.toUpperCase())).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('refuses a namespace that is not a uuid', () => {
    expect(() => uuidv5('x', 'not-a-uuid')).toThrow(BugError);
  });
});

describe('fingerprints', () => {
  const sha256 = (text: string) => createHash('sha256').update(text).digest();

  it('hash the canonical JSON of the reserve body, whatever the key order or extra fields', () => {
    const dropId = '5eed0004-0000-4000-8000-000000000001';
    const expected = sha256(`{"dropId":"${dropId}","qty":2}`);

    const withExtraField = { dropId, qty: 2, note: 'not part of the body' };

    expect(requestFingerprint({ qty: 2, dropId })).toEqual(expected);
    expect(requestFingerprint(withExtraField)).toEqual(expected);
    expect(requestFingerprint({ dropId, qty: 3 })).not.toEqual(expected);
  });

  it('hash the checkout body with the shipping address in canonical order', () => {
    const a = checkoutFingerprint({
      orderId: 'o1',
      shipping: { name: 'Ada', country: 'SE' },
      paymentMethod: 'pm_ok',
    });
    const b = checkoutFingerprint({
      paymentMethod: 'pm_ok',
      shipping: { country: 'SE', name: 'Ada' },
      orderId: 'o1',
    });

    expect(a).toEqual(b);
    expect(a).toEqual(
      sha256('{"orderId":"o1","paymentMethod":"pm_ok","shipping":{"country":"SE","name":"Ada"}}'),
    );
  });
});

describe('reservationId', () => {
  const ids = {
    userId: '5eed0001-0000-4000-8000-000000000002',
    dropId: '5eed0004-0000-4000-8000-000000000001',
    idempotencyKey: 'key_0001-abcd',
  };

  it('is uuidv5(RID_NAMESPACE, userId:dropId:idempotencyKey)', () => {
    expect(reservationId(ids)).toBe(
      uuidv5(`${ids.userId}:${ids.dropId}:${ids.idempotencyKey}`, RID_NAMESPACE),
    );
    expect(reservationId(ids)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is stable for the same request, whatever the case of the uuids, and differs per key, user and drop', () => {
    const rid = reservationId(ids);

    expect(reservationId({ ...ids, dropId: ids.dropId.toUpperCase() })).toBe(rid);
    expect(reservationId({ ...ids, idempotencyKey: 'key_0001-abce' })).not.toBe(rid);
    expect(reservationId({ ...ids, userId: '5eed0001-0000-4000-8000-000000000003' })).not.toBe(rid);
    expect(reservationId({ ...ids, dropId: '5eed0004-0000-4000-8000-000000000002' })).not.toBe(rid);
  });

  it('refuses a key or id that validation should have stopped', () => {
    expect(() => reservationId({ ...ids, idempotencyKey: 'short' })).toThrow(BugError);
    expect(() => reservationId({ ...ids, idempotencyKey: 'has:colon:inside' })).toThrow(BugError);
    expect(() => reservationId({ ...ids, userId: 'user-1' })).toThrow(BugError);
  });
});

describe('uuidv7', () => {
  it('encodes the millisecond timestamp, version 7 and the RFC 9562 variant', () => {
    const at = Date.UTC(2026, 9, 2, 12, 0, 0, 123);
    const id = uuidv7(at);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(at);
  });

  it('sorts by creation time and never repeats', () => {
    const ids = [uuidv7(1_000), uuidv7(2_000), uuidv7(3_000)];

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(Array.from({ length: 1_000 }, () => uuidv7())).size).toBe(1_000);
  });
});

describe('fingerprintHex', () => {
  it('is the lowercase hex Postgres encode(request_hash, hex) produces', () => {
    expect(fingerprintHex(Buffer.from([0x00, 0xab, 0xff]))).toBe('00abff');
    expect(fingerprintHex(requestFingerprint({ dropId: 'd', qty: 1 }))).toMatch(/^[0-9a-f]{64}$/);
  });
});
