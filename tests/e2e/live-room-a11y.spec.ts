import type { Page } from '@playwright/test';
import { expectNoBlockingViolations, MODES, modeTitle } from './support/axe';
import { expect, reserveViaApi, type TestDrop, test } from './support/fixtures';
import { expectPlaying, paintedOpacity, player, UNMUTE, viewerCount } from './support/live';

/*
 * The live room's part of the axe gate (design §13, support/axe.ts), in Google Chrome like live-room.spec.ts
 * (playwright.config.ts): scanned while the stream plays, so the overlay controls are in the page, and with
 * focus in the player, so they are painted rather than faded out. A browser that cannot play the sample
 * stream fails `expectPlaying` instead of scanning the error card in their place. Each mode scans the room
 * signed out, and with a signed-in buyer's hold, whose notice sits on the drop card's surface; the phone
 * layout, where the card docks under the video, is scanned in both themes.
 */

test.use({ dropSettings: { stock: 5, room: true } });

/** iPhone 14: the card docked under the video, the controls over a narrow stream. */
const PHONE = { width: 390, height: 844 } as const;

/** Opens the drop's room and waits until it plays with its controls painted. */
async function openPlayingRoom(page: Page, drop: TestDrop): Promise<void> {
  const room = drop.room;
  if (room === null) throw new Error('the drop was created without its room');
  await page.goto(`/live/${room.slug}`);
  // The room topic has answered: the viewer count is on the video.
  await expect(viewerCount(page)).toBeVisible();
  await expectPlaying(page);
  // Focus inside the player keeps the capsules shown past their idle fade.
  await player(page).focus();
  // The player's own toggle: the room's transcript card has a "Turn on captions" button for the same state.
  const captions = player(page).getByRole('button', { name: 'Captions' });
  await expect(captions).toBeVisible();
  await expect(player(page).getByRole('button', { name: UNMUTE })).toBeVisible();
  await expect.poll(() => paintedOpacity(captions)).toBe(1);
}

for (const mode of MODES) {
  test.describe(modeTitle(mode), () => {
    test.use(mode);

    test('live room, playing with its controls shown, has no serious or critical axe violations', async ({
      page,
      drop,
    }, testInfo) => {
      await openPlayingRoom(page, drop);
      await expectNoBlockingViolations(page, testInfo);
    });

    test("live room with the buyer's hold on its card has no serious or critical axe violations", async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      await reserveViaApi(page.request, baseURL, drop.id);
      await openPlayingRoom(page, drop);
      await expect(page.getByText('You have 1 reserved', { exact: true })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });
  });
}

for (const mode of MODES.filter(({ reducedMotion }) => reducedMotion === 'no-preference')) {
  test.describe(`phone, ${modeTitle(mode)}`, () => {
    test.use({ ...mode, viewport: PHONE });

    test("live room with the buyer's hold has no serious or critical axe violations", async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      await reserveViaApi(page.request, baseURL, drop.id);
      await openPlayingRoom(page, drop);
      await expect(page.getByText('You have 1 reserved', { exact: true })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });
  });
}
