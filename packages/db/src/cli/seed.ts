import { parseArgs } from 'node:util';
import { LlmEnv, loadEnv } from '@flashdrop/config';
import { REPO_CATALOG_DIR, seedDatabase } from '../seed';
import { runScript } from './script';

// pnpm db:seed [--catalog-dir <dir>]
const { values } = parseArgs({ options: { 'catalog-dir': { type: 'string' } } });

await runScript('db:seed', async ({ db, logger }) => {
  const { UPLOAD_DIR } = loadEnv([LlmEnv]);
  // TODO(M2): pass armDrops: syncDropFromPostgres for each id, from a caller that can import packages/inventory.
  await seedDatabase(db, {
    catalogDir: values['catalog-dir'] ?? REPO_CATALOG_DIR,
    uploadDir: UPLOAD_DIR,
    logger,
  });
});
