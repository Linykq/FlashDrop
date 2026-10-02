import { KafkaEnv, loadEnv, PostgresEnv, RedisEnv, TOPICS } from '@flashdrop/config';
import { createKafka } from '@flashdrop/messaging';
import pg from 'pg';
import { createClient } from 'redis';

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Where the Compose infra is: the process environment, into which vitest.config.ts loads `.env` for the
 * global setup and the workers alike, or else the local defaults on 127.0.0.1.
 */
export function loadInfraEnv() {
  return loadEnv([PostgresEnv, RedisEnv, KafkaEnv]);
}

export type InfraEnv = ReturnType<typeof loadInfraEnv>;

export interface InfraProblem {
  readonly service: 'postgres' | 'redis' | 'kafka';
  /** `host:port` only, never the URL, which may carry credentials. */
  readonly target: string;
  readonly problem: string;
}

/** Checks that Postgres, Redis and Kafka answer, and that `kafka-init` has created the topics. */
export async function probeInfra(env: InfraEnv): Promise<InfraProblem[]> {
  const results = await Promise.all([
    probePostgres(env.DATABASE_URL),
    probeRedis(env.REDIS_URL),
    probeKafka(env.KAFKA_BROKERS),
  ]);
  return results.filter((result) => result !== undefined);
}

export function formatInfraProblems(problems: readonly InfraProblem[]): string {
  const serviceWidth = Math.max(...problems.map((p) => p.service.length));
  const targetWidth = Math.max(...problems.map((p) => p.target.length));
  return [
    'Integration tests need the Compose infra, which is not ready:',
    ...problems.map(
      (p) => `  ${p.service.padEnd(serviceWidth)}  ${p.target.padEnd(targetWidth)}  ${p.problem}`,
    ),
    'Start it with `pnpm infra:up`, then run `pnpm test:int` again.',
  ].join('\n');
}

async function probePostgres(url: string): Promise<InfraProblem | undefined> {
  const target = hostOf(url);
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: PROBE_TIMEOUT_MS });
  try {
    await client.connect();
    try {
      await client.query('select 1');
    } finally {
      await client.end();
    }
  } catch (error) {
    return { service: 'postgres', target, problem: describeError(error) };
  }
  return undefined;
}

async function probeRedis(url: string): Promise<InfraProblem | undefined> {
  const target = hostOf(url);
  const client = createClient({
    url,
    socket: { connectTimeout: PROBE_TIMEOUT_MS, reconnectStrategy: false },
  });
  // node-redis also emits connection failures as 'error' events, which crash the process when nobody
  // listens. connect() rejects with the same error, and that rejection is what gets reported.
  client.on('error', () => undefined);
  try {
    await client.connect();
    try {
      await client.ping();
    } finally {
      await client.close();
    }
  } catch (error) {
    return { service: 'redis', target, problem: describeError(error) };
  }
  return undefined;
}

async function probeKafka(brokers: readonly string[]): Promise<InfraProblem | undefined> {
  const target = brokers.join(',');
  const admin = createKafka({ brokers, clientId: 'flashdrop-infra-probe', logLevel: 'nothing' }).admin();
  try {
    await admin.connect();
    try {
      const topics = await admin.listTopics({ timeout: PROBE_TIMEOUT_MS });
      const missing = Object.values(TOPICS).filter((topic) => !topics.includes(topic));
      if (missing.length > 0) {
        return {
          service: 'kafka',
          target,
          problem: `topics missing: ${missing.join(', ')} (run \`docker compose run --rm kafka-init\`)`,
        };
      }
    } finally {
      await admin.disconnect();
    }
  } catch (error) {
    return { service: 'kafka', target, problem: describeError(error) };
  }
  return undefined;
}

function hostOf(url: string): string {
  const { hostname, port } = new URL(url);
  return port ? `${hostname}:${port}` : hostname;
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(describeError).join('; ');
  }
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
