import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ApiEnv,
  CoreEnv,
  EnvError,
  KafkaEnv,
  LlmEnv,
  loadEnv,
  PostgresEnv,
  PspEnv,
  RedisEnv,
  RevalidateEnv,
  SessionEnv,
  TestingEnv,
  WebEnv,
  WorkerEnv,
} from './env';

const SECRET = 's'.repeat(32);

function loadError(...args: Parameters<typeof loadEnv>): EnvError {
  try {
    loadEnv(...args);
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error('expected loadEnv to throw an EnvError');
}

describe('loadEnv', () => {
  it('defaults connections to the local Compose stack on 127.0.0.1', () => {
    const env = loadEnv([CoreEnv, PostgresEnv, RedisEnv, KafkaEnv], {});

    expect(env).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://flashdrop:flashdrop@127.0.0.1:5433/flashdrop',
      REDIS_URL: 'redis://127.0.0.1:6379',
      KAFKA_BROKERS: ['127.0.0.1:9092'],
    });
  });

  it('parses lists, numbers, flags and ranges', () => {
    const env = loadEnv([ApiEnv, WorkerEnv, PspEnv, TestingEnv], {
      API_ROLES: ' ws ,http,ws',
      WS_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
      RATE_LIMIT_USER_PER_SEC: '1000',
      WORKER_ROLES: 'payment,settlement,dashboard',
      PSP_LATENCY_MS: '50',
      PSP_ERROR_RATE: '0',
      ENABLE_TEST_ROUTES: 'true',
      TEST_ROUTES_SECRET: 't'.repeat(16),
    });

    expect(env.API_ROLES).toEqual(['ws', 'http']);
    expect(env.WS_ALLOWED_ORIGINS).toEqual(['http://127.0.0.1:8080']);
    expect(env.RATE_LIMIT_USER_PER_SEC).toBe(1000);
    expect(env.RATE_LIMIT_IP_PER_SEC).toBe(100);
    expect(env.WORKER_ROLES).toEqual(['payment', 'settlement', 'dashboard']);
    expect(env.PSP_LATENCY_MS).toEqual({ minMs: 50, maxMs: 50 });
    expect(env.PSP_ERROR_RATE).toBe(0);
    expect(env.ENABLE_TEST_ROUTES).toBe(true);
    expect(env.FD_TEST_HOOKS).toBe(false);
  });

  it('treats empty values as unset', () => {
    const env = loadEnv([RedisEnv, PspEnv], { REDIS_URL: '', PSP_LATENCY_MS: '  ' });

    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6379');
    expect(env.PSP_LATENCY_MS).toEqual({ minMs: 100, maxMs: 800 });
  });

  it('returns a frozen object', () => {
    const env = loadEnv([SessionEnv], { SESSION_SECRET: SECRET });

    expect(Object.isFrozen(env)).toBe(true);
  });

  it('reports every problem across all schemas in one error', () => {
    const error = loadError([PostgresEnv, SessionEnv, KafkaEnv, ApiEnv, WorkerEnv], {
      DATABASE_URL: 'mysql://127.0.0.1/flashdrop',
      KAFKA_BROKERS: '127.0.0.1:9092,kafka',
      WS_ALLOWED_ORIGINS: 'http://127.0.0.1:3000/',
      WORKER_ROLES: 'relay,janitor',
    });

    expect(error.issues.map((issue) => issue.variable)).toEqual([
      'DATABASE_URL',
      'SESSION_SECRET',
      'KAFKA_BROKERS',
      'WS_ALLOWED_ORIGINS',
      'WORKER_ROLES',
    ]);
    expect(error.issues[0]?.problem).toBe('must be a postgres:// URL');
    expect(error.issues[1]?.problem).toBe('is not set');
    expect(error.message).toMatch(
      /^Invalid environment \(5 problems\):\n {2}DATABASE_URL {8}must be a postgres:\/\/ URL\n/,
    );
    expect(error.message).toMatch(/see \.env\.example/);
  });

  it('names bad list entries by position', () => {
    const error = loadError([ApiEnv], { API_ROLES: 'http,,foo,ws', WS_ALLOWED_ORIGINS: 'nope,http://a/b' });

    expect(error.issues).toEqual([
      { variable: 'API_ROLES', problem: 'entry 2: is empty' },
      { variable: 'API_ROLES', problem: 'entry 3: must be one of http, ws' },
      { variable: 'WS_ALLOWED_ORIGINS', problem: 'entry 1: must be an http(s) URL' },
      {
        variable: 'WS_ALLOWED_ORIGINS',
        problem: 'entry 2: must be an origin such as http://127.0.0.1:3000 (no path or trailing slash)',
      },
    ]);
  });

  it.each([
    ['RATE_LIMIT_IP_PER_SEC', 'abc', 'must be a whole number'],
    ['RATE_LIMIT_IP_PER_SEC', '0x10', 'must be a whole number'],
    ['RATE_LIMIT_IP_PER_SEC', '1e3', 'must be a whole number'],
    ['RATE_LIMIT_USER_PER_SEC', '0', 'must be positive'],
  ])('rejects %s=%s', (variable, value, problem) => {
    expect(loadError([ApiEnv], { [variable]: value }).issues).toEqual([{ variable, problem }]);
  });

  it.each(['abc', '1.5', '-0.1', '1e-3'])('rejects the ratio %s', (value) => {
    expect(loadError([PspEnv], { PSP_ERROR_RATE: value }).issues).toEqual([
      { variable: 'PSP_ERROR_RATE', problem: 'must be a number between 0 and 1' },
    ]);
  });

  it('never echoes values, which may be secrets', () => {
    const error = loadError([SessionEnv, LlmEnv], {
      SESSION_SECRET: 'hunter2-too-short',
      LLM_PROVIDER: 'anthropic',
    });

    expect(error.message).not.toContain('hunter2');
    expect(error.issues).toEqual([
      { variable: 'SESSION_SECRET', problem: 'must be at least 32 characters' },
      { variable: 'ANTHROPIC_API_KEY', problem: 'is required when LLM_PROVIDER=anthropic' },
    ]);
  });

  it('requires a secret when test routes are enabled', () => {
    const error = loadError([TestingEnv], { ENABLE_TEST_ROUTES: 'yes' });

    expect(error.issues).toEqual([
      { variable: 'TEST_ROUTES_SECRET', problem: 'is required when ENABLE_TEST_ROUTES=true' },
    ]);
  });

  it('rejects flags that are not booleans', () => {
    const error = loadError([TestingEnv], { FD_TEST_HOOKS: 'sometimes' });

    expect(error.issues).toEqual([{ variable: 'FD_TEST_HOOKS', problem: 'must be true or false' }]);
  });
});

describe('LlmEnv', () => {
  it('falls back to fixtures without an API key', () => {
    const env = loadEnv([LlmEnv], {});

    expect(env).toEqual({
      LLM_PROVIDER: 'fixture',
      LISTING_MODEL: 'claude-sonnet-5-5',
      LISTING_EFFORT: 'low',
      LLM_RECORD: false,
      UPLOAD_DIR: join(tmpdir(), 'flashdrop', 'uploads'),
    });
  });

  it('uses Anthropic when a key is present, unless told otherwise', () => {
    expect(loadEnv([LlmEnv], { ANTHROPIC_API_KEY: 'key' }).LLM_PROVIDER).toBe('anthropic');
    expect(loadEnv([LlmEnv], { ANTHROPIC_API_KEY: 'key', LLM_PROVIDER: 'fixture' }).LLM_PROVIDER).toBe(
      'fixture',
    );
  });

  it('records only from Anthropic', () => {
    expect(loadEnv([LlmEnv], { ANTHROPIC_API_KEY: 'key', LLM_RECORD: 'true' }).LLM_RECORD).toBe(true);
    expect(loadError([LlmEnv], { LLM_RECORD: 'true' }).issues).toEqual([
      { variable: 'ANTHROPIC_API_KEY', problem: 'is required when LLM_RECORD is on' },
    ]);
    expect(
      loadError([LlmEnv], { ANTHROPIC_API_KEY: 'key', LLM_PROVIDER: 'fixture', LLM_RECORD: 'true' }).issues,
    ).toEqual([{ variable: 'LLM_RECORD', problem: 'must be false when LLM_PROVIDER=fixture' }]);
  });

  it('needs an absolute UPLOAD_DIR, so api and the worker share it', () => {
    const shared = join(tmpdir(), 'flashdrop-shared-uploads');

    expect(loadEnv([LlmEnv], { UPLOAD_DIR: shared }).UPLOAD_DIR).toBe(shared);
    expect(loadError([LlmEnv], { UPLOAD_DIR: 'uploads' }).issues).toEqual([
      { variable: 'UPLOAD_DIR', problem: 'must be an absolute path' },
    ]);
  });
});

describe('.env.example', () => {
  const example = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));
  const schemas = [
    CoreEnv,
    PostgresEnv,
    RedisEnv,
    KafkaEnv,
    SessionEnv,
    RevalidateEnv,
    ApiEnv,
    WorkerEnv,
    WebEnv,
    PspEnv,
    LlmEnv,
    TestingEnv,
  ] as const;

  it('is a valid environment for every schema', () => {
    expect(() => loadEnv(schemas, example)).not.toThrow();
  });

  it('documents exactly the variables the schemas read', () => {
    const read = schemas.flatMap((schema) => Object.keys('shape' in schema ? schema.shape : schema.in.shape));
    // NODE_ENV is set by the runtime (Next.js, Vitest, the Docker images), never in .env.
    const documented = [...Object.keys(example), 'NODE_ENV'];

    expect(documented.sort()).toEqual(read.sort());
  });
});
