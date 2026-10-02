import { createLogger, type Logger } from '@flashdrop/config';
import { coreEnv } from './env';

let logger: Logger | undefined;

/** web's server-side logger (pino, secrets redacted), created on first use like the env it reads. */
export function log(): Logger {
  logger ??= createLogger({ name: 'web', level: coreEnv().LOG_LEVEL });
  return logger;
}
