import { uploadPath } from '@flashdrop/contracts';
import { liveDrop, openDrops, seededBuyer, sessionUser, stockSnapshot } from './support/api';
import { expect, productOf, stockOf, test } from './support/fixtures';
import { escapeRegExp, formatPrice, stockLinePattern } from './support/text';

/*
 * The storefront's M1 paths (design §8.1, design-system §10.1, §10.2, §10.6), in a real browser. The home page
 * shows the seeded catalog, which test drops never join (they are not listed); the product page uses the
 * spec's own drop.
 */

test('home features the live drop and lists the upcoming ones', async ({ page, request }) => {
  const drops = await openDrops(request);
  const live = await liveDrop(request);
  const upcoming = drops.filter((drop) => drop.status === 'SCHEDULED');
  expect(upcoming.length, 'the seed schedules upcoming drops').toBeGreaterThan(0);

  await page.goto('/');

  const hero = page.getByRole('region', { name: live.product.title });
  await expect(hero.getByRole('heading', { level: 1 })).toHaveText(live.product.title);
  await expect(hero.getByText('Live', { exact: true })).toBeVisible();
  await expect(hero.getByRole('link', { name: 'Buy' })).toHaveAttribute('href', `/p/${live.product.slug}`);
  const stock = await stockSnapshot(request, live.id);
  await expect(hero.getByText(stockLinePattern(stock.avail))).toBeVisible();

  const list = page.getByRole('region', { name: 'Upcoming drops' });
  for (const drop of upcoming) {
    await expect(list.getByRole('link', { name: drop.product.title })).toHaveAttribute(
      'href',
      `/p/${drop.product.slug}`,
    );
  }
});

test('product page shows the gallery, price and stock', async ({ page, request, drop }) => {
  const detail = await productOf(request, drop.productSlug);
  const { title, imageKeys } = detail.product;
  if (detail.drop === null) throw new Error(`${drop.productSlug} has no drop`);
  const { priceCents, currency } = detail.drop;
  const [firstKey] = imageKeys;
  if (firstKey === undefined) throw new Error(`${drop.productSlug} has no photos`);

  // The original photo, from api's content-addressed store through Caddy.
  const original = await request.get(uploadPath(firstKey));
  expect(original.status()).toBe(200);
  expect(original.headers()['content-type']).toBe('image/jpeg');

  await page.goto(`/p/${drop.productSlug}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(title);

  const gallery = main.getByRole('region', { name: `Photos of ${title}` });
  await expect(gallery.getByRole('img', { name: new RegExp(`^${escapeRegExp(title)}, photo `) })).toHaveCount(
    imageKeys.length,
  );
  const photo = gallery.getByRole('img', { name: `${title}, photo 1 of ${imageKeys.length}` });
  // next/image serves it through the optimizer, which fetches the original from api via /uploads.
  await expect(photo).toHaveAttribute(
    'src',
    new RegExp(`^/_next/image\\?url=${encodeURIComponent(uploadPath(firstKey))}&`),
  );
  await expect
    .poll(() => photo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth))
    .toBeGreaterThan(0);

  // The phone's sticky buy bar repeats price and stock; on desktop only the panel's copy is visible.
  await expect(
    main.getByText(formatPrice(priceCents, currency), { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  const stock = await stockOf(request, drop.id);
  await expect(main.getByText(stockLinePattern(stock.avail)).filter({ visible: true })).toHaveCount(1);
});

test('a seeded buyer signs in, appears in the bar and signs out', async ({ page, request }) => {
  const buyer = await seededBuyer(request);

  await page.goto('/login');
  await page.getByRole('radio', { name: buyer.email }).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL('/');
  const bar = page.getByRole('banner');
  const account = bar.getByRole('button', { name: `Account, ${buyer.displayName}` });
  await expect(account).toBeVisible();
  // page.request shares the browser's cookies, so this is the session api set.
  expect((await sessionUser(page.request))?.id).toBe(buyer.id);

  await account.click();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(bar.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(account).toBeHidden();
  expect(await sessionUser(page.request)).toBeNull();
});
