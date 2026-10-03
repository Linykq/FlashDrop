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
});
