import { randomUUID } from 'node:crypto';
import { loadEnv, PostgresEnv } from '@flashdrop/config';
import pg from 'pg';
import { createDb, type Db } from './client';
import { migrateDatabase } from './migrate';
import { createPool, POOL_PROFILES, type PoolOptions } from './pool';

/*
 * Integration-test helper, exported only as `@flashdrop/db/testing` (never from the package root): a
 * throwaway database on the shared Compose server. Migrations name the `public` schema explicitly, so a
 * fresh database, not a fresh schema, is what isolates a test file from the development database, from the
 * running stack's loops (which track every armed drop in it) and from other test files.
 */

export interface TestDatabase {
  readonly url: string;
  readonly pool: pg.Pool;
  readonly db: Db;
  /** Closes the pool and drops the database, ending any connection a failed test left behind. */
  readonly drop: () => Promise<void>;
}

const quiet: PoolOptions['logger'] = { warn: () => undefined };

export async function createTestDatabase({ migrate = true } = {}): Promise<TestDatabase> {
  const { DATABASE_URL } = loadEnv([PostgresEnv]);
  const name = `fd_test_${randomUUID().replaceAll('-', '')}`;
  await onServer(DATABASE_URL, `CREATE DATABASE ${name}`);

  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool({
    connectionString: url.href,
    logger: quiet,
    ...POOL_PROFILES.maintenance,
    applicationName: 'db-tests',
  });
  if (migrate) await migrateDatabase(pool);

  return {
    url: url.href,
    pool,
    db: createDb(pool),
    drop: async () => {
      await pool.end();
      await onServer(DATABASE_URL, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

async function onServer(url: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
