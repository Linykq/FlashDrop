import { describe, expect, it } from 'vitest';
import { offsetFromRoundTrip, responseArrivedAt } from './clock';

describe('responseArrivedAt', () => {
  it('anchors the server reading at the first byte of the response, not at hydration', () => {
    // The document's first byte came 600 ms into the navigation; hydration, on a throttled phone, at 2.6 s.
    const navigationStartWall = 1_000_000;
    const monotonicNow = 2_600;
    const wallNow = navigationStartWall + monotonicNow;
    expect(responseArrivedAt(600, monotonicNow, wallNow)).toBe(navigationStartWall + 600);
  });

  it('measures on the monotonic clock, so a device clock adjusted since does not skew it', () => {
    // The device clock jumped 5 minutes ahead after the response: the anchor stays 2 s before "now".
    expect(responseArrivedAt(600, 2_600, 9_000_000)).toBe(9_000_000 - 2_000);
  });

  it('has no anchor without navigation timing', () => {
    expect(responseArrivedAt(undefined, 2_600, 1_000)).toBeNull();
    expect(responseArrivedAt(0, 2_600, 1_000)).toBeNull();
  });
});

describe('offsetFromRoundTrip', () => {
  it('takes the midpoint of the round trip, off by at most half of it', () => {
    // The server read its clock (10 s ahead of the device) halfway through a 400 ms round trip.
    const sentAt = 50_000;
    const receivedAt = 50_400;
    const serverNow = sentAt + 200 + 10_000;
    expect(offsetFromRoundTrip(serverNow, sentAt, receivedAt)).toEqual({ offset: 10_000, error: 200 });
  });

  it('never trusts a negative round trip (a device clock set back mid-request)', () => {
    expect(offsetFromRoundTrip(5_000, 1_000, 900)).toEqual({ offset: 4_100, error: 0 });
  });
});
