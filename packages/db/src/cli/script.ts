import { existsSync } from 'node:fs';
import { CoreEnv, createLogger, type Logger, loadEnv, PostgresEnv } from '@flashdrop/config';
import { createDb, type Db } from '../client';
import { createPool, POOL_PROFILES, type PoolProfile } from '../pool';

export interface ScriptContext {
  readonly env: ReturnType<typeof loadScriptEnv>;
  readonly logger: Logger;
  readonly pool: ReturnType<typeof createPool>;
  readonly db: Db;
}

function loadScriptEnv() {
  return loadEnv([CoreEnv, PostgresEnv]);
}

/**
 * Runs a one-shot maintenance script (`pnpm db:*`, the Compose `migrate` job): env, logger and a pool
 * without the api's timeouts. Failures are logged and turn into exit code 1.
 */
export async function runScript(
  name: string,
  main: (context: ScriptContext) => Promise<void>,
  profile: PoolProfile = POOL_PROFILES.maintenance,
): Promise<void> {
  // Like `node --env-file`, variables already set win. The Compose job has no .env and needs none.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = loadScriptEnv();
  const logger = createLogger({ name, level: env.LOG_LEVEL });
  const pool = createPool({ connectionString: env.DATABASE_URL, logger, ...profile, applicationName: name });
  try {
    await main({ env, logger, pool, db: createDb(pool) });
  } catch (err) {
    logger.error({ err }, `${name} failed`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
