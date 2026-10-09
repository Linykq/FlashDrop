import {
  CoreEnv,
  type EnvSource,
  KafkaEnv,
  LlmEnv,
  loadEnv,
  PostgresEnv,
  RedisEnv,
  RevalidateEnv,
  TestHooksEnv,
  WorkerEnv,
} from '@flashdrop/config';
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

/**
 * Optional: with `REVALIDATE_SECRET`, the drop scheduler asks `web` at `WEB_INTERNAL_URL` to revalidate the
 * `drops` tag on every status transition (§4.6, §8.1). Without it the home page catches up when its cache
 * entry expires (`cacheLife('minutes')`).
 */
export const WorkerRevalidateEnv = RevalidateEnv.partial();

/**
 * Everything the worker reads from the environment. `FD_TEST_HOOKS` is read by `@flashdrop/db` at the first
 * hook point, inside a payment or expiry transaction; validated here, a bad value fails the start instead.
 */
export function loadWorkerEnv(source?: EnvSource) {
  return loadEnv(
    [
      CoreEnv,
      PostgresEnv,
      RedisEnv,
      KafkaEnv,
      WorkerEnv,
      WorkerRevalidateEnv,
      LlmEnv,
      HealthEnv,
      TestHooksEnv,
    ],
    source,
  );
}

export type WorkerConfig = ReturnType<typeof loadWorkerEnv>;
