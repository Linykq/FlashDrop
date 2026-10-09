import { describe, expect, it } from 'vitest';
import { CHECKOUT_REFUSALS, type CheckoutReplayable, cancelReplay, checkoutReplay } from './checkout';
import { BugError, ERROR_STATUS } from './errors';
import { ORDER_STATUSES, type OrderStatus } from './statuses';

const hash = Uint8Array.from([7, 7, 7]);
const submitted = (status: OrderStatus, key = 'key-aaaaaaaa'): CheckoutReplayable => ({
  status,
  checkoutKey: key,
  checkoutHash: Buffer.from([7, 7, 7]),
});
const notSubmitted = (status: OrderStatus): CheckoutReplayable => ({
  status,
  checkoutKey: null,
  checkoutHash: null,
});

describe('checkoutReplay (§5.2)', () => {
  it.each(['PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'] as const)(
    'replays the same key and body as the order is now: %s',
    (status) => {
      expect(checkoutReplay(submitted(status), 'key-aaaaaaaa', hash)).toEqual({ kind: 'order' });
    },
  );

  it('refuses the same key with another body: 422', () => {
    expect(checkoutReplay(submitted('PENDING_PAYMENT'), 'key-aaaaaaaa', Uint8Array.from([7, 7]))).toEqual({
      kind: 'refused',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('refuses an order submitted under another key: 409 ALREADY_SUBMITTED, whatever its status', () => {
    for (const status of ['PENDING_PAYMENT', 'PAID', 'EXPIRED'] as const) {
      expect(checkoutReplay(submitted(status, 'other-key-1'), 'key-aaaaaaaa', hash)).toEqual({
        kind: 'refused',
        code: 'ALREADY_SUBMITTED',
      });
    }
  });

  it('answers 410 for a hold that ran out before checkout, expired by the sweeper or not yet', () => {
    for (const status of ['RESERVED', 'EXPIRED'] as const) {
      expect(checkoutReplay(notSubmitted(status), 'key-aaaaaaaa', hash)).toEqual({
        kind: 'refused',
        code: 'RESERVATION_EXPIRED',
      });
    }
  });

  it('answers 409 CONFLICT for an order closed before checkout', () => {
    for (const status of ['CANCELLED', 'REJECTED'] as const) {
      expect(checkoutReplay(notSubmitted(status), 'key-aaaaaaaa', hash)).toEqual({
        kind: 'refused',
        code: 'CONFLICT',
      });
    }
  });

  it('treats a status only a submit reaches, without its key, as a bug', () => {
    for (const status of ['PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED'] as const) {
      expect(() => checkoutReplay(notSubmitted(status), 'key-aaaaaaaa', hash)).toThrow(BugError);
    }
  });

  it('maps every refusal to 409, 410 or 422', () => {
    expect(CHECKOUT_REFUSALS.map((code) => ERROR_STATUS[code])).toEqual([422, 409, 410, 409]);
  });
});

describe('cancelReplay (§5.1)', () => {
  it.each(ORDER_STATUSES)('answers a cancel the CAS refused: %s', (status) => {
    expect(cancelReplay(status)).toEqual(
      status === 'CANCELLED' ? { kind: 'order' } : { kind: 'refused', code: 'CONFLICT' },
    );
  });
});
