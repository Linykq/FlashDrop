import { expect, type Locator, type Page } from '@playwright/test';

/*
 * The live room's player (design §8.1, design-system §10.3), as the live room specs drive it. They run in
 * Google Chrome (playwright.config.ts), which plays the H.264/AAC sample stream; in a browser that cannot,
 * the player shows its error card instead of its controls, and `expectPlaying` fails rather than letting a
 * spec check that card in their place.
 */

/** hls.js loads with the player, then the playlist, the init segment and a media segment. */
const PLAYING_WITHIN_MS = 15_000;
/** HTMLMediaElement.HAVE_CURRENT_DATA. */
const HAVE_CURRENT_DATA = 2;

/** The player itself: it takes focus for its single-key shortcuts. */
export const player = (page: Page): Locator => page.getByRole('region', { name: 'Live stream' });

/**
 * The unmute pill's name: "Tap to unmute" where the pointer is a finger, "Unmute" with a mouse (CSS picks one,
 * design-system §10.3), so it depends on the context's pointer rather than its viewport.
 */
export const UNMUTE = /^(Tap to unmute|Unmute)$/;

/** "2 watching": the count on the video, its unit read by screen readers only. */
export const viewerCount = (page: Page): Locator => page.getByRole('main').getByText(/^[\d,]+ watching$/);

/** Waits until the local HLS sample has a frame to show and the player offers its controls. */
export async function expectPlaying(page: Page): Promise<void> {
  const video = player(page).locator('video');
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), {
      message: 'the local HLS sample loads (is this Google Chrome, with H.264?)',
      timeout: PLAYING_WITHIN_MS,
    })
    .toBeGreaterThanOrEqual(HAVE_CURRENT_DATA);
  await expect(player(page).getByRole('button', { name: 'Captions' })).toBeAttached();
}

/**
 * The element's opacity as painted, its ancestors' included: the capsules fade by their wrapper's opacity,
 * which `toBeVisible` ignores.
 */
export function paintedOpacity(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity;
  });
}
