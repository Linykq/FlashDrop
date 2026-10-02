import { loadEnv, PostgresEnv } from '@flashdrop/config';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { isTransientDbError, pgErrorOf } from './errors';
import { createPool, POOL_PROFILES, type SessionSettings } from './pool';
import { transaction } from './transaction';

// No tables are touched, so the shared development database is fine here.
const { DATABASE_URL } = loadEnv([PostgresEnv]);
const pools: ReturnType<typeof createPool>[] = [];

function setup(settings: SessionSettings) {
  const warnings: unknown[] = [];
  const pool = createPool({
    connectionString: DATABASE_URL,
    logger: { warn: (context: unknown) => void warnings.push(context) },
    connectionTimeoutMillis: POOL_PROFILES.api.connectionTimeoutMillis,
    settings,
    max: 1,
  });
  pools.push(pool);
  return { db: createDb(pool), pool, warnings };
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('pools and transactions against Postgres 17', () => {
  it('apply the session settings to every connection', async () => {
    const { pool } = setup({ statement_timeout: '1500ms', transaction_timeout: '4s' });

    const { rows } = await pool.query<{ statement: string; transaction: string }>(
      `SELECT current_setting('statement_timeout') AS statement, current_setting('transaction_timeout') AS transaction`,
    );

    expect(rows[0]).toEqual({ statement: '1500ms', transaction: '4s' });
  });

  it('surface the transaction_timeout FATAL instead of the failed ROLLBACK, and survive it', async () => {
    const { db, warnings } = setup({ transaction_timeout: '300ms' });

    const error: unknown = await transaction(db, async (tx) => {
      await tx.execute(sql`SELECT pg_sleep(2)`);
    }).catch((caught: unknown) => caught);

    expect(pgErrorOf(error)).toMatchObject({ code: '25P04', severity: 'FATAL' });
    expect(error).toHaveProperty('rollbackError');
    expect(isTransientDbError(error)).toBe(true);
    // The dead session reached the per-client listener instead of crashing the process...
    expect(warnings.length).toBeGreaterThan(0);
    // ...and the pool replaced it.
    expect((await db.execute<{ one: number }>(sql`SELECT 1 AS one`)).rows).toEqual([{ one: 1 }]);
  });

  it('classify a statement_timeout as transient and keep the connection', async () => {
    const { db, warnings } = setup({ statement_timeout: '200ms' });

    const error: unknown = await transaction(db, async (tx) => {
      await tx.execute(sql`SELECT pg_sleep(2)`);
    }).catch((caught: unknown) => caught);

    expect(pgErrorOf(error)?.code).toBe('57014');
    expect(error).not.toHaveProperty('rollbackError');
    expect(isTransientDbError(error)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('pass a constraint error through unchanged and not as transient', async () => {
    const { db } = setup({});

    const error: unknown = await transaction(db, async (tx) => {
      await tx.execute(sql`SELECT 1 / 0`);
    }).catch((caught: unknown) => caught);

    expect(pgErrorOf(error)?.code).toBe('22012');
    expect(isTransientDbError(error)).toBe(false);
  });
});
