import {
  ApiEnv,
  CoreEnv,
  type EnvSource,
  LlmEnv,
  loadEnv,
  PostgresEnv,
  RedisEnv,
  SessionEnv,
  TestingEnv,
} from '@flashdrop/config';
import { z } from 'zod';

/**
 * Where the server listens. Loopback by default, because in dev everything runs on 127.0.0.1 (design §15);
 * Compose sets `HOST=0.0.0.0` so that Caddy and web reach the api over the Compose network.
 */
export const ListenEnv = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z
    .string()
    .regex(/^\d+$/, 'must be a port number')
    .transform(Number)
    .pipe(z.int().min(1, 'must be a port number').max(65_535, 'must be a port number'))
    .default(4000),
});

/**
 * Everything the api reads from the environment. `LlmEnv` brings `UPLOAD_DIR`, shared with the worker;
 * `TestingEnv` mounts the test routes (§5.1) only with `ENABLE_TEST_ROUTES=true` and a secret.
 */
export function loadApiEnv(source?: EnvSource) {
  return loadEnv([CoreEnv, PostgresEnv, RedisEnv, SessionEnv, ApiEnv, LlmEnv, TestingEnv, ListenEnv], source);
}

export type ApiConfig = ReturnType<typeof loadApiEnv>;
