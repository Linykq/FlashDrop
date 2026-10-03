import {
  type DropStatus,
  LIVE_ORDER_STATUSES,
  type OrderStatus,
  TERMINAL_ORDER_STATUSES,
} from '@flashdrop/domain';
import { type RedisDropState, redisDropViolations } from '@flashdrop/inventory';

/*
 * The invariants of design §1.1, checked on one sample of a drop: a REPEATABLE READ snapshot of its Postgres
 * rows next to one MULTI read of its Redis keys. Pure functions, so every rule is unit-tested; reading the
 * stores and waiting for quiescence live in `invariant-samples.ts`.
 *
 * Which rule may be checked when:
 * - INV-1, INV-2 and INV-3 (Postgres) and INV-9 (Redis) hold at every instant: each store changes its
 *   counters together with the rows they count, and each side is read atomically.
 * - Redis against Postgres is compared only on a **stable sample** (§4.7): neither store changed between
 *   the first and the last read, so both sides describe the same instant. Even then in-flight work leaves
 *   Redis legitimately *lower* (a hold Postgres has not committed yet, an outcome Postgres committed and
 *   Redis has not applied yet), so INV-7 and the instant-wise half of INV-8 only reject the optimistic
 *   direction.
 * - Equality (INV-6, the rest of INV-8) needs the drop to be **idle** as well: no due live order, no terminal
 *   order Redis has not applied, no hold without an order, and a Redis state rebuilt at Postgres's
 *   generation. Every one of those is work some loop still has to do, so it counts as pending, not as a
 *   breach, until the wait for quiescence runs out.
 */

export const INVARIANTS = {
  'INV-1': 'No oversell',
  'INV-2': 'Counters match orders',
  'INV-3': 'Per-user limit',
  'INV-4': 'No double charge',
  'INV-5': 'No lost events',
  'INV-6': 'No leaked stock',
  'INV-7': 'Redis is never optimistic',
  'INV-8': 'Redis agrees with Postgres',
  'INV-9': 'Redis conservation',
} as const;
export type InvariantId = keyof typeof INVARIANTS;
const INVARIANT_IDS = Object.keys(INVARIANTS) as InvariantId[];

/** Checks whose evidence later milestones build. Reported as skipped, never as passed. */
export const SKIPPED_INVARIANTS: Readonly<Partial<Record<InvariantId, string>>> = {
  'INV-4': 'skipped until M4: the payments table and the PSP ledger arrive with payment-mock',
  'INV-5': 'skipped until M3: the outbox relay and the consumer groups arrive in M3',
};

export interface PgOrder {
  readonly id: string;
  readonly userId: string;
  readonly qty: number;
  readonly status: OrderStatus;
  /** `encode(request_hash, 'hex')`: the `fp` of its `rsv` entry. */
  readonly fp: string;
  readonly idempotencyKey: string;
  /** `expires_at < now()` at the snapshot. Meaningful for live orders only. */
  readonly due: boolean;
  /** `redis_settled_at IS NOT NULL`. */
  readonly settled: boolean;
  /** The sweeper loops that quarantined it (§4.6); empty when none did. */
  readonly quarantinedBy: readonly string[];
}

export interface PgQuota {
  readonly userId: string;
  readonly claimed: number;
  readonly limit: number;
}

/** One drop's Postgres rows, read in one REPEATABLE READ transaction. */
export interface PgDropSnapshot {
  readonly status: DropStatus;
  readonly perUserLimit: number;
  /** In the tracked set (§4.1): armed and within 24 h of its end, so its Redis state must exist. */
  readonly tracked: boolean;
  readonly total: number;
  readonly reserved: number;
  readonly sold: number;
  readonly redisGen: number;
  readonly orders: readonly PgOrder[];
  readonly quotas: readonly PgQuota[];
  /** Changes whenever the drop's inventory, orders or quarantine rows change: the stable-sample probe. */
  readonly version: string;
}

export type RedisRead =
  | { readonly kind: 'ok'; readonly state: RedisDropState }
  /** The keys exist but do not parse: itself an INV-9 breach. */
  | { readonly kind: 'malformed'; readonly message: string };

export interface DropSample {
  readonly dropId: string;
  readonly pg: PgDropSnapshot;
  readonly redis: RedisRead;
  /** Neither store changed while the sample was taken. */
  readonly stable: boolean;
}

export interface Violation {
  readonly invariant: InvariantId;
  readonly dropId: string;
  readonly orderId?: string;
  readonly message: string;
}

const LIVE: ReadonlySet<OrderStatus> = new Set(LIVE_ORDER_STATUSES);
const TERMINAL: ReadonlySet<OrderStatus> = new Set(TERMINAL_ORDER_STATUSES);

const sumQty = (orders: readonly PgOrder[], keep: (order: PgOrder) => boolean): number =>
  orders.reduce((units, order) => (keep(order) ? units + order.qty : units), 0);

/** Postgres's available stock: what Redis `avail` must equal when idle and never exceed (INV-6, INV-7). */
export const pgAvailable = (pg: PgDropSnapshot): number => pg.total - pg.sold - pg.reserved;

/** The Redis state when it can be compared with Postgres at all; null while it is missing or rebuilding. */
function comparableRedis(sample: DropSample): RedisDropState | null {
  if (!sample.pg.tracked || sample.redis.kind !== 'ok') return null;
  const { inv } = sample.redis.state;
  if (inv === null || inv.status === 'RECONCILING' || inv.gen !== sample.pg.redisGen) return null;
  return sample.redis.state;
}

/** What a drop is still waiting for, by the loop that will do it (§4.6, §4.7). */
export const PENDING_KINDS = {
  expiry: 'No live order past expires_at',
  settlement: 'Every terminal order applied to Redis',
  rebuild: 'Redis rebuilt at the Postgres generation',
  'orphan-scan': 'No Redis hold waiting for the orphan scan',
  sampling: 'Neither store changed while sampled',
} as const;
export type PendingKind = keyof typeof PENDING_KINDS;

export interface PendingWork {
  readonly kind: PendingKind;
  readonly message: string;
}

/**
 * Work that some loop still owes this drop; empty when the drop is idle. Quarantined orders are left out:
 * no loop will touch them again, so waiting cannot help, and `checkDrop` reports them.
 */
export function pendingWork(sample: DropSample): PendingWork[] {
  const { pg, redis } = sample;
  const pending: PendingWork[] = [];
  const owe = (kind: PendingKind, message: string) => pending.push({ kind, message });
  const open = pg.orders.filter((order) => order.quarantinedBy.length === 0);
  const due = open.filter((order) => LIVE.has(order.status) && order.due).length;
  if (due > 0) owe('expiry', `${due} live orders past expires_at`);
  const unsettled = open.filter((order) => TERMINAL.has(order.status) && !order.settled).length;
  if (unsettled > 0) owe('settlement', `${unsettled} terminal orders not yet applied to Redis`);

  if (pg.tracked && redis.kind === 'ok') {
    const { inv, entries } = redis.state;
    if (inv === null) owe('rebuild', 'no Redis state');
    else if (inv.status === 'RECONCILING') owe('rebuild', 'Redis is RECONCILING');
    else if (inv.gen !== pg.redisGen) {
      owe('rebuild', `Redis gen ${inv.gen} != Postgres redis_gen ${pg.redisGen}`);
    }
    // Both kinds are found through `exp` once hold expiry plus 30 s of grace has passed: a hold with no
    // order is tombstoned, and a hold whose order Postgres already settled (an AOF tail lost after the
    // settle resurrected it) is settled again with `force`.
    const orders = new Map(pg.orders.map((order) => [order.id, order]));
    let orphans = 0;
    let resurrected = 0;
    for (const [rid, entry] of entries) {
      if (entry.s !== 'HELD') continue;
      const order = orders.get(rid);
      if (order === undefined) orphans += 1;
      else if (TERMINAL.has(order.status) && order.settled) resurrected += 1;
    }
    if (orphans > 0) owe('orphan-scan', `${orphans} Redis holds without an order`);
    if (resurrected > 0) owe('orphan-scan', `${resurrected} Redis holds of orders already settled`);
  }
  if (!sample.stable) owe('sampling', 'the drop changed while it was sampled');
  return pending;
}

/**
 * Every invariant breach in one sample. `pending` is `pendingWork(sample)`: when it is not empty the wait
 * for quiescence has run out, each item becomes an INV-6 breach, and the equality checks are skipped.
 */
export function checkDrop(
  sample: DropSample,
  pending: readonly PendingWork[] = pendingWork(sample),
): Violation[] {
  const { dropId, pg } = sample;
  const violations: Violation[] = [];
  const breach = (invariant: InvariantId, message: string, orderId?: string) => {
    violations.push(
      orderId === undefined ? { invariant, dropId, message } : { invariant, dropId, orderId, message },
    );
  };
  const liveUnits = sumQty(pg.orders, (order) => LIVE.has(order.status));
  const paidUnits = sumQty(pg.orders, (order) => order.status === 'PAID');

  // INV-1: no oversell.
  if (pg.reserved < 0 || pg.sold < 0) {
    breach('INV-1', `negative counter: reserved ${pg.reserved}, sold ${pg.sold}`);
  }
  if (pg.reserved + pg.sold > pg.total) {
    breach('INV-1', `reserved ${pg.reserved} + sold ${pg.sold} > total ${pg.total}`);
  }
  if (paidUnits > pg.total) breach('INV-1', `${paidUnits} PAID units > total ${pg.total}`);

  // INV-2: counters match orders.
  if (pg.reserved !== liveUnits) {
    breach('INV-2', `reserved ${pg.reserved} != ${liveUnits} RESERVED/PENDING_PAYMENT units`);
  }
  if (pg.sold !== paidUnits) breach('INV-2', `sold ${pg.sold} != ${paidUnits} PAID units`);

  // INV-3: per-user limit, in Postgres and in the Redis gate.
  const userUnits = new Map<string, number>();
  for (const order of pg.orders) {
    if (LIVE.has(order.status) || order.status === 'PAID') {
      userUnits.set(order.userId, (userUnits.get(order.userId) ?? 0) + order.qty);
    }
  }
  const quotas = new Map(pg.quotas.map((quota) => [quota.userId, quota]));
  for (const userId of new Set([...userUnits.keys(), ...quotas.keys()])) {
    const units = userUnits.get(userId) ?? 0;
    const quota = quotas.get(userId);
    const claimed = quota?.claimed ?? 0;
    if (claimed !== units) {
      breach('INV-3', `user ${userId}: claimed ${claimed} != ${units} held or bought units`);
    }
    if (units > pg.perUserLimit) {
      breach('INV-3', `user ${userId}: ${units} units > per-user limit ${pg.perUserLimit}`);
    }
    if (quota !== undefined && quota.limit !== pg.perUserLimit) {
      breach(
        'INV-3',
        `user ${userId}: limit_qty ${quota.limit} != the drop's per_user_limit ${pg.perUserLimit}`,
      );
    }
    if (quota !== undefined && quota.claimed > quota.limit) {
      breach('INV-3', `user ${userId}: claimed ${quota.claimed} > limit_qty ${quota.limit}`);
    }
  }

  // INV-6, Postgres side: work no loop will ever finish.
  for (const order of pg.orders) {
    if (order.quarantinedBy.length > 0) {
      breach('INV-6', `order ${order.status}, quarantined by ${order.quarantinedBy.join(', ')}`, order.id);
    }
  }
  for (const item of pending) breach('INV-6', `not quiescent: ${item.message}`);

  if (!pg.tracked) return violations;
  const { redis } = sample;
  if (redis.kind === 'malformed') {
    breach('INV-9', `unreadable Redis state: ${redis.message}`);
    return violations;
  }
  const { inv } = redis.state;
  if (inv === null || inv.status === 'RECONCILING') return violations;

  // INV-9: Redis conservation and internal consistency, atomic within its MULTI read.
  for (const message of redisDropViolations(redis.state)) {
    breach('INV-9', message.replace(/^INV-9: /, ''));
  }
  for (const [userId, units] of redis.state.quotas) {
    if (units > pg.perUserLimit) {
      breach('INV-3', `Redis uq[${userId}] ${units} > per-user limit ${pg.perUserLimit}`);
    }
  }

  const state = sample.stable ? comparableRedis(sample) : null;
  if (state === null || state.inv === null) return violations;
  checkRedisAgainstPostgres(sample, state, pending.length === 0, breach);
  return violations;
}

type Breach = (invariant: InvariantId, message: string, orderId?: string) => void;

/** INV-6, INV-7 and INV-8 on a stable sample whose Redis state is at Postgres's generation. */
function checkRedisAgainstPostgres(
  sample: DropSample,
  state: RedisDropState,
  idle: boolean,
  breach: Breach,
): void {
  const { pg } = sample;
  const { inv } = state;
  if (inv === null) return;
  const available = pgAvailable(pg);

  // INV-7: the optimistic direction is a breach even mid-flight (§4.3 ordering rule).
  if (inv.avail > available) breach('INV-7', `Redis avail ${inv.avail} > Postgres available ${available}`);
  if (inv.held < pg.reserved) breach('INV-7', `Redis held ${inv.held} < Postgres reserved ${pg.reserved}`);
  if (inv.sold > pg.sold) breach('INV-7', `Redis sold ${inv.sold} > Postgres sold ${pg.sold}`);
  if (inv.total !== pg.total) breach('INV-6', `Redis total ${inv.total} != Postgres total ${pg.total}`);

  // INV-8, instant-wise: Postgres commits every outcome before Redis applies it.
  const orders = new Map(pg.orders.map((order) => [order.id, order]));
  for (const [rid, entry] of state.entries) {
    const order = orders.get(rid);
    if (order === undefined) {
      if (entry.s !== 'HELD') breach('INV-8', `Redis entry ${entry.s} has no order`, rid);
      continue;
    }
    if (
      entry.u !== order.userId ||
      entry.q !== order.qty ||
      entry.fp !== order.fp ||
      entry.k !== order.idempotencyKey
    ) {
      breach(
        'INV-8',
        `Redis entry {u, q, fp, k} differs from the order's user, qty, request hash or key`,
        rid,
      );
    }
    if (entry.s === 'COMMITTED' && order.status !== 'PAID') {
      breach('INV-8', `Redis COMMITTED, order ${order.status}`, rid);
    }
    if (entry.s === 'RELEASED' && (LIVE.has(order.status) || order.status === 'PAID')) {
      breach('INV-8', `Redis RELEASED, order ${order.status}`, rid);
    }
  }
  if (!idle) return;

  // INV-6 and INV-8 equality, once nothing is in flight. Idle rules out a HELD entry of a terminal order
  // (unsettled ones are pending or quarantined, settled ones orphan-scan work), so the states now match.
  for (const order of pg.orders) {
    if (!state.entries.has(order.id)) breach('INV-8', `order ${order.status} has no Redis entry`, order.id);
  }
  if (inv.avail !== available) breach('INV-6', `Redis avail ${inv.avail} != Postgres available ${available}`);
  if (inv.held !== pg.reserved) breach('INV-6', `Redis held ${inv.held} != Postgres reserved ${pg.reserved}`);
  if (inv.sold !== pg.sold) breach('INV-6', `Redis sold ${inv.sold} != Postgres sold ${pg.sold}`);
  const claimed = new Map(
    pg.quotas.filter((quota) => quota.claimed > 0).map((quota) => [quota.userId, quota.claimed]),
  );
  for (const userId of new Set([...claimed.keys(), ...state.quotas.keys()])) {
    const pgUnits = claimed.get(userId) ?? 0;
    const redisUnits = state.quotas.get(userId) ?? 0;
    if (pgUnits !== redisUnits) breach('INV-6', `Redis uq[${userId}] ${redisUnits} != claimed ${pgUnits}`);
  }
}

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface InvariantResult {
  readonly id: InvariantId;
  readonly title: string;
  readonly status: CheckStatus;
  readonly reason?: string;
  readonly violations: readonly Violation[];
}

/** One result per invariant, in §1.1 order. */
export function summarizeInvariants(violations: readonly Violation[]): InvariantResult[] {
  return INVARIANT_IDS.map((id) => {
    const reason = SKIPPED_INVARIANTS[id];
    if (reason !== undefined) return { id, title: INVARIANTS[id], status: 'skipped', reason, violations: [] };
    const own = violations.filter((violation) => violation.invariant === id);
    return { id, title: INVARIANTS[id], status: own.length === 0 ? 'pass' : 'fail', violations: own };
  });
}
