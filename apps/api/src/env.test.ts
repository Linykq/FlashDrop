import { EnvError } from '@flashdrop/config';
import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env';

const SECRET = 's'.repeat(32);

describe('loadApiEnv', () => {
  it('listens on 127.0.0.1:4000 with both roles by default', () => {
    const env = loadApiEnv({ SESSION_SECRET: SECRET });
    expect(env).toMatchObject({ HOST: '127.0.0.1', PORT: 4000, API_ROLES: ['http', 'ws'] });
  });

  it('reads the Compose settings', () => {
    const env = loadApiEnv({ SESSION_SECRET: SECRET, HOST: '0.0.0.0', PORT: '4000', API_ROLES: 'http' });
    expect(env).toMatchObject({ HOST: '0.0.0.0', PORT: 4000, API_ROLES: ['http'] });
  });

  it('reads Redis, the rate limits and the test-route switch, closed by default', () => {
    expect(loadApiEnv({ SESSION_SECRET: SECRET })).toMatchObject({
      REDIS_URL: 'redis://127.0.0.1:6379',
      RATE_LIMIT_USER_PER_SEC: 10,
      RATE_LIMIT_IP_PER_SEC: 100,
      ENABLE_TEST_ROUTES: false,
    });
    expect(() => loadApiEnv({ SESSION_SECRET: SECRET, ENABLE_TEST_ROUTES: 'true' })).toThrow(
      /TEST_ROUTES_SECRET\s+is required/,
    );
  });

  it('keeps the dev login off unless asked, and refuses it beside any origin that is not this machine', () => {
    expect(loadApiEnv({ SESSION_SECRET: SECRET }).ENABLE_DEV_LOGIN).toBe(false);
    const local = 'http://127.0.0.1:8080,http://localhost:3000,http://[::1]:3000';
    expect(
      loadApiEnv({ SESSION_SECRET: SECRET, ENABLE_DEV_LOGIN: 'true', WS_ALLOWED_ORIGINS: local })
        .ENABLE_DEV_LOGIN,
    ).toBe(true);
    for (const origin of [
      'https://shop.example.com',
      'http://192.168.1.20:8080',
      'http://127.0.0.1.nip.io',
    ]) {
      expect(() =>
        loadApiEnv({
          SESSION_SECRET: SECRET,
          ENABLE_DEV_LOGIN: 'true',
          WS_ALLOWED_ORIGINS: `http://127.0.0.1:8080,${origin}`,
        }),
      ).toThrow(
        /ENABLE_DEV_LOGIN\s+must be false when WS_ALLOWED_ORIGINS has an origin other than 127\.0\.0\.1/,
      );
    }
  });

  it('trusts forwarded headers from loopback only, unless TRUST_PROXY names the edge', () => {
    expect(loadApiEnv({ SESSION_SECRET: SECRET }).TRUST_PROXY).toEqual(['loopback']);
    expect(
      loadApiEnv({ SESSION_SECRET: SECRET, TRUST_PROXY: '172.30.0.10, 10.0.0.0/8,fd00::/8' }).TRUST_PROXY,
    ).toEqual(['172.30.0.10', '10.0.0.0/8', 'fd00::/8']);
    for (const bad of ['caddy', '10.0.0.0/33', '172.30.0.10/', '1.2.3.4/8/9']) {
      expect(() => loadApiEnv({ SESSION_SECRET: SECRET, TRUST_PROXY: bad })).toThrow(/TRUST_PROXY/);
    }
  });

  it('marks the session cookie Secure in production behind https origins, or as COOKIE_SECURE says', () => {
    const https = { SESSION_SECRET: SECRET, WS_ALLOWED_ORIGINS: 'https://shop.example.com' };
    expect(loadApiEnv({ SESSION_SECRET: SECRET }).COOKIE_SECURE).toBe(false);
    expect(loadApiEnv({ ...https, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
    expect(loadApiEnv({ ...https, NODE_ENV: 'development' }).COOKIE_SECURE).toBe(false);
    // The Compose stack: production images behind the plain-http local edge.
    expect(
      loadApiEnv({
        SESSION_SECRET: SECRET,
        NODE_ENV: 'production',
        WS_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
      }).COOKIE_SECURE,
    ).toBe(false);
    expect(loadApiEnv({ ...https, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(
      false,
    );
    expect(loadApiEnv({ SESSION_SECRET: SECRET, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    // NODE_ENV stays CoreEnv's.
    expect(loadApiEnv({ ...https, NODE_ENV: 'production' }).NODE_ENV).toBe('production');
  });

  it('fails fast on a bad port or a missing secret', () => {
    let error: unknown;
    try {
      loadApiEnv({ PORT: '70000' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as EnvError).issues).toEqual([
      { variable: 'SESSION_SECRET', problem: 'is not set' },
      { variable: 'PORT', problem: 'must be a port number' },
    ]);
  });
});
