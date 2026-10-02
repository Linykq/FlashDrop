import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// Load .env into this process, before the integration global setup probes the infra and before the
// workers fork, so all of them see the same values. Like `node --env-file`, it never overrides variables
// already set in the shell. Without a .env, @flashdrop/config falls back to the local Compose defaults on
// 127.0.0.1, which is what CI uses.
const dotenv = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

const exclude = [...configDefaults.exclude, '**/.next/**', '**/dist/**', '**/.turbo/**'];
const integrationTests = '**/*.int.test.{ts,tsx}';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/*.test.{ts,tsx}'],
          exclude: [...exclude, integrationTests],
        },
      },
      {
        test: {
          name: 'integration',
          include: [integrationTests],
          exclude,
          globalSetup: ['packages/test-utils/src/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
