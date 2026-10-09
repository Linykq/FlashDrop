import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { TEST_SHIPPING } from './fixtures';

/*
 * The buyer's path through the storefront's checkout (design §8.3, design-system §10.4, §10.5), by the roles
 * and names a screen reader would announce, so the specs read as what a buyer does.
 */

export const CHECKOUT_URL = /\/checkout\/([0-9a-f-]{36})$/;
export const ORDER_URL = /\/orders\/([0-9a-f-]{36})$/;
export const CHECKOUT_REQUEST = /\/api\/v1\/orders\/[0-9a-f-]{36}\/checkout$/;
const ORDER_READ = /\/api\/v1\/orders\/[0-9a-f-]{36}$/;

/** How long a placed order takes to show PAID or declined: relay, PSP latency, consumer, the page's 2 s poll. */
export const SETTLES_WITHIN_MS = 30_000;

/**
 * How long Redis stock may take to follow an order's outcome once the spec has seen it: the relay and the
 * settlement consumer, well under a second. A spec sees the outcome at most about 3 s after Postgres
 * decided it (the order page polls every 2 s), so this stays below the settle safety net's 10 s minimum
 * age (§4.6): stock that comes back in time was returned by the settlement consumer, never by the fallback
 * that would also hide a consumer failing every event.
 */
export const STOCK_FOLLOWS_WITHIN_MS = 6_000;

/** The id in a checkout or order page URL. */
export function orderIdIn(page: Page): string {
  const { pathname } = new URL(page.url());
  const id = (CHECKOUT_URL.exec(pathname) ?? ORDER_URL.exec(pathname))?.[1];
  if (id === undefined) throw new Error(`not on a checkout or order page: ${page.url()}`);
  return id;
}

/**
 * Checkout's first read of its order, a second after the page opens (`use-hold-sync.ts`), which sends the
 * page to the order page when the order has left checkout. A spec that changes the order behind the page's
 * back (another tab's submit, a submit whose answer is lost) waits for it first, or the page may leave on its
 * own before the step under test. Start waiting before `buy`.
 */
export function firstOrderRead(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) => response.request().method() === 'GET' && ORDER_READ.test(response.url()),
  );
}

/** Presses Buy on the product page and waits for checkout; returns the order id. */
export async function buy(page: Page, productSlug: string): Promise<string> {
  await page.goto(`/p/${productSlug}`);
  await page.getByRole('main').getByRole('button', { name: 'Buy', exact: true }).click();
  await expect(page).toHaveURL(CHECKOUT_URL);
  return orderIdIn(page);
}

/** The Pay button, labelled with the total ("Pay $19.99"). */
export const payButton = (page: Page): Locator => page.getByRole('button', { name: /^Pay \$/ });

/**
 * Waits for the form to hydrate. Until then Pay is a plain button that does nothing (a press before
 * hydration must not submit the form natively, which would reload the page and drop what was typed).
 */
export async function formReady(page: Page): Promise<void> {
  await expect(page.locator('#checkout-form button[type="submit"]')).toBeVisible();
}

/** Types the test address into the shipping fieldset, by label, as autofill would leave it. */
export async function fillShipping(page: Page): Promise<void> {
  await formReady(page);
  const shipping = page.getByRole('group', { name: 'Shipping' });
  await shipping.getByLabel('Full name').fill(TEST_SHIPPING.name);
  await shipping.getByLabel('Address', { exact: true }).fill(TEST_SHIPPING.line1);
  await shipping.getByLabel('City').fill(TEST_SHIPPING.city);
  await shipping.getByLabel('State').selectOption(TEST_SHIPPING.state);
  await shipping.getByLabel('ZIP code').fill(TEST_SHIPPING.postalCode);
}

/** The order page's heading, which names the outcome ("You got it.", "Payment declined"). */
export const orderHeading = (page: Page): Locator => page.getByRole('heading', { level: 1 });
