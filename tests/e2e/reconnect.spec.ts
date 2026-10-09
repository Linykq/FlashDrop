import type { Page } from '@playwright/test';
import { expect, reserveViaApi, signInNewBuyer, stockOf, test } from './support/fixtures';
import { recordGateway, stockFrames, strictlyNewer } from './support/realtime';
import { stockLinePattern } from './support/text';

/*
 * Resync after a lost connection (design §7 steps 4 and 5, §13): stock is a level, not a log, so a client
 * that comes back needs nothing but a fresh snapshot. The browser goes offline; the page drops its socket,
 * says "Live updates paused" after 5 s, and misses a reservation made meanwhile. Back online, it reconnects
 * at once and shows the true level, from the snapshot on its new socket. The stock polls are cut off, so the
 * level can only come from that snapshot.
 */

const STOCK_POLLS = '**/api/v1/drops/*/stock';
/** The paused notice follows 5 s without a socket (`REALTIME_TIMING.pausedAfterMs`). */
const PAUSED_WITHIN_MS = 8_000;
/** Back online, the reconnect skips its backoff. */
const RESYNCED_WITHIN_MS = 3_000;

const stockLine = (page: Page) => page.getByRole('main').getByText(/^(Only )?[\d,]+ left$/);
const pausedNotice = (page: Page) => page.getByRole('main').getByText('Live updates paused');

test.use({ dropSettings: { stock: 12, perUserLimit: 5 } });

test('offline, the page says live updates are paused; back online, a fresh snapshot shows the true level', async ({
  page,
  drop,
  browser,
  request,
  baseURL,
}) => {
  const gateway = recordGateway(page);
  await page.route(STOCK_POLLS, (route) => route.abort());
  await page.goto(`/p/${drop.productSlug}`);
  await expect(stockLine(page)).toHaveText(stockLinePattern(12));
  await expect.poll(() => stockFrames(gateway, drop.id).length).toBe(1);

  await page.context().setOffline(true);
  // A browser keeps a socket "open" through a lost network; the client closes it on the offline event.
  await expect.poll(() => gateway.sockets[0]?.closed).toBe(true);
  await expect(pausedNotice(page)).toBeVisible({ timeout: PAUSED_WITHIN_MS });

  const other = await browser.newContext();
  try {
    await signInNewBuyer(request, baseURL, other);
    await reserveViaApi(other.request, baseURL, drop.id, 5);
  } finally {
    await other.close();
  }
  expect(await stockOf(request, drop.id)).toMatchObject({ avail: 7, held: 5 });
  // The page cannot know yet: it keeps the last level it had.
  await expect(stockLine(page)).toHaveText(stockLinePattern(12));

  await page.context().setOffline(false);
  await expect(stockLine(page)).toHaveText(stockLinePattern(7), { timeout: RESYNCED_WITHIN_MS });
  await expect(pausedNotice(page)).toHaveCount(0);

  const frames = stockFrames(gateway, drop.id);
  const resync = frames.filter((frame) => frame.socket > 0);
  expect(resync[0]).toMatchObject({ type: 'snapshot', data: { avail: 7, held: 5, sold: 0 } });
  expect(strictlyNewer(frames)).toBe(true);
  expect(gateway.malformed).toEqual([]);
});
