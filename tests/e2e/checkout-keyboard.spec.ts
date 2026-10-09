import type { Locator, Page } from '@playwright/test';
import { CHECKOUT_URL, ORDER_URL, orderHeading, SETTLES_WITHIN_MS } from './support/checkout';
import { expect, orderOf, TEST_SHIPPING, test } from './support/fixtures';

/*
 * A purchase with the keyboard alone (design §8.3; WCAG 2.1.1, 2.4.3, 3.3.1): Tab, Shift+Tab, Enter, typing
 * and the arrow keys, asserting where focus is at each step. Focus starts on the checkout heading; the tab
 * order through the form is the visual order; a failed submit moves focus to the error summary, whose links
 * move it to the fields; a placed order moves it to the order page's heading. The countdown announcements
 * and the +60 s extension under `page.clock` are M6 (§16).
 */

test.use({ dropSettings: { stock: 2 } });

/** Presses Tab until `target` has focus, at most `limit` times: the only way a keyboard user gets there. */
async function tabTo(page: Page, target: Locator, limit = 40): Promise<void> {
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

test('a keyboard-only purchase, with the error summary on the way', async ({ page, drop, buyer: _ }) => {
  await page.goto(`/p/${drop.productSlug}`);
  const buyButton = page.getByRole('main').getByRole('button', { name: 'Buy', exact: true });
  await tabTo(page, buyButton);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(CHECKOUT_URL);
  const orderId = new URL(page.url()).pathname.split('/').at(-1) ?? '';

  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeFocused();
  await expect(page.locator('#checkout-form button[type="submit"]')).toBeVisible();

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
  const approving = page.getByRole('radio', { name: 'Card ending 4242' });
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
  await page.keyboard.press('Tab');

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
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(ORDER_URL);
  await expect(orderHeading(page)).toBeFocused();
  await expect(orderHeading(page)).toHaveText('You got it.', { timeout: SETTLES_WITHIN_MS });
  // A status change after load never moves focus.
  await expect(orderHeading(page)).toBeFocused();
  expect(await orderOf(page.request, orderId)).toMatchObject({ status: 'PAID', shipping: TEST_SHIPPING });
});
