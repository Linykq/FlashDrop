import { expect, test } from '@playwright/test';
import { liveDrop, stockSnapshot } from './support/api';
import { decodeHtmlText, escapeRegExp, formatCount } from './support/text';

/*
 * Design §8.1 and §13: the product page is server-rendered with its title and current stock in the one
 * HTML response. `request.get` runs no JavaScript, so everything asserted here is in the bytes the server
 * sent; the stock arrives in the same response, streamed from the page's uncached Suspense hole. Where the
 * <title> sits is not asserted: Next 16.3 streams metadata into <body> for most user agents (spike §3.6).
 */
test('the raw HTML of a product page carries its title and current stock', async ({ request }) => {
  const drop = await liveDrop(request);

  const response = await request.get(`/p/${drop.product.slug}`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/html/);
  const html = await response.text();

  // Stock is read from Postgres and nothing reserves before M2, so the snapshot equals what was rendered.
  const stock = await stockSnapshot(request, drop.id);
  expect(stock.avail, 'the LIVE drop has units left').toBeGreaterThan(0);

  const titles = Array.from(html.matchAll(/<title>([^<]*)<\/title>/g), ([, text = '']) =>
    decodeHtmlText(text),
  );
  expect(titles, 'the document title').toContainEqual(expect.stringContaining(drop.product.title));

  // Matched as a whole text node: markup such as the class list "opacity-100 left-4" contains "100 left".
  expect(html).toMatch(new RegExp(`>(Only )?${escapeRegExp(formatCount(stock.avail))} left<`));
});
