import { type DestinationStream, type Logger, type LoggerOptions as PinoOptions, pino } from 'pino';
import type { LogLevel } from './env';

export type { Logger } from 'pino';

/** Secret variables from `.env`. Both URLs can embed a password. */
const SECRET_VARIABLES = [
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
  'REVALIDATE_SECRET',
  'TEST_ROUTES_SECRET',
  'ANTHROPIC_API_KEY',
] as const;

const SECRET_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-test-secret'] as const;

/**
 * Explicit paths for the shapes FlashDrop logs: `{ password }`, `{ env: { SESSION_SECRET } }` and
 * `{ req: { headers: { cookie } } }`. There are deliberately no `*` wildcards: pino checks those against
 * every object on every call, which measured about 30 times slower than unredacted logging, and the
 * reserve hot path logs on every request.
 */
export const REDACT_PATHS: readonly string[] = [
  'password',
  'secret',
  'token',
  'apiKey',
  'connectionString',
  ...SECRET_VARIABLES.flatMap((name) => [name, `env.${name}`]),
  ...['headers', 'req.headers', 'res.headers'].flatMap((parent) =>
    SECRET_HEADERS.map((header) => `${parent}["${header}"]`),
  ),
];

export const REDACTED = '[redacted]';

export interface LoggerOptions {
  /** The process or component, e.g. `api` or `worker:relay`. Emitted as `name` on every line. */
  readonly name: string;
  readonly level?: LogLevel;
}

/**
 * A pino JSON logger with secret redaction. Callers add context with `logger.child({ orderId, dropId,
 * traceId })` so that one grep follows an order end to end (§12).
 */
export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const config = {
    name: options.name,
    level: options.level ?? 'info',
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  } satisfies PinoOptions;
  return pino(config, destination);
}
