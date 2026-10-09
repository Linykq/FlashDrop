import { delimiter } from 'node:path';

/*
 * Which Compose stack a chaos run breaks. By default the isolated project of compose.isolated.yaml
 * (`flashdrop-sys`, design §15): a stack of its own on other host ports, so killing its Redis or pausing its
 * Kafka never fails the integration runs, E2E specs and dev servers that share the main stack on this
 * machine. CI's nightly job instead gives the run a throwaway stack and says so the way the system job does:
 * COMPOSE_FILE names that stack's files, FD_SYSTEM_TESTS=1 allows breaking it, and DATABASE_URL, REDIS_URL,
 * KAFKA_BROKERS and E2E_BASE_URL point at it.
 *
 * It must be settled before the run calls anything of tools/system/support.ts: its functions read the
 * connection variables, and refuse to touch Compose without FD_SYSTEM_TESTS=1, when they run.
 */

/** compose.isolated.yaml's project: its files (`;` separates them on Windows) and published host ports. */
const ISOLATED_STACK = {
  COMPOSE_FILE: ['compose.yaml', 'compose.ci.yaml', 'compose.isolated.yaml'].join(delimiter),
  // compose.ci.yaml requires one; the api, k6 and the test-route calls all read it from here.
  TEST_ROUTES_SECRET: 'sys-only-test-routes-secret',
  DATABASE_URL: 'postgres://flashdrop:flashdrop@127.0.0.1:15433/flashdrop',
  REDIS_URL: 'redis://127.0.0.1:16379',
  KAFKA_BROKERS: '127.0.0.1:19094',
  E2E_BASE_URL: 'http://127.0.0.1:18080',
  FD_SYSTEM_TESTS: '1',
} as const;

export type Target = 'isolated' | 'from-environment';

/** Points this process, and every `docker compose` and tool it starts, at the stack to break. */
export function selectTarget(env: NodeJS.ProcessEnv = process.env): Target {
  if (env.COMPOSE_FILE === undefined || env.COMPOSE_FILE === '') {
    Object.assign(env, ISOLATED_STACK);
    return 'isolated';
  }
  if (env.FD_SYSTEM_TESTS !== '1') {
    throw new Error(
      `COMPOSE_FILE=${env.COMPOSE_FILE} names a stack, and a chaos run kills and pauses its services: ` +
        'set FD_SYSTEM_TESTS=1 to allow it, or unset COMPOSE_FILE to use the isolated stack',
    );
  }
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'KAFKA_BROKERS', 'E2E_BASE_URL', 'TEST_ROUTES_SECRET']) {
    if (!env[name]) throw new Error(`COMPOSE_FILE is set, so ${name} must point at that stack too`);
  }
  return 'from-environment';
}
