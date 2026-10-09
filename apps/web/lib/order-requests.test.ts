import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelOrder, extendHold, readOrder, submitCheckout } from './order-requests';

const orderId = '0192f3a4-5b6c-5d7e-8f90-a1b2c3d4e5f6';
const body = {
  shipping: {
    name: 'Mira Chen',
    line1: '1 Main St',
    city: 'Springfield',
    postalCode: '62701',
    country: 'US',
  },
  paymentMethod: 'pm_ok',
} as const;
const order = {
  id: orderId,
  status: 'RESERVED',
  expiresAt: '2026-10-02T19:03:00.000Z',
  extensions: 1,
  serverNow: '2026-10-02T19:01:00.000Z',
};

function answer(status: number, json?: unknown): Response {
  const problem = status >= 400;
  return new Response(json === undefined ? null : JSON.stringify(json), {
    status,
    headers: { 'content-type': problem ? 'application/problem+json' : 'application/json' },
  });
}

function respond(response: Response | Error) {
  const fetch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const signal = () => new AbortController().signal;
const submit = () => submitCheckout({ orderId, key: 'key_0001-abcd', body }, signal());

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submitCheckout', () => {
  it('posts the body with the Idempotency-Key, same-origin and uncached', async () => {
    const fetch = respond(answer(202, { order: { ...order, status: 'PENDING_PAYMENT' } }));
    expect(await submit()).toEqual({ kind: 'placed' });
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/orders/${orderId}/checkout`,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'key_0001-abcd' },
        body: JSON.stringify(body),
      }),
    );
  });

  it.each([
    [answer(200, { order }), { kind: 'placed' }],
    [answer(409, { code: 'ALREADY_SUBMITTED' }), { kind: 'already-placed' }],
    [answer(422, { code: 'IDEMPOTENCY_KEY_REUSED' }), { kind: 'already-placed' }],
    [answer(409, { code: 'CONFLICT' }), { kind: 'closed' }],
    [answer(410, { code: 'RESERVATION_EXPIRED' }), { kind: 'expired' }],
    [answer(401, { code: 'UNAUTHENTICATED' }), { kind: 'signed-out' }],
    [
      answer(400, {
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'shipping.postalCode', message: 'x' }, 'junk'],
      }),
      { kind: 'invalid', issues: [{ path: 'shipping.postalCode', message: 'x' }] },
    ],
    [answer(400, { code: 'VALIDATION_FAILED' }), { kind: 'failed' }],
    [answer(503, { code: 'RETRY' }), { kind: 'failed' }],
    [new TypeError('Failed to fetch'), { kind: 'failed' }],
  ])('classifies %# as the outcome the form acts on', async (response, outcome) => {
    respond(response);
    expect(await submit()).toEqual(outcome);
  });

  it('rejects only when the page aborts it', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    await expect(
      submitCheckout({ orderId, key: 'key_0001-abcd', body }, controller.signal),
    ).rejects.toThrow();
  });
});

describe('extendHold and cancelOrder', () => {
  it('return the order state of a 200', async () => {
    respond(answer(200, { order }));
    expect(await extendHold(orderId, signal())).toEqual({
      kind: 'done',
      order: { status: 'RESERVED', expiresAt: order.expiresAt, extensions: 1, serverNow: order.serverNow },
    });
  });

  it('post the extension to its path', async () => {
    const fetch = respond(answer(200, { order }));
    await extendHold(orderId, signal());
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/orders/${orderId}/extend`,
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    );
  });

  it('cancel only a hold: from=RESERVED, so an order being paid is refused, never cancelled', async () => {
    const fetch = respond(answer(409, { code: 'CONFLICT' }));
    expect(await cancelOrder(orderId, signal())).toEqual({ kind: 'refused' });
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/orders/${orderId}/cancel?from=RESERVED`,
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    );
  });

  it('treat a lost compare-and-set as refused', async () => {
    respond(answer(409, { code: 'CONFLICT' }));
    expect(await cancelOrder(orderId, signal())).toEqual({ kind: 'refused' });
  });

  it('report a 200 that breaks the contract and fail', async () => {
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    respond(answer(200, { order: { ...order, status: 'SHIPPED' } }));
    expect(await extendHold(orderId, signal())).toEqual({ kind: 'failed' });
    expect(reportError).toHaveBeenCalledOnce();
  });
});

describe('readOrder', () => {
  it('reads the status and hold, or says why not', async () => {
    respond(answer(200, { order: { ...order, status: 'PAID' } }));
    expect(await readOrder(orderId, signal())).toMatchObject({ kind: 'ok', order: { status: 'PAID' } });
    respond(answer(404, { code: 'NOT_FOUND' }));
    expect(await readOrder(orderId, signal())).toEqual({ kind: 'not-found' });
    respond(answer(401, { code: 'UNAUTHENTICATED' }));
    expect(await readOrder(orderId, signal())).toEqual({ kind: 'signed-out' });
    respond(answer(502));
    expect(await readOrder(orderId, signal())).toEqual({ kind: 'failed' });
  });
});
