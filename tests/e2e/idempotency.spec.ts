import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAYED_HEADER } from '@flashdrop/contracts';
import type { Page, Request } from '@playwright/test';
import {
  buy,
  CHECKOUT_REQUEST,
  fillShipping,
  firstOrderRead,
  ORDER_URL,
  orderHeading,
  payButton,
} from './support/checkout';
import { checkoutViaApi, expect, orderOf, test } from './support/fixtures';

/*
 * Checkout submits once per order, however often it is sent (design §4.5, §5.2, §8.2): the form creates its
 * Idempotency-Key at the first submit and keeps it in sessionStorage under the order id. Pay pressed again
 * after a lost answer, or after a reload, sends the same key, and api replays (200) instead of answering 409
 * as it would to another tab's key.
 */

const FAILED_SUBMIT = "Couldn't place your order. Check your connection and try again.";

/** Every checkout request the page sends, with the key it carried. */
function recordCheckouts(page: Page): Request[] {
  const sent: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && CHECKOUT_REQUEST.test(request.url())) sent.push(request);
  });
  return sent;
}

const keyOf = (request: Request) => request.headers()[IDEMPOTENCY_KEY_HEADER] ?? '';

test('a double press submits once, under one key', async ({ page, drop, buyer: _ }) => {
  const sent = recordCheckouts(page);
  const orderId = await buy(page, drop.productSlug);
  await fillShipping(page);
  await payButton(page).dblclick();

  await expect(page).toHaveURL(ORDER_URL);
  // The in-flight Pay ignores a second press (aria-disabled, never disabled, so focus stays on it).
  expect(new Set(sent.map(keyOf)).size).toBe(1);
  expect((await orderOf(page.request, orderId)).status).toMatch(/^(PENDING_PAYMENT|PAID)$/);
});

test('after a lost answer, Pay again replays the submission api already took', async ({
  page,
  drop,
  buyer: _,
}) => {
  // After checkout's first read, which would otherwise find the order placed and leave before Pay again.
  const firstRead = firstOrderRead(page);
  const orderId = await buy(page, drop.productSlug);
  await fillShipping(page);
  await firstRead;
  // The submit reaches api and is placed, but its answer never reaches the page.
  let first: { key: string; status: number } | undefined;
  await page.route(CHECKOUT_REQUEST, async (route) => {
    const response = await route.fetch();
    first = { key: keyOf(route.request()), status: response.status() };
    await route.abort('connectionreset');
  });
  await payButton(page).click();
  await expect(page.getByRole('alert').filter({ hasText: FAILED_SUBMIT })).toBeVisible();
  expect(first).toEqual({ key: expect.any(String), status: 202 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  const answer = page.waitForResponse((response) => CHECKOUT_REQUEST.test(response.url()));
  await payButton(page).click();
  const replay = await answer;

  expect(keyOf(replay.request())).toBe(first?.key);
  expect(replay.status()).toBe(200);
  expect(replay.headers()[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
  await expect(page).toHaveURL(`/orders/${orderId}`);
});

test('the key outlives a reload: a submit that never arrived is sent again under it', async ({
  page,
  drop,
  buyer: _,
}) => {
  const sent = recordCheckouts(page);
  const orderId = await buy(page, drop.productSlug);
  await fillShipping(page);
  await page.route(CHECKOUT_REQUEST, (route) => route.abort('connectionreset'));
  await payButton(page).click();
  await expect(page.getByRole('alert').filter({ hasText: FAILED_SUBMIT })).toBeVisible();
  const [lost] = sent;
  if (lost === undefined) throw new Error('the page sent no checkout request');

  await page.reload();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // Still a hold: the form is back, empty, and the stored key goes with the new details.
  await fillShipping(page);
  const answer = page.waitForResponse((response) => CHECKOUT_REQUEST.test(response.url()));
  await payButton(page).click();
  const placed = await answer;

  expect(keyOf(placed.request())).toBe(keyOf(lost));
  expect(placed.status()).toBe(202);
  await expect(page).toHaveURL(`/orders/${orderId}`);
});

test('another tab placed the order first: its 409 opens the order page', async ({
  page,
  drop,
  buyer: _,
  baseURL,
}) => {
  // After checkout's first read, which would otherwise find the order placed and leave before Pay.
  const firstRead = firstOrderRead(page);
  const orderId = await buy(page, drop.productSlug);
  await fillShipping(page);
  await firstRead;
  // Another tab of the same buyer submits under its own key.
  await checkoutViaApi(page.request, baseURL, orderId);

  const answer = page.waitForResponse((response) => CHECKOUT_REQUEST.test(response.url()));
  await payButton(page).click();
  const refused = await answer;

  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'ALREADY_SUBMITTED' });
  await expect(page).toHaveURL(`/orders/${orderId}`);
  await expect(page.getByText('This order was already placed.')).toBeVisible();
  await expect(orderHeading(page)).toBeVisible();
});
