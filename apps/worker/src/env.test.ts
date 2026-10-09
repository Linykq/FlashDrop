import { EnvError } from '@flashdrop/config';
import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env';

const KEY = 'k'.repeat(32);

describe('loadWorkerEnv', () => {
  it('reads the roles and defaults the health endpoint to loopback', () => {
    const env = loadWorkerEnv({ WORKER_ROLES: 'sweeper, reconciler' });
    expect(env.WORKER_ROLES).toEqual(['sweeper', 'reconciler']);
    expect(env).toMatchObject({ HEALTH_HOST: '127.0.0.1', HEALTH_PORT: 4200 });
  });

  it('requires WORKER_ROLES and rejects unknown roles and bad ports', () => {
    expect(() => loadWorkerEnv({})).toThrow(EnvError);
    expect(() => loadWorkerEnv({ WORKER_ROLES: 'sweeper,janitor' })).toThrow(/WORKER_ROLES/);
    expect(() => loadWorkerEnv({ WORKER_ROLES: 'sweeper', HEALTH_PORT: '70000' })).toThrow(/HEALTH_PORT/);
  });

  it('runs the listing role on fixtures without an Anthropic key', () => {
    const env = loadWorkerEnv({ WORKER_ROLES: 'listing' });
    expect(env).toMatchObject({
      LLM_PROVIDER: 'fixture',
      LISTING_MODEL: 'claude-sonnet-5-5',
      LISTING_EFFORT: 'low',
    });
    expect(loadWorkerEnv({ WORKER_ROLES: 'listing', ANTHROPIC_API_KEY: 'sk-ant-x' }).LLM_PROVIDER).toBe(
      'anthropic',
    );
  });

  it('refuses race-matrix hooks at startup outside the tests', () => {
    expect(() =>
      loadWorkerEnv({ WORKER_ROLES: 'sweeper', NODE_ENV: 'production', FD_TEST_HOOKS: '1' }),
    ).toThrow(/FD_TEST_HOOKS/);
    expect(() => loadWorkerEnv({ WORKER_ROLES: 'sweeper', FD_TEST_HOOKS: 'maybe' })).toThrow(/FD_TEST_HOOKS/);
    expect(loadWorkerEnv({ WORKER_ROLES: 'sweeper' }).FD_TEST_HOOKS).toBe(false);
  });

  it('gives the PSP key to the payment role, which cannot start without it, and asks no other role for it', () => {
    expect(() => loadWorkerEnv({ WORKER_ROLES: 'payment,settlement' })).toThrow(
      /PSP_API_KEY\s+is required when WORKER_ROLES includes payment/,
    );
    expect(() => loadWorkerEnv({ WORKER_ROLES: 'payment', PSP_API_KEY: 'short' })).toThrow(/PSP_API_KEY/);
    expect(loadWorkerEnv({ WORKER_ROLES: ' payment ', PSP_API_KEY: KEY }).PSP_API_KEY).toBe(KEY);
    expect(loadWorkerEnv({ WORKER_ROLES: 'settlement,dashboard' }).PSP_API_KEY).toBeUndefined();
  });

  it('publishes every batch once unless the dup-delivery chaos mode is set on a disruptable stack', () => {
    expect(loadWorkerEnv({ WORKER_ROLES: 'relay' }).FD_CHAOS_DUP_DELIVERY).toBe(false);
    expect(
      loadWorkerEnv({ WORKER_ROLES: 'relay', FD_CHAOS_DUP_DELIVERY: 'true', FD_SYSTEM_TESTS: '1' })
        .FD_CHAOS_DUP_DELIVERY,
    ).toBe(true);
    // A leftover line in .env must not double every publish of `pnpm dev`.
    expect(() => loadWorkerEnv({ WORKER_ROLES: 'relay', FD_CHAOS_DUP_DELIVERY: 'true' })).toThrow(
      /FD_CHAOS_DUP_DELIVERY\s+may be true only with FD_SYSTEM_TESTS=1/,
    );
    expect(() => loadWorkerEnv({ WORKER_ROLES: 'relay', FD_CHAOS_DUP_DELIVERY: 'twice' })).toThrow(
      /FD_CHAOS_DUP_DELIVERY/,
    );
  });
});
