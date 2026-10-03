/**
 * `pnpm db:seed [--catalog-dir <dir>]`, also the second step of the Compose `migrate` job (design §15).
 * Seeds the development catalog (`seedDatabase` in packages/db), then arms the seeded drops through the
 * same service as `POST /admin/drops/:id/arm`: `syncDropFromPostgres`, under each drop's lock (§4.7). A
 * fresh stack's drops are therefore live in Redis before the first request, and a re-run rebuilds them from
 * whatever the seed moved. It lives here because packages/inventory depends on packages/db, not the other
 * way round.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CoreEnv, createLogger, LlmEnv, loadEnv, PostgresEnv, RedisEnv } from '@flashdrop/config';
import {
  createDb,
  createPool,
  isTrackedDrop,
  POOL_PROFILES,
  REPO_CATALOG_DIR,
  seedDatabase,
} from '@flashdrop/db';
import {
  connectCommandClient,
  DROP_LOCK_POOL_PROFILE,
  type FlashdropRedis,
  syncDropFromPostgres,
} from '@flashdrop/inventory';

// The bundled copy in the image resolves REPO_CATALOG_DIR from its own location, so the job passes it.
const { values } = parseArgs({ options: { 'catalog-dir': { type: 'string' } } });

// Like `node --env-file`, variables already set win. The Compose job has no .env and needs none.
if (existsSync('.env')) process.loadEnvFile('.env');
const env = loadEnv([CoreEnv, PostgresEnv, RedisEnv, LlmEnv]);
const logger = createLogger({ name: 'db:seed', level: env.LOG_LEVEL });

const pool = createPool({
  connectionString: env.DATABASE_URL,
  logger,
  ...POOL_PROFILES.maintenance,
  applicationName: 'db:seed',
});
const lockPool = createPool({
  connectionString: env.DATABASE_URL,
  logger,
  ...DROP_LOCK_POOL_PROFILE,
  applicationName: 'db:seed:locks',
  max: 1,
});
const db = createDb(pool);
let redis: FlashdropRedis | undefined;

try {
  redis = await connectCommandClient({ url: env.REDIS_URL, name: 'seed-cmd', logger });
  const sync = { db, redis, logger, lock: { pool: lockPool, logger } };
  await seedDatabase(db, {
    catalogDir: values['catalog-dir'] ?? REPO_CATALOG_DIR,
    uploadDir: env.UPLOAD_DIR,
    logger,
    armDrops: async (dropIds) => {
      for (const dropId of dropIds) {
        // A seeded drop that ended more than 24 h ago has left the tracked set: Redis keeps nothing for it.
        if (!(await isTrackedDrop(db, dropId))) continue;
        const outcome = await syncDropFromPostgres(sync, dropId);
        if (outcome.kind === 'REBUILT') logger.info({ dropId, gen: outcome.gen }, 'seeded drop armed');
        // STALE: Redis holds a newer generation than this database, which was reset under it. Every
        // reconciler rebuild bumps the Postgres generation, so the drop catches up within a few ticks.
        else logger.warn({ dropId, outcome: outcome.kind }, 'seeded drop not armed');
      }
    },
  });
} catch (err) {
  logger.error({ err }, 'db:seed failed');
  process.exitCode = 1;
} finally {
  await redis?.close();
  await Promise.all([pool.end(), lockPool.end()]);
}
