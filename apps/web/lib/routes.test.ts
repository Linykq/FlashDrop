import { describe, expect, it } from 'vitest';
import {
  adminHref,
  checkoutHref,
  liveRoomHref,
  loginHref,
  orderHref,
  orderPageHref,
  safeReturnTo,
} from './routes';

describe('safeReturnTo', () => {
  it('keeps paths on this origin, with their query and hash', () => {
    expect(safeReturnTo('/p/sage-wireless-headphones')).toBe('/p/sage-wireless-headphones');
    expect(safeReturnTo('/p/a?ref=nav#details')).toBe('/p/a?ref=nav#details');
  });

  it.each([
    ['https://evil.example/', 'an absolute URL'],
    ['//evil.example/path', 'a protocol-relative URL'],
    ['/\\evil.example', 'a backslash host'],
    ['/\t/evil.example', 'a tab the browser strips'],
    ['javascript:alert(1)', 'a script URL'],
    ['p/relative', 'a relative path'],
    ['', 'an empty value'],
    [undefined, 'a missing value'],
    [['/a', '/b'], 'a repeated parameter'],
  ] as [unknown, string][])('falls back to / for %j (%s)', (value) => {
    expect(safeReturnTo(value)).toBe('/');
  });
});

describe('loginHref', () => {
  it('carries the page to return to, except the home page', () => {
    expect(loginHref('/p/a b')).toBe('/login?returnTo=%2Fp%2Fa+b');
    expect(loginHref('/')).toBe('/login');
    expect(loginHref()).toBe('/login');
  });
});

describe('orderHref', () => {
  const id = '6f1c2a3b-4d5e-5f60-8a7b-9c0d1e2f3a4b';

  it('opens a held order at checkout', () => {
    expect(orderHref({ id, status: 'RESERVED' })).toBe(checkoutHref(id));
    expect(checkoutHref(id)).toBe(`/checkout/${id}`);
  });

  it('opens every other order on its status page', () => {
    expect(orderPageHref(id)).toBe(`/orders/${id}`);
    for (const status of ['PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'] as const) {
      expect(orderHref({ id, status })).toBe(`/orders/${id}`);
    }
  });
});

describe('liveRoomHref and adminHref', () => {
  it('links a drop that sells on stream to its room, and nothing otherwise', () => {
    expect(liveRoomHref({ slug: 'studio', title: 'FlashDrop Studio' })).toBe('/live/studio');
    expect(liveRoomHref(null)).toBeNull();
  });

  it('offers the admin area to admins only', () => {
    expect(adminHref('admin')).toBe('/admin/drops');
    expect(adminHref('buyer')).toBeNull();
  });
});
