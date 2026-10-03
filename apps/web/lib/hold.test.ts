import type { OrderView } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import {
  announcedFrom,
  HOLD_MARGIN_MS,
  holdAnnouncement,
  holdClock,
  holdState,
  liveHold,
  liveHoldsFirst,
  rejectionText,
} from './hold';

const created = '2026-10-02T19:00:00.000Z';
const expires = '2026-10-02T19:02:00.000Z';
const at = (seconds: number) => Date.parse(created) + seconds * 1000;

describe('holdClock and holdState', () => {
  const clock = holdClock(created, expires);

  it('ends the hold 2 s before api does', () => {
    expect(clock.deadline).toBe(Date.parse(expires) - HOLD_MARGIN_MS);
    expect(holdState(clock.deadline - 1, clock).expired).toBe(false);
    expect(holdState(clock.deadline, clock)).toMatchObject({ expired: true, seconds: 0, fraction: 0 });
    expect(holdState(clock.deadline + 5_000, clock).remainingMs).toBe(0);
  });

  it('starts full and turns to the warning colour for the last minute', () => {
    expect(holdState(at(0), clock)).toMatchObject({ seconds: 118, fraction: 1, warning: false });
    expect(holdState(at(57.5), clock)).toMatchObject({ seconds: 61, warning: false });
    expect(holdState(at(58), clock)).toMatchObject({ seconds: 60, warning: true });
    expect(holdState(at(59), clock).fraction).toBeCloseTo(59 / 118);
  });

  it('never overfills the bar when the device clock runs behind', () => {
    expect(holdState(at(-30), clock).fraction).toBe(1);
  });
});

describe('holdAnnouncement', () => {
  it('speaks at 2:00, 1:00, 0:30 and 0:10 only', () => {
    const spoken: [number, string][] = [];
    for (let seconds = 180; seconds > 0; seconds--) {
      const text = holdAnnouncement(seconds, seconds - 1);
      if (text) spoken.push([seconds - 1, text]);
    }
    expect(spoken).toEqual([
      [120, '2 minutes left to check out.'],
      [60, '1 minute left.'],
      [30, '30 seconds left.'],
      [10, '10 seconds left.'],
    ]);
  });

  it('says only the latest crossing after a jump, and nothing without one', () => {
    expect(holdAnnouncement(125, 25)).toBe('30 seconds left.');
    expect(holdAnnouncement(118, 118)).toBeNull();
    expect(holdAnnouncement(90, 89)).toBeNull();
  });

  it('names the band of a fresh 2-minute hold on its first tick, although the 2 s margin starts it at 1:58', () => {
    const clock = holdClock(created, expires);
    const first = holdState(at(0), clock).seconds;
    expect(first).toBe(118);
    // Counted from the first value shown, 2:00 is never crossed and the first word comes at 1:00.
    expect(holdAnnouncement(first, first)).toBeNull();
    expect(announcedFrom(created, expires)).toBe(121);
    expect(holdAnnouncement(announcedFrom(created, expires), first)).toBe('2 minutes left to check out.');
  });

  it('names the band of a hold opened late, and of a short hold', () => {
    expect(holdAnnouncement(announcedFrom(created, expires), 45)).toBe('1 minute left.');
    const tenSeconds = '2026-10-02T19:00:10.000Z';
    expect(holdAnnouncement(announcedFrom(created, tenSeconds), 8)).toBe('10 seconds left.');
  });
});

/** An order of the buyer's, as `GET /me/orders` lists it, read at `serverNow`. */
function order(overrides: Partial<OrderView> & Pick<OrderView, 'id'>): OrderView {
  return {
    status: 'RESERVED',
    closeReason: null,
    dropId: 'drop-a',
    product: { id: 'product-a', slug: 'aurora-runner', title: 'Aurora Runner', imageKeys: [] },
    qty: 1,
    unitPriceCents: 12_900,
    totalCents: 12_900,
    currency: 'USD',
    createdAt: created,
    expiresAt: expires,
    extensions: 0,
    serverNow: '2026-10-02T19:01:00.000Z',
    ...overrides,
  };
}

describe('liveHold', () => {
  it('finds the live hold on the drop', () => {
    const held = order({ id: 'held', qty: 2 });
    expect(liveHold([order({ id: 'other', dropId: 'drop-b' }), held], 'drop-a')).toEqual({
      id: 'held',
      qty: 2,
      createdAt: created,
      expiresAt: expires,
    });
  });

  it('skips orders that are no longer holds, and holds past the UI deadline that api has not expired yet', () => {
    expect(
      liveHold([order({ id: 'paid', status: 'PAID' }), order({ id: 'gone', status: 'EXPIRED' })], 'drop-a'),
    ).toBe(null);
    // 1 s before expires_at: past the UI's deadline, still RESERVED in Postgres.
    expect(liveHold([order({ id: 'late', serverNow: '2026-10-02T19:01:59.000Z' })], 'drop-a')).toBeNull();
  });

  it('takes the buyer back to the hold that ends first', () => {
    const later = order({
      id: 'later',
      createdAt: '2026-10-02T19:00:30.000Z',
      expiresAt: '2026-10-02T19:02:30.000Z',
    });
    expect(liveHold([later, order({ id: 'sooner' })], 'drop-a')?.id).toBe('sooner');
  });
});

describe('liveHoldsFirst', () => {
  it('lists live holds first, soonest ending on top, then the rest in api order', () => {
    const orders = [
      order({ id: 'paid', status: 'PAID' }),
      order({ id: 'later', expiresAt: '2026-10-02T19:02:30.000Z' }),
      order({ id: 'expired-unswept', serverNow: '2026-10-02T19:02:01.000Z' }),
      order({ id: 'sooner' }),
      order({ id: 'cancelled', status: 'CANCELLED' }),
    ];
    expect(liveHoldsFirst(orders).map(({ id }) => id)).toEqual([
      'sooner',
      'later',
      'paid',
      'expired-unswept',
      'cancelled',
    ]);
  });
});

describe('rejectionText', () => {
  it('explains each refusal without system words', () => {
    expect(rejectionText('SOLD_OUT')).toBe('Every unit was claimed before your reservation went through.');
    expect(rejectionText('LIMIT')).toBe("You've already claimed the limit for this drop.");
    expect(rejectionText('NOT_LIVE')).toBe("The drop wasn't open when your request arrived.");
    expect(rejectionText('ORPHANED')).toBe("Your request didn't finish, so nothing was reserved.");
  });
});
