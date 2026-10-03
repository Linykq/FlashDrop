import { randomUUID } from 'node:crypto';
import { requestFingerprint } from '@flashdrop/domain/identity';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { fdConfirm, fdRateLimitHit, fdRebuild, fdRelease, fdReserve, fdSetStatus } from './calls';
import { createSubscriber, type FlashdropRedis } from './client';
import { rateLimitKey, stockChannel } from './keys';
import { readDropState, readStock, redisDropViolations } from './state';
import { parseStockMessage, type StockLevelMessage } from './stock-message';
import { armTestDrop, connectTestRedis, deleteDropKeys, emptySnapshot, reserveInput } from './test/redis';

/*
 * The Functions against the shared Compose Redis (design §13): concurrency, idempotency, the RECONCILING
 * guard and the generation check. Every test arms its own drop and deletes its keys afterwards.
 */

let redis: FlashdropRedis;
/** Extra connections, so concurrent calls really arrive on several sockets. */
let pool: FlashdropRedis[];

beforeAll(async () => {
  redis = await connectTestRedis();
  pool = await Promise.all(Array.from({ length: 8 }, (_, i) => connectTestRedis(`inventory-test-${i}`)));
});

afterAll(async () => {
  await Promise.all([redis, ...pool].map((client) => client.close()));
});

async function arm(options: Parameters<typeof armTestDrop>[1] = {}) {
  const drop = await armTestDrop(redis, options);
  onTestFinished(() => deleteDropKeys(redis, drop.dropId));
  return drop;
}

async function expectConsistent(dropId: string) {
  expect(redisDropViolations(await readDropState(redis, dropId))).toEqual([]);
}

describe('fd_reserve under concurrency', () => {
  it('admits exactly the stock: 2,000 concurrent reserves from 300 users on 100 units, limit 2', async () => {
    const { dropId } = await arm({ total: 100, limit: 2 });
    const users = Array.from({ length: 300 }, () => randomUUID());

    // Each user sends 6-7 requests back to back, spread over 8 connections, so the limit gate is hit
    // long before the stock runs out.
    const results = await Promise.all(
      Array.from({ length: 2_000 }, (_, i) => {
        const user = users[Math.floor((i * users.length) / 2_000)] as string; // index < users.length
        return fdReserve(pool[i % pool.length] as FlashdropRedis, reserveInput(dropId, user));
      }),
    );

    const kinds = results.map((result) => result.kind);
    expect(kinds.filter((kind) => kind === 'RESERVED')).toHaveLength(100);
    expect(new Set(kinds)).toEqual(new Set(['RESERVED', 'SOLD_OUT', 'LIMIT']));
    const state = await readDropState(redis, dropId);
    expect(state.inv).toMatchObject({ total: 100, avail: 0, held: 100, sold: 0, seq: 100 });
    expect([...state.entries.values()].filter((entry) => entry.s === 'HELD')).toHaveLength(100);
    expect(Math.max(...state.quotas.values())).toBeLessThanOrEqual(2);
    expect(redisDropViolations(state)).toEqual([]);
  });

  it('gives one hold to a storm of 50 identical requests', async () => {
    const { dropId } = await arm();
    const input = reserveInput(dropId, randomUUID());

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => fdReserve(pool[i % pool.length] as FlashdropRedis, input)),
    );

    expect(results.filter((result) => result.kind === 'RESERVED')).toEqual([{ kind: 'RESERVED', gen: 1 }]);
    expect(results.filter((result) => result.kind === 'EXISTING')).toEqual(
      Array(49).fill({ kind: 'EXISTING', state: 'HELD', gen: 1 }),
    );
    expect(await readStock(redis, dropId)).toMatchObject({ avail: 99, held: 1 });
    await expectConsistent(dropId);
  });
});

describe('fd_reserve gates', () => {
  it('answers each refusal read-only, in the documented order', async () => {
    const { dropId } = await arm({ total: 3, limit: 2 });
    const user = randomUUID();
    const first = reserveInput(dropId, user, 2);

    expect(await fdReserve(redis, { ...first, qty: 0 })).toEqual({ kind: 'BAD_QTY' });
    expect(await fdReserve(redis, { ...first, qty: 1.5 })).toEqual({ kind: 'BAD_QTY' });
    expect(await fdReserve(redis, { ...first, qty: 11 })).toEqual({ kind: 'BAD_QTY' });
    expect(await fdReserve(redis, first)).toEqual({ kind: 'RESERVED', gen: 1 });
    // Same rid, other body: the fingerprint no longer matches.
    expect(await fdReserve(redis, { ...first, fingerprint: requestFingerprint({ dropId, qty: 1 }) })).toEqual(
      {
        kind: 'FP_MISMATCH',
      },
    );
    expect(await fdReserve(redis, reserveInput(dropId, user, 1))).toEqual({ kind: 'LIMIT' });
    expect(await fdReserve(redis, reserveInput(dropId, randomUUID(), 2))).toEqual({ kind: 'SOLD_OUT' });
    expect(await fdReserve(redis, reserveInput(randomUUID(), user))).toEqual({ kind: 'NO_DROP' });
    expect(await readStock(redis, dropId)).toMatchObject({ avail: 1, held: 2, seq: 1 });
  });

  it('admits only inside [startsAt, endsAt) while SCHEDULED or LIVE', async () => {
    const early = await arm({ status: 'SCHEDULED', startsInMs: 60_000 });
    const late = await arm({ startsInMs: -120_000, endsInMs: -60_000 });
    const open = await arm({ status: 'SCHEDULED' });
    const user = randomUUID();

    expect(await fdReserve(redis, reserveInput(early.dropId, user))).toEqual({ kind: 'NOT_LIVE' });
    expect(await fdReserve(redis, reserveInput(late.dropId, user))).toEqual({ kind: 'NOT_LIVE' });
    // Armed and inside its window: open on time, before the scheduler flips it to LIVE.
    expect(await fdReserve(redis, reserveInput(open.dropId, user))).toEqual({ kind: 'RESERVED', gen: 1 });
    for (const status of ['PAUSED', 'ENDED'] as const) {
      expect(await fdSetStatus(redis, open.dropId, status)).toEqual({ kind: 'OK' });
      expect(await fdReserve(redis, reserveInput(open.dropId, user))).toEqual({ kind: 'NOT_LIVE' });
    }
  });
});

describe('fd_confirm and fd_release', () => {
  it('apply each outcome once and refuse the opposite one', async () => {
    const { dropId } = await arm({ total: 5 });
    const paid = reserveInput(dropId, randomUUID(), 2);
    const unpaid = reserveInput(dropId, randomUUID(), 1);
    await fdReserve(redis, paid);
    await fdReserve(redis, unpaid);

    expect(await fdConfirm(redis, dropId, paid.rid)).toEqual({ kind: 'OK' });
    expect(await fdConfirm(redis, dropId, paid.rid)).toEqual({ kind: 'NOOP' });
    expect(await fdRelease(redis, dropId, paid.rid)).toEqual({ kind: 'CONFLICT' });
    expect(await fdRelease(redis, dropId, unpaid.rid)).toEqual({ kind: 'OK' });
    expect(await fdRelease(redis, dropId, unpaid.rid)).toEqual({ kind: 'NOOP' });
    expect(await fdConfirm(redis, dropId, unpaid.rid)).toEqual({ kind: 'CONFLICT' });
    expect(await fdRelease(redis, dropId, randomUUID())).toEqual({ kind: 'MISSING' });

    const state = await readDropState(redis, dropId);
    expect(state.inv).toMatchObject({ avail: 3, held: 0, sold: 2 });
    expect(state.quotas.get(unpaid.userId)).toBeUndefined();
    expect(state.quotas.get(paid.userId)).toBe(2);
    // A released entry stays as the idempotency record of its rid.
    expect(await fdReserve(redis, unpaid)).toEqual({ kind: 'EXISTING', state: 'RELEASED', gen: 1 });
    await expectConsistent(dropId);
  });
});

describe('RECONCILING and the generation', () => {
  it('answers RETRY to every Function while a rebuild runs, and only fd_rebuild clears it', async () => {
    const { dropId, snapshot } = await arm();
    const held = reserveInput(dropId, randomUUID());
    await fdReserve(redis, held);

    expect(await fdSetStatus(redis, dropId, 'RECONCILING')).toEqual({ kind: 'OK' });
    expect(await fdReserve(redis, reserveInput(dropId, randomUUID()))).toEqual({ kind: 'RETRY' });
    expect(await fdConfirm(redis, dropId, held.rid)).toEqual({ kind: 'RETRY' });
    expect(await fdRelease(redis, dropId, held.rid)).toEqual({ kind: 'RETRY' });
    for (const status of ['SCHEDULED', 'LIVE', 'PAUSED', 'ENDED'] as const) {
      expect(await fdSetStatus(redis, dropId, status)).toEqual({ kind: 'RETRY' });
    }
    expect(await fdSetStatus(redis, dropId, 'RECONCILING')).toEqual({ kind: 'OK' });

    expect(await fdRebuild(redis, dropId, { ...snapshot, gen: 2 })).toEqual({ kind: 'OK' });
    const stock = await readStock(redis, dropId);
    expect(stock).toMatchObject({ status: 'LIVE', gen: 2, seq: 0, avail: 100, held: 0 });
    // The rebuild replaced rsv: the hold Postgres never recorded is gone, not leaked.
    expect((await readDropState(redis, dropId)).entries.size).toBe(0);
    expect((await readDropState(redis, dropId)).inv?.reconcilingSince).toBeUndefined();
  });

  it('refuses a rebuild whose generation is not newer (STALE), leaving the drop untouched', async () => {
    const { dropId, snapshot } = await arm({ gen: 5 });
    await fdReserve(redis, reserveInput(dropId, randomUUID()));
    const before = await readDropState(redis, dropId);

    expect(await fdRebuild(redis, dropId, { ...snapshot, gen: 5 })).toEqual({ kind: 'STALE' });
    expect(await fdRebuild(redis, dropId, { ...snapshot, gen: 4 })).toEqual({ kind: 'STALE' });

    expect(await readDropState(redis, dropId)).toEqual(before);
  });

  it('refuses a malformed snapshot whole (BAD_SNAPSHOT), before writing anything', async () => {
    const { dropId, snapshot } = await arm();
    const before = await readDropState(redis, dropId);
    const bad = [
      { ...snapshot, gen: 2, total: 1, reserved: 1, sold: 1 }, // more claimed than exists
      { ...snapshot, gen: 2, meta: { ...snapshot.meta, status: 'RECONCILING' as 'LIVE' } },
      { ...snapshot, gen: 2, meta: { ...snapshot.meta, retainAt: 1.5 } },
      {
        ...snapshot,
        gen: 2,
        entries: [{ rid: 'r', u: 'u', q: 0, s: 'HELD' as const, fp: 'f', k: 'k', expAt: 1 }],
      },
      { ...snapshot, gen: 2, quotas: { u: -1 } },
    ];

    for (const candidate of bad) {
      expect(await fdRebuild(redis, dropId, candidate)).toEqual({ kind: 'BAD_SNAPSHOT' });
    }
    expect(await readDropState(redis, dropId)).toEqual(before);
  });

  it('fd_set_status creates nothing but the complete fail-closed hash', async () => {
    const dropId = randomUUID();
    onTestFinished(() => deleteDropKeys(redis, dropId));

    expect(await fdSetStatus(redis, dropId, 'LIVE')).toEqual({ kind: 'NO_DROP' });
    expect(await readStock(redis, dropId)).toBeNull();
    expect(await fdSetStatus(redis, dropId, 'RECONCILING')).toEqual({ kind: 'OK' });
    expect(await readStock(redis, dropId)).toEqual({
      status: 'RECONCILING',
      gen: -1,
      seq: 1,
      avail: 0,
      held: 0,
      sold: 0,
    });
    expect(await fdRebuild(redis, dropId, emptySnapshot({ gen: 1 }))).toEqual({ kind: 'OK' });
    expect(await fdSetStatus(redis, dropId, 'PAUSED')).toEqual({ kind: 'OK' });
    expect(await fdSetStatus(redis, dropId, 'PAUSED')).toEqual({ kind: 'NOOP' });
    expect(await fdSetStatus(redis, dropId, 'DRAFT' as 'LIVE')).toEqual({ kind: 'BAD_STATUS' });
  });
});

describe('stock messages', () => {
  it('are published in mutation order, one per mutation, with the new level', async () => {
    const { dropId } = await arm({ total: 3 });
    const subscriber = createSubscriber(redis, {
      name: 'inventory-test-sub',
      logger: { warn: () => undefined },
    });
    await subscriber.connect();
    onTestFinished(() => subscriber.close());
    const messages: StockLevelMessage[] = [];
    await subscriber.subscribe(stockChannel(dropId), (message) => {
      const parsed = parseStockMessage(message);
      if (parsed !== null) messages.push(parsed);
    });

    const input = reserveInput(dropId, randomUUID());
    await fdReserve(redis, input);
    await fdReserve(redis, input); // a replay mutates nothing and publishes nothing
    await fdRelease(redis, dropId, input.rid);
    await fdSetStatus(redis, dropId, 'ENDED');
    await expect.poll(() => messages.length).toBe(3);

    expect(messages.map(({ ts: _, ...level }) => level)).toEqual([
      { gen: 1, seq: 1, avail: 2, held: 1, sold: 0, status: 'LIVE' },
      { gen: 1, seq: 2, avail: 3, held: 0, sold: 0, status: 'LIVE' },
      { gen: 1, seq: 3, avail: 3, held: 0, sold: 0, status: 'ENDED' },
    ]);
    expect(Math.abs((messages[0]?.ts ?? 0) - Date.now())).toBeLessThan(5_000);
  });
});

describe('fd_rl_hit', () => {
  it('counts hits in a fixed window that the first hit starts', async () => {
    const key = rateLimitKey('inventory-test', randomUUID());
    onTestFinished(async () => {
      await redis.del(key);
    });

    expect(await fdRateLimitHit(redis, key, 1_000)).toEqual({ count: 1, ttlMs: 1_000 });
    const second = await fdRateLimitHit(redis, key, 1_000);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeLessThanOrEqual(1_000);
    expect(second.ttlMs).toBeGreaterThan(0);

    // A counter that lost its TTL gets one back instead of limiting its subject forever.
    await redis.persist(key);
    expect((await fdRateLimitHit(redis, key, 1_000)).ttlMs).toBe(1_000);
  });
});
