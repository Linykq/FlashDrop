import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { createDrop, expect, pollOrder, reserveViaApi, signInNewBuyer, test } from './support/fixtures';

/*
 * The axe gate of design §13: 0 serious or critical violations on every page built so far, in both themes.
 * Every violation, whatever its impact, is attached to the test, so lesser ones stay visible. The theme
 * follows `prefers-color-scheme` unless a stored override exists, and a fresh context has none. Pages that
 * show stock or a hold use the spec's own drop (support/fixtures.ts); home and sign-in show the seed.
 */

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

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

async function expectNoBlockingViolations(page: Page, testInfo: TestInfo): Promise<void> {
  await settle(page);
  const { violations } = await new AxeBuilder({ page }).analyze();
  await testInfo.attach('axe-violations.json', {
    body: JSON.stringify(violations, null, 2),
    contentType: 'application/json',
  });
  const blocking = violations
    .filter(({ impact }) => impact != null && BLOCKING_IMPACTS.has(impact))
    .map(({ id, impact, help, nodes }) => ({ id, impact, help, targets: nodes.map(({ target }) => target) }));
  expect(blocking).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('home page has no serious or critical axe violations', async ({ page }, testInfo) => {
      await page.goto('/');
      await expectNoBlockingViolations(page, testInfo);
    });

    test('product page has no serious or critical axe violations', async ({ page, drop }, testInfo) => {
      await page.goto(`/p/${drop.productSlug}`);
      await expectNoBlockingViolations(page, testInfo);
    });

    test('sign-in page has no serious or critical axe violations', async ({ page }, testInfo) => {
      await page.goto('/login');
      await expectNoBlockingViolations(page, testInfo);
    });

    test('checkout holding has no serious or critical axe violations', async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      const order = await reserveViaApi(page.request, baseURL, drop.id);
      await page.goto(`/checkout/${order.id}`);
      await expect(page.getByRole('region', { name: 'Reserved for you' })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('product page and orders with a live hold have no serious or critical axe violations', async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      await reserveViaApi(page.request, baseURL, drop.id);
      await page.goto(`/p/${drop.productSlug}`);
      await expect(page.getByText('You have 1 reserved', { exact: true })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
      await page.goto('/orders');
      await expect(page.getByText(/^\d:\d{2} left$/)).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('checkout expired has no serious or critical axe violations', async ({
      page,
      context,
      request,
      baseURL,
    }, testInfo) => {
      test.setTimeout(60_000);
      // The shortest hold there is, left to run out: Postgres expires it within a second of its deadline.
      const drop = await createDrop(request, baseURL, { stock: 1, holdSeconds: 10 });
      await signInNewBuyer(request, baseURL, context);
      const order = await reserveViaApi(page.request, baseURL, drop.id);
      await expect
        .poll(async () => (await pollOrder(page.request, order.id))?.status, { timeout: 20_000 })
        .toBe('EXPIRED');
      await page.goto(`/checkout/${order.id}`);
      await expect(page.getByRole('heading', { name: 'Reservation expired' })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });
  });
}

test.describe('forced colours', () => {
  test.use({ forcedColors: 'active' });

  // Disabled controls use aria-disabled, which the browser doesn't map to GrayText, and forced colours
  // replace the tertiary label that otherwise marks them (design-system §13.1).
  test('aria-disabled controls take GrayText', async ({ page, drop, buyer: _ }) => {
    await page.goto(`/p/${drop.productSlug}`);
    const main = page.getByRole('main');
    const decrease = main.getByRole('button', { name: 'Decrease quantity' });
    const increase = main.getByRole('button', { name: 'Increase quantity' });
    await expect(decrease).toHaveAttribute('aria-disabled', 'true');
    await expect(increase).not.toHaveAttribute('aria-disabled', 'true');

    const grayText = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'GrayText';
      document.body.append(probe);
      const { color } = getComputedStyle(probe);
      probe.remove();
      return color;
    });
    await expect(decrease).toHaveCSS('color', grayText);
    await expect(decrease).toHaveCSS('border-top-color', grayText);
    await expect(increase).not.toHaveCSS('color', grayText);

    // At the limit, plus is the disabled one.
    await increase.click();
    await expect(increase).toHaveCSS('color', grayText);
    await expect(decrease).not.toHaveCSS('color', grayText);
  });
});
