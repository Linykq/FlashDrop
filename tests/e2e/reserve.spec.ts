import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  OrderListResponse,
  OrderResponse,
} from '@flashdrop/contracts';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { expect, orderOf, reserveViaApi, signInNewBuyer, stockOf, test } from './support/fixtures';

/*
 * Reserving from the product page (design §4.5, §5.2, §8.2; design-system §9.13, §10.4): Buy holds a unit
 * and opens checkout with the hold's countdown. The Idempotency-Key makes every retry of one press safe: a
 * double click, and a press after a reload that lost the first answer, both end on the one order. A buyer
 * back from checkout finds Buy usable and the hold offered back; a press refused on stale stock says what the
 * stock is now, and a press in the phone's buy bar keeps the buyer's focus.
 */

const CHECKOUT_URL = /\/checkout\/([0-9a-f-]{36})$/;
const RESERVATIONS = /\/api\/v1\/drops\/[0-9a-f-]{36}\/reservations$/;
const STOCK_POLLS = '**/api/v1/drops/*/stock';

/** The purchase panel's Buy button; the phone's sticky bar repeats it, hidden on desktop. */
const buyButton = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Buy', exact: true });

/** The checkout page's order id. */
function checkoutOrderId(page: Page): string {
  const id = CHECKOUT_URL.exec(new URL(page.url()).pathname)?.[1];
  if (id === undefined) throw new Error(`not on a checkout page: ${page.url()}`);
  return id;
}

/** The signed-in buyer's orders on one drop. */
async function ordersOn(request: APIRequestContext, dropId: string) {
  const response = await request.get('/api/v1/me/orders');
  expect(response.status()).toBe(200);
  return OrderListResponse.parse(await response.json()).orders.filter((order) => order.dropId === dropId);
}

/**
 * Serves the page's stock polls the level it rendered, until `page.unroute(STOCK_POLLS)`: the buyer then
 * presses on stock that is no longer true, as in a burst between two polls.
 */
async function holdStockStill(page: Page, request: APIRequestContext, dropId: string): Promise<void> {
  const rendered = await stockOf(request, dropId);
  await page.route(STOCK_POLLS, (route) =>
    route.fulfill({ json: { ...rendered, serverNow: new Date().toISOString() } }),
  );
}

/** Another buyer reserves `qty` units of the drop. */
async function claim(
  browser: Browser,
  request: APIRequestContext,
  baseURL: string | undefined,
  dropId: string,
  qty: number,
): Promise<void> {
  const other = await browser.newContext();
  try {
    await signInNewBuyer(request, baseURL, other);
    await reserveViaApi(other.request, baseURL, dropId, qty);
  } finally {
    await other.close();
  }
}

/** Everything the Announcer's polite region says from now on (design-system §13.3), for `spoken()`. */
async function listenToAnnouncer(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const spoken: string[] = [];
    Object.assign(window, { spoken });
    const region = document.querySelector('div.sr-only[role="status"]');
    if (region === null) throw new Error('no Announcer on the page');
    new MutationObserver(() => {
      if (region.textContent) spoken.push(region.textContent);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { spoken: string[] }).spoken);
}

/** Longer than the stock announcements' 3 s cooldown, so one that was held back would have been said. */
const COOLDOWN_PASSED_MS = 3_500;

test('Buy holds a unit and checkout counts the hold down', async ({ page, drop, buyer: _ }) => {
  await page.goto(`/p/${drop.productSlug}`);
  await buyButton(page).click();

  await expect(page).toHaveURL(CHECKOUT_URL);
  const orderId = checkoutOrderId(page);
  // Focus starts on the heading (SD §8.3).
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeFocused();

  const hold = page.getByRole('region', { name: 'Reserved for you' });
  // The digits are hidden from assistive technology (a polite region speaks at thresholds instead).
  const countdown = hold.getByText(/^\d+:\d{2}$/);
  await expect(countdown).toHaveText(/^1:5\d$/);
  const first = await countdown.textContent();
  await expect(countdown).not.toHaveText(first ?? '');
  await expect(hold.getByText(/^We hold it until .+\.$/)).toBeVisible();
  // The 2 s margin starts the hold at 1:58, and the first tick still names its band (SD §8.3).
  await expect(hold.getByRole('status')).toHaveText('2 minutes left to check out.');
  await expect(
    page.getByRole('region', { name: 'Order summary' }).getByText('Qty 1', { exact: true }),
  ).toBeVisible();

  const order = await orderOf(page.request, orderId);
  expect(order).toMatchObject({ status: 'RESERVED', dropId: drop.id, qty: 1 });
  expect(Date.parse(order.expiresAt) - Date.parse(order.createdAt)).toBe(120_000);
  expect(await stockOf(page.request, drop.id)).toMatchObject({ avail: drop.settings.stock - 1, held: 1 });

  // Back on the product page, which Next kept in a hidden <Activity>: Buy works again rather than staying
  // "Reserved", and the hold, still running, is offered back.
  await page.goBack();
  await expect(buyButton(page)).toBeEnabled();
  const main = page.getByRole('main');
  await expect(main.getByText('You have 1 reserved', { exact: true })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Go to checkout' })).toHaveAttribute(
    'href',
    `/checkout/${orderId}`,
  );
});

test.describe('with a limit of 1', () => {
  test.use({ dropSettings: { perUserLimit: 1 } });

  test('leaving checkout keeps the hold, and the product page leads back to it', async ({
    page,
    drop,
    buyer: _,
  }) => {
    await page.goto(`/p/${drop.productSlug}`);
    await buyButton(page).click();
    await expect(page).toHaveURL(CHECKOUT_URL);
    const orderId = checkoutOrderId(page);
    await page.getByRole('link', { name: 'Leave checkout' }).click();

    await expect(page).toHaveURL(`/p/${drop.productSlug}`);
    const main = page.getByRole('main');
    await expect(main.getByText('You have 1 reserved', { exact: true })).toBeVisible();
    // The hold takes the whole limit: no Buy that api would refuse; the filled action is the way back.
    await expect(buyButton(page)).toHaveCount(0);
    const back = main.getByRole('link', { name: 'Go to checkout' });
    await expect(back).toHaveCount(1);
    await back.click();
    await expect(page).toHaveURL(`/checkout/${orderId}`);
    await expect(page.getByRole('region', { name: 'Reserved for you' })).toBeVisible();
  });
});

test.describe('refused on stale stock', () => {
  test.use({ dropSettings: { stock: 3 } });

  test('a press for 2 with 1 left offers the 1, and says so once', async ({
    page,
    drop,
    buyer: _,
    browser,
    request,
    baseURL,
  }) => {
    await page.goto(`/p/${drop.productSlug}`);
    await holdStockStill(page, request, drop.id);
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'Increase quantity' }).click();
    await claim(browser, request, baseURL, drop.id, 2);
    const spoken = await listenToAnnouncer(page);
    await page.unroute(STOCK_POLLS);
    await main.getByRole('button', { name: 'Buy 2', exact: true }).click();

    // Redis refused SOLD_OUT, but one is left: the note says so, from the stock refreshed after the refusal.
    const note = 'Only 1 left now. We set your quantity to 1.';
    await expect(main.getByText(note)).toBeVisible();
    await expect(main.getByText('Only 1 left', { exact: true })).toBeVisible();
    await expect(buyButton(page)).toHaveAccessibleDescription(note);
    // The stepper stays, at 1 with plus disabled, rather than leaving the row.
    await expect(main.getByRole('group', { name: 'Quantity' }).getByText('1', { exact: true })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Increase quantity' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Said once: the refresh's own crossing to "1 left." is the note's to tell.
    await expect.poll(spoken).toContain(note);
    await page.waitForTimeout(COOLDOWN_PASSED_MS);
    expect(await spoken()).toEqual([note]);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, dropSettings: { stock: 1, perUserLimit: 1 } });

  test('a refusal in the buy bar leaves focus on the row, described by its note', async ({
    page,
    drop,
    buyer: _,
    browser,
    request,
    baseURL,
  }) => {
    await page.goto(`/p/${drop.productSlug}`);
    await holdStockStill(page, request, drop.id);
    // The row out of view: the sticky buy bar takes over (design-system §10.2).
    await page.getByRole('contentinfo').scrollIntoViewIfNeeded();
    const bar = page.locator('[data-bottom-bar]');
    await expect(bar).toBeVisible();
    await claim(browser, request, baseURL, drop.id, 1);
    const spoken = await listenToAnnouncer(page);
    await page.unroute(STOCK_POLLS);
    await bar.getByRole('button', { name: 'Buy', exact: true }).press('Enter');

    // The last unit is in another cart: not sold out. The bar leaves with the action, and focus moves to
    // the row's own button, which the note describes, instead of falling to the page.
    const note = 'All reserved right now. Some may free up.';
    const inline = page.getByRole('main').getByRole('button', { name: 'All reserved' });
    await expect(inline).toBeFocused();
    await expect(inline).toHaveAccessibleDescription(note);
    await expect(bar).toHaveCount(0);
    await expect.poll(spoken).toContain(note);
    await page.waitForTimeout(COOLDOWN_PASSED_MS);
    expect(await spoken()).toEqual([note]);
  });
});

test('a double click reserves once', async ({ page, drop, buyer: _ }) => {
  const keys: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && RESERVATIONS.test(request.url())) {
      keys.push(request.headers()[IDEMPOTENCY_KEY_HEADER] ?? '');
    }
  });
  await page.goto(`/p/${drop.productSlug}`);
  await buyButton(page).dblclick();

  await expect(page).toHaveURL(CHECKOUT_URL);
  const orders = await ordersOn(page.request, drop.id);
  expect(orders.map((order) => order.id)).toEqual([checkoutOrderId(page)]);
  expect(await stockOf(page.request, drop.id)).toMatchObject({ avail: drop.settings.stock - 1, held: 1 });
  // However many requests the clicks sent, they were one intent under one key.
  expect(keys.length).toBeGreaterThan(0);
  expect(new Set(keys).size).toBe(1);
});

test('after a reload loses the answer, Buy replays the same reservation', async ({
  page,
  drop,
  buyer: _,
}) => {
  // The first request reaches api and reserves, but its answer never reaches the page; every retry fails
  // in the network as well, so the button is still "Reserving…" when the buyer reloads.
  let first: { key: string; orderId: string } | undefined;
  await page.route(RESERVATIONS, async (route) => {
    if (first === undefined) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      first = {
        key: route.request().headers()[IDEMPOTENCY_KEY_HEADER] ?? '',
        orderId: OrderResponse.parse(await response.json()).order.id,
      };
    }
    await route.abort('connectionreset');
  });

  await page.goto(`/p/${drop.productSlug}`);
  await buyButton(page).click();
  await expect(
    page.getByRole('main').getByRole('button', { name: /^(Reserving|Still trying)…$/ }),
  ).toBeVisible();
  await expect.poll(() => first).toBeDefined();
  if (first === undefined) throw new Error('unreachable: polled until defined');

  await page.reload();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // The key outlives the reload (sessionStorage), so this press continues the same intent.
  const answer = page.waitForResponse(
    (response) => response.request().method() === 'POST' && RESERVATIONS.test(response.url()),
  );
  await buyButton(page).click();
  const replay = await answer;

  expect(replay.request().headers()[IDEMPOTENCY_KEY_HEADER]).toBe(first.key);
  expect(replay.status()).toBe(200);
  expect(replay.headers()[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
  expect(OrderResponse.parse(await replay.json()).order.id).toBe(first.orderId);
  await expect(page).toHaveURL(`/checkout/${first.orderId}`);
  expect((await ordersOn(page.request, drop.id)).map((order) => order.id)).toEqual([first.orderId]);
  expect(await stockOf(page.request, drop.id)).toMatchObject({ held: 1 });
});
