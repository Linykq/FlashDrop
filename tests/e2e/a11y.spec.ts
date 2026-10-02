import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { liveDrop } from './support/api';

/*
 * The axe gate of design §13: 0 serious or critical violations on every M1 page, in both themes. Every
 * violation, whatever its impact, is attached to the test, so lesser ones stay visible. The theme follows
 * `prefers-color-scheme` unless a stored override exists, and a fresh context has none.
 */

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

const PAGES: readonly { name: string; path: (request: APIRequestContext) => Promise<string> }[] = [
  { name: 'home', path: async () => '/' },
  { name: 'product', path: async (request) => `/p/${(await liveDrop(request)).product.slug}` },
  { name: 'sign-in', path: async () => '/login' },
];

/** Waits until the page is what a reader sees: streamed parts in, fonts loaded, entrance motion done. */
async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Contrast is judged at rest. An infinite animation never finishes, so it is not waited for.
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    for (const { name, path } of PAGES) {
      test(`${name} page has no serious or critical axe violations`, async ({ page, request }, testInfo) => {
        await page.goto(await path(request));
        await settle(page);

        const { violations } = await new AxeBuilder({ page }).analyze();
        await testInfo.attach('axe-violations.json', {
          body: JSON.stringify(violations, null, 2),
          contentType: 'application/json',
        });

        const blocking = violations
          .filter(({ impact }) => impact != null && BLOCKING_IMPACTS.has(impact))
          .map(({ id, impact, help, nodes }) => ({
            id,
            impact,
            help,
            targets: nodes.map(({ target }) => target),
          }));
        expect(blocking).toEqual([]);
      });
    }
  });
}
