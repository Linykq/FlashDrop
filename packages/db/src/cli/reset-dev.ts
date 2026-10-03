import { sql } from 'drizzle-orm';
import { migrateDatabase } from '../migrate';
import { POOL_PROFILES } from '../pool';
import { transaction } from '../transaction';
import { runScript } from './script';

/*
 * The first step of `pnpm db:reset-dev`: drops every FlashDrop schema of a local development database, then
 * migrates it again. The root script goes on with tools/reset-redis-dev.ts, which clears the drop states the
 * dropped database left in Redis, and tools/seed.ts, which seeds and arms the drops around the current time.
 * Photos in UPLOAD_DIR are content-addressed and kept.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

await runScript(
  'db:reset-dev',
  async ({ env, db, logger, pool }) => {
    const { hostname, pathname } = new URL(env.DATABASE_URL);
    if (env.NODE_ENV === 'production' || !LOOPBACK_HOSTS.has(hostname)) {
      throw new Error(`db:reset-dev only resets a development database on this machine, not ${hostname}`);
    }

    // One transaction: either everything is gone or nothing is. Drizzle's bookkeeping schema goes too, so the
    // migrator starts from scratch. The public schema comes back with the PostgreSQL 15+ defaults.
    await transaction(db, async (tx) => {
      await tx.execute(sql`DROP SCHEMA IF EXISTS drizzle, psp, public CASCADE`);
      await tx.execute(sql`CREATE SCHEMA public AUTHORIZATION pg_database_owner`);
      await tx.execute(sql`GRANT USAGE ON SCHEMA public TO PUBLIC`);
    });
    logger.info({ database: pathname.slice(1) }, 'schemas dropped');

    const migrations = await migrateDatabase(pool);
    logger.info(migrations, 'migrations applied');
  },
  // Fail fast instead of queueing behind a running `pnpm dev` that holds locks on the tables.
  { ...POOL_PROFILES.maintenance, settings: { lock_timeout: '5s' } },
);
