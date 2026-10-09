import {
  CoreEnv,
  type EnvSource,
  KafkaEnv,
  LlmEnv,
  loadEnv,
  PostgresEnv,
  PspAuthEnv,
  port,
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
  HEALTH_PORT: port(4200),
});

/**
 * Optional: with `REVALIDATE_SECRET`, the drop scheduler asks `web` at `WEB_INTERNAL_URL` to revalidate the
 * `drops` tag on every status transition (§4.6, §8.1). Without it the home page catches up when its cache
 * entry expires (`cacheLife('minutes')`).
 */
export const WorkerRevalidateEnv = RevalidateEnv.partial();

/** Whether `WORKER_ROLES`, as written, names `role`; `WorkerEnv` validates the list itself. */
const namesRole = (roles: string | undefined, role: string) =>
  roles?.split(',').some((entry) => entry.trim() === role) ?? false;

/**
 * `PSP_API_KEY`, which the payment role needs to call the PSP (§6.5) and no other role is given: Compose
 * passes it to the `consumers` service only.
 */
export const WorkerPspEnv = PspAuthEnv.partial()
  .extend({ WORKER_ROLES: z.string().optional() })
  .superRefine((env, ctx) => {
    if (env.PSP_API_KEY === undefined && namesRole(env.WORKER_ROLES, 'payment')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PSP_API_KEY'],
        message: 'is required when WORKER_ROLES includes payment',
      });
    }
  })
  // Only the key: WORKER_ROLES belongs to WorkerEnv, which parses it into a list.
  .transform(({ PSP_API_KEY }) => ({ PSP_API_KEY }));

/**
 * The `dup-delivery` chaos case (design §13): `FD_CHAOS_DUP_DELIVERY=true` makes the relay publish every
 * batch twice, so each consumer group receives every event at least twice and has to dedupe it (§6.4). It
 * doubles the load on every group, so like the system tests it needs `FD_SYSTEM_TESTS=1`, which says this
 * stack may be disrupted: a leftover line in `.env` cannot turn it on for `pnpm dev`. compose.yaml never
 * passes either to a container; only the chaos overlay does, on the isolated stack's worker
 * (tests/chaos/compose.dup-delivery.yaml).
 */
export const ChaosEnv = z
  .object({
    FD_CHAOS_DUP_DELIVERY: z.stringbool({ error: 'must be true or false' }).default(false),
    FD_SYSTEM_TESTS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.FD_CHAOS_DUP_DELIVERY && env.FD_SYSTEM_TESTS !== '1') {
      ctx.addIssue({
        code: 'custom',
        path: ['FD_CHAOS_DUP_DELIVERY'],
        message: 'may be true only with FD_SYSTEM_TESTS=1 (the chaos overlay sets both)',
      });
    }
  })
  .transform(({ FD_CHAOS_DUP_DELIVERY }) => ({ FD_CHAOS_DUP_DELIVERY }));

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
      WorkerPspEnv,
      LlmEnv,
      HealthEnv,
      TestHooksEnv,
      ChaosEnv,
    ],
    source,
  );
}

export type WorkerConfig = ReturnType<typeof loadWorkerEnv>;
