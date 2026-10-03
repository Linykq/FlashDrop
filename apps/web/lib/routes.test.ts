import { describe, expect, it } from 'vitest';
import { checkoutHref, loginHref, orderHref, safeReturnTo } from './routes';

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

  it('opens an ended order where its outcome is shown', () => {
    // Checkout shows EXPIRED and REJECTED until the order status page arrives (M3).
    expect(orderHref({ id, status: 'EXPIRED' })).toBe(`/checkout/${id}`);
    expect(orderHref({ id, status: 'REJECTED' })).toBe(`/checkout/${id}`);
  });
});
