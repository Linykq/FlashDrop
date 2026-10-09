import { topicOf } from '@flashdrop/contracts';
import type { Browser, Page } from '@playwright/test';
import { expect, reserveViaApi, signInNewBuyer, test } from './support/fixtures';
import { expectFocusOnPage, tabTo } from './support/keyboard';
import { expectPlaying, paintedOpacity, player, UNMUTE, viewerCount } from './support/live';
import {
  expectPropagated,
  type GatewayRecording,
  instanceIds,
  levelFrames,
  recordGateway,
  SHOWN_WITHIN_MS,
} from './support/realtime';
import { stockLinePattern } from './support/text';

/*
 * The live room (design §7, §8.1, §13) of the spec's own drop, opened by two viewers pinned through Caddy to
 * different gateway instances (/ws/1 and /ws/2). The local HLS sample plays (the video reaches HAVE_CURRENT_DATA)
 * with its English captions track; the pinned drop's card follows its stock live; and the viewer count, the
 * sum of every instance's viewers in Redis, says 2 on both pages. And the player works from the keyboard
 * alone (design-system §10.3): Tab reaches it, C turns the captions on, the controls stay while focus is in
 * the player, and unmuting keeps focus on the page.
 */

/** Gateways write their viewer counts every 5 s and push the sum on the room topic (§7). */
const VIEWERS_COUNTED_WITHIN_MS = 15_000;
/** The controls fade after 3 s without the pointer moving (player.tsx), but never while focus is inside. */
const PAST_IDLE_FADE_MS = 3_500;

interface Viewer {
  readonly page: Page;
  readonly gateway: GatewayRecording;
}

async function openRoom(browser: Browser, slug: string, instance: 1 | 2): Promise<Viewer> {
  const page = await (await browser.newContext()).newPage();
  const gateway = recordGateway(page);
  await page.goto(`/live/${slug}?ws=${instance}`);
  return { page, gateway };
}

/** The drop card beside (or under) the player. */
const dropCard = (page: Page) => page.getByRole('main').getByText(/^(Only )?[\d,]+ left$/);

test.use({ dropSettings: { stock: 8, perUserLimit: 3, room: true } });

test('two viewers on different instances: the stream plays with captions, the card is live, and both count 2 viewers', async ({
  browser,
  drop,
  request,
  baseURL,
}) => {
  const room = drop.room;
  if (room === null) throw new Error('the drop was created without its room');
  const viewers = [await openRoom(browser, room.slug, 1), await openRoom(browser, room.slug, 2)];
  try {
    await expect.poll(() => viewers.map(({ gateway }) => instanceIds(gateway).length)).toEqual([1, 1]);
    const [first, second] = viewers.map(({ gateway }) => instanceIds(gateway)[0]);
    expect(first).not.toBe(second);

    for (const { page } of viewers) {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Test room /);
      await expectPlaying(page);
      const video = page.locator('video');
      const captions = video.locator('track[kind="captions"]');
      await expect(captions).toHaveAttribute('srclang', 'en');
      await expect(captions).toHaveAttribute('src', /\/hls\/captions\.en\.vtt$/);
      expect(await video.evaluate((element: HTMLVideoElement) => element.textTracks.length)).toBe(1);
      await expect(dropCard(page)).toHaveText(stockLinePattern(8));
      await expect(viewerCount(page)).toHaveText('2 watching', { timeout: VIEWERS_COUNTED_WITHIN_MS });
    }

    const buyer = await browser.newContext();
    let answered: number;
    try {
      await signInNewBuyer(request, baseURL, buyer);
      await reserveViaApi(buyer.request, baseURL, drop.id, 3);
      answered = Date.now();
    } finally {
      await buyer.close();
    }
    await Promise.all(
      viewers.map(async ({ page, gateway }) => {
        await expectPropagated(gateway, drop.id, 5, answered);
        await expect(dropCard(page)).toHaveText(stockLinePattern(5), { timeout: SHOWN_WITHIN_MS });
      }),
    );

    // The room topic names this drop as pinned, on both instances.
    for (const { gateway } of viewers) {
      const frames = levelFrames(gateway, topicOf('room', room.id));
      expect(frames.at(-1)?.data).toEqual({ pinned: { dropId: drop.id, status: 'LIVE' }, viewers: 2 });
      expect(gateway.malformed).toEqual([]);
    }
  } finally {
    await Promise.all(viewers.map(({ page }) => page.context().close()));
  }
});

test('the player works from the keyboard alone: captions, controls that stay while focused, and unmuting', async ({
  page,
  drop,
}) => {
  const room = drop.room;
  if (room === null) throw new Error('the drop was created without its room');
  // Before the page loads, so the idle fade's timer runs on a clock the spec moves past it.
  await page.clock.install();
  await page.goto(`/live/${room.slug}`);
  await expectPlaying(page);
  const video = player(page).locator('video');
  const captions = player(page).getByRole('button', { name: 'Captions' });

  // Single-key shortcuts work while the player itself has focus (WCAG 2.1.4).
  await tabTo(page, player(page));
  await page.keyboard.press('c');
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.textTracks[0]?.mode))
    .toBe('showing');
  await expect(captions).toHaveAttribute('aria-pressed', 'true');
  // The state shows without a cue on screen: a pressed toggle keeps a fill, and loses it when released.
  const fill = () => captions.evaluate((element) => getComputedStyle(element).backgroundColor);
  await expect.poll(fill).not.toBe('rgba(0, 0, 0, 0)');

  // On a control, past the idle fade: the capsules stay, so focus never sits on something invisible.
  await tabTo(page, captions);
  await page.clock.runFor(PAST_IDLE_FADE_MS);
  await expect.poll(() => paintedOpacity(captions)).toBe(1);
  await page.keyboard.press('Enter');
  await expect(captions).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(fill).toBe('rgba(0, 0, 0, 0)');

  // Back to the unmute pill, before the capsules: it goes once used, and focus must move to something on
  // the page rather than fall to the body.
  const unmute = player(page).getByRole('button', { name: UNMUTE });
  await tabTo(page, unmute, { backwards: true });
  await page.keyboard.press('Enter');
  await expect(unmute).toHaveCount(0);
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false);
  await expectFocusOnPage(page, 'after the unmute pill went away');
});
