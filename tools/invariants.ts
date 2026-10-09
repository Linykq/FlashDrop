import {
  type DropStatus,
  LIVE_ORDER_STATUSES,
  type OrderStatus,
  type PaymentStatus,
  type PspChargeStatus,
  TERMINAL_ORDER_STATUSES,
  TERMINAL_UNPAID_ORDER_STATUSES,
} from '@flashdrop/domain';
import { type RedisDropState, redisDropViolations } from '@flashdrop/inventory';

/*
 * The invariants of design §1.1, checked on one sample of a drop: a REPEATABLE READ snapshot of its Postgres
 * rows (the PSP ledger included: `psp` is a schema of the same database, so orders, payments and charges are
 * one consistent snapshot) next to one MULTI read of its Redis keys, plus one sample of the event pipeline
 * (outbox and consumer lag). Pure functions, so every rule is unit-tested; reading the stores and waiting for
 * quiescence live in `invariant-samples.ts` and `event-samples.ts`.
 *
 * Which rule may be checked when:
 * - INV-1, INV-2 and INV-3 (Postgres), the instant half of INV-4 (Postgres with the ledger) and INV-9 (Redis)
 *   hold at every instant: each store changes its rows together with what counts them, and each side is
 *   read atomically. A PAID order and its SUCCEEDED payment commit together, after its charge succeeded.
 * - Redis against Postgres is compared only on a **stable sample** (§4.7): neither store changed between
 *   the first and the last read, so both sides describe the same instant. Even then in-flight work leaves
 *   Redis legitimately *lower* (a hold Postgres has not committed yet, an outcome Postgres committed and
 *   Redis has not applied yet), so INV-7 and the instant-wise half of INV-8 only reject the optimistic
 *   direction.
 * - Equality (INV-6, the rest of INV-8, "net captured is 0 unless PAID" of INV-4, and INV-5) needs the
 *   system to be **quiescent**: per drop, no due live order, no terminal order Redis has not applied, no
 *   hold without an order, a Redis state rebuilt at Postgres's generation, no captured charge of an unpaid
 *   order still to be refunded and recorded; globally, the outbox drained and every checked consumer group
 *   at the log end. Each of those is work some loop or consumer still has to do, so it counts as pending,
 *   not as a breach, until the wait for quiescence runs out; then it is a breach of the invariant it would
 *   break.
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

/** What INV-5 covers until the dashboard group exists. Shown with its result. */
export const INV5_SCOPE =
  'the outbox and the payment and inventory-settlement groups; sales-dashboard joins in M7';

/** `payments` row of an order (`order_id` is its primary key, so at most one). */
export interface PgPayment {
  readonly status: PaymentStatus;
  readonly pspChargeId: string | null;
  readonly amountCents: number;
}

/** A `psp.charges` row whose reference is the order id: the PSP's book, the evidence for INV-4. */
export interface LedgerCharge {
  readonly id: string;
  readonly status: PspChargeStatus;
  readonly amountCents: number;
}

export interface PgOrder {
  readonly id: string;
  readonly userId: string;
  readonly qty: number;
  readonly status: OrderStatus;
  /** `qty * unit_price_cents`: what a PAID order's charge must be. */
  readonly totalCents: number;
  /** `encode(request_hash, 'hex')`: the `fp` of its `rsv` entry. */
  readonly fp: string;
  readonly idempotencyKey: string;
  /** `expires_at < now()` at the snapshot. Meaningful for live orders only. */
  readonly due: boolean;
  /** `redis_settled_at IS NOT NULL`. */
  readonly settled: boolean;
  /** The sweeper loops that quarantined it (§4.6); empty when none did. */
  readonly quarantinedBy: readonly string[];
  readonly payment: PgPayment | null;
  /** Every PSP charge of its reference, oldest first. */
  readonly charges: readonly LedgerCharge[];
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

/** One partition of a consumer group, as the broker sees it. */
export interface PartitionLag {
  readonly partition: number;
  /** The group's committed offset; null when it never committed on this partition. */
  readonly committed: string | null;
  /** Records the group has yet to finish. */
  readonly lag: number;
}

export interface GroupLag {
  /** The worker role that runs the group (`payment`, `settlement`). */
  readonly name: string;
  readonly groupId: string;
  readonly partitions: readonly PartitionLag[];
}

/** The event pipeline at one instant (§5.4, §6.3): what INV-5 is judged on. */
export interface EventsSample {
  readonly outbox: { readonly pending: number; readonly oldestSeconds: number | null };
  readonly groups: readonly GroupLag[];
  /** The log end of every partition of `orders.v1`: changes whenever the relay publishes anything. */
  readonly logEnd: readonly string[];
  /**
   * Records in `orders.v1.dlq`; null when not counted. Gated only on request (`checkDeadLetters`): the topic
   * keeps 30 days of every run, so only on a fresh broker does the count belong to one run.
   */
  readonly deadLetters: number | null;
}

export interface Violation {
  readonly invariant: InvariantId;
  /** Absent for a breach of the event pipeline, which no single drop owns. */
  readonly dropId?: string;
  readonly orderId?: string;
  readonly message: string;
}

const LIVE: ReadonlySet<OrderStatus> = new Set(LIVE_ORDER_STATUSES);
const TERMINAL: ReadonlySet<OrderStatus> = new Set(TERMINAL_ORDER_STATUSES);
const TERMINAL_UNPAID: ReadonlySet<OrderStatus> = new Set(TERMINAL_UNPAID_ORDER_STATUSES);

const sumQty = (orders: readonly PgOrder[], keep: (order: PgOrder) => boolean): number =>
  orders.reduce((units, order) => (keep(order) ? units + order.qty : units), 0);

/** Postgres's available stock: what Redis `avail` must equal when idle and never exceed (INV-6, INV-7). */
export const pgAvailable = (pg: PgDropSnapshot): number => pg.total - pg.sold - pg.reserved;

/** What the PSP holds for an order now: its succeeded charges that were not refunded. */
export const netCaptured = (order: PgOrder): number =>
  order.charges.reduce(
    (cents, charge) => (charge.status === 'succeeded' ? cents + charge.amountCents : cents),
    0,
  );

/** The Redis state when it can be compared with Postgres at all; null while it is missing or rebuilding. */
function comparableRedis(sample: DropSample): RedisDropState | null {
  if (!sample.pg.tracked || sample.redis.kind !== 'ok') return null;
  const { inv } = sample.redis.state;
  if (inv === null || inv.status === 'RECONCILING' || inv.gen !== sample.pg.redisGen) return null;
  return sample.redis.state;
}

/**
 * What the system is still waiting for, by the loop or consumer that will do it (§4.6, §4.7, §5.4, §6.5),
 * and the invariant that work would be breaking if it never came.
 */
export const PENDING_KINDS = {
  expiry: { check: 'No live order past expires_at', invariant: 'INV-6' },
  settlement: { check: 'Every terminal order applied to Redis', invariant: 'INV-6' },
  rebuild: { check: 'Redis rebuilt at the Postgres generation', invariant: 'INV-6' },
  'orphan-scan': { check: 'No Redis hold waiting for the orphan scan', invariant: 'INV-6' },
  payments: { check: 'No unpaid order holding money, every refund recorded', invariant: 'INV-4' },
  outbox: { check: 'Outbox drained, nothing published while sampled', invariant: 'INV-5' },
  consumers: { check: 'Consumer groups caught up (lag 0)', invariant: 'INV-5' },
  sampling: { check: 'Neither store changed while sampled', invariant: 'INV-6' },
} as const satisfies Record<string, { readonly check: string; readonly invariant: InvariantId }>;
export type PendingKind = keyof typeof PENDING_KINDS;

/** The pending kinds only the event pipeline produces; skipped when it is not checked. */
export const EVENT_PENDING_KINDS: readonly PendingKind[] = ['outbox', 'consumers'];

export interface PendingWork {
  readonly kind: PendingKind;
  readonly message: string;
}

/**
 * Work that some loop or consumer still owes this drop; empty when the drop is idle. Quarantined orders are
 * left out: no loop will touch them again, so waiting cannot help, and `checkDrop` reports them.
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
  owePayments(open, owe);

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
 * The money still in flight (§6.5). A PENDING_PAYMENT order can hold its charge for the moment between the
 * PSP's answer and the PAID CAS; an order that ended unpaid holds a charge that raced its end until the
 * payment consumer closes its reference (refund plus fence), and then until it records the REFUNDED row.
 */
function owePayments(orders: readonly PgOrder[], owe: (kind: PendingKind, message: string) => void): void {
  let charging = 0;
  let unrefunded = 0;
  let unrecorded = 0;
  for (const order of orders) {
    if (order.status === 'PAID' || netCaptured(order) === 0) {
      if (TERMINAL_UNPAID.has(order.status) && unrecordedRefund(order) !== undefined) unrecorded += 1;
      continue;
    }
    if (order.status === 'PENDING_PAYMENT') charging += 1;
    else if (TERMINAL_UNPAID.has(order.status)) unrefunded += 1;
  }
  if (charging > 0) owe('payments', `${charging} PENDING_PAYMENT orders hold a captured charge`);
  if (unrefunded > 0) owe('payments', `${unrefunded} orders that ended unpaid hold a captured charge`);
  if (unrecorded > 0) owe('payments', `${unrecorded} refunds not yet recorded as REFUNDED payments`);
}

/** A refunded charge of the order that its `payments` row does not record; undefined when none. */
function unrecordedRefund(order: PgOrder): LedgerCharge | undefined {
  return order.charges.find(
    (charge) =>
      charge.status === 'refunded' &&
      !(order.payment?.status === 'REFUNDED' && order.payment.pspChargeId === charge.id),
  );
}

/**
 * Every invariant breach in one drop's sample. `pending` is `pendingWork(sample)`: when it is not empty the
 * wait for quiescence has run out, each item becomes a breach of the invariant its kind protects, and the
 * equality checks are skipped.
 */
export function checkDrop(
  sample: DropSample,
  pending: readonly PendingWork[] = pendingWork(sample),
): Violation[] {
  const { dropId, pg } = sample;
  const violations: Violation[] = [];
  const breach: Breach = (invariant, message, orderId) => {
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

  // INV-4: no double charge, the half that holds at every instant.
  for (const order of pg.orders) checkMoney(order, breach);

  // INV-6, Postgres side: work no loop will ever finish.
  for (const order of pg.orders) {
    if (order.quarantinedBy.length > 0) {
      breach('INV-6', `order ${order.status}, quarantined by ${order.quarantinedBy.join(', ')}`, order.id);
    }
  }
  for (const item of pending) breach(PENDING_KINDS[item.kind].invariant, `not quiescent: ${item.message}`);

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

/**
 * INV-4 on one order, against its own `payments` row and the PSP's charges of its reference, all from one
 * snapshot. Every rule here holds at every instant (§4.4, §6.5): the PSP serializes a reference and keys its
 * charge `charge:<orderId>`, so it never holds two; PAID commits with its SUCCEEDED row only after the charge
 * succeeded, and PAID is final, so close-by-reference never touches it; PAYMENT_FAILED commits with its
 * FAILED row; a REFUNDED row is recorded only after the close that refunded its charge committed. What only
 * holds once quiet (an unpaid order holding no money, every refund recorded) is pending work instead.
 */
function checkMoney(order: PgOrder, breach: Breach): void {
  const { id, status, payment, charges, totalCents } = order;
  const succeeded = charges.filter((charge) => charge.status === 'succeeded');
  if (succeeded.length > 1) {
    breach('INV-4', `${succeeded.length} succeeded charges for one reference`, id);
  }

  if (status === 'PAID') {
    const net = netCaptured(order);
    if (net !== totalCents) breach('INV-4', `PSP net captured ${net} for a PAID order of ${totalCents}`, id);
    if (payment?.status !== 'SUCCEEDED') {
      breach('INV-4', `PAID with a ${payment?.status ?? 'missing'} payment instead of SUCCEEDED`, id);
    } else {
      if (payment.amountCents !== totalCents) {
        breach('INV-4', `SUCCEEDED payment of ${payment.amountCents} for a total of ${totalCents}`, id);
      }
      if (!succeeded.some((charge) => charge.id === payment.pspChargeId)) {
        breach('INV-4', `SUCCEEDED payment names ${payment.pspChargeId}, not a succeeded PSP charge`, id);
      }
    }
    return;
  }

  if (payment?.status === 'SUCCEEDED') breach('INV-4', `SUCCEEDED payment on a ${status} order`, id);
  // The payment consumer refuses to charge an order that never reached checkout (§6.5).
  if ((status === 'RESERVED' || status === 'REJECTED') && charges.length > 0) {
    breach('INV-4', `${charges.length} PSP charges for a ${status} order`, id);
  }
  if ((status === 'PAYMENT_FAILED') !== (payment?.status === 'FAILED')) {
    breach('INV-4', `${status} order with a ${payment?.status ?? 'missing'} payment`, id);
  }
  if (payment?.status === 'REFUNDED') {
    if (!TERMINAL_UNPAID.has(status)) breach('INV-4', `REFUNDED payment on a ${status} order`, id);
    const refunded = charges.find((charge) => charge.id === payment.pspChargeId);
    if (refunded?.status !== 'refunded' || refunded.amountCents !== payment.amountCents) {
      breach(
        'INV-4',
        `REFUNDED payment of ${payment.amountCents} names ${payment.pspChargeId}, which the PSP did not refund for that amount`,
        id,
      );
    }
  }
}

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

/**
 * What the event pipeline still owes (§5.4, §6.4), from two samples taken before and after the drops were
 * sampled: empty only when the outbox was drained and every checked group sat at the log end both times, and
 * nothing was published in between. Without the second condition an event could have been written, relayed
 * and consumed while the drops were read, and the drop samples would straddle it.
 */
export function pendingEvents(before: EventsSample, after: EventsSample): PendingWork[] {
  const pending: PendingWork[] = [];
  const { outbox } = after;
  if (outbox.pending > 0) {
    const age = outbox.oldestSeconds === null ? '' : `, the oldest for ${outbox.oldestSeconds.toFixed(1)} s`;
    pending.push({ kind: 'outbox', message: `${outbox.pending} outbox rows not yet published${age}` });
  } else if (before.outbox.pending > 0 || before.logEnd.join() !== after.logEnd.join()) {
    pending.push({ kind: 'outbox', message: 'events were published while the drops were sampled' });
  }
  for (const group of after.groups) {
    const behind = group.partitions.filter((partition) => partition.lag > 0);
    if (behind.length === 0) continue;
    const lag = behind.reduce((sum, partition) => sum + partition.lag, 0);
    const neverCommitted = behind.some((partition) => partition.committed === null);
    pending.push({
      kind: 'consumers',
      message:
        `${group.name} (group ${group.groupId}): ${lag} events not yet processed on partitions ` +
        `${behind.map((partition) => partition.partition).join(', ')}` +
        (neverCommitted ? `; no commits there yet: is the ${group.name} role running?` : ''),
    });
  }
  return pending;
}

/** INV-5 breaches once the wait has run out: the event pipeline's pending work. */
export function checkEvents(pending: readonly PendingWork[]): Violation[] {
  return pending.map((item) => ({
    invariant: PENDING_KINDS[item.kind].invariant,
    message: `not quiescent: ${item.message}`,
  }));
}

/**
 * INV-5 on the dead-letter topic, when a ceiling is given (`--max-dead-letters`, §6.4): a dead letter is an
 * event its consumer gave up on, which lag 0 does not show (the runner commits past it). For settlement the
 * safety net still returns the stock 10 to 15 s later, so without this a handler that fails every event
 * would pass every stock check. Only meaningful where the topic holds one run's letters: a fresh broker.
 */
export function checkDeadLetters(deadLetters: number | null, max: number | undefined): Violation[] {
  if (max === undefined) return [];
  if (deadLetters === null) {
    return [{ invariant: 'INV-5', message: `dead letters not counted, but at most ${max} are allowed` }];
  }
  if (deadLetters <= max) return [];
  const letters = deadLetters === 1 ? '1 dead letter' : `${deadLetters} dead letters`;
  return [{ invariant: 'INV-5', message: `${letters} in the DLQ topic, at most ${max} allowed` }];
}

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface InvariantResult {
  readonly id: InvariantId;
  readonly title: string;
  readonly status: CheckStatus;
  /** Why it was skipped, or what a passing check covers. */
  readonly reason?: string;
  readonly violations: readonly Violation[];
}

/**
 * One result per invariant, in §1.1 order. INV-5 is skipped when the event pipeline was not sampled (no
 * Kafka connection given), never reported as passed.
 */
export function summarizeInvariants(
  violations: readonly Violation[],
  options: { readonly eventsChecked: boolean },
): InvariantResult[] {
  return INVARIANT_IDS.map((id) => {
    const title = INVARIANTS[id];
    if (id === 'INV-5' && !options.eventsChecked) {
      return { id, title, status: 'skipped', reason: 'not checked: no Kafka connection', violations: [] };
    }
    const own = violations.filter((violation) => violation.invariant === id);
    const status = own.length === 0 ? 'pass' : 'fail';
    return id === 'INV-5'
      ? { id, title, status, reason: `covers ${INV5_SCOPE}`, violations: own }
      : { id, title, status, violations: own };
  });
}
