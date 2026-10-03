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
