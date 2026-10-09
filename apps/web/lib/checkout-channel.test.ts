import { describe, expect, it } from 'vitest';
import { parseCheckoutMessage } from './checkout-channel';

const orderId = '0192a3b4-0000-7000-8000-000000000001';

describe('parseCheckoutMessage', () => {
  it('reads an order that left checkout in another tab', () => {
    expect(parseCheckoutMessage({ orderId, kind: 'ended', end: 'placed' })).toEqual({
      orderId,
      kind: 'ended',
      end: 'placed',
    });
    expect(parseCheckoutMessage({ orderId, kind: 'ended', end: 'left' })?.kind).toBe('ended');
  });

  it("reads another tab's extension", () => {
    const message = {
      orderId,
      kind: 'hold',
      expiresAt: '2026-10-02T19:03:00.000Z',
      extensions: 1,
      serverNow: 1_790_000_000_000,
    };
    expect(parseCheckoutMessage(message)).toEqual(message);
  });

  it('ignores what another build of the page might send', () => {
    expect(parseCheckoutMessage(null)).toBeNull();
    expect(parseCheckoutMessage({ kind: 'ended', end: 'placed' })).toBeNull();
    expect(parseCheckoutMessage({ orderId, kind: 'ended', end: 'expired' })).toBeNull();
    expect(
      parseCheckoutMessage({ orderId, kind: 'hold', expiresAt: 'soon', extensions: 1, serverNow: 1 }),
    ).toBeNull();
    expect(
      parseCheckoutMessage({
        orderId,
        kind: 'hold',
        expiresAt: '2026-10-02T19:03:00.000Z',
        extensions: -1,
        serverNow: 1,
      }),
    ).toBeNull();
  });
});
