import { parseArgs } from 'node:util';
import { loadEnv, PspRoleEnv } from '@flashdrop/config';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../migrate';
import { enablePspLogin, PSP_DB_ROLE } from '../psp-role';
import { runScript } from './script';

// pnpm db:migrate [--migrations-dir <dir>]. The directory option lets a bundled image point at its copy.
const { values } = parseArgs({ options: { 'migrations-dir': { type: 'string' } } });

await runScript('db:migrate', async ({ logger, pool }) => {
  const { PSP_DB_PASSWORD } = loadEnv([PspRoleEnv]);
  const result = await migrateDatabase(pool, values['migrations-dir'] ?? MIGRATIONS_FOLDER);
  logger.info(result, result.applied > 0 ? 'migrations applied' : 'database is up to date');
  if (PSP_DB_PASSWORD !== undefined) {
    await enablePspLogin(pool, PSP_DB_PASSWORD);
    logger.info({ role: PSP_DB_ROLE }, 'payment-mock role may log in');
  }
});
