import {
  buy,
  fillShipping,
  ORDER_URL,
  orderHeading,
  payButton,
  SETTLES_WITHIN_MS,
  STOCK_FOLLOWS_WITHIN_MS,
} from './support/checkout';
import { expect, orderOf, pollOrder, pollStock, TEST_SHIPPING, test } from './support/fixtures';

/*
 * The purchase (design §5.2, §5.3, §16 M4 demo "Buy → PAID"): Buy holds a unit, checkout submits once and
 * answers at once (202, payment is asynchronous), and the order page follows the payment through the relay,
 * the payment consumer and payment-mock to PAID, while the settlement consumer commits the unit in Redis.
 */

test.use({ dropSettings: { stock: 3 } });

test('Buy, check out with the approving card, and the order is paid', async ({
  page,
  drop,
  buyer: _,
}, testInfo) => {
  const orderId = await buy(page, drop.productSlug);
  await fillShipping(page);
  await expect(page.getByRole('radio', { name: 'Test card that approves' })).toBeChecked();
  await payButton(page).click();

  // Submitted: the order page, its heading focused, follows the payment without moving focus again.
  await expect(page).toHaveURL(ORDER_URL);
  expect(new URL(page.url()).pathname).toBe(`/orders/${orderId}`);
  await expect(orderHeading(page)).toBeFocused();
  await expect(orderHeading(page)).toHaveText('You got it.', { timeout: SETTLES_WITHIN_MS });
  await expect(page.getByText('Your order is confirmed and paid.', { exact: true })).toBeVisible();
  const details = page.getByRole('region', { name: 'Order details' });
  await expect(details.getByText('Test card that approves')).toBeVisible();
  await expect(details.getByText(new RegExp(`^${TEST_SHIPPING.name}, ${TEST_SHIPPING.line1}`))).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to drops' })).toBeVisible();
  // The demo's evidence (§16 M4 "Buy → PAID"), kept in the HTML report.
  await testInfo.attach('paid-order-page', { body: await page.screenshot(), contentType: 'image/png' });

  const order = await orderOf(page.request, orderId);
  expect(order).toMatchObject({
    status: 'PAID',
    paymentMethod: 'pm_ok',
    declineCode: null,
    shipping: { ...TEST_SHIPPING },
  });
  // The settlement consumer commits the unit in Redis: sold, no longer held.
  await expect
    .poll(async () => await pollStock(page.request, drop.id), { timeout: STOCK_FOLLOWS_WITHIN_MS })
    .toMatchObject({ avail: 2, held: 0, sold: 1 });
  expect((await pollOrder(page.request, orderId))?.status).toBe('PAID');
});
