import type { RedisDropState, RedisRsvEntry } from '@flashdrop/inventory';
import { describe, expect, it } from 'vitest';
import {
  checkDrop,
  type DropSample,
  type PgDropSnapshot,
  type PgOrder,
  pendingWork,
  summarizeInvariants,
  type Violation,
} from './invariants';

const DROP = '00000000-0000-4000-8000-0000000000d1';
const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';

function order(id: string, overrides: Partial<PgOrder> = {}): PgOrder {
  return {
    id,
    userId: ALICE,
    qty: 1,
    status: 'RESERVED',
    fp: `fp-${id}`,
    idempotencyKey: `key-${id}`,
    due: false,
    settled: false,
    quarantinedBy: [],
    ...overrides,
  };
}

const entryOf = (o: PgOrder, s: RedisRsvEntry['s']): RedisRsvEntry => ({
  u: o.userId,
  q: o.qty,
  s,
  fp: o.fp,
  k: o.idempotencyKey,
});

/** A consistent, idle drop of 10 units: Alice holds one, Bob bought one, one hold expired and settled. */
function consistent(): { pg: PgDropSnapshot; redis: RedisDropState } {
  const held = order('r1');
  const paid = order('r2', { userId: BOB, status: 'PAID', settled: true });
  const expired = order('r3', { status: 'EXPIRED', settled: true });
  return {
    pg: {
      status: 'LIVE',
      perUserLimit: 2,
      tracked: true,
      total: 10,
      reserved: 1,
      sold: 1,
      redisGen: 3,
      orders: [held, paid, expired],
      quotas: [
        { userId: ALICE, claimed: 1, limit: 2 },
        { userId: BOB, claimed: 1, limit: 2 },
      ],
      version: 'v1',
    },
    redis: {
      inv: { status: 'LIVE', gen: 3, seq: 7, total: 10, avail: 8, held: 1, sold: 1 },
      entries: new Map([
        ['r1', entryOf(held, 'HELD')],
        ['r2', entryOf(paid, 'COMMITTED')],
        ['r3', entryOf(expired, 'RELEASED')],
      ]),
      quotas: new Map([
        [ALICE, 1],
        [BOB, 1],
      ]),
      expiries: new Map([['r1', 1]]),
    },
  };
}

function sample(
  edit: (state: { pg: PgDropSnapshot; redis: RedisDropState }) => {
    pg: PgDropSnapshot;
    redis: RedisDropState;
  } = (s) => s,
  stable = true,
): DropSample {
  const { pg, redis } = edit(consistent());
  return { dropId: DROP, pg, redis: { kind: 'ok', state: redis }, stable };
}

const described = (violations: readonly Violation[]) => violations.map((v) => `${v.invariant} ${v.message}`);

describe('checkDrop', () => {
  it('finds nothing on a consistent idle drop', () => {
    expect(pendingWork(sample())).toEqual([]);
    expect(checkDrop(sample())).toEqual([]);
  });

  it('treats Redis below Postgres mid-flight as pending, not as a breach', () => {
    // A release Postgres committed and Redis has not applied yet: Redis holds one unit too many.
    const unsettled = sample(({ pg, redis }) => ({
      pg: {
        ...pg,
        reserved: 0,
        orders: pg.orders.map((o) => (o.id === 'r1' ? { ...o, status: 'EXPIRED' } : o)),
        quotas: pg.quotas.map((q) => (q.userId === ALICE ? { ...q, claimed: 0 } : q)),
      },
      redis,
    }));
    expect(pendingWork(unsettled)).toEqual([
      { kind: 'settlement', message: '1 terminal orders not yet applied to Redis' },
    ]);
    expect(checkDrop(unsettled, [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ invariant: 'INV-6' })]),
    );
    expect(described(checkDrop(unsettled))).toEqual([
      'INV-6 not quiescent: 1 terminal orders not yet applied to Redis',
    ]);
  });

  it('flags the optimistic direction even when the drop is not idle', () => {
    const optimistic = sample(({ pg, redis }) => ({
      pg: { ...pg, orders: [...pg.orders, order('r4', { status: 'EXPIRED' })] },
      redis: { ...redis, inv: redis.inv && { ...redis.inv, avail: 9, held: 0 } },
    }));
    expect(described(checkDrop(optimistic))).toEqual(
      expect.arrayContaining([
        'INV-7 Redis avail 9 > Postgres available 8',
        'INV-7 Redis held 0 < Postgres reserved 1',
      ]),
    );
  });

  it('compares the stores only on a stable sample', () => {
    const moving = sample(
      ({ pg, redis }) => ({ pg, redis: { ...redis, inv: redis.inv && { ...redis.inv, avail: 9, held: 0 } } }),
      false,
    );
    expect(pendingWork(moving)).toEqual([
      { kind: 'sampling', message: 'the drop changed while it was sampled' },
    ]);
    // INV-9 still applies: one Redis read is atomic on its own.
    expect(described(checkDrop(moving))).toEqual([
      'INV-6 not quiescent: the drop changed while it was sampled',
      'INV-9 held 0 != HELD units 1',
    ]);
  });

  it('checks INV-8 both ways', () => {
    const released = sample(({ pg, redis }) => ({
      pg,
      redis: {
        ...redis,
        entries: new Map([...redis.entries, ['r1', { ...entryOf(order('r1'), 'RELEASED') }]]),
      },
    }));
    expect(described(checkDrop(released))).toContain('INV-8 Redis RELEASED, order RESERVED');

    const missing = sample(({ pg, redis }) => ({
      pg: { ...pg, orders: [...pg.orders, order('r9', { status: 'REJECTED', settled: true })] },
      redis,
    }));
    expect(described(checkDrop(missing))).toEqual(['INV-8 order REJECTED has no Redis entry']);
  });

  it('waits for orphan holds and holds of settled orders, which the orphan scan repairs', () => {
    const orphan = sample(({ pg, redis }) => ({
      pg: {
        ...pg,
        reserved: 0,
        orders: pg.orders.map((o) => (o.id === 'r1' ? { ...o, status: 'EXPIRED', settled: true } : o)),
        quotas: pg.quotas.map((q) => (q.userId === ALICE ? { ...q, claimed: 0 } : q)),
      },
      redis: {
        ...redis,
        entries: new Map([...redis.entries, ['r8', { ...entryOf(order('r8'), 'HELD') }]]),
      },
    }));
    expect(pendingWork(orphan).map((item) => item.message)).toEqual([
      '1 Redis holds without an order',
      '1 Redis holds of orders already settled',
    ]);
  });

  it('reports quarantined orders instead of waiting for them', () => {
    const stuck = sample(({ pg, redis }) => ({
      pg: {
        ...pg,
        orders: pg.orders.map((o) =>
          o.id === 'r1' ? { ...o, due: true, quarantinedBy: ['expire-orders'] } : o,
        ),
      },
      redis,
    }));
    expect(pendingWork(stuck)).toEqual([]);
    expect(described(checkDrop(stuck))).toEqual(['INV-6 order RESERVED, quarantined by expire-orders']);
  });

  it('checks only Postgres for an untracked drop', () => {
    const untracked = sample(({ pg }) => ({
      pg: { ...pg, tracked: false },
      redis: { inv: null, entries: new Map(), quotas: new Map(), expiries: new Map() },
    }));
    expect(pendingWork(untracked)).toEqual([]);
    expect(checkDrop(untracked)).toEqual([]);
  });

  it('checks the per-user limit in both stores', () => {
    const over = sample(({ pg, redis }) => ({
      pg: {
        ...pg,
        reserved: 3,
        orders: [...pg.orders, order('r5', { qty: 2 })],
        quotas: pg.quotas.map((q) => (q.userId === ALICE ? { ...q, claimed: 3 } : q)),
      },
      redis: { ...redis, quotas: new Map([...redis.quotas, [ALICE, 3]]) },
    }));
    expect(described(checkDrop(over, []))).toEqual(
      expect.arrayContaining([
        `INV-3 user ${ALICE}: 3 units > per-user limit 2`,
        `INV-3 user ${ALICE}: claimed 3 > limit_qty 2`,
        `INV-3 Redis uq[${ALICE}] 3 > per-user limit 2`,
      ]),
    );
  });
});

describe('summarizeInvariants', () => {
  it('lists every invariant once, with INV-4 and INV-5 skipped until their milestones', () => {
    const results = summarizeInvariants([{ invariant: 'INV-2', dropId: DROP, message: 'x' }]);
    expect(results.map((result) => `${result.id} ${result.status}`)).toEqual([
      'INV-1 pass',
      'INV-2 fail',
      'INV-3 pass',
      'INV-4 skipped',
      'INV-5 skipped',
      'INV-6 pass',
      'INV-7 pass',
      'INV-8 pass',
      'INV-9 pass',
    ]);
  });
});
