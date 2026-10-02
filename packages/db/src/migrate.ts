import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/** The committed migrations: `drizzle-kit generate` output plus the custom trigger migrations. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export interface MigrationResult {
  /** Migrations applied by this run. */
  readonly applied: number;
  /** Migrations recorded in the database afterwards. */
  readonly total: number;
}

/**
 * Applies pending migrations with Drizzle's node-postgres migrator (all of them in one transaction).
 *
 * The run holds a session advisory lock, so the Compose `migrate` job and a developer's `pnpm db:migrate`
 * never apply the same migration twice at once: the second waits, then finds nothing to do. The pool must
 * not carry the api's `transaction_timeout` (`POOL_PROFILES.maintenance`).
 */
export async function migrateDatabase(
  pool: pg.Pool,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtextextended('fd.migrate', 0))`);
    const before = await appliedCount(client);
    await migrate(drizzle({ client }), { migrationsFolder });
    const total = await appliedCount(client);
    await client.query(`SELECT pg_advisory_unlock(hashtextextended('fd.migrate', 0))`);
    client.release();
    return { applied: total - before, total };
  } catch (error) {
    // Destroying the connection drops the session lock too, whatever state the failure left the session in.
    client.release(true);
    throw error;
  }
}

async function appliedCount(client: pg.PoolClient): Promise<number> {
  const exists = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0]?.exists) return 0;
  const count = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
  );
  return count.rows[0]?.n ?? 0;
}
