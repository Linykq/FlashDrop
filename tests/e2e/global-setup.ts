import { HealthResponse } from '@flashdrop/contracts';
import type { FullConfig } from '@playwright/test';

/**
 * Fails the run at once, with the fix in the message, when the stack is not up. Otherwise every spec
 * would time out on its own connection error.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (baseURL === undefined) throw new Error('playwright.config.ts sets no baseURL');
  const url = new URL('/api/v1/health', baseURL);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    HealthResponse.parse(await response.json());
  } catch (cause) {
    throw new Error(`The stack at ${baseURL} is not ready: GET ${url} failed. Run \`pnpm stack:up\`.`, {
      cause,
    });
  }
}
