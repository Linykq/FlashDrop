import type { Locator, Page } from '@playwright/test';
import {
  CHECKOUT_URL,
  countdownSeconds,
  fastForwardHold,
  firstOrderRead,
  holdAnnouncement,
  holdCard,
  ORDER_URL,
  orderHeading,
  orderIdIn,
  SETTLES_WITHIN_MS,
  STOCK_FOLLOWS_WITHIN_MS,
} from './support/checkout';
import { expect, orderOf, pollStock, reserveViaApi, TEST_SHIPPING, test } from './support/fixtures';

/*
 * Checkout with the keyboard alone (design §8.3; WCAG 2.1.1, 2.1.2, 2.2.1, 2.4.3, 3.3.1, 4.1.3): Tab,
 * Shift+Tab, Space, Enter, the arrow keys and typing, asserting where focus is and what the hold card's live
 * region says at each step. Focus starts on the checkout heading; the tab order is the visual order; a failed
 * submit moves focus to the error summary, whose links move it to the fields; a placed order moves it to the
 * order page's heading. Nothing the countdown says ever moves focus.
 *
 * The countdown runs under `page.clock` on a 120 s hold: jumps to 1:00, 0:30 and 0:10 bring each
 * announcement and, at 1:00, the one-time extension, which the buyer takes from the keyboard at 0:10.
 */

test.use({ dropSettings: { stock: 2, holdSeconds: 120 } });

/** Presses Tab until `target` has focus, at most `limit` times: the only way a keyboard user gets there. */
async function tabTo(page: Page, target: Locator, limit = 40): Promise<void> {
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Where Tab goes past a modal dialog's first or last control: out of the page, to the browser's own UI. */
const BROWSER_UI = 'browser UI';

/** Whether focus has left the document for the browser's own controls (nothing on the page has it). */
function focusLeftThePage(page: Page): Promise<boolean> {
  return page.evaluate(() => !document.hasFocus() && document.activeElement === document.body);
}

test('a keyboard-only purchase: tab order, error summary, countdown announcements and the extension', async ({
  page,
  drop,
  buyer: _,
}) => {
  // Before the first page loads, so every timer of checkout runs on a clock the spec can move.
  await page.clock.install();
  await page.goto(`/p/${drop.productSlug}`);
  const buyButton = page.getByRole('main').getByRole('button', { name: 'Buy', exact: true });
  await tabTo(page, buyButton);
  const firstRead = firstOrderRead(page);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(CHECKOUT_URL);
  const orderId = orderIdIn(page);

  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeFocused();
  await expect(page.locator('#checkout-form button[type="submit"]')).toBeVisible();
  // A fresh hold names its band once: the UI's 2 s margin starts the countdown at 1:58.
  const announcement = holdAnnouncement(page);
  await expect(announcement).toHaveText('2 minutes left to check out.');

  // The tab order is the visual order: every field, one stop for the payment radio group, then Pay.
  const shipping = page.getByRole('group', { name: 'Shipping' });
  const fields = {
    name: shipping.getByLabel('Full name'),
    line1: shipping.getByLabel('Address', { exact: true }),
    line2: shipping.getByLabel('Apartment, suite (optional)'),
    city: shipping.getByLabel('City'),
    state: shipping.getByLabel('State'),
    postalCode: shipping.getByLabel('ZIP code'),
    country: shipping.getByLabel('Country'),
  };
  const approving = page.getByRole('radio', { name: 'Test card that approves' });
  const declining = page.getByRole('radio', { name: 'Test card that declines' });
  const pay = page.getByRole('button', { name: /^Pay \$/ });
  const order = [...Object.values(fields), approving, pay];
  await page.keyboard.press('Tab');
  for (const [index, stop] of order.entries()) {
    if (index > 0) await page.keyboard.press('Tab');
    await expect(stop).toBeFocused();
  }
  // And back.
  await page.keyboard.press('Shift+Tab');
  await expect(approving).toBeFocused();
  // The arrow keys move through the native radio group and choose as they go.
  await page.keyboard.press('ArrowDown');
  await expect(declining).toBeFocused();
  await expect(declining).toBeChecked();
  await page.keyboard.press('ArrowUp');
  await expect(approving).toBeFocused();
  await expect(approving).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(pay).toBeFocused();

  // Pay on an empty form: the summary takes focus and links to each field to fix. Named by its title and
  // described by its list, so that the one focus event reads the count and every field (design-system
  // §10.4); its role is the component's choice.
  await page.keyboard.press('Enter');
  const focused = page.locator(':focus');
  await expect(focused).toHaveAccessibleName('Fix 5 fields to continue');
  await expect(focused).toHaveAccessibleDescription(/^Enter your full name\. Enter your street address\./);
  await expect(fields.name).toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Enter your full name.' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(fields.name).toBeFocused();

  await page.keyboard.type(TEST_SHIPPING.name);
  await page.keyboard.press('Tab');
  await page.keyboard.type(TEST_SHIPPING.line1);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(fields.city).toBeFocused();
  await page.keyboard.type(TEST_SHIPPING.city);
  await page.keyboard.press('Tab');
  // A closed native select picks the option the typed letters begin.
  await expect(fields.state).toBeFocused();
  await page.keyboard.type('California');
  await expect(fields.state).toHaveValue(TEST_SHIPPING.state);
  await page.keyboard.press('Tab');
  await page.keyboard.type(TEST_SHIPPING.postalCode);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(approving).toBeFocused();
  await expect(approving).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(pay).toBeFocused();
  await expect(announcement).toHaveText('2 minutes left to check out.');

  // The first read measured the page's offset to the server's clock; a jump before it would be taken back.
  await firstRead;
  const { expiresAt } = await orderOf(page.request, orderId);

  // 1:00: the warning, with the one-time extension. Focus stays where the buyer is, on Pay, the card scrolled
  // away above it: the bar keeps the time in view and the offer comes again just above Pay (WCAG 2.2.1).
  await fastForwardHold(page, 60);
  await expect(announcement).toHaveText('1 minute left. You can add 1 more minute.');
  await expect(pay).toBeFocused();
  await expect(holdCard(page).getByText('Need more time?')).toBeAttached();
  await expect(page.getByRole('banner').getByRole('link', { name: /^Reserved until / })).toBeVisible();
  const form = page.locator('#checkout-form');
  const extendButton = form.getByRole('button', { name: 'Add 1 minute' });
  await expect(extendButton).toBeVisible();

  await fastForwardHold(page, 30);
  await expect(announcement).toHaveText('30 seconds left.');
  await fastForwardHold(page, 10);
  await expect(announcement).toHaveText('10 seconds left.');
  await expect(pay).toBeFocused();

  // The extension, from the keyboard: its result replaces the button and takes its focus, which reads it.
  await page.keyboard.press('Shift+Tab');
  await expect(extendButton).toBeFocused();
  await page.keyboard.press('Space');
  const added = form.getByText('1 minute added', { exact: true });
  await expect(added).toBeFocused();
  await expect(page.getByRole('button', { name: 'Add 1 minute' })).toHaveCount(0);
  const extended = await orderOf(page.request, orderId);
  expect(extended).toMatchObject({ status: 'RESERVED', extensions: 1 });
  expect(Date.parse(extended.expiresAt) - Date.parse(expiresAt)).toBe(60_000);
  // The countdown moved up by the minute (or by more, when the extension's answer re-measured the offset).
  expect(await countdownSeconds(page)).toBeGreaterThan(60);

  // The new last minute is announced plainly: the extension is spent.
  await fastForwardHold(page, 60);
  await expect(announcement).toHaveText('1 minute left.');
  await expect(added).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(pay).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(ORDER_URL);
  await expect(orderHeading(page)).toBeFocused();
  await expect(orderHeading(page)).toHaveText('You got it.', { timeout: SETTLES_WITHIN_MS });
  // A status change after load never moves focus.
  await expect(orderHeading(page)).toBeFocused();
  expect(await orderOf(page.request, orderId)).toMatchObject({ status: 'PAID', shipping: TEST_SHIPPING });
});

test('the leave dialog traps focus, gives it back, and leaves from the keyboard', async ({
  page,
  drop,
  buyer: _,
  baseURL,
}) => {
  const { id: orderId } = await reserveViaApi(page.request, baseURL, drop.id);
  await page.goto(`/checkout/${orderId}`);
  const heading = page.getByRole('heading', { level: 1, name: 'Checkout' });
  await expect(heading).toBeFocused();

  // Before the heading: the bar's way out, and before it the skip link.
  const leaveButton = page.getByRole('button', { name: 'Leave checkout' });
  await page.keyboard.press('Shift+Tab');
  await expect(leaveButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('link', { name: 'Skip to checkout' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(leaveButton).toBeFocused();

  // Open: the safe action has focus, and Tab cycles through the dialog in both directions. Past either end
  // focus goes to the browser's own controls, as with any native modal dialog, and from there back into the
  // dialog: never to the inert page behind it.
  const dialog = page.getByRole('alertdialog', { name: 'Leave checkout?' });
  const stay = dialog.getByRole('button', { name: 'Stay' });
  const leave = dialog.getByRole('button', { name: 'Leave', exact: true });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription('Your reservation will be released.');
  await expect(stay).toBeFocused();
  for (const [key, next] of [
    ['Tab', leave],
    ['Tab', BROWSER_UI],
    ['Tab', stay],
    ['Shift+Tab', BROWSER_UI],
    ['Shift+Tab', leave],
    ['Shift+Tab', stay],
  ] as const) {
    await page.keyboard.press(key);
    if (next === BROWSER_UI) expect(await focusLeftThePage(page)).toBe(true);
    else await expect(next).toBeFocused();
  }

  // Stay closes it and gives focus back to the button that opened it; Esc chooses Stay.
  await page.keyboard.press('Space');
  await expect(dialog).toBeHidden();
  await expect(leaveButton).toBeFocused();
  await page.keyboard.press('Space');
  await expect(stay).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(leaveButton).toBeFocused();
  expect((await orderOf(page.request, orderId)).status).toBe('RESERVED');

  // Leave, from the keyboard: the hold is cancelled and the unit goes back on sale.
  await page.keyboard.press('Enter');
  await expect(stay).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(leave).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/p/${drop.productSlug}`);
  expect(await orderOf(page.request, orderId)).toMatchObject({ status: 'CANCELLED', closeReason: 'USER' });
  await expect
    .poll(async () => (await pollStock(page.request, drop.id))?.avail, { timeout: STOCK_FOLLOWS_WITHIN_MS })
    .toBe(drop.settings.stock);
});
