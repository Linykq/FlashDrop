import { type OrderStatus, type PaymentMethod, topicOf } from '@flashdrop/contracts';
import type { APIRequestContext, Page } from '@playwright/test';
import { dashboardOf, signInAdmin } from './support/admin';
import { SETTLES_WITHIN_MS } from './support/checkout';
import { checkoutViaApi, expect, pollOrder, reserveViaApi, signInNewBuyer, test } from './support/fixtures';
import { levelFrames, recordGateway, strictlyNewer } from './support/realtime';

/*
 * The live sales dashboard (design §9, §13) for the spec's own drop: the totals the `sales-dashboard`
 * consumer projected from orders.v1 match what the spec's buyers did, the page server-renders them, and an
 * order paid while the page is open reaches it over the admin-only `dash:<dropId>` topic, without a reload.
 */

/** Order events reach the projection through the relay and the consumer: well within a payment's settling. */
const PROJECTED_WITHIN_MS = SETTLES_WITHIN_MS;

/** A buyer's order of `qty`, placed and paid with `method`, waited on until the payment consumer decided it. */
async function decidedOrder(
  request: APIRequestContext,
  baseURL: string | undefined,
  dropId: string,
  qty: number,
  method: PaymentMethod,
  status: OrderStatus,
): Promise<void> {
  const order = await reserveViaApi(request, baseURL, dropId, qty);
  await checkoutViaApi(request, baseURL, order.id, method);
  await expect
    .poll(async () => (await pollOrder(request, order.id))?.status, { timeout: SETTLES_WITHIN_MS })
    .toBe(status);
}

const funnel = (page: Page) => page.getByRole('img', { name: /^Funnel:/ });
const unitsSold = (page: Page) =>
  page
    .getByRole('region', { name: 'Totals' })
    .getByText('Units sold', { exact: true })
    .locator('xpath=../following-sibling::p[1]');

test.use({ dropSettings: { stock: 10, perUserLimit: 5 } });

test('totals of the drop’s own orders, server-rendered, then updated live by an order paid meanwhile', async ({
  page,
  drop,
  browser,
  request,
  baseURL,
}) => {
  const buyer = await browser.newContext();
  try {
    await signInNewBuyer(request, baseURL, buyer);
    await decidedOrder(buyer.request, baseURL, drop.id, 2, 'pm_ok', 'PAID');
    await decidedOrder(buyer.request, baseURL, drop.id, 1, 'pm_decline', 'PAYMENT_FAILED');

    await signInAdmin(page.context(), baseURL);
    await expect
      .poll(async () => (await dashboardOf(page.request, drop.id)).projection.totals, {
        message: 'the sales-dashboard consumer projects the orders',
        timeout: PROJECTED_WITHIN_MS,
      })
      .toMatchObject({
        reserved: 2,
        placed: 2,
        paid: 1,
        failed: 1,
        expired: 0,
        cancelled: 0,
        rejected: 0,
        unitsSold: 2,
        revenueCents: 2 * 2_500,
      });

    const gateway = recordGateway(page);
    await page.goto(`/admin/dashboard/${drop.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Test drop /);
    await expect(unitsSold(page)).toHaveText('2');
    await expect(funnel(page)).toHaveAccessibleName(
      'Funnel: 2 reserved, 2 placed, 1 paid; 0 expired, 0 cancelled, 1 failed, 0 rejected.',
    );
    const dash = topicOf('dash', drop.id);
    await expect.poll(() => levelFrames(gateway, dash).map((frame) => frame.type)).toContain('snapshot');
    // Proof that what follows arrives without a navigation.
    await page.evaluate(() => Object.assign(window, { stayed: true }));

    await decidedOrder(buyer.request, baseURL, drop.id, 1, 'pm_ok', 'PAID');
    await expect(unitsSold(page)).toHaveText('3', { timeout: PROJECTED_WITHIN_MS });
    await expect(funnel(page)).toHaveAccessibleName(
      'Funnel: 3 reserved, 3 placed, 2 paid; 0 expired, 0 cancelled, 1 failed, 0 rejected.',
    );
    expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);

    const frames = levelFrames(gateway, dash);
    expect(frames.some((frame) => frame.type === 'delta')).toBe(true);
    expect(strictlyNewer(frames)).toBe(true);
    expect(frames.at(-1)?.data).toMatchObject({ paid: 2, unitsSold: 3, revenueCents: 3 * 2_500 });
    expect(gateway.malformed).toEqual([]);
  } finally {
    await buyer.close();
  }
});
