import { describe, expect, it } from 'vitest';
import { loginHref, safeReturnTo } from './routes';

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
