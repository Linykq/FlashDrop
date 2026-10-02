import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, PostgresEnv } from '@flashdrop/config';
import {
  createDb,
  createPool,
  type Db,
  migrateDatabase,
  POOL_PROFILES,
  REPO_CATALOG_DIR,
  seedDatabase,
} from '@flashdrop/db';

/*
 * Integration-test database: a throwaway database on the shared Compose Postgres, migrated and seeded
 * exactly like the development one, so tests read the real seed without depending on (or disturbing) the
 * shared `flashdrop` database. Photos go to a temporary UPLOAD_DIR.
 */

export interface SeededDatabase {
  readonly db: Db;
  /** With the api's pool profile (2 s statements, 5 s transactions, 2 s connection wait), as in production. */
  readonly pool: ReturnType<typeof createPool>;
  readonly url: string;
  readonly uploadDir: string;
  readonly drop: () => Promise<void>;
}

const quiet = { warn: () => undefined, info: () => undefined };

export async function createSeededDatabase(now: Date): Promise<SeededDatabase> {
  const { DATABASE_URL } = loadEnv([PostgresEnv]);
  const name = `fd_test_api_${randomUUID().replaceAll('-', '')}`;
  const server = createPool({
    connectionString: DATABASE_URL,
    logger: quiet,
    ...POOL_PROFILES.maintenance,
    max: 1,
  });
  await server.query(`CREATE DATABASE ${name}`);

  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const uploadDir = await mkdtemp(join(tmpdir(), 'fd-api-int-'));
  const maintenance = createPool({
    connectionString: url.href,
    logger: quiet,
    ...POOL_PROFILES.maintenance,
  });
  try {
    await migrateDatabase(maintenance);
    await seedDatabase(createDb(maintenance), {
      catalogDir: REPO_CATALOG_DIR,
      uploadDir,
      logger: quiet,
      now,
    });
  } finally {
    await maintenance.end();
  }

  const pool = createPool({ connectionString: url.href, logger: quiet, ...POOL_PROFILES.api });
  return {
    db: createDb(pool),
    pool,
    url: url.href,
    uploadDir,
    drop: async () => {
      await pool.end();
      await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await server.end();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}
