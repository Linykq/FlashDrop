import { describe, expect, it } from 'vitest';
import { BugError, ERROR_STATUS } from './errors';
import { isIdempotencyKey } from './idempotency';
import {
  ADMISSION_REFUSALS,
  LUA_TO_API,
  REJECT_REASONS,
  refusalErrorCode,
  rejectionErrorCode,
  reserveReplay,
  rsvStateOf,
} from './reservation';
import { ORDER_STATUSES, type OrderStatus } from './statuses';

describe('Idempotency-Key format (§4.5)', () => {
  it.each(['abcdefgh', 'A-b_c-9_', 'x'.repeat(64), '0198f2c4-7a1e-7c3b-9a55-1b2c3d4e5f60'])(
    'accepts %s',
    (key) => {
      expect(isIdempotencyKey(key)).toBe(true);
    },
  );

  it.each(['', 'abcdefg', 'x'.repeat(65), 'has space1', 'colon:key', 'ümlautkey', 'dot.dot.dot'])(
    'refuses %j',
    (key) => {
      expect(isIdempotencyKey(key)).toBe(false);
    },
  );

  it('refuses non-strings', () => {
    expect(isIdempotencyKey(12345678)).toBe(false);
    expect(isIdempotencyKey(undefined)).toBe(false);
  });
});

describe('refusal mapping (§5.2)', () => {
  it('maps Lua and Postgres refusals to the same 409 codes, and a fenced generation to 503', () => {
    expect(LUA_TO_API).toEqual({ NOT_LIVE: 'DROP_NOT_LIVE', LIMIT: 'LIMIT_REACHED', SOLD_OUT: 'SOLD_OUT' });
    for (const reason of ADMISSION_REFUSALS) {
      expect(refusalErrorCode(reason)).toBe(LUA_TO_API[reason]);
      expect(ERROR_STATUS[refusalErrorCode(reason)]).toBe(409);
    }
    expect(refusalErrorCode('STALE_GEN')).toBe('RETRY');
    expect(ERROR_STATUS.RETRY).toBe(503);
  });

  it('replays an orphan tombstone as an expired reservation', () => {
    expect(REJECT_REASONS.map(rejectionErrorCode)).toEqual([
      'SOLD_OUT',
      'LIMIT_REACHED',
      'DROP_NOT_LIVE',
      'RESERVATION_EXPIRED',
    ]);
  });
});

describe('reserveReplay (§4.5)', () => {
  const hash = Uint8Array.from([1, 2, 3]);
  const order = (status: OrderStatus, closeReason: string | null = null) =>
    ({ status, closeReason, requestHash: Buffer.from([1, 2, 3]) }) as Parameters<typeof reserveReplay>[0];

  it('answers 422 for the same key with another body, whatever the status', () => {
    for (const status of ORDER_STATUSES) {
      expect(reserveReplay(order(status, 'SOLD_OUT'), Uint8Array.from([1, 2, 4]))).toEqual({
        kind: 'refused',
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
    expect(reserveReplay(order('RESERVED'), Uint8Array.from([1, 2]))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('replays live, paid and other closed orders as the order', () => {
    for (const status of ['RESERVED', 'PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'CANCELLED'] as const) {
      expect(reserveReplay(order(status), hash)).toEqual({ kind: 'order' });
    }
  });

  it('answers 410 for an expired hold and the refusal for a tombstone', () => {
    expect(reserveReplay(order('EXPIRED', 'TIMEOUT'), hash)).toEqual({
      kind: 'refused',
      code: 'RESERVATION_EXPIRED',
    });
    expect(reserveReplay(order('REJECTED', 'LIMIT'), hash)).toEqual({
      kind: 'refused',
      code: 'LIMIT_REACHED',
    });
    expect(reserveReplay(order('REJECTED', 'ORPHANED'), hash)).toEqual({
      kind: 'refused',
      code: 'RESERVATION_EXPIRED',
    });
  });

  it('treats a tombstone without a refusal reason as a bug', () => {
    expect(() => reserveReplay(order('REJECTED', 'TIMEOUT'), hash)).toThrow(BugError);
    expect(() => reserveReplay(order('REJECTED'), hash)).toThrow(BugError);
  });
});

describe('rsvStateOf (§4.7 step 4)', () => {
  it.each([
    ['RESERVED', 'HELD'],
    ['PENDING_PAYMENT', 'HELD'],
    ['PAID', 'COMMITTED'],
    ['PAYMENT_FAILED', 'RELEASED'],
    ['EXPIRED', 'RELEASED'],
    ['CANCELLED', 'RELEASED'],
    ['REJECTED', 'RELEASED'],
  ] as const)('%s -> %s', (status, state) => {
    expect(rsvStateOf(status)).toBe(state);
  });
});
