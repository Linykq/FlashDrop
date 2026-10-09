import {
  buy,
  fillShipping,
  ORDER_URL,
  orderHeading,
  payButton,
  SETTLES_WITHIN_MS,
  STOCK_FOLLOWS_WITHIN_MS,
} from './support/checkout';
import { expect, orderOf, pollStock, test } from './support/fixtures';
import { stockLinePattern } from './support/text';

/*
 * A declined card (design §4.4, §6.5; §16 M4 demo "with declines, stock comes back"): payment-mock declines
 * `pm_decline`, the payment consumer moves the order to PAYMENT_FAILED, which gives the quota and the unit
 * back in Postgres in the same transaction, and the settlement consumer gives the unit back to Redis. The
 * order page says so and offers the drop again, where the unit is on sale.
 */

test.use({ dropSettings: { stock: 1, perUserLimit: 1 } });

test('a declined card fails the payment, and the unit goes back on sale', async ({
  page,
  drop,
  buyer: _,
}) => {
  const orderId = await buy(page, drop.productSlug);
  await fillShipping(page);
  // The payment methods are one native radio group: the arrow keys move the choice.
  await page.getByRole('radio', { name: 'Card ending 4242' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'Declining card' })).toBeChecked();
  await payButton(page).click();

  await expect(page).toHaveURL(ORDER_URL);
  await expect(orderHeading(page)).toHaveText('Payment declined', { timeout: SETTLES_WITHIN_MS });
  await expect(
    page.getByText('Your test card was declined, so we released your reservation.', { exact: true }),
  ).toBeVisible();
  const details = page.getByRole('region', { name: 'Order details' });
  await expect(details.getByText('Declining card')).toBeVisible();
  const tryAgain = page.getByRole('link', { name: 'Try again' });
  await expect(tryAgain).toHaveAttribute('href', `/p/${drop.productSlug}`);

  expect(await orderOf(page.request, orderId)).toMatchObject({
    status: 'PAYMENT_FAILED',
    closeReason: 'DECLINED',
    declineCode: 'card_declined',
  });
  // Postgres gave the unit back with the decline; the settlement consumer gives it back to Redis.
  await expect
    .poll(async () => await pollStock(page.request, drop.id), { timeout: STOCK_FOLLOWS_WITHIN_MS })
    .toMatchObject({ avail: 1, held: 0, sold: 0 });

  // The limit of 1 came back with the unit: the buyer can try again.
  await tryAgain.click();
  await expect(page).toHaveURL(`/p/${drop.productSlug}`);
  const main = page.getByRole('main');
  await expect(main.getByText(stockLinePattern(1)).filter({ visible: true })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Buy', exact: true })).toBeEnabled();
});
