import { describe, expect, it } from 'vitest';
import { createPool, POOL_PROFILES, startupOptions } from './pool';

describe('startupOptions', () => {
  it('turns session settings into libpq -c options', () => {
    expect(startupOptions(POOL_PROFILES.api.settings)).toBe(
      '-c statement_timeout=2s -c transaction_timeout=5s',
    );
    expect(startupOptions(POOL_PROFILES.relay.settings)).toBe(
      '-c idle_in_transaction_session_timeout=30s -c transaction_timeout=20s',
    );
  });

  it('sends nothing for the maintenance profile, so migrations run without limits', () => {
    expect(startupOptions(POOL_PROFILES.maintenance.settings)).toBeUndefined();
  });
});

describe('createPool', () => {
  it('bounds the wait for a connection, which pg would otherwise never give up on', async () => {
    const pool = createPool({
      connectionString: 'postgres://flashdrop@127.0.0.1:1/flashdrop',
      logger: { warn: () => undefined },
      ...POOL_PROFILES.api,
    });
    try {
      expect(pool.options).toMatchObject({
        connectionTimeoutMillis: 2_000,
        options: '-c statement_timeout=2s -c transaction_timeout=5s',
      });
    } finally {
      await pool.end();
    }
  });
});
