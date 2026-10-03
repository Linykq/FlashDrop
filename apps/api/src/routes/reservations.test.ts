import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { OrderResponse, ProblemDetails } from '@flashdrop/contracts';
import { requestFingerprint, reservationId } from '@flashdrop/domain/identity';
import type { ReserveResult } from '@flashdrop/inventory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../http/api';
import {
  BUYER,
  buildTestApp,
  type FakeState,
  fakeOrder,
  fakeState,
  LIVE_DROP,
  NOW,
  ORIGIN,
  sessionToken,
} from '../test/fakes';

let app: Api;
let state: FakeState;
let token: string;

beforeEach(async () => {
  state = fakeState();
  app = await buildTestApp({}, state);
  token = await sessionToken(BUYER);
});
afterEach(() => app.close());

const KEY = 'key_0198a3c4-1f2e';
const RID = reservationId({ userId: BUYER.id, dropId: LIVE_DROP.id, idempotencyKey: KEY });

function reserve(
  options: {
    readonly dropId?: string;
    readonly key?: string | null;
    readonly qty?: unknown;
    readonly token?: string | null;
    readonly headers?: Record<string, string>;
  } = {},
) {
  const key = options.key === undefined ? KEY : options.key;
  const session = options.token === undefined ? token : options.token;
  return app.inject({
    method: 'POST',
    url: `/api/v1/drops/${options.dropId ?? LIVE_DROP.id}/reservations`,
    headers: { origin: ORIGIN, ...(key === null ? {} : { 'idempotency-key': key }), ...options.headers },
    cookies: session === null ? {} : { [SESSION_COOKIE]: session },
    payload: { qty: options.qty ?? 1 },
  });
}

/** The reservation the default request makes, as Postgres would store it. */
const reservation = (qty = 1) => ({
  id: RID,
  userId: BUYER.id,
  dropId: LIVE_DROP.id,
  qty,
  idempotencyKey: KEY,
  requestHash: requestFingerprint({ dropId: LIVE_DROP.id, qty }),
});

function expectProblem(response: Awaited<ReturnType<typeof reserve>>, status: number, code: string) {
  expect(response.statusCode).toBe(status);
  expect(ProblemDetails.parse(response.json())).toMatchObject({ status, code });
}

describe('POST /api/v1/drops/:dropId/reservations: new holds', () => {
  it('answers 201 with the order, after Lua admitted it and Postgres recorded it under Lua’s gen', async () => {
    state.reserve.admit = () => ({ kind: 'RESERVED', gen: 7 });
    const response = await reserve({ qty: 2 });

    expect(response.statusCode).toBe(201);
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(OrderResponse.parse(response.json()).order).toEqual({
      id: RID,
      status: 'RESERVED',
      closeReason: null,
      dropId: LIVE_DROP.id,
      product: LIVE_DROP.product,
      qty: 2,
      unitPriceCents: LIVE_DROP.priceCents,
      totalCents: 2 * LIVE_DROP.priceCents,
      currency: 'USD',
      expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
      extensions: 0,
      createdAt: NOW.toISOString(),
      serverNow: NOW.toISOString(),
    });
    expect(state.reserve.admitted).toEqual([
      {
        dropId: LIVE_DROP.id,
        rid: RID,
        userId: BUYER.id,
        qty: 2,
        fingerprint: requestFingerprint({ dropId: LIVE_DROP.id, qty: 2 }),
        idempotencyKey: KEY,
      },
    ]);
    expect(state.reserve.recordedGens).toEqual([7]);
  });

  it('derives the same rid and fingerprint from any spelling of the drop id', async () => {
    await reserve({ dropId: LIVE_DROP.id.toUpperCase() });
    expect(state.reserve.admitted[0]).toMatchObject({
      dropId: LIVE_DROP.id,
      rid: RID,
      fingerprint: requestFingerprint({ dropId: LIVE_DROP.id, qty: 1 }),
    });
  });
});

describe('POST /api/v1/drops/:dropId/reservations: replays', () => {
  it('answers a repeated request with 200, Idempotency-Replayed and the same order', async () => {
    const first = await reserve();
    state.reserve.admit = () => ({ kind: 'EXISTING', state: 'HELD', gen: 1 });
    const second = await reserve();

    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(OrderResponse.parse(second.json()).order.id).toBe(OrderResponse.parse(first.json()).order.id);
    // Regression: the replay opened a reserve transaction too, which held a pool connection while it
    // waited on the first copy's primary key. An existing order answers without one.
    expect(state.reserve.recordedGens).toEqual([1]);
  });

  it('heals an orphan: EXISTING in Redis with no row in Postgres records the order (201)', async () => {
    state.reserve.admit = () => ({ kind: 'EXISTING', state: 'HELD', gen: 3 });
    const response = await reserve();
    expect(response.statusCode).toBe(201);
    expect(state.reserve.recordedGens).toEqual([3]);
  });

  it.each([
    [
      'an expired hold',
      { status: 'EXPIRED' as const, closeReason: 'TIMEOUT' as const },
      410,
      'RESERVATION_EXPIRED',
    ],
    [
      'a tombstoned orphan',
      { status: 'REJECTED' as const, closeReason: 'ORPHANED' as const },
      410,
      'RESERVATION_EXPIRED',
    ],
    [
      'a SOLD_OUT tombstone',
      { status: 'REJECTED' as const, closeReason: 'SOLD_OUT' as const },
      409,
      'SOLD_OUT',
    ],
    [
      'a LIMIT tombstone',
      { status: 'REJECTED' as const, closeReason: 'LIMIT' as const },
      409,
      'LIMIT_REACHED',
    ],
  ])('replays %s as its refusal', async (_name, outcome, status, code) => {
    state.orders.set(RID, fakeOrder(reservation(), { ...outcome, closedAt: NOW }));
    state.reserve.admit = () => ({ kind: 'EXISTING', state: 'RELEASED', gen: 1 });
    expectProblem(await reserve(), status, code);
    expect(state.reserve.recordedGens).toEqual([]);
  });

  it('answers 422 when Postgres holds the key with another body', async () => {
    state.orders.set(RID, fakeOrder(reservation(2)));
    state.reserve.admit = () => ({ kind: 'EXISTING', state: 'HELD', gen: 1 });
    expectProblem(await reserve({ qty: 1 }), 422, 'IDEMPOTENCY_KEY_REUSED');
  });
});

describe('POST /api/v1/drops/:dropId/reservations: Lua refusals end in Redis', () => {
  it.each<[ReserveResult['kind'], number, string]>([
    ['NOT_LIVE', 409, 'DROP_NOT_LIVE'],
    ['LIMIT', 409, 'LIMIT_REACHED'],
    ['SOLD_OUT', 409, 'SOLD_OUT'],
    ['FP_MISMATCH', 422, 'IDEMPOTENCY_KEY_REUSED'],
    ['BAD_QTY', 500, 'INTERNAL'],
  ])('%s answers %i %s without touching Postgres', async (kind, status, code) => {
    state.reserve.admit = () => ({ kind }) as ReserveResult;
    expectProblem(await reserve(), status, code);
    expect(state.reserve.recordedGens).toEqual([]);
    expect(state.orders.size).toBe(0);
  });

  it('RETRY (the drop is RECONCILING) answers 503 with Retry-After: 1', async () => {
    state.reserve.admit = () => ({ kind: 'RETRY' });
    const response = await reserve();
    expectProblem(response, 503, 'RETRY');
    expect(response.headers['retry-after']).toBe('1');
  });

  it('refuses with 503 before Lua while the Postgres breaker is open: no hold Postgres cannot record', async () => {
    state.reserve.healthy = false;
    const response = await reserve();
    expectProblem(response, 503, 'RETRY');
    expect(response.headers['retry-after']).toBe('1');
    expect(state.reserve.admitted).toEqual([]);
  });
});

describe('POST /api/v1/drops/:dropId/reservations: NO_DROP', () => {
  beforeEach(() => {
    state.reserve.admit = () => ({ kind: 'NO_DROP' });
  });

  it('replays the order from Postgres when the rid has one (after retainAt, or a wipe of an ended drop)', async () => {
    state.orders.set(RID, fakeOrder(reservation(), { status: 'PAID', paidAt: NOW }));
    const response = await reserve();
    expect(response.statusCode).toBe(200);
    expect(response.headers['idempotency-replayed']).toBe('true');
    expect(OrderResponse.parse(response.json()).order).toMatchObject({ id: RID, status: 'PAID' });
  });

  it('answers 503 and nudges the reconciler for a tracked drop: Redis was wiped, the rebuild is pending', async () => {
    const response = await reserve();
    expectProblem(response, 503, 'RETRY');
    expect(state.reserve.nudged).toEqual([LIVE_DROP.id]);
  });

  it('answers 409 DROP_NOT_LIVE for a drop that is not tracked (DRAFT, unknown, or ended long ago)', async () => {
    state.reserve.tracked.clear();
    expectProblem(await reserve(), 409, 'DROP_NOT_LIVE');
    expect(state.reserve.nudged).toEqual([]);
  });

  it('answers 422 for a stored order with another body', async () => {
    state.orders.set(RID, fakeOrder(reservation(2)));
    expectProblem(await reserve({ qty: 1 }), 422, 'IDEMPOTENCY_KEY_REUSED');
  });
});

describe('POST /api/v1/drops/:dropId/reservations: Postgres refusals', () => {
  it.each([
    ['SOLD_OUT', 'SOLD_OUT'],
    ['LIMIT', 'LIMIT_REACHED'],
  ] as const)('%s: tombstone, nudge (Redis was optimistic), 409 %s', async (reason, code) => {
    state.reserve.decide = () => reason;
    expectProblem(await reserve(), 409, code);
    expect(state.reserve.tombstones).toEqual([
      expect.objectContaining({ id: RID, reason, userId: BUYER.id, dropId: LIVE_DROP.id, qty: 1 }),
    ]);
    expect(state.orders.get(RID)).toMatchObject({ status: 'REJECTED', closeReason: reason });
    expect(state.reserve.nudged).toEqual([LIVE_DROP.id]);
  });

  it('NOT_LIVE (the window backstop): tombstone, no nudge, 409 DROP_NOT_LIVE', async () => {
    state.reserve.decide = () => 'NOT_LIVE';
    expectProblem(await reserve(), 409, 'DROP_NOT_LIVE');
    expect(state.reserve.tombstones).toHaveLength(1);
    expect(state.reserve.nudged).toEqual([]);
  });

  it('STALE_GEN (a rebuild fenced the generation): 503 to retry with the same key, no tombstone', async () => {
    state.reserve.decide = () => 'STALE_GEN';
    expectProblem(await reserve(), 503, 'RETRY');
    expect(state.reserve.tombstones).toEqual([]);
    expect(state.orders.size).toBe(0);
  });

  it('a tombstone that loses to a concurrent same-key winner replays the winner’s order', async () => {
    state.reserve.decide = () => {
      state.orders.set(RID, fakeOrder(reservation()));
      return 'SOLD_OUT';
    };
    const response = await reserve();
    expect(response.statusCode).toBe(200);
    expect(OrderResponse.parse(response.json()).order).toMatchObject({ id: RID, status: 'RESERVED' });
    expect(state.reserve.tombstones).toHaveLength(1);
  });
});

describe('POST /api/v1/drops/:dropId/reservations: validation and auth', () => {
  it.each([
    ['no Idempotency-Key', { key: null }, 'idempotency-key'],
    ['a short key', { key: 'short' }, 'idempotency-key'],
    ['a key with spaces', { key: 'has spaces in it' }, 'idempotency-key'],
    ['qty 0', { qty: 0 }, 'qty'],
    ['qty 11', { qty: 11 }, 'qty'],
    ['a fractional qty', { qty: 1.5 }, 'qty'],
    ['a drop id that is not a uuid', { dropId: '42' }, 'dropId'],
  ])('answers 400 for %s, before Lua', async (_name, options, path) => {
    const response = await reserve(options);
    expectProblem(response, 400, 'VALIDATION_FAILED');
    expect(response.json().errors.map((error: { path: string }) => error.path)).toContain(path);
    expect(state.reserve.admitted).toEqual([]);
  });

  it('answers 401 without a session and 403 without an allowed Origin', async () => {
    expectProblem(await reserve({ token: null }), 401, 'UNAUTHENTICATED');
    expectProblem(await reserve({ headers: { origin: 'https://evil.example' } }), 403, 'FORBIDDEN');
    expect(state.reserve.admitted).toEqual([]);
  });
});

describe('POST /api/v1/drops/:dropId/reservations: rate limits', () => {
  it('allows RATE_LIMIT_USER_PER_SEC per user, then 429 with Retry-After', async () => {
    const limited = await buildTestApp({ rateLimits: { userPerSecond: 3, ipPerSecond: 1_000 } }, state);
    try {
      const statuses: number[] = [];
      let last: Awaited<ReturnType<typeof limited.inject>> | undefined;
      for (let i = 0; i < 4; i++) {
        last = await limited.inject({
          method: 'POST',
          url: `/api/v1/drops/${LIVE_DROP.id}/reservations`,
          headers: { origin: ORIGIN, 'idempotency-key': `key_rate_limit_${i}` },
          cookies: { [SESSION_COOKIE]: token },
          payload: { qty: 1 },
        });
        statuses.push(last.statusCode);
      }
      expect(statuses).toEqual([201, 201, 201, 429]);
      expect(last?.headers['retry-after']).toBe('1');
      expect(last?.json()).toMatchObject({ code: 'RATE_LIMITED' });
      expect(state.reserve.admitted).toHaveLength(3);
      expect(state.rateLimitHits.get(`fd:rl:reserve-user:${BUYER.id}`)).toBe(4);
    } finally {
      await limited.close();
    }
  });

  it('allows RATE_LIMIT_IP_PER_SEC per client IP, anonymous callers included', async () => {
    const limited = await buildTestApp({ rateLimits: { userPerSecond: 1_000, ipPerSecond: 2 } }, state);
    try {
      const send = (remoteAddress: string, cookie: string | null) =>
        limited.inject({
          method: 'POST',
          url: `/api/v1/drops/${LIVE_DROP.id}/reservations`,
          remoteAddress,
          headers: { origin: ORIGIN, 'idempotency-key': KEY },
          cookies: cookie === null ? {} : { [SESSION_COOKIE]: cookie },
          payload: { qty: 1 },
        });
      expect((await send('203.0.113.7', null)).statusCode).toBe(401);
      expect((await send('203.0.113.7', token)).statusCode).toBe(201);
      expect((await send('203.0.113.7', token)).statusCode).toBe(429);
      expect((await send('203.0.113.8', token)).statusCode).toBe(200);
      expect(state.rateLimitHits.get('fd:rl:reserve-ip:203.0.113.7')).toBe(3);
    } finally {
      await limited.close();
    }
  });
});
