import {
  buy,
  CHECKOUT_REQUEST,
  fillShipping,
  firstOrderRead,
  ORDER_URL,
  orderHeading,
  payButton,
  STOCK_FOLLOWS_WITHIN_MS,
} from './support/checkout';
import { expect, orderOf, pollStock, test } from './support/fixtures';

/*
 * Leaving checkout (design §5.1, §8.3; design-system §9.14, §10.4): "Leave checkout" in the bar opens a
 * native alert dialog. Stay is the safe action, with initial focus, and Esc chooses it; focus returns to the
 * button. Leave cancels the order, a CAS that gives the quota and the unit back in Postgres at once, and the
 * settlement consumer gives the unit back to Redis, rather than when the hold would have run out.
 *
 * Leave cancels a hold, never an order being paid: the button waits while Pay's submit is in flight, and
 * the cancel carries `from=RESERVED`, so an order placed meanwhile (a submit whose answer was lost, another
 * tab or device) is refused with 409 and the order page shows its payment.
 */

const CANCEL_REQUEST = /\/api\/v1\/orders\/[0-9a-f-]{36}\/cancel\?from=RESERVED$/;

test.use({ dropSettings: { stock: 1, perUserLimit: 1 } });

test('Leave checkout cancels the order after asking, and the unit goes back on sale', async ({
  page,
  drop,
  buyer: _,
}) => {
  const orderId = await buy(page, drop.productSlug);
  const leaveButton = page.getByRole('button', { name: 'Leave checkout' });
  const dialog = page.getByRole('alertdialog', { name: 'Leave checkout?' });

  // Esc is Stay: nothing changes, and focus goes back to the button that opened the dialog.
  await leaveButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/Your reservation will be released\./);
  await expect(dialog.getByRole('button', { name: 'Stay' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(leaveButton).toBeFocused();
  expect((await orderOf(page.request, orderId)).status).toBe('RESERVED');

  await leaveButton.click();
  await dialog.getByRole('button', { name: 'Leave', exact: true }).click();

  await expect(page).toHaveURL(`/p/${drop.productSlug}`);
  expect(await orderOf(page.request, orderId)).toMatchObject({ status: 'CANCELLED', closeReason: 'USER' });
  await expect
    .poll(async () => await pollStock(page.request, drop.id), { timeout: STOCK_FOLLOWS_WITHIN_MS })
    .toMatchObject({ avail: 1, held: 0, sold: 0 });
  await expect(page.getByRole('main').getByRole('button', { name: 'Buy', exact: true })).toBeEnabled({
    timeout: 15_000,
  });

  // Checkout of a cancelled order is over: it shows what happened on the order page instead.
  await page.goto(`/checkout/${orderId}`);
  await expect(page).toHaveURL(`/orders/${orderId}`);
  await expect(orderHeading(page)).toHaveText('Order cancelled');
  await expect(page.getByRole('link', { name: 'Back to the drop' })).toHaveAttribute(
    'href',
    `/p/${drop.productSlug}`,
  );
});

test('Leave waits while Pay is in flight: the answer decides the order', async ({ page, drop, buyer: _ }) => {
  const orderId = await buy(page, drop.productSlug);
  await fillShipping(page);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(CHECKOUT_REQUEST, async (route) => {
    await held;
    await route.continue();
  });
  const leaveButton = page.getByRole('button', { name: 'Leave checkout' });

  await payButton(page).click();
  await expect(leaveButton).toHaveAttribute('aria-disabled', 'true');
  // Forced past Playwright's own wait for an enabled element: the press must reach the button and do nothing.
  await leaveButton.click({ force: true });
  await expect(page.getByRole('alertdialog')).toBeHidden();

  release();
  await expect(page).toHaveURL(`/orders/${orderId}`);
  expect((await orderOf(page.request, orderId)).status).toMatch(/^(PENDING_PAYMENT|PAID)$/);
});

test('Leave after a lost answer never cancels the placed order: api refuses and the order page shows it', async ({
  page,
  drop,
  buyer: _,
}) => {
  // Checkout reads the order a second after it opens, then only on focus or a message from another tab. A
  // read after the lost submit would find the order placed and leave by itself; the case under test is the
  // one no read catches, so Pay comes after it.
  const firstRead = firstOrderRead(page);
  const orderId = await buy(page, drop.productSlug);
  await fillShipping(page);
  await firstRead;
  // The submit reaches api and places the order, but its answer never reaches the page: still a hold here.
  await page.route(CHECKOUT_REQUEST, async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  await payButton(page).click();
  await expect(page.getByRole('alert').filter({ hasText: "Couldn't place your order." })).toBeVisible();

  const cancel = page.waitForResponse((response) => CANCEL_REQUEST.test(response.url()));
  await page.getByRole('button', { name: 'Leave checkout' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Leave', exact: true }).click();

  expect((await cancel).status()).toBe(409);
  await expect(page).toHaveURL(ORDER_URL);
  expect((await orderOf(page.request, orderId)).status).toMatch(/^(PENDING_PAYMENT|PAID)$/);
  await expect(orderHeading(page)).toHaveText(/^(Processing payment…|You got it\.)$/);
});
