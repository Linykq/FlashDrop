import { parseArgs } from 'node:util';
import { AppRoleEnv, loadEnv, PspRoleEnv } from '@flashdrop/config';
import { APP_DB_ROLE, enableRoleLogin, PSP_DB_ROLE } from '../db-roles';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../migrate';
import { runScript } from './script';

// pnpm db:migrate [--migrations-dir <dir>]. The directory option lets a bundled image point at its copy.
const { values } = parseArgs({ options: { 'migrations-dir': { type: 'string' } } });

await runScript('db:migrate', async ({ logger, pool }) => {
  const { PSP_DB_PASSWORD, APP_DB_PASSWORD } = loadEnv([PspRoleEnv, AppRoleEnv]);
  const result = await migrateDatabase(pool, values['migrations-dir'] ?? MIGRATIONS_FOLDER);
  logger.info(result, result.applied > 0 ? 'migrations applied' : 'database is up to date');
  if (PSP_DB_PASSWORD !== undefined) {
    await enableRoleLogin(pool, PSP_DB_ROLE, PSP_DB_PASSWORD);
    logger.info({ role: PSP_DB_ROLE }, 'payment-mock role may log in');
  }
  if (APP_DB_PASSWORD !== undefined) {
    await enableRoleLogin(pool, APP_DB_ROLE, APP_DB_PASSWORD);
    logger.info({ role: APP_DB_ROLE }, 'application role may log in');
  }
});
