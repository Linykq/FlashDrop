import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

/*
 * The axe gate of design §13, shared by a11y.spec.ts and the live room's scans (live-room-a11y.spec.ts, which
 * runs in Google Chrome so the stream plays): 0 serious or critical violations, in both themes, each with
 * motion and with `reducedMotion: 'reduce'`. Every violation, whatever its impact, is attached to the test,
 * so lesser ones stay visible.
 */

export const MODES = [
  { colorScheme: 'light', reducedMotion: 'no-preference' },
  { colorScheme: 'dark', reducedMotion: 'no-preference' },
  { colorScheme: 'light', reducedMotion: 'reduce' },
  { colorScheme: 'dark', reducedMotion: 'reduce' },
] as const;

export type Mode = (typeof MODES)[number];

export const modeTitle = ({ colorScheme, reducedMotion }: Mode): string =>
  `${colorScheme} theme${reducedMotion === 'reduce' ? ', reduced motion' : ''}`;

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/** Waits until every finite animation and transition (entrances, dialogs opening, fades) has finished. */
export async function animationsDone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Contrast is judged at rest. An infinite animation never finishes, so it is not waited for.
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** Waits until the page is what a reader sees: streamed parts in, fonts loaded, entrance motion done. */
export async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await animationsDone(page);
}

type Blocking = { id: string; impact: string; help: string; targets: string[] };

async function blockingViolations(page: Page, testInfo: TestInfo, name: string): Promise<Blocking[]> {
  await settle(page);
  const { violations } = await new AxeBuilder({ page }).analyze();
  await testInfo.attach(name, { body: JSON.stringify(violations, null, 2), contentType: 'application/json' });
  return violations
    .filter(({ impact }) => impact != null && BLOCKING_IMPACTS.has(impact))
    .map(({ id, impact, help, nodes }) => ({
      id,
      impact: impact ?? '',
      help,
      targets: nodes.map(({ target }) => target.join(' ')),
    }));
}

/**
 * A live page keeps changing while axe reads it: in the live room the "On screen" link follows the video and
 * can mount, fading in, during the scan, where axe judges it at part opacity. A real violation is still there
 * at rest, so a finding counts only if a second scan, after the page settles again, repeats it on the same
 * elements.
 */
export async function expectNoBlockingViolations(page: Page, testInfo: TestInfo): Promise<void> {
  const first = await blockingViolations(page, testInfo, 'axe-violations.json');
  if (first.length === 0) return;
  const second = await blockingViolations(page, testInfo, 'axe-violations-rescan.json');
  const persistent = first
    .map((violation) => {
      const again = second.find(({ id }) => id === violation.id);
      return { ...violation, targets: violation.targets.filter((target) => again?.targets.includes(target)) };
    })
    .filter(({ targets }) => targets.length > 0);
  expect(persistent).toEqual([]);
}
