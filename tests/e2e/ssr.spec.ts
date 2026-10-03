import { expect, productOf, stockOf, test } from './support/fixtures';
import { decodeHtmlText, escapeRegExp, formatCount } from './support/text';

/*
 * Design §8.1 and §13: the product page is server-rendered with its title and current stock in the one
 * HTML response. `request.get` runs no JavaScript, so everything asserted here is in the bytes the server
 * sent; the stock arrives in the same response, streamed from the page's uncached Suspense hole. Where the
 * <title> sits is not asserted: Next 16.3 streams metadata into <body> for most user agents (spike §3.6).
 */

test.use({ dropSettings: { stock: 37 } });

test('the raw HTML of a product page carries its title and current stock', async ({ request, drop }) => {
  const { product } = await productOf(request, drop.productSlug);

  const response = await request.get(`/p/${drop.productSlug}`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^text\/html/);
  const html = await response.text();

  // The spec's own drop: nobody reserves from it, so the live level is what was rendered.
  const stock = await stockOf(request, drop.id);
  expect(stock).toMatchObject({ status: 'LIVE', avail: 37 });

  const titles = Array.from(html.matchAll(/<title>([^<]*)<\/title>/g), ([, text = '']) =>
    decodeHtmlText(text),
  );
  expect(titles, 'the document title').toContainEqual(expect.stringContaining(product.title));

  // Matched as a whole text node: markup such as the class list "opacity-100 left-4" contains "100 left".
  expect(html).toMatch(new RegExp(`>(Only )?${escapeRegExp(formatCount(stock.avail))} left<`));
});
