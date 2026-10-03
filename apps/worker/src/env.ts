import { CoreEnv, type EnvSource, loadEnv, PostgresEnv, RedisEnv, WorkerEnv } from '@flashdrop/config';
import { z } from 'zod';

/**
 * Where the health endpoint listens (Compose healthcheck, design §15). Loopback by default: the probe runs
 * inside the container. Its own variable names, because in development the worker shares one `.env` with
 * `api`, whose `HOST` and `PORT` would otherwise collide with it.
 */
export const HealthEnv = z.object({
  HEALTH_HOST: z.string().min(1).default('127.0.0.1'),
  HEALTH_PORT: z
    .string()
    .regex(/^\d+$/, 'must be a port number')
    .transform(Number)
    .pipe(z.int().min(1, 'must be a port number').max(65_535, 'must be a port number'))
    .default(4200),
});

/** Everything the worker reads from the environment. */
export function loadWorkerEnv(source?: EnvSource) {
  return loadEnv([CoreEnv, PostgresEnv, RedisEnv, WorkerEnv, HealthEnv], source);
}

export type WorkerConfig = ReturnType<typeof loadWorkerEnv>;
