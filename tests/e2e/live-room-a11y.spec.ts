import { expectNoBlockingViolations, MODES, modeTitle } from './support/axe';
import { expect, test } from './support/fixtures';
import { expectPlaying, paintedOpacity, player, viewerCount } from './support/live';

/*
 * The live room's part of the axe gate (design §13, support/axe.ts), in Google Chrome like live-room.spec.ts
 * (playwright.config.ts): scanned while the stream plays, so the overlay controls are in the page, and with
 * focus in the player, so they are painted rather than faded out. A browser that cannot play the sample
 * stream fails `expectPlaying` instead of scanning the error card in their place.
 */

test.use({ dropSettings: { stock: 5, room: true } });

for (const mode of MODES) {
  test.describe(modeTitle(mode), () => {
    test.use(mode);

    test('live room, playing with its controls shown, has no serious or critical axe violations', async ({
      page,
      drop,
    }, testInfo) => {
      const room = drop.room;
      if (room === null) throw new Error('the drop was created without its room');
      await page.goto(`/live/${room.slug}`);
      // The room topic has answered: the viewer count is on the video.
      await expect(viewerCount(page)).toBeVisible();
      await expectPlaying(page);
      // Focus inside the player keeps the capsules shown past their idle fade.
      await player(page).focus();
      const captions = page.getByRole('button', { name: 'Captions' });
      await expect(captions).toBeVisible();
      await expect(page.getByRole('button', { name: 'Tap to unmute' })).toBeVisible();
      await expect.poll(() => paintedOpacity(captions)).toBe(1);
      await expectNoBlockingViolations(page, testInfo);
    });
  });
}
