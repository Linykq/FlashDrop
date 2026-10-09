import { expect, type Locator, type Page } from '@playwright/test';

/*
 * Keyboard paths (design §13, WCAG 2.1.1, 2.4.3): reaching a control the way a keyboard user does, and
 * checking that focus never falls to <body> when the control that had it goes away.
 */

/**
 * Presses Tab (Shift+Tab with `backwards`) until `target` has focus, the way a keyboard user reaches it;
 * fails after `maxPresses`.
 */
export async function tabTo(
  page: Page,
  target: Locator,
  { backwards = false, maxPresses = 40 }: { backwards?: boolean; maxPresses?: number } = {},
): Promise<void> {
  for (let press = 0; press < maxPresses; press += 1) {
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`${backwards ? 'Shift+Tab' : 'Tab'} did not reach ${target} within ${maxPresses} presses`);
}

/** Focus is on an element of the page, not on <body> (where it lands when its element left the page). */
export async function expectFocusOnPage(page: Page, what: string): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body),
      {
        message: `focus stays on the page ${what}`,
      },
    )
    .toBe(true);
}
