import { randomBytes } from 'node:crypto';
import { loadEnv, PostgresEnv } from '@flashdrop/config';
import { createDb, createPool, type Db, PSP_DB_ROLE } from '@flashdrop/db';
import { createTestDatabase, type TestDatabase } from '@flashdrop/db/testing';
import pg from 'pg';
import { createLedger, type Ledger } from '../ledger';
import { PSP_POOL_PROFILE } from '../postgres';

/*
 * A throwaway, migrated database on the shared Compose Postgres (design §13), with the ledger connected
 * under the PSP role's grants, so every test also proves what that role may do.
 *
 * Roles are global to the server, and the running stack's payment-mock logs in as `flashdrop_psp` with the
 * password the migrate job set. So the tests never touch that role: each file logs in as its own throwaway
 * member of it, which inherits exactly its privileges (migration 0007's grants on this database).
 */

const TEST_APPLICATION_NAME = 'payment-mock-tests';
const quiet = { warn: () => undefined };

export interface PspTestDatabase {
  /** The migrating owner role, for setup and for checks the PSP role may not make. */
  readonly admin: TestDatabase;
  /** Logged in with the PSP role's privileges. */
  readonly pool: pg.Pool;
  readonly db: Db;
  readonly ledger: Ledger;
  close(): Promise<void>;
}

export async function createPspTestDatabase(): Promise<PspTestDatabase> {
  const admin = await createTestDatabase();
  const login = `fd_test_psp_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  await admin.pool.query(
    `CREATE ROLE ${login} LOGIN PASSWORD ${pg.escapeLiteral(password)} IN ROLE ${PSP_DB_ROLE}`,
  );
  const url = new URL(admin.url);
  url.username = login;
  url.password = password;
  const pool = createPool({
    connectionString: url.href,
    logger: quiet,
    ...PSP_POOL_PROFILE,
    applicationName: TEST_APPLICATION_NAME,
  });
  const db = createDb(pool);
  return {
    admin,
    pool,
    db,
    ledger: createLedger(db),
    close: async () => {
      await pool.end();
      await admin.drop();
      const server = new pg.Client({ connectionString: loadEnv([PostgresEnv]).DATABASE_URL });
      await server.connect();
      try {
        await server.query(`DROP ROLE IF EXISTS ${login}`);
      } finally {
        await server.end();
      }
    },
  };
}
