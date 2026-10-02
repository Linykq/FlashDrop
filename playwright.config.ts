import { defineConfig, devices } from '@playwright/test';
import { z } from 'zod';

/*
 * End-to-end tests (design §13) against the built Compose stack behind Caddy: `pnpm stack:up`, then
 * `pnpm test:e2e`. Playwright never starts the stack itself, so the run exercises the same images CI
 * builds. `E2E_BASE_URL` points the suite at another stack; it must be an origin, because api's CSRF
 * check and the session cookie are scoped to it.
 */
const baseURL = z
  .url({ protocol: /^https?$/, error: 'E2E_BASE_URL must be an http(s) URL' })
  .transform((value) => new URL(value).origin)
  .parse(process.env.E2E_BASE_URL || 'http://127.0.0.1:8080');

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: ci,
  // Specs assert exact stock and focus states; a retry would hide a race rather than survive a flake.
  retries: 0,
  // Two cores on a CI runner also run the stack; locally, Playwright's default (half the cores).
  workers: ci ? 2 : undefined,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
