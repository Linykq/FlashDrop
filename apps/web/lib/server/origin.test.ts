import { EnvError } from '@flashdrop/config';
import { describe, expect, it } from 'vitest';
import { browserOrigin, originFromEnv } from './origin';

describe('originFromEnv', () => {
  it('is the configured origin, whatever host a request claims', () => {
    expect(originFromEnv({ PUBLIC_ORIGIN: 'https://shop.example' })).toBe('https://shop.example');
    expect(originFromEnv({ PUBLIC_ORIGIN: 'http://127.0.0.1:8091', NODE_ENV: 'development' })).toBe(
      'http://127.0.0.1:8091',
    );
  });

  it("defaults to Caddy's edge, and to web's own port under `pnpm dev`", () => {
    expect(originFromEnv({})).toBe('http://127.0.0.1:8080');
    expect(originFromEnv({ NODE_ENV: 'production' })).toBe('http://127.0.0.1:8080');
    expect(originFromEnv({ NODE_ENV: 'development' })).toBe('http://127.0.0.1:3000');
  });

  it.each([
    ['a path', 'https://shop.example/p'],
    ['a trailing slash', 'https://shop.example/'],
    ['another scheme', 'javascript://shop.example'],
    ['no URL at all', 'evil.example'],
  ])('refuses %s', (_case, value) => {
    expect(() => originFromEnv({ PUBLIC_ORIGIN: value })).toThrow(EnvError);
  });
});

describe('browserOrigin', () => {
  it("forwards the browser's own Origin as it came", () => {
    expect(browserOrigin(new Headers({ origin: 'http://127.0.0.1:8080' }))).toBe('http://127.0.0.1:8080');
    expect(browserOrigin(new Headers({ origin: 'https://evil.example' }))).toBe('https://evil.example');
  });

  it('is null without one, so the write is refused instead of vouched for', () => {
    expect(browserOrigin(new Headers())).toBeNull();
    expect(browserOrigin(new Headers({ origin: 'null' }))).toBeNull();
    expect(
      browserOrigin(new Headers({ host: 'evil.example', 'x-forwarded-host': 'evil.example' })),
    ).toBeNull();
  });
});
