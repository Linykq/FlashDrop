import type { OrderStatus, PaymentMethod } from '@flashdrop/contracts';
import type { Locator, Page } from '@playwright/test';
import { choosePhotos, dashboardOf, settledListingJob, signInAdmin, uploadListing } from './support/admin';
import { expectNoBlockingViolations, MODES, modeTitle, settle } from './support/axe';
import {
  fastForwardHold,
  firstOrderRead,
  formReady,
  holdCard,
  orderHeading,
  payButton,
  SETTLES_WITHIN_MS,
} from './support/checkout';
import {
  checkoutViaApi,
  createDrop,
  expect,
  pollOrder,
  reserveViaApi,
  signInNewBuyer,
  test,
} from './support/fixtures';

/*
 * The axe gate of design §13 (support/axe.ts): 0 serious or critical violations on every page built so far,
 * in every checkout state (idle, holding, its last minute, error, expired, paid and declined) and the admin's
 * states (the drops list with its New drop sheet, empty and with errors; a drop's page with its End and
 * Reconcile confirmations; the dashboard; health; the listing upload, also refusing a file; the review, also
 * after a failed approve and after the fix), in both themes, each with motion and with
 * `reducedMotion: 'reduce'`, which turns the motion off rather than waiting it out. The live room's scans
 * need the stream to play, so they run in Google Chrome (live-room-a11y.spec.ts). The theme follows
 * `prefers-color-scheme` unless a stored override exists, and a fresh context has none. Pages that show
 * stock or a hold use the spec's own drop (support/fixtures.ts); home and sign-in show the seed. Then the
 * phone layouts in both themes, the admin tables at a narrow desktop width, and forced colours.
 */

/**
 * A short phone (iPhone SE): a test product has no highlights or details, so on a taller screen its page is
 * short enough that the buy row stays in view and the sticky buy bar rightly never shows.
 */
const PHONE = { width: 375, height: 667 } as const;

/** A seeded product with three photos, so its gallery has thumbnails to tell apart (assets/catalog). */
const GALLERY_PRODUCT = 'amber-jar-candle';

/**
 * Tables wider than the card that clips them, by caption: a table must fit its card or scroll sideways in a
 * region of its own (design-system §9.22). Judged on the layout boxes, so a column cut off at the card's edge
 * counts even though nothing overflows the page.
 */
function clippedTables(page: Page): Promise<string[]> {
  return page.locator('table').evaluateAll((tables) =>
    tables.flatMap((table) => {
      const caption = table.querySelector('caption')?.textContent ?? 'a table without a caption';
      for (let node = table.parentElement; node !== null; node = node.parentElement) {
        const { overflowX } = getComputedStyle(node);
        if (overflowX === 'auto' || overflowX === 'scroll') return [];
        if (overflowX === 'hidden' || overflowX === 'clip') {
          return table.scrollWidth > node.clientWidth + 1 ? [caption] : [];
        }
      }
      return table.getBoundingClientRect().right > document.documentElement.clientWidth + 1 ? [caption] : [];
    }),
  );
}

/**
 * What still marks an element in forced colours, which repaint every colour, background and shadow with the
 * system's: borders and outlines by width and style, text decoration and weight, and the system colours used.
 */
function forcedLook(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const sides = ['top', 'right', 'bottom', 'left'].map((side) =>
      ['width', 'style', 'color'].map((part) => style.getPropertyValue(`border-${side}-${part}`)),
    );
    return JSON.stringify([
      style.color,
      style.backgroundColor,
      sides,
      style.outlineStyle,
      style.outlineWidth,
      style.outlineColor,
      style.textDecorationLine,
      style.fontWeight,
    ]);
  });
}

/** A placed order of the spec's buyer, waited on until the payment consumer decided it. */
async function decidedOrder(
  page: Page,
  baseURL: string | undefined,
  dropId: string,
  paymentMethod: PaymentMethod,
  status: OrderStatus,
): Promise<string> {
  const order = await reserveViaApi(page.request, baseURL, dropId);
  await checkoutViaApi(page.request, baseURL, order.id, paymentMethod);
  await expect
    .poll(async () => (await pollOrder(page.request, order.id))?.status, { timeout: SETTLES_WITHIN_MS })
    .toBe(status);
  return order.id;
}

for (const mode of MODES) {
  test.describe(modeTitle(mode), () => {
    test.use(mode);

    test('home page has no serious or critical axe violations', async ({ page }, testInfo) => {
      await page.goto('/');
      await expectNoBlockingViolations(page, testInfo);
    });

    test('product page has no serious or critical axe violations', async ({ page, drop }, testInfo) => {
      await page.goto(`/p/${drop.productSlug}`);
      await expectNoBlockingViolations(page, testInfo);
    });

    test('sign-in page has no serious or critical axe violations', async ({ page }, testInfo) => {
      await page.goto('/login');
      await expectNoBlockingViolations(page, testInfo);
    });

    test('checkout holding has no serious or critical axe violations', async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      const order = await reserveViaApi(page.request, baseURL, drop.id);
      await page.goto(`/checkout/${order.id}`);
      await expect(page.getByRole('region', { name: 'Reserved for you' })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('checkout in its last minute, offering the extension and then with it, has no serious or critical axe violations', async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      // The warning colours and the extension row, a minute from the end of a 120 s hold under page.clock.
      await page.clock.install();
      const order = await reserveViaApi(page.request, baseURL, drop.id);
      const firstRead = firstOrderRead(page);
      await page.goto(`/checkout/${order.id}`);
      const card = holdCard(page);
      await expect(card).toBeVisible();
      await firstRead;
      await fastForwardHold(page, 50);
      const extend = card.getByRole('button', { name: 'Add 1 minute' });
      await expect(extend).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
      await extend.click();
      await expect(card.getByText('1 minute added', { exact: true })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('product page and orders with a live hold have no serious or critical axe violations', async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      await reserveViaApi(page.request, baseURL, drop.id);
      await page.goto(`/p/${drop.productSlug}`);
      await expect(page.getByText('You have 1 reserved', { exact: true })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
      await page.goto('/orders');
      await expect(page.getByText(/^\d:\d{2} left$/)).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('checkout with the error summary and the leave dialog has no serious or critical axe violations', async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      const order = await reserveViaApi(page.request, baseURL, drop.id);
      await page.goto(`/checkout/${order.id}`);
      await formReady(page);
      await payButton(page).click();
      // The error summary takes focus (checkout-keyboard.spec.ts follows it further).
      await expect(page.locator(':focus')).toHaveAccessibleName(/^Fix \d+ fields/);
      await expectNoBlockingViolations(page, testInfo);
      await page.getByRole('button', { name: 'Leave checkout' }).click();
      await expect(page.getByRole('alertdialog', { name: 'Leave checkout?' })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('order pages, paid and declined, have no serious or critical axe violations', async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      const paid = await decidedOrder(page, baseURL, drop.id, 'pm_ok', 'PAID');
      await page.goto(`/orders/${paid}`);
      await expect(orderHeading(page)).toHaveText('You got it.');
      await expectNoBlockingViolations(page, testInfo);
      const declined = await decidedOrder(page, baseURL, drop.id, 'pm_decline', 'PAYMENT_FAILED');
      await page.goto(`/orders/${declined}`);
      await expect(orderHeading(page)).toHaveText('Payment declined');
      await expectNoBlockingViolations(page, testInfo);
    });

    test('checkout expired has no serious or critical axe violations', async ({
      page,
      context,
      request,
      baseURL,
    }, testInfo) => {
      // The shortest hold there is, left to run out: Postgres expires it within a second of its deadline.
      const drop = await createDrop(request, baseURL, { stock: 1, holdSeconds: 10 });
      await signInNewBuyer(request, baseURL, context);
      const order = await reserveViaApi(page.request, baseURL, drop.id);
      await expect
        .poll(async () => (await pollOrder(page.request, order.id))?.status, { timeout: 20_000 })
        .toBe('EXPIRED');
      await page.goto(`/checkout/${order.id}`);
      await expect(page.getByRole('heading', { name: 'Reservation expired' })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('admin dashboard has no serious or critical axe violations', async ({
      page,
      context,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      await decidedOrder(page, baseURL, drop.id, 'pm_ok', 'PAID');
      await signInAdmin(context, baseURL);
      await expect
        .poll(async () => (await dashboardOf(page.request, drop.id)).projection.totals.paid, {
          timeout: SETTLES_WITHIN_MS,
        })
        .toBe(1);
      await page.goto(`/admin/dashboard/${drop.id}`);
      await expect(page.getByRole('img', { name: /^Funnel:/ })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('admin drops list and its New drop sheet, empty and with errors, have no serious or critical axe violations', async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      await signInAdmin(context, baseURL);
      await page.goto('/admin/drops');
      await expectNoBlockingViolations(page, testInfo);
      await page.getByRole('button', { name: 'New drop' }).first().click();
      const sheet = page.getByRole('dialog', { name: 'New drop' });
      await expect(sheet).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
      // No product and no price: each problem under its field, found before anything is sent.
      await sheet.getByRole('button', { name: 'Create draft' }).click();
      await expect(sheet.getByText('Choose a product.', { exact: true })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
      await sheet.getByRole('button', { name: 'Cancel' }).click();
      await expect(sheet).toBeHidden();
    });

    // Arm's confirmation is Reconcile's layout (a filled action and a gray Cancel) with other words: arming
    // needs a DRAFT, which only the New drop sheet makes, and a draft from every run would pile up in the
    // shared catalog.
    test('admin drop page with its End and Reconcile confirmations has no serious or critical axe violations', async ({
      page,
      context,
      drop,
      baseURL,
    }, testInfo) => {
      await signInAdmin(context, baseURL);
      await page.goto(`/admin/drops/${drop.id}`);
      await expectNoBlockingViolations(page, testInfo);
      for (const [action, title] of [
        ['End drop', 'End this drop now?'],
        ['Reconcile', 'Rebuild live stock?'],
      ] as const) {
        await page.getByRole('button', { name: action }).click();
        const dialog = page.getByRole('alertdialog', { name: title });
        await expect(dialog).toBeVisible();
        await expectNoBlockingViolations(page, testInfo);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
      }
    });

    test('admin health has no serious or critical axe violations', async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      await signInAdmin(context, baseURL);
      await page.goto('/admin/health');
      await expectNoBlockingViolations(page, testInfo);
    });

    test('admin listing upload and review have no serious or critical axe violations', async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      await signInAdmin(context, baseURL);
      await page.goto('/admin/listings/new');
      await expectNoBlockingViolations(page, testInfo);
      // A file the form refuses, with its reason under the drop zone.
      await choosePhotos(page, {
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not a photo'),
      });
      // Shown under the drop zone (and announced through a status region, which is not what this waits for).
      await expect(
        page.getByRole('listitem').filter({ hasText: "notes.txt isn't a JPEG, PNG or WebP." }),
      ).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
      // NEEDS_REVIEW, the review state with the most on it: the banner, issues and an uncertainty prompt.
      const jobId = await uploadListing(
        page.request,
        baseURL,
        'shirt.jpg',
        `a11y run ${crypto.randomUUID()}`,
      );
      expect((await settledListingJob(page.request, jobId)).status).toBe('NEEDS_REVIEW');
      await page.goto(`/admin/listings/${jobId}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Review listing' })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
      // A failed approve: the error summary, with focus, and each field's error.
      await page.getByRole('button', { name: 'Approve and publish' }).click();
      const summary = page.getByRole('region', { name: /^Fix \d+ fields? to publish$/ });
      await expect(summary).toBeFocused();
      await expectNoBlockingViolations(page, testInfo);
      // The size given, the summary goes with the last error it listed.
      await page.getByRole('textbox', { name: 'Size', exact: true }).fill('M');
      await expect(summary).toHaveCount(0);
      await expectNoBlockingViolations(page, testInfo);
    });
  });
}

for (const mode of MODES.filter(({ reducedMotion }) => reducedMotion === 'no-preference')) {
  test.describe(`phone, ${modeTitle(mode)}`, () => {
    test.use({ ...mode, viewport: PHONE });

    test('product page with its sticky buy bar has no serious or critical axe violations', async ({
      page,
      drop,
    }, testInfo) => {
      await page.goto(`/p/${drop.productSlug}`);
      // The row out of view: the bar takes over (design-system §10.2).
      await page.getByRole('contentinfo').scrollIntoViewIfNeeded();
      await expect(page.locator('[data-bottom-bar]')).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('checkout holding has no serious or critical axe violations', async ({
      page,
      drop,
      buyer: _,
      baseURL,
    }, testInfo) => {
      const order = await reserveViaApi(page.request, baseURL, drop.id);
      await page.goto(`/checkout/${order.id}`);
      await expect(page.getByRole('region', { name: 'Reserved for you' })).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });

    test('admin drops, its table scrolling sideways, has no serious or critical axe violations', async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      await signInAdmin(context, baseURL);
      await page.goto('/admin/drops');
      await expect(page.locator('table').first()).toBeVisible();
      await expectNoBlockingViolations(page, testInfo);
    });
  });
}

// From 735 px the tables stop scrolling in their own region (data-table.tsx), so a narrow desktop is where
// a column would be cut off at the card's edge.
test.describe('admin tables at 1024 px', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('fit their card or scroll in a region of their own', async ({ page, context, drop: _, baseURL }) => {
    await signInAdmin(context, baseURL);
    for (const path of ['/admin/drops', '/admin/health']) {
      await page.goto(path);
      await expect(page.locator('table').first()).toBeVisible();
      await settle(page);
      expect(await clippedTables(page), `tables cut off on ${path}`).toEqual([]);
    }
  });
});

test.describe('forced colours', () => {
  test.use({ forcedColors: 'active' });

  // A ring (a box-shadow) or a brighter colour marks the current item otherwise, and forced colours remove
  // both: the current thumbnail and the current page's link need a mark that survives (WCAG 1.4.1).
  test("the gallery's current thumbnail stays told apart from the others", async ({ page }) => {
    await page.goto(`/p/${GALLERY_PRODUCT}`);
    const thumbnails = page.getByRole('button', { name: /^Show photo \d+ of \d+$/ });
    await expect(thumbnails.first()).toHaveAttribute('aria-current', 'true');
    expect(await forcedLook(thumbnails.first())).not.toBe(await forcedLook(thumbnails.nth(1)));
  });

  test("the bar's current page link stays told apart from the others", async ({ page, context, baseURL }) => {
    // Signed in as the admin, the bar's Admin link sits beside the current Drops link, in the same style.
    await signInAdmin(context, baseURL);
    await page.goto('/');
    const bar = page.getByRole('banner');
    const current = bar.getByRole('link', { name: 'Drops', exact: true });
    await expect(current).toHaveAttribute('aria-current', 'page');
    expect(await forcedLook(current)).not.toBe(await forcedLook(bar.getByRole('link', { name: 'Admin' })));
  });

  // Disabled controls use aria-disabled, which the browser doesn't map to GrayText, and forced colours
  // replace the tertiary label that otherwise marks them (design-system §13.1).
  test('aria-disabled controls take GrayText', async ({ page, drop, buyer: _ }) => {
    await page.goto(`/p/${drop.productSlug}`);
    const main = page.getByRole('main');
    const decrease = main.getByRole('button', { name: 'Decrease quantity' });
    const increase = main.getByRole('button', { name: 'Increase quantity' });
    await expect(decrease).toHaveAttribute('aria-disabled', 'true');
    await expect(increase).not.toHaveAttribute('aria-disabled', 'true');

    const grayText = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'GrayText';
      document.body.append(probe);
      const { color } = getComputedStyle(probe);
      probe.remove();
      return color;
    });
    await expect(decrease).toHaveCSS('color', grayText);
    await expect(decrease).toHaveCSS('border-top-color', grayText);
    await expect(increase).not.toHaveCSS('color', grayText);

    // At the limit, plus is the disabled one.
    await increase.click();
    await expect(increase).toHaveCSS('color', grayText);
    await expect(decrease).not.toHaveCSS('color', grayText);
  });
});
