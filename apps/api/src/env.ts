import {
  ApiEnv,
  CoreEnv,
  type EnvSource,
  KafkaEnv,
  LlmEnv,
  listenEnv,
  loadEnv,
  PostgresEnv,
  RedisEnv,
  SessionEnv,
  TestingEnv,
} from '@flashdrop/config';

/** `HOST` and `PORT`: 127.0.0.1:4000 unless Compose says `HOST=0.0.0.0` (design §15). */
export const ListenEnv = listenEnv(4000);

/**
 * Everything the api reads from the environment. `LlmEnv` brings `UPLOAD_DIR`, shared with the worker;
 * `TestingEnv` mounts the test routes (§5.1) only with `ENABLE_TEST_ROUTES=true` and a secret; `KafkaEnv`
 * is for the admin health tiles' consumer lag and dead letters (§12).
 */
export function loadApiEnv(source?: EnvSource) {
  return loadEnv(
    [CoreEnv, PostgresEnv, RedisEnv, KafkaEnv, SessionEnv, ApiEnv, LlmEnv, TestingEnv, ListenEnv],
    source,
  );
}

export type ApiConfig = ReturnType<typeof loadApiEnv>;
