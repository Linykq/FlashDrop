import type { RedisDropState, RedisRsvEntry } from '@flashdrop/inventory';
import { describe, expect, it } from 'vitest';
import {
  checkDeadLetters,
  checkDrop,
  checkEvents,
  type DropSample,
  type EventsSample,
  type LedgerCharge,
  type PgDropSnapshot,
  type PgOrder,
  pendingEvents,
  pendingWork,
  summarizeInvariants,
  type Violation,
} from './invariants';

const DROP = '00000000-0000-4000-8000-0000000000d1';
const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const TOTAL = 1_999;

function order(id: string, overrides: Partial<PgOrder> = {}): PgOrder {
  return {
    id,
    userId: ALICE,
    qty: 1,
    status: 'RESERVED',
    totalCents: TOTAL,
    fp: `fp-${id}`,
    idempotencyKey: `key-${id}`,
    due: false,
    settled: false,
    quarantinedBy: [],
    payment: null,
    charges: [],
    ...overrides,
  };
}

const charge = (id: string, status: LedgerCharge['status'], amountCents = TOTAL): LedgerCharge => ({
  id,
  status,
  amountCents,
});

/** A PAID order as the payment consumer leaves it: one succeeded charge and its SUCCEEDED payment. */
function paidOrder(id: string, overrides: Partial<PgOrder> = {}): PgOrder {
  return order(id, {
    status: 'PAID',
    settled: true,
    payment: { status: 'SUCCEEDED', pspChargeId: `ch_${id}`, amountCents: TOTAL },
    charges: [charge(`ch_${id}`, 'succeeded')],
    ...overrides,
  });
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
  const paid = paidOrder('r2', { userId: BOB });
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

/** The consistent drop with one more order of Bob's, which holds no units and needs no Redis change. */
function withOrder(extra: PgOrder): DropSample {
  return sample(({ pg, redis }) => ({
    pg: { ...pg, orders: [...pg.orders, extra] },
    redis: { ...redis, entries: new Map([...redis.entries, [extra.id, entryOf(extra, 'RELEASED')]]) },
  }));
}

describe('INV-4: no double charge', () => {
  it('accepts every way an order can end with its money in order', () => {
    const declined = order('r5', {
      userId: BOB,
      status: 'PAYMENT_FAILED',
      settled: true,
      payment: { status: 'FAILED', pspChargeId: 'ch_r5', amountCents: TOTAL },
      charges: [charge('ch_r5', 'declined')],
    });
    const refunded = order('r6', {
      userId: BOB,
      status: 'EXPIRED',
      settled: true,
      payment: { status: 'REFUNDED', pspChargeId: 'ch_r6', amountCents: TOTAL },
      charges: [charge('ch_r6', 'refunded')],
    });
    // Closed before the charge arrived: the PSP refused it and recorded nothing.
    const fenced = order('r7', { userId: BOB, status: 'CANCELLED', settled: true });
    for (const extra of [declined, refunded, fenced]) {
      expect(pendingWork(withOrder(extra))).toEqual([]);
      expect(checkDrop(withOrder(extra))).toEqual([]);
    }
  });

  it('flags a second succeeded charge, a refunded PAID order and a payment that names the wrong charge', () => {
    const twice = order('r5', {
      userId: BOB,
      status: 'CANCELLED',
      settled: true,
      charges: [charge('ch_r5', 'succeeded'), charge('ch_again', 'succeeded')],
    });
    expect(described(checkDrop(withOrder(twice), []))).toContain(
      'INV-4 2 succeeded charges for one reference',
    );

    // Bob's PAID order r2, edited.
    const paid = (edit: Partial<PgOrder>) =>
      sample(({ pg, redis }) => ({
        pg: { ...pg, orders: pg.orders.map((o) => (o.id === 'r2' ? { ...o, ...edit } : o)) },
        redis,
      }));
    expect(described(checkDrop(paid({ charges: [charge('ch_r2', 'refunded')] })))).toEqual([
      `INV-4 PSP net captured 0 for a PAID order of ${TOTAL}`,
      'INV-4 SUCCEEDED payment names ch_r2, not a succeeded PSP charge',
    ]);

    expect(described(checkDrop(paid({ payment: null })))).toEqual([
      'INV-4 PAID with a missing payment instead of SUCCEEDED',
    ]);

    const short = paid({
      payment: { status: 'SUCCEEDED', pspChargeId: 'ch_r2', amountCents: 999 },
      charges: [charge('ch_r2', 'succeeded', 999)],
    });
    expect(described(checkDrop(short))).toEqual([
      `INV-4 PSP net captured 999 for a PAID order of ${TOTAL}`,
      `INV-4 SUCCEEDED payment of 999 for a total of ${TOTAL}`,
    ]);
  });

  it('flags bookkeeping that contradicts the order at any instant', () => {
    const charged = order('r5', {
      userId: BOB,
      status: 'REJECTED',
      settled: true,
      charges: [charge('ch_r5', 'declined')],
    });
    expect(described(checkDrop(withOrder(charged)))).toEqual(['INV-4 1 PSP charges for a REJECTED order']);

    const failedWithoutRow = order('r5', { userId: BOB, status: 'PAYMENT_FAILED', settled: true });
    expect(described(checkDrop(withOrder(failedWithoutRow)))).toEqual([
      'INV-4 PAYMENT_FAILED order with a missing payment',
    ]);

    const ghostRefund = order('r5', {
      userId: BOB,
      status: 'CANCELLED',
      settled: true,
      payment: { status: 'REFUNDED', pspChargeId: 'ch_r5', amountCents: TOTAL },
    });
    expect(described(checkDrop(withOrder(ghostRefund)))).toEqual([
      `INV-4 REFUNDED payment of ${TOTAL} names ch_r5, which the PSP did not refund for that amount`,
    ]);
  });

  it('waits for the payment consumer while money is in flight, then fails INV-4', () => {
    // A charge that raced the expiry: the order ended unpaid, and no close has refunded it yet.
    const raced = order('r5', {
      userId: BOB,
      status: 'EXPIRED',
      settled: true,
      charges: [charge('ch_r5', 'succeeded')],
    });
    expect(pendingWork(withOrder(raced))).toEqual([
      { kind: 'payments', message: '1 orders that ended unpaid hold a captured charge' },
    ]);
    expect(described(checkDrop(withOrder(raced)))).toEqual([
      'INV-4 not quiescent: 1 orders that ended unpaid hold a captured charge',
    ]);

    // Refunded by the close, not yet recorded as a REFUNDED payment.
    const unrecorded = { ...raced, charges: [charge('ch_r5', 'refunded')] };
    expect(pendingWork(withOrder(unrecorded))).toEqual([
      { kind: 'payments', message: '1 refunds not yet recorded as REFUNDED payments' },
    ]);

    // Between the PSP's answer and the PAID CAS.
    const charging = sample(({ pg, redis }) => ({
      pg: {
        ...pg,
        orders: pg.orders.map((o) =>
          o.id === 'r1' ? { ...o, status: 'PENDING_PAYMENT', charges: [charge('ch_r1', 'succeeded')] } : o,
        ),
      },
      redis,
    }));
    expect(pendingWork(charging)).toEqual([
      { kind: 'payments', message: '1 PENDING_PAYMENT orders hold a captured charge' },
    ]);
  });
});

const quietEvents: EventsSample = {
  outbox: { pending: 0, oldestSeconds: null },
  groups: [
    { name: 'payment', groupId: 'payment', partitions: [{ partition: 0, committed: '7', lag: 0 }] },
    {
      name: 'settlement',
      groupId: 'inventory-settlement',
      partitions: [{ partition: 0, committed: '7', lag: 0 }],
    },
  ],
  logEnd: ['7'],
  deadLetters: 0,
};

describe('INV-5: no lost events', () => {
  it('is quiet when the outbox is drained and every group is at the log end, both times', () => {
    expect(pendingEvents(quietEvents, quietEvents)).toEqual([]);
    expect(checkEvents([])).toEqual([]);
  });

  it('waits for the relay and the consumers, and says which group is behind', () => {
    const behind: EventsSample = {
      ...quietEvents,
      outbox: { pending: 3, oldestSeconds: 1.25 },
      groups: [
        {
          name: 'payment',
          groupId: 'payment',
          partitions: [
            { partition: 0, committed: '5', lag: 2 },
            { partition: 1, committed: null, lag: 4 },
          ],
        },
      ],
    };
    const pending = pendingEvents(quietEvents, behind);
    expect(pending).toEqual([
      { kind: 'outbox', message: '3 outbox rows not yet published, the oldest for 1.3 s' },
      {
        kind: 'consumers',
        message:
          'payment (group payment): 6 events not yet processed on partitions 0, 1; ' +
          'no commits there yet: is the payment role running?',
      },
    ]);
    expect(checkEvents(pending).map((v) => `${v.invariant} ${v.dropId ?? 'events'}`)).toEqual([
      'INV-5 events',
      'INV-5 events',
    ]);
  });

  it('does not count a round in which something was published', () => {
    expect(pendingEvents(quietEvents, { ...quietEvents, logEnd: ['8'] })).toEqual([
      { kind: 'outbox', message: 'events were published while the drops were sampled' },
    ]);
  });

  it('gates dead letters only under a ceiling, and fails above it', () => {
    // Without a ceiling the DLQ is reported, never judged: a shared broker keeps 30 days of every run.
    expect(checkDeadLetters(12, undefined)).toEqual([]);
    expect(checkDeadLetters(0, 0)).toEqual([]);
    expect(checkDeadLetters(1, 1)).toEqual([]);
    expect(checkDeadLetters(1, 0)).toEqual([
      { invariant: 'INV-5', message: '1 dead letter in the DLQ topic, at most 0 allowed' },
    ]);
    expect(checkDeadLetters(3, 1)).toEqual([
      { invariant: 'INV-5', message: '3 dead letters in the DLQ topic, at most 1 allowed' },
    ]);
    // A ceiling that cannot be checked is a failure, not a pass.
    expect(checkDeadLetters(null, 0)).toEqual([
      { invariant: 'INV-5', message: 'dead letters not counted, but at most 0 are allowed' },
    ]);
  });
});

describe('summarizeInvariants', () => {
  it('lists every invariant once, with INV-5 skipped when the event pipeline was not sampled', () => {
    const violations: Violation[] = [{ invariant: 'INV-2', dropId: DROP, message: 'x' }];
    const results = summarizeInvariants(violations, { eventsChecked: false });
    expect(results.map((result) => `${result.id} ${result.status}`)).toEqual([
      'INV-1 pass',
      'INV-2 fail',
      'INV-3 pass',
      'INV-4 pass',
      'INV-5 skipped',
      'INV-6 pass',
      'INV-7 pass',
      'INV-8 pass',
      'INV-9 pass',
    ]);
    const checked = summarizeInvariants(violations, { eventsChecked: true });
    expect(checked.find((result) => result.id === 'INV-5')).toMatchObject({
      status: 'pass',
      reason: expect.stringContaining('sales-dashboard joins in M7'),
    });
  });
});
