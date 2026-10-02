import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { API_ROLES, WORKER_ROLES } from './constants';

/*
 * Environment for every FlashDrop process (design §15). Variables are grouped into small schemas so that
 * each process validates exactly what it reads:
 *
 *   const env = loadEnv([CoreEnv, PostgresEnv, RedisEnv, SessionEnv, ApiEnv]);
 *
 * Connection settings default to the local Compose stack on 127.0.0.1, so the infra and the tests need no
 * `.env`. The apps also need the secrets and `WORKER_ROLES`, which have no defaults; `.env.example`
 * documents every variable with development values.
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LLM_PROVIDERS = ['anthropic', 'fixture'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** `output_config.effort` levels accepted by the listing models (§10). */
export const LISTING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ListingEffort = (typeof LISTING_EFFORTS)[number];

const oneOf = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, { error: `must be one of ${values.join(', ')}` });

/**
 * A comma-separated list with every entry validated by `item`, then de-duplicated. An empty entry is an
 * error rather than skipped, so the position in each problem matches the value as written.
 */
const list = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((value) => value.split(',').map((entry) => entry.trim()))
    .pipe(z.array(z.string().min(1, 'is empty').pipe(item)))
    .transform((entries) => [...new Set(entries)]);

// abort: a value that is not a URL at all must not reach the origin check, where `new URL` would throw.
const httpUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL', abort: true });

const origin = httpUrl.refine(
  (value) => new URL(value).origin === value,
  'must be an origin such as http://127.0.0.1:3000 (no path or trailing slash)',
);

const secret = (minLength: number) => z.string().min(minLength, `must be at least ${minLength} characters`);

const flag = z.stringbool({ error: 'must be true or false' });

// Plain digits only: Number() would also accept `0x10`, `1e3` and `Infinity`.
const ratio = z
  .string()
  .regex(/^\d*\.?\d+$/, 'must be a number between 0 and 1')
  .transform(Number)
  .pipe(z.number().max(1, 'must be a number between 0 and 1'));

const perSecond = z
  .string()
  .regex(/^\d+$/, 'must be a whole number')
  .transform(Number)
  .pipe(z.int().positive('must be positive'));

/** `100-800` (uniformly random latency within the range) or a fixed `50`. */
const latencyRange = z
  .string()
  .regex(/^\d+(-\d+)?$/, 'must be milliseconds such as 100-800 or 50')
  .transform((value) => {
    const bounds = value.split('-').map(Number);
    return { minMs: Math.min(...bounds), maxMs: Math.max(...bounds) };
  });

export const CoreEnv = z.object({
  NODE_ENV: oneOf(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: oneOf(LOG_LEVELS).default('info'),
});

export const PostgresEnv = z.object({
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' })
    .default('postgres://flashdrop:flashdrop@127.0.0.1:5433/flashdrop'),
});

export const RedisEnv = z.object({
  REDIS_URL: z
    .url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' })
    .default('redis://127.0.0.1:6379'),
});

export const KafkaEnv = z.object({
  KAFKA_BROKERS: list(z.string().regex(/^[\w.-]+:\d{1,5}$/, 'must be host:port')).prefault('127.0.0.1:9092'),
});

/** HS256 key for the `fd_session` cookie, shared by `api` and `web` (§11). */
export const SessionEnv = z.object({
  SESSION_SECRET: secret(32),
});

/** Shared secret for `web`'s internal revalidation route, called by `worker` (§8.1). */
export const RevalidateEnv = z.object({
  REVALIDATE_SECRET: secret(32),
});

export const ApiEnv = z.object({
  API_ROLES: list(oneOf(API_ROLES)).prefault('http,ws'),
  WS_ALLOWED_ORIGINS: list(origin).prefault('http://127.0.0.1:3000,http://127.0.0.1:8080'),
  RATE_LIMIT_IP_PER_SEC: perSecond.default(100),
  RATE_LIMIT_USER_PER_SEC: perSecond.default(10),
});

export const WorkerEnv = z.object({
  WORKER_ROLES: list(oneOf(WORKER_ROLES)),
  WEB_INTERNAL_URL: httpUrl.default('http://127.0.0.1:3000'),
  PAYMENT_MOCK_URL: httpUrl.default('http://127.0.0.1:4100'),
});

/**
 * `web`'s settings, validated on the server at startup. Client code reads `process.env.NEXT_PUBLIC_WS_URL`
 * directly: Next.js inlines only literal `process.env.NEXT_PUBLIC_*` references into the browser bundle,
 * so `loadEnv`, which enumerates `process.env`, would never see the value there.
 */
export const WebEnv = z.object({
  API_INTERNAL_URL: httpUrl.default('http://127.0.0.1:4000'),
  /** Dev override only; the browser otherwise derives the socket URL from `location` (§8.1). */
  NEXT_PUBLIC_WS_URL: z.url({ protocol: /^wss?$/, error: 'must be a ws:// URL' }).optional(),
});

export const PspEnv = z.object({
  PSP_LATENCY_MS: latencyRange.prefault('100-800'),
  PSP_ERROR_RATE: ratio.default(0.02),
  PSP_TIMEOUT_AFTER_SUCCESS_RATE: ratio.default(0.01),
});

/**
 * Without `LLM_PROVIDER`, the listing generator uses Anthropic when a key is present and the recorded
 * fixtures otherwise, so CI and fresh clones need no secret (§10).
 */
export const LlmEnv = z
  .object({
    LLM_PROVIDER: oneOf(LLM_PROVIDERS).optional(),
    LISTING_MODEL: z.string().default('claude-sonnet-5-5'),
    LISTING_EFFORT: oneOf(LISTING_EFFORTS).default('low'),
    ANTHROPIC_API_KEY: z.string().optional(),
    LLM_RECORD: flag.default(false),
    /**
     * Where `api` stores listing photos and the worker's `listing` role reads them. Absolute, because the
     * two run from different working directories and a relative path would give each its own folder.
     */
    UPLOAD_DIR: z
      .string()
      .refine(isAbsolute, 'must be an absolute path')
      .default(join(tmpdir(), 'flashdrop', 'uploads')),
  })
  .superRefine((env, ctx) => {
    const problem = (variable: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [variable], message });
    if (env.LLM_RECORD && env.LLM_PROVIDER === 'fixture') {
      problem('LLM_RECORD', 'must be false when LLM_PROVIDER=fixture');
    } else if (env.ANTHROPIC_API_KEY === undefined) {
      if (env.LLM_PROVIDER === 'anthropic')
        problem('ANTHROPIC_API_KEY', 'is required when LLM_PROVIDER=anthropic');
      else if (env.LLM_RECORD) problem('ANTHROPIC_API_KEY', 'is required when LLM_RECORD is on');
    }
  })
  .transform(({ LLM_PROVIDER, ...env }) => {
    const provider: LlmProvider = LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'fixture');
    return { ...env, LLM_PROVIDER: provider };
  });

export const TestingEnv = z
  .object({
    /** Mounts `/api/v1/test/*` (§5.1); requests must also carry `x-test-secret`. */
    ENABLE_TEST_ROUTES: flag.default(false),
    TEST_ROUTES_SECRET: secret(16).optional(),
    /** Makes named race-matrix points block on `pg_advisory_lock(hookId)` (§13). */
    FD_TEST_HOOKS: flag.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.ENABLE_TEST_ROUTES && env.TEST_ROUTES_SECRET === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TEST_ROUTES_SECRET'],
        message: 'is required when ENABLE_TEST_ROUTES=true',
      });
    }
  });

export type EnvSource = Readonly<Record<string, string | undefined>>;
export type EnvSchema = z.ZodType<object>;

type Merge<S extends readonly EnvSchema[]> = S extends readonly [
  infer Head extends EnvSchema,
  ...infer Tail extends readonly EnvSchema[],
]
  ? z.output<Head> & Merge<Tail>
  : unknown;

export type Env<S extends readonly EnvSchema[]> = { readonly [K in keyof Merge<S>]: Merge<S>[K] };

export interface EnvIssue {
  readonly variable: string;
  readonly problem: string;
}

/** Thrown by `loadEnv` with every problem at once. Values are never echoed, because some are secrets. */
export class EnvError extends Error {
  override readonly name = 'EnvError';
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    const width = Math.max(...issues.map((issue) => issue.variable.length));
    const lines = issues.map((issue) => `  ${issue.variable.padEnd(width)}  ${issue.problem}`);
    const count = issues.length === 1 ? '1 problem' : `${issues.length} problems`;
    super(
      [
        `Invalid environment (${count}):`,
        ...lines,
        'Set these in .env (see .env.example) or in the process environment.',
      ].join('\n'),
    );
    this.issues = issues;
  }
}

/**
 * Validates `source` against each schema and returns the merged, typed, frozen result. Fails fast: one
 * `EnvError` lists every problem across all schemas. Empty values count as unset, so `KEY=` in `.env`
 * falls back to the default.
 */
export function loadEnv<const S extends readonly EnvSchema[]>(
  schemas: S,
  source: EnvSource = process.env,
): Env<S> {
  const input = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== '',
    ),
  );
  const env: Record<string, unknown> = {};
  const issues: EnvIssue[] = [];

  for (const schema of schemas) {
    const result = schema.safeParse(input);
    if (result.success) {
      Object.assign(env, result.data);
    } else {
      issues.push(...result.error.issues.map((issue) => toEnvIssue(issue, input)));
    }
  }

  if (issues.length > 0) throw new EnvError(issues);
  return Object.freeze(env) as Env<S>;
}

function toEnvIssue(issue: z.core.$ZodIssue, input: Record<string, string>): EnvIssue {
  const [key, entry] = issue.path;
  const variable = typeof key === 'string' ? key : '(environment)';
  if (issue.code === 'invalid_type' && input[variable] === undefined)
    return { variable, problem: 'is not set' };
  // List problems name the entry by position, because no problem ever echoes a value.
  const problem = typeof entry === 'number' ? `entry ${entry + 1}: ${issue.message}` : issue.message;
  return { variable, problem };
}
