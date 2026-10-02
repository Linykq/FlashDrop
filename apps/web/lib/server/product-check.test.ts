import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiEnv } from './env';
import { productExists } from './product-check';

// The fail-open cases log a warning by design; the test output doesn't need it.
vi.stubEnv('LOG_LEVEL', 'silent');

/** A fetch stub answering every HEAD with `status`, or failing like an unreachable api. */
function stubApi(status: number | 'unreachable') {
  const fetch = vi.fn(async () => {
    if (status === 'unreachable') throw new TypeError('fetch failed');
    return new Response(null, { status });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('productExists', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a malformed slug without asking api', async () => {
    const fetch = stubApi(200);
    expect(await productExists('Not%20A%20Slug')).toBe(false);
    expect(await productExists('../admin')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is false only when api answers 404, and never remembers a miss', async () => {
    const fetch = stubApi(404);
    expect(await productExists('no-such-product')).toBe(false);
    expect(await productExists('no-such-product')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      new URL('/api/v1/products/no-such-product', apiEnv().API_INTERNAL_URL),
      expect.objectContaining({ method: 'HEAD' }),
    );
  });

  it('remembers a product api confirmed', async () => {
    const fetch = stubApi(200);
    expect(await productExists('sage-wireless-headphones')).toBe(true);
    expect(await productExists('sage-wireless-headphones')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails open when api cannot answer, so the page renders its own error state', async () => {
    stubApi('unreachable');
    expect(await productExists('linen-band-collar-shirt')).toBe(true);
    stubApi(503);
    expect(await productExists('amber-jar-soy-candle')).toBe(true);
  });
});
