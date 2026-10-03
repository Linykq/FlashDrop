import { expect, orderOf, pollOrder, pollStock, stockOf, test } from './support/fixtures';
import { stockLinePattern } from './support/text';

/*
 * An abandoned hold (design §4.6, §8.3; design-system §10.4): a 10 s hold on the only unit runs out on the
 * checkout page, which swaps the hold for the expired card and moves focus to it. Postgres expires the order
 * (`expire-orders`, every second) and, with no settlement consumer before M3, the sweeper's
 * `settle-safety-net` returns the unit to Redis about 10 to 15 s later, which another visitor's product page
 * picks up from its live stock. "Try again" then leads back to a product page that can reserve.
 */

test.use({ dropSettings: { stock: 1, perUserLimit: 1, holdSeconds: 10 } });

/*
 * How long after `expiresAt` the unit is back in Redis at the latest. The sweeper's schedule, mirrored from
 * apps/worker/src/sweeper/index.ts and packages/db/src/sweeper.ts: expire-orders runs every 1 s; the
 * settle-safety-net, every 5 s, settles orders that changed more than 10 s ago. Each loop starts its next tick
 * a period after the last one started, so a slow tick on a busy runner adds to that: the margin covers it and
 * the 250 ms poll.
 */
const EXPIRE_ORDERS_EVERY_MS = 1_000;
const SAFETY_NET_AGE_MS = 10_000;
const SAFETY_NET_EVERY_MS = 5_000;
const BUSY_RUNNER_MARGIN_MS = 10_000;
const STOCK_BACK_WITHIN_MS =
  EXPIRE_ORDERS_EVERY_MS + SAFETY_NET_AGE_MS + SAFETY_NET_EVERY_MS + BUSY_RUNNER_MARGIN_MS;
/** A product page's live stock polls every 2.5 to 3 s; with the same margin for a busy runner. */
const PAGE_CATCHES_UP_MS = 3_000 + BUSY_RUNNER_MARGIN_MS;

test('an abandoned hold expires on screen and its unit goes back on sale', async ({
  page,
  drop,
  buyer: _,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto(`/p/${drop.productSlug}`);
  await page.getByRole('main').getByRole('button', { name: 'Buy', exact: true }).click();
  await expect(page).toHaveURL(/\/checkout\/[0-9a-f-]{36}$/);
  const checkoutUrl = page.url();
  const orderId = new URL(checkoutUrl).pathname.split('/').at(-1) ?? '';
  await expect(page.getByRole('region', { name: 'Reserved for you' })).toBeVisible();
  const leave = page.getByRole('link', { name: 'Leave checkout' });
  await expect(leave).toBeVisible();
  const { expiresAt } = await orderOf(page.request, orderId);

  // Another visitor, signed out, sees the only unit in a cart: the stock line, not the closed Buy button
  // that repeats its word. The phone's sticky bar repeats both, hidden on desktop.
  const visitor = await browser.newContext();
  try {
    const watcher = await visitor.newPage();
    await watcher.goto(`/p/${drop.productSlug}`);
    const watched = watcher.getByRole('main');
    await expect(
      watched.getByRole('paragraph').filter({ hasText: /^All reserved$/, visible: true }),
    ).toBeVisible();

    // The card ends the hold 2 s before api does. Its heading takes focus, and that one focus event reads it
    // with its description: no alert as well, which would read it twice (design-system §13.3).
    const expired = page.getByRole('heading', { name: 'Reservation expired' });
    await expect(expired).toBeVisible({ timeout: 15_000 });
    await expect(expired).toBeFocused();
    await expect(expired).toHaveAccessibleDescription('Your item went back on sale.');
    await expect(page.getByRole('alert').filter({ hasText: 'Reservation expired' })).toHaveCount(0);
    // There is no hold left to leave; the card's own action is the way back.
    await expect(leave).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      `/p/${drop.productSlug}`,
    );

    await expect
      .poll(async () => (await pollOrder(page.request, orderId))?.status, { timeout: 10_000 })
      .toBe('EXPIRED');
    await expect
      .poll(async () => (await pollStock(page.request, drop.id))?.avail, {
        message: 'the unit is back in Redis (is the worker running the sweeper role?)',
        timeout: Date.parse(expiresAt) + STOCK_BACK_WITHIN_MS - Date.now(),
        intervals: [250],
      })
      .toBe(1);
    const backAfterMs = Date.now() - Date.parse(expiresAt);
    testInfo.annotations.push({ type: 'stock back after expiry', description: `${backAfterMs} ms` });
    expect(await stockOf(page.request, drop.id)).toMatchObject({ avail: 1, held: 0, sold: 0 });

    // The visitor's page follows its live stock: the unit is on sale again.
    await expect(watched.getByText(stockLinePattern(1)).filter({ visible: true })).toBeVisible({
      timeout: PAGE_CATCHES_UP_MS,
    });
  } finally {
    await visitor.close();
  }

  // "Try again" reveals the product page Next kept from before checkout: it can reserve again, rather than
  // still showing "Reserved" from the press that led here.
  await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page).toHaveURL(`/p/${drop.productSlug}`);
  await expect(page.getByRole('main').getByRole('button', { name: 'Buy', exact: true })).toBeEnabled({
    timeout: PAGE_CATCHES_UP_MS,
  });

  // Loaded again, checkout renders the expired order as such from the server, with nothing to leave.
  await page.goto(checkoutUrl);
  await expect(page.getByRole('heading', { name: 'Reservation expired' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Leave checkout' })).toHaveCount(0);
});
