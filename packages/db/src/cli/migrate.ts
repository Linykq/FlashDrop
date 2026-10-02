import { parseArgs } from 'node:util';
import { MIGRATIONS_FOLDER, migrateDatabase } from '../migrate';
import { runScript } from './script';

// pnpm db:migrate [--migrations-dir <dir>]. The directory option lets a bundled image point at its copy.
const { values } = parseArgs({ options: { 'migrations-dir': { type: 'string' } } });

await runScript('db:migrate', async ({ logger, pool }) => {
  const result = await migrateDatabase(pool, values['migrations-dir'] ?? MIGRATIONS_FOLDER);
  logger.info(result, result.applied > 0 ? 'migrations applied' : 'database is up to date');
});
