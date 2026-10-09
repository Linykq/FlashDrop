import { randomUUID } from 'node:crypto';
import { createLogger, postgresCheck } from '@flashdrop/config';
import { SESSION_COOKIE } from '@flashdrop/config/constants';
import { OrderResponse, TestDropResponse, TestSessionsResponse } from '@flashdrop/contracts';
import { createDb, sql } from '@flashdrop/db';
import { RetryError } from '@flashdrop/domain';
import {
  createReservationService,
  createReservePorts,
  createSyncNudger,
  type ReservePorts,
  readDropState,
  readStock,
  redisDropViolations,
} from '@flashdrop/inventory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from './http/api';
import { createPgBreaker } from './services/pg-breaker';
import { ADMIN, ORIGIN, sessionToken } from './test/fakes';
import { createTestStack, TEST_ROUTES_SECRET, type TestStack } from './test/stack';

/*
 * Race matrix (design §13): a rebuild against a reserve in flight between Lua and Postgres. The reserve
 * service is the api's own, over the real ports, with its Postgres step held at a gate: Lua has admitted the
 * hold under generation G, then the admin reconcile rebuilds the drop (fence to G+1, snapshot, `fd_rebuild`),
 * then the reserve reaches Postgres still carrying G. The fence must refuse it, the rebuilt Redis must not
 * count it, and the same key must succeed afterwards. The other side of the fence, a reserve whose
 * transaction passed the generation check before the fence and is counted by the rebuild, is in
 * `packages/inventory` (sync tests), where a transaction can be held open between its steps.
 */

let stack: TestStack;
let app: Api;
let adminToken: string;
const logger = createLogger({ name: 'race-matrix', level: 'silent' });

beforeAll(async () => {
  stack = await createTestStack(new Date());
  app = await stack.build();
  adminToken = await sessionToken(ADMIN);
});

afterAll(async () => {
  await stack?.close();
});

async function newDrop(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/test/drops',
    headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
    payload: { stock: 10, perUserLimit: 2, holdSeconds: 120, paymentSeconds: 300 },
  });
  expect(response.statusCode, response.body).toBe(201);
  return TestDropResponse.parse(response.json()).dropId;
}

async function newBuyer() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/test/sessions',
    headers: { origin: ORIGIN, 'x-test-secret': TEST_ROUTES_SECRET },
    payload: { count: 1 },
  });
  expect(response.statusCode).toBe(200);
  const [session] = TestSessionsResponse.parse(response.json()).sessions;
  if (session === undefined) throw new Error('no buyer minted');
  return session;
}

/** The api's reserve service over the real ports, its Postgres step waiting for `open()`. */
function gatedReservations() {
  const db = createDb(stack.infra.pool);
  const real = createReservePorts({
    db,
    redis: stack.redis,
    breaker: createPgBreaker({ probe: postgresCheck(stack.infra.pool), logger }),
    nudger: createSyncNudger({ db, logger }),
  });
  const arrived = Promise.withResolvers<number>();
  const gate = Promise.withResolvers<void>();
  const ports: ReservePorts = {
    ...real,
    record: async (reservation) => {
      arrived.resolve(reservation.gen);
      await gate.promise;
      return real.record(reservation);
    },
  };
  return {
    service: createReservationService(ports, () => new Date()),
    /** Resolves with the generation Lua admitted the hold under, once the reserve reaches Postgres. */
    arrived: arrived.promise,
    open: () => gate.resolve(),
  };
}

describe('rebuild vs an in-flight reserve (the generation fence, §4.7)', () => {
  it('refuses the reserve the rebuild fenced out (503), drops its hold, and the same key succeeds after', async () => {
    const dropId = await newDrop();
    const buyer = await newBuyer();
    const key = `key_${randomUUID()}`;
    const gated = gatedReservations();

    const inFlight = gated.service.reserve(
      { userId: buyer.userId, dropId, idempotencyKey: key, qty: 1, traceId: 'race-matrix' },
      logger,
    );
    const admittedGen = await gated.arrived;
    expect(await readStock(stack.redis, dropId)).toMatchObject({ avail: 9, held: 1, gen: admittedGen });

    // The rebuild runs while the reserve sits between Lua and Postgres: its snapshot has no order for the
    // hold, so the rebuilt Redis has neither the hold nor its rsv entry.
    const reconcile = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drops/${dropId}/reconcile`,
      headers: { origin: ORIGIN },
      cookies: { [SESSION_COOKIE]: adminToken },
    });
    expect(reconcile.statusCode, reconcile.body).toBe(200);
    expect(await readStock(stack.redis, dropId)).toMatchObject({ avail: 10, held: 0, gen: admittedGen + 1 });

    gated.open();
    await expect(inFlight).rejects.toBeInstanceOf(RetryError);

    const { rows } = await stack.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM orders WHERE drop_id = ${dropId}`,
    );
    expect(rows[0]?.n).toBe(0);
    const state = await readDropState(stack.redis, dropId);
    expect(redisDropViolations(state)).toEqual([]);

    // The client retries with the same key (503 says so); Lua admits it afresh under the new generation.
    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/drops/${dropId}/reservations`,
      headers: { origin: ORIGIN, 'idempotency-key': key },
      cookies: { [SESSION_COOKIE]: buyer.token },
      payload: { qty: 1 },
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(OrderResponse.parse(retried.json()).order.status).toBe('RESERVED');
    expect(await readStock(stack.redis, dropId)).toMatchObject({ avail: 9, held: 1, gen: admittedGen + 1 });
    const { rows: inventory } = await stack.database.db.execute<{ reserved: number; redis_gen: number }>(
      sql`SELECT reserved, redis_gen FROM drop_inventory WHERE drop_id = ${dropId}`,
    );
    expect(inventory[0]).toEqual({ reserved: 1, redis_gen: admittedGen + 1 });
  });
});
