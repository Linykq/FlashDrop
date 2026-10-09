import { EnvError } from '@flashdrop/config';
import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env';

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
      loadWorkerEnv({ WORKER_ROLES: 'payment', NODE_ENV: 'production', FD_TEST_HOOKS: '1' }),
    ).toThrow(/FD_TEST_HOOKS/);
    expect(() => loadWorkerEnv({ WORKER_ROLES: 'payment', FD_TEST_HOOKS: 'maybe' })).toThrow(/FD_TEST_HOOKS/);
    expect(loadWorkerEnv({ WORKER_ROLES: 'payment' }).FD_TEST_HOOKS).toBe(false);
  });
});
