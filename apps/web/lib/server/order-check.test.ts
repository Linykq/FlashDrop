import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiEnv } from './env';
import { checkOrder } from './order-check';

// The fail-open cases log a warning by design; the test output doesn't need it.
vi.stubEnv('LOG_LEVEL', 'silent');

const ORDER = '0199c5a0-0000-7000-8000-000000000001';

function stubApi(status: number | 'unreachable') {
  const fetch = vi.fn(async () => {
    if (status === 'unreachable') throw new TypeError('fetch failed');
    return new Response(null, { status });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('checkOrder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks api with the buyer's session, and finds the buyer's own order", async () => {
    const fetch = stubApi(200);
    expect(await checkOrder(ORDER, 'token')).toBe('found');
    expect(fetch).toHaveBeenCalledWith(
      new URL(`/api/v1/orders/${ORDER}`, apiEnv().API_INTERNAL_URL),
      expect.objectContaining({ method: 'HEAD', headers: { cookie: 'fd_session=token' } }),
    );
  });

  it("is not found for an unknown order or another buyer's (api answers 404 for both)", async () => {
    stubApi(404);
    expect(await checkOrder(ORDER, 'token')).toBe('not-found');
  });

  it('rejects a malformed id without asking api', async () => {
    const fetch = stubApi(200);
    expect(await checkOrder('not-an-order', 'token')).toBe('not-found');
    expect(await checkOrder('../admin', 'token')).toBe('not-found');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signs in again when api no longer accepts the session', async () => {
    stubApi(401);
    expect(await checkOrder(ORDER, 'expired')).toBe('signed-out');
  });

  it('fails open when api cannot answer, so the page renders its own error state', async () => {
    stubApi('unreachable');
    expect(await checkOrder(ORDER, 'token')).toBe('found');
    stubApi(503);
    expect(await checkOrder(ORDER, 'token')).toBe('found');
  });
});
