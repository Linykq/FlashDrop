import { settledListingJob, signInAdmin, uploadListing } from './support/admin';
import { expect, test } from './support/fixtures';
import { expectFocusOnPage, tabTo } from './support/keyboard';

/*
 * The admin's keyboard paths (design §13, design-system §10.8, §10.9, WCAG 2.4.3): a destructive action
 * confirmed from the keyboard alone leaves focus on the page, not on <body>, although the action replaces
 * the buttons it was reached through; and a failed approve's error summary follows the fixes, its links
 * taking focus to the field each names, a list-level error to the list's first entry.
 */

test.beforeEach(async ({ context, baseURL }) => {
  await signInAdmin(context, baseURL);
});

test('End drop from the keyboard: Enter, Tab to confirm, Enter; focus moves to the new header actions', async ({
  page,
  drop,
}) => {
  await page.goto(`/admin/drops/${drop.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const end = page.getByRole('button', { name: 'End drop' });
  await tabTo(page, end);
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'End this drop now?' });
  await expect(dialog).toBeVisible();
  // The safe choice has focus first (§9.14); the destructive one is a Tab away.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'End drop' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Reconcile' })).toBeVisible();
  await expect(end).toHaveCount(0);
  // The button that had focus is gone: the header's first action takes it.
  await expect(page.locator('[data-page-actions] button').first()).toBeFocused();
  await expectFocusOnPage(page, 'after the drop ended');
});

test('a failed approve: the summary drops what was fixed, and the highlights link focuses the first highlight', async ({
  page,
  baseURL,
}) => {
  // Apparel without a size: NEEDS_REVIEW, with the size required (tests/fixtures/README.md).
  const jobId = await uploadListing(
    page.request,
    baseURL,
    'shirt.jpg',
    `Keyboard review run ${crypto.randomUUID().slice(0, 8)}`,
  );
  expect((await settledListingJob(page.request, jobId)).status).toBe('NEEDS_REVIEW');
  await page.goto(`/admin/listings/${jobId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Review listing' })).toBeVisible();

  // Two highlights of the three required: an error on the list as a whole.
  await page.getByRole('button', { name: 'Remove highlight 3' }).click();
  await page.getByRole('button', { name: 'Approve and publish' }).click();

  const summary = page.getByRole('region', { name: /^Fix \d+ fields? to publish$/ });
  await expect(summary).toBeFocused();
  // Each link points at what it focuses: the size field, and for the list, its first entry.
  const links = summary.getByRole('link');
  const sizeLink = summary.locator('a[href$="-size"]');
  const highlightsLink = summary.locator('a[href$="-highlights-0"]');
  await expect(links).toHaveCount(2);
  await expect(sizeLink).toHaveCount(1);
  await expect(highlightsLink).toHaveCount(1);

  // Fixed, the size leaves the summary: no empty link stays behind, and the count follows.
  await page.getByRole('textbox', { name: 'Size', exact: true }).fill('M');
  await expect(summary).toHaveAccessibleName('Fix 1 field to publish');
  await expect(sizeLink).toHaveCount(0);
  await expect(links).toHaveCount(1);

  await tabTo(page, highlightsLink, { backwards: true, maxPresses: 80 });
  await page.keyboard.press('Enter');
  const first = page.getByRole('textbox', { name: 'Highlight 1', exact: true });
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('id', /-highlights-0$/);
});
