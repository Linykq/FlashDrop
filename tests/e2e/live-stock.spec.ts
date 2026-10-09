import type { Browser, Page } from '@playwright/test';
import { expect, reserveViaApi, signInNewBuyer, stockOf, test } from './support/fixtures';
import {
  expectPropagated,
  type GatewayRecording,
  instanceIds,
  recordGateway,
  SHOWN_WITHIN_MS,
  stockFrames,
  strictlyNewer,
} from './support/realtime';
import { stockLinePattern } from './support/text';

/*
 * Live stock across gateway instances (design §7, §8.2, §13): two browsers, one pinned through Caddy's /ws/1
 * to api-1 and one through /ws/2 to api-2, watch the same product page. Each gets a different
 * `hello.instanceId`, a snapshot on subscribing, and then every reservation as a delta from its own
 * instance (Redis pub/sub fans the Functions' publish out to both), received within 1 s of the reserve's
 * answer and then shown. The pages' stock polls are cut off, so the socket is the only way a change can
 * arrive. The 1 s is judged on the frames (support/realtime.ts), the page on a timeout a busy runner can meet.
 */

const STOCK_POLLS = '**/api/v1/drops/*/stock';

interface Viewer {
  readonly page: Page;
  readonly gateway: GatewayRecording;
}

/** A fresh browser on the product page, its first socket pinned to one gateway instance. */
async function openViewer(browser: Browser, slug: string, instance: 1 | 2): Promise<Viewer> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const gateway = recordGateway(page);
  await page.route(STOCK_POLLS, (route) => route.abort());
  await page.goto(`/p/${slug}?ws=${instance}`);
  return { page, gateway };
}

/** The purchase panel's primary stock line, "10 left" or "Only 3 left". */
const stockLine = (page: Page) => page.getByRole('main').getByText(/^(Only )?[\d,]+ left$/);

test.use({ dropSettings: { stock: 20, perUserLimit: 5 } });

test('pages on /ws/1 and /ws/2 reach different instances, and both get each reservation within 1 s', async ({
  browser,
  drop,
  request,
  baseURL,
}) => {
  const viewers = [
    await openViewer(browser, drop.productSlug, 1),
    await openViewer(browser, drop.productSlug, 2),
  ];
  try {
    for (const { page, gateway } of viewers) {
      await expect(stockLine(page)).toHaveText(stockLinePattern(20));
      // Subscribed: the snapshot of the drop's level, before anything changes.
      await expect.poll(() => stockFrames(gateway, drop.id).map((frame) => frame.type)).toEqual(['snapshot']);
    }
    const [first, second] = viewers.map(({ gateway }) => instanceIds(gateway));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first?.[0]).not.toBe(second?.[0]);

    const buyer = await browser.newContext();
    try {
      await signInNewBuyer(request, baseURL, buyer);
      let avail = 20;
      for (const qty of [3, 1]) {
        await reserveViaApi(buyer.request, baseURL, drop.id, qty);
        const answered = Date.now();
        avail -= qty;
        // Both at once: each page has the same second from the moment the reservation answered.
        await Promise.all(
          viewers.map(async ({ page, gateway }) => {
            await expectPropagated(gateway, drop.id, avail, answered);
            await expect(stockLine(page)).toHaveText(stockLinePattern(avail), { timeout: SHOWN_WITHIN_MS });
          }),
        );
      }
    } finally {
      await buyer.close();
    }

    const truth = await stockOf(request, drop.id);
    expect(truth).toMatchObject({ avail: 16, held: 4 });
    for (const { gateway } of viewers) {
      expect(gateway.malformed).toEqual([]);
      // One socket each, never replaced; its deltas newer than the snapshot and ending on Redis's level.
      expect(gateway.sockets).toHaveLength(1);
      const frames = stockFrames(gateway, drop.id);
      expect(frames.slice(1).every((frame) => frame.type === 'delta')).toBe(true);
      expect(strictlyNewer(frames)).toBe(true);
      expect(frames.at(-1)?.data).toMatchObject({ avail: truth.avail, held: truth.held, sold: truth.sold });
    }
  } finally {
    await Promise.all(viewers.map(({ page }) => page.context().close()));
  }
});
