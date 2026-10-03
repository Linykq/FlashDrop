import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESERVE_BUDGET_MS, type ReserveEnvironment, reserve, retryDelay } from './reserve';
import { forgetReserveKey, pendingQuantity, reserveKey } from './reserve-key';

const DROP = '0191f3a2-7c4e-7b1a-9d2e-5f6a7b8c9d0e';
const ORDER = '6f1c2a3b-4d5e-5f60-8a7b-9c0d1e2f3a4b';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  json(status, { type: 'about:blank', title: code, status, code }, headers);

type Reply = Response | Error;

/** A fake browser: answers from `replies` in order, on a clock that only moves when the flow sleeps. */
function environment(replies: Reply[], { online = true } = {}) {
  let clock = 0;
  const sent: { url: string; key: string | null; body: unknown }[] = [];
  const sleeps: number[] = [];
  const env: ReserveEnvironment = {
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      sent.push({ url, key: headers.get('idempotency-key'), body: JSON.parse(String(init.body)) });
      const reply = replies.shift();
      if (reply === undefined) throw new Error('no reply left');
      if (reply instanceof Error) throw reply;
      return reply;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0.5,
    online: () => online,
  };
  return { env, sent, sleeps };
}

const request = { dropId: DROP, qty: 2, key: 'key-0001' };
const signal = () => new AbortController().signal;

describe('reserve', () => {
  it('answers a new reservation and a replay with the order', async () => {
    for (const status of [201, 200]) {
      const { env, sent } = environment([json(status, { order: { id: ORDER } })]);
      await expect(reserve(request, signal(), env)).resolves.toEqual({ kind: 'reserved', orderId: ORDER });
      expect(sent).toEqual([
        { url: `/api/v1/drops/${DROP}/reservations`, key: 'key-0001', body: { qty: 2 } },
      ]);
    }
  });

  it('passes the final refusals through without retrying', async () => {
    for (const [status, code] of [
      [409, 'SOLD_OUT'],
      [409, 'LIMIT_REACHED'],
      [409, 'DROP_NOT_LIVE'],
      [410, 'RESERVATION_EXPIRED'],
      [422, 'IDEMPOTENCY_KEY_REUSED'],
    ] as const) {
      const { env, sent } = environment([problem(status, code)]);
      await expect(reserve(request, signal(), env)).resolves.toEqual({ kind: 'refused', code });
      expect(sent).toHaveLength(1);
    }
  });

  it('retries a 503 with the same key after Retry-After, then succeeds', async () => {
    const { env, sent, sleeps } = environment([
      problem(503, 'RETRY', { 'retry-after': '1' }),
      problem(503, 'RETRY', { 'retry-after': '1' }),
      json(201, { order: { id: ORDER } }),
    ]);
    await expect(reserve(request, signal(), env)).resolves.toEqual({ kind: 'reserved', orderId: ORDER });
    expect(sent.map((attempt) => attempt.key)).toEqual(['key-0001', 'key-0001', 'key-0001']);
    expect(sleeps).toEqual([1250, 1250]);
  });

  it('gives up within the budget while the drop stays unavailable', async () => {
    const { env, sleeps } = environment(
      Array.from({ length: 20 }, () => problem(503, 'RETRY', { 'retry-after': '1' })),
    );
    await expect(reserve(request, signal(), env)).resolves.toEqual({ kind: 'unavailable', cause: 'busy' });
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(RESERVE_BUDGET_MS);
    expect(sleeps).toHaveLength(8);
  });

  it('retries a rate limit and a gateway error, and reports the cause when they last', async () => {
    const limited = environment([problem(429, 'RATE_LIMITED'), json(201, { order: { id: ORDER } })]);
    await expect(reserve(request, signal(), limited.env)).resolves.toMatchObject({ kind: 'reserved' });

    const gateway = environment([new Response('', { status: 502 }), json(200, { order: { id: ORDER } })]);
    await expect(reserve(request, signal(), gateway.env)).resolves.toMatchObject({ kind: 'reserved' });

    const busy = environment(Array.from({ length: 40 }, () => problem(429, 'RATE_LIMITED')));
    await expect(reserve(request, signal(), busy.env)).resolves.toEqual({
      kind: 'unavailable',
      cause: 'rate-limited',
    });
  });

  it('retries a lost connection, but stops at once while offline', async () => {
    const lost = environment([new TypeError('Failed to fetch'), json(201, { order: { id: ORDER } })]);
    await expect(reserve(request, signal(), lost.env)).resolves.toMatchObject({ kind: 'reserved' });
    expect(lost.sent).toHaveLength(2);

    const offline = environment([new TypeError('Failed to fetch')], { online: false });
    await expect(reserve(request, signal(), offline.env)).resolves.toEqual({
      kind: 'unavailable',
      cause: 'offline',
    });
  });

  it('sends a signed-out buyer to sign in, and flags answers it never expects', async () => {
    await expect(
      reserve(request, signal(), environment([problem(401, 'UNAUTHENTICATED')]).env),
    ).resolves.toEqual({ kind: 'signed-out' });
    for (const reply of [
      problem(400, 'VALIDATION_FAILED'),
      problem(422, 'VALIDATION_FAILED'),
      problem(500, 'INTERNAL'),
      json(201, { order: { id: 'not-a-uuid' } }),
    ]) {
      const { status } = reply;
      await expect(reserve(request, signal(), environment([reply]).env)).resolves.toEqual({
        kind: 'failed',
        status,
      });
    }
  });

  it('stops when the page goes away', async () => {
    const controller = new AbortController();
    const { env } = environment([]);
    env.fetch = async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    };
    await expect(reserve(request, controller.signal, env)).rejects.toThrow('aborted');
  });
});

describe('retryDelay', () => {
  it('follows Retry-After, otherwise backs off exponentially to 2 s, plus jitter', () => {
    expect(retryDelay(1000, 0, () => 0)).toBe(1000);
    expect(retryDelay(1000, 5, () => 1)).toBe(1500);
    expect([0, 1, 2, 3, 4].map((attempt) => retryDelay(null, attempt, () => 0))).toEqual([
      250, 500, 1000, 2000, 2000,
    ]);
  });
});

describe('reserve keys', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetReserveKey(DROP);
  });

  function fakeSessionStorage() {
    const items = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (name: string) => items.get(name) ?? null,
      setItem: (name: string, value: string) => items.set(name, value),
      removeItem: (name: string) => items.delete(name),
    });
    return items;
  }

  it('reuses the key of an unfinished request for the same quantity, across a reload', () => {
    const items = fakeSessionStorage();
    const key = reserveKey(DROP, 2);
    expect(reserveKey(DROP, 2)).toBe(key);
    expect(JSON.parse(items.get(`fd:reserve:${DROP}`) ?? '')).toEqual({ key, qty: 2 });
    expect(pendingQuantity(DROP)).toBe(2);
  });

  it('starts a new intent for another quantity, and after a final answer', () => {
    fakeSessionStorage();
    const first = reserveKey(DROP, 1);
    const second = reserveKey(DROP, 2);
    expect(second).not.toBe(first);
    forgetReserveKey(DROP);
    expect(pendingQuantity(DROP)).toBeNull();
    expect(reserveKey(DROP, 2)).not.toBe(second);
  });

  it('ignores a damaged entry', () => {
    const items = fakeSessionStorage();
    items.set(`fd:reserve:${DROP}`, '{"key":"short","qty":2}');
    expect(pendingQuantity(DROP)).toBeNull();
    items.set(`fd:reserve:${DROP}`, 'not json');
    expect(pendingQuantity(DROP)).toBeNull();
  });

  it('keeps the key in memory where storage is blocked', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    const key = reserveKey(DROP, 1);
    expect(reserveKey(DROP, 1)).toBe(key);
    forgetReserveKey(DROP);
    expect(pendingQuantity(DROP)).toBeNull();
  });
});
