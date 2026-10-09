import { setTimeout as sleep } from 'node:timers/promises';
import { type Db, listTrackedDrops, PgUuid, parseRows, sql, transaction } from '@flashdrop/db';
import {
  BugError,
  DROP_RETENTION_SECONDS,
  DROP_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  PSP_CHARGE_STATUSES,
} from '@flashdrop/domain';
import { type FlashdropRedis, readDropState, readStock } from '@flashdrop/inventory';
import { z } from 'zod';
import type { EventsProbe } from './event-samples';
import {
  type CheckStatus,
  checkDeadLetters,
  checkDrop,
  checkEvents,
  type DropSample,
  EVENT_PENDING_KINDS,
  type EventsSample,
  type InvariantResult,
  type LedgerCharge,
  netCaptured,
  PENDING_KINDS,
  type PendingKind,
  type PendingWork,
  type PgDropSnapshot,
  pendingEvents,
  pendingWork,
  pgAvailable,
  type RedisRead,
  summarizeInvariants,
} from './invariants';

/*
 * Reading the stores for `verify:invariants` (design §13): stable samples of each drop (§4.7) and samples of
 * the event pipeline around them, repeated until everything is quiescent or the wait runs out, then the
 * report. Read-only everywhere: the Redis client never loads the Functions library, every Postgres read runs
 * in a READ ONLY transaction, and Kafka is read through the admin API.
 */

export interface SampleDeps {
  readonly db: Db;
  readonly redis: FlashdropRedis;
  /** Samples the outbox and the consumer groups; without it INV-5 is skipped. */
  readonly events?: EventsProbe;
}

const DropRow = z.object({
  status: z.enum(DROP_STATUSES),
  per_user_limit: z.int(),
  tracked: z.boolean(),
  total: z.int(),
  reserved: z.int(),
  sold: z.int(),
  redis_gen: z.int(),
  version: z.string(),
});
const OrderRow = z.object({
  id: PgUuid,
  user_id: PgUuid,
  qty: z.int(),
  status: z.enum(ORDER_STATUSES),
  total_cents: z.int(),
  fp: z.string(),
  idempotency_key: z.string(),
  due: z.boolean(),
  settled: z.boolean(),
  quarantined_by: z.array(z.string()),
  payment_status: z.enum(PAYMENT_STATUSES).nullable(),
  psp_charge_id: z.string().nullable(),
  payment_amount_cents: z.int().nullable(),
});
const ChargeRow = z.object({
  reference: z.string(),
  id: z.string(),
  status: z.enum(PSP_CHARGE_STATUSES),
  amount_cents: z.int(),
});
const QuotaRow = z.object({ user_id: PgUuid, claimed: z.int(), limit_qty: z.int() });
const VersionRow = z.object({ version: z.string() });

/**
 * Everything that changes when the drop's inventory, orders, quotas or quarantine rows change, as one
 * opaque string. Quotas change only together with an order (same transaction), and `redis_settled_at`
 * changes the unsettled count, so comparing two of these tells whether Postgres moved in between. Payments
 * and PSP charges are left out: they are only compared with orders of the same snapshot.
 */
const VERSION = sql`concat_ws('|', d.status, i.updated_at, i.redis_gen, i.reserved, i.sold,
  (SELECT count(*) FROM orders o WHERE o.drop_id = d.id),
  (SELECT count(*) FROM orders o WHERE o.drop_id = d.id AND o.redis_settled_at IS NULL),
  (SELECT max(o.updated_at) FROM orders o WHERE o.drop_id = d.id),
  (SELECT count(*) FROM sweeper_quarantine q JOIN orders o ON o.id = q.order_id WHERE o.drop_id = d.id))`;

/** The drop's Postgres side, PSP ledger included, in one REPEATABLE READ snapshot; undefined if unknown. */
export async function readPgSnapshot(db: Db, dropId: string): Promise<PgDropSnapshot | undefined> {
  return transaction(
    db,
    async (tx) => {
      const dropRows = await tx.execute(sql`
        SELECT d.status, d.per_user_limit, i.total, i.reserved, i.sold, i.redis_gen,
               (d.status <> 'DRAFT'
                AND now() < d.ends_at + make_interval(secs => ${DROP_RETENTION_SECONDS})) AS tracked,
               ${VERSION} AS version
        FROM drops d JOIN drop_inventory i ON i.drop_id = d.id
        WHERE d.id = ${dropId}`);
      const [drop] = parseRows(DropRow, dropRows.rows, 'readPgSnapshot drop');
      if (drop === undefined) return undefined;
      const orderRows = await tx.execute(sql`
        SELECT o.id, o.user_id, o.qty, o.status, o.total_cents, encode(o.request_hash, 'hex') AS fp,
               o.idempotency_key, o.expires_at < now() AS due, o.redis_settled_at IS NOT NULL AS settled,
               ARRAY(SELECT q.loop FROM sweeper_quarantine q WHERE q.order_id = o.id ORDER BY q.loop)
                 AS quarantined_by,
               p.status AS payment_status, p.psp_charge_id, p.amount_cents AS payment_amount_cents
        FROM orders o LEFT JOIN payments p ON p.order_id = o.id
        WHERE o.drop_id = ${dropId} ORDER BY o.id`);
      // The PSP's reference is the order id (§6.5). psp.charges has no index on reference, so this is one
      // hash semi-join over the ledger per drop, not a lookup per order.
      const chargeRows = await tx.execute(sql`
        SELECT c.reference, c.id, c.status, c.amount_cents FROM psp.charges c
        WHERE c.reference IN (SELECT o.id::text FROM orders o WHERE o.drop_id = ${dropId})
        ORDER BY c.created_at, c.id`);
      const quotaRows = await tx.execute(sql`
        SELECT user_id, claimed, limit_qty FROM user_drop_quota WHERE drop_id = ${dropId} ORDER BY user_id`);

      const charges = new Map<string, LedgerCharge[]>();
      for (const row of parseRows(ChargeRow, chargeRows.rows, 'readPgSnapshot charges')) {
        const list = charges.get(row.reference) ?? [];
        list.push({ id: row.id, status: row.status, amountCents: row.amount_cents });
        charges.set(row.reference, list);
      }
      return {
        status: drop.status,
        perUserLimit: drop.per_user_limit,
        tracked: drop.tracked,
        total: drop.total,
        reserved: drop.reserved,
        sold: drop.sold,
        redisGen: drop.redis_gen,
        version: drop.version,
        orders: parseRows(OrderRow, orderRows.rows, 'readPgSnapshot orders').map((order) => ({
          id: order.id,
          userId: order.user_id,
          qty: order.qty,
          status: order.status,
          totalCents: order.total_cents,
          fp: order.fp,
          idempotencyKey: order.idempotency_key,
          due: order.due,
          settled: order.settled,
          quarantinedBy: order.quarantined_by,
          payment:
            order.payment_status === null || order.payment_amount_cents === null
              ? null
              : {
                  status: order.payment_status,
                  pspChargeId: order.psp_charge_id,
                  amountCents: order.payment_amount_cents,
                },
          charges: charges.get(order.id) ?? [],
        })),
        quotas: parseRows(QuotaRow, quotaRows.rows, 'readPgSnapshot quotas').map((quota) => ({
          userId: quota.user_id,
          claimed: quota.claimed,
          limit: quota.limit_qty,
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function readPgVersion(db: Db, dropId: string): Promise<string | undefined> {
  const { rows } = await db.execute(sql`
    SELECT ${VERSION} AS version FROM drops d JOIN drop_inventory i ON i.drop_id = d.id WHERE d.id = ${dropId}`);
  return parseRows(VersionRow, rows, 'readPgVersion')[0]?.version;
}

/** Garbage in the drop's keys is a finding, not a crash; a dead connection still throws. */
function isMalformed(error: unknown): error is Error {
  return error instanceof z.ZodError || error instanceof SyntaxError || error instanceof BugError;
}

/** Every Function bumps `seq` on every write, and a rebuild changes `gen`: together, Redis's version. */
function redisVersion(read: RedisRead): string {
  if (read.kind === 'malformed') return 'malformed';
  const { inv } = read.state;
  return inv === null ? 'none' : `${inv.gen}:${inv.seq}`;
}

async function readRedis(redis: FlashdropRedis, dropId: string): Promise<RedisRead> {
  try {
    return { kind: 'ok', state: await readDropState(redis, dropId) };
  } catch (error) {
    if (!isMalformed(error)) throw error;
    return { kind: 'malformed', message: error.message };
  }
}

async function readRedisVersion(redis: FlashdropRedis, dropId: string): Promise<string> {
  try {
    const stock = await readStock(redis, dropId);
    return stock === null ? 'none' : `${stock.gen}:${stock.seq}`;
  } catch (error) {
    if (!isMalformed(error)) throw error;
    return 'malformed';
  }
}

/**
 * One stable-sample attempt (§4.7): Redis, then Postgres, then each side's version again. It is stable when
 * neither moved, so both reads describe the same instant. Undefined for an unknown drop.
 */
export async function sampleDrop(deps: SampleDeps, dropId: string): Promise<DropSample | undefined> {
  const redis = await readRedis(deps.redis, dropId);
  const pg = await readPgSnapshot(deps.db, dropId);
  if (pg === undefined) return undefined;
  const redisAfter = await readRedisVersion(deps.redis, dropId);
  const pgAfter = await readPgVersion(deps.db, dropId);
  return { dropId, pg, redis, stable: redisVersion(redis) === redisAfter && pg.version === pgAfter };
}

/**
 * Whether neither store has changed the drop since `sample` was taken, by the same versions a stable sample
 * compares. Then the sample still describes the drop, and an idle one need not be read again. Payments and
 * PSP charges are outside the version, but only an order that is pending work (holding money, or a refund
 * not yet recorded) can see them change without its own row changing, and a pending drop is always re-read.
 */
async function unchangedSince(deps: SampleDeps, sample: DropSample): Promise<boolean> {
  return (
    (await readRedisVersion(deps.redis, sample.dropId)) === redisVersion(sample.redis) &&
    (await readPgVersion(deps.db, sample.dropId)) === sample.pg.version
  );
}

export interface VerifyOptions {
  /** Check these drops instead of the tracked set. */
  readonly dropIds?: readonly string[];
  /** How long to wait for quiescence before checking what is there. */
  readonly timeoutMs: number;
  readonly pollMs?: number;
  /** INV-5 fails when the DLQ topic holds more records than this (§6.4); unlimited when unset. */
  readonly maxDeadLetters?: number;
}

export interface QuiescenceCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

export interface DropReport {
  readonly dropId: string;
  readonly status: PgDropSnapshot['status'];
  readonly tracked: boolean;
  readonly idle: boolean;
  readonly stable: boolean;
  readonly pending: readonly PendingWork[];
  readonly postgres: {
    readonly total: number;
    readonly available: number;
    readonly reserved: number;
    readonly sold: number;
    readonly redisGen: number;
    readonly orders: Readonly<Record<string, number>>;
  };
  /** The PSP's book for the drop's orders. */
  readonly ledger: {
    readonly charges: Readonly<Record<string, number>>;
    /** Held now: succeeded charges that were not refunded. */
    readonly capturedCents: number;
    readonly refundedCents: number;
  };
  /** Null when Redis is not checked (an untracked drop) or holds nothing for it. */
  readonly redis: {
    readonly status: string;
    readonly gen: number;
    readonly seq: number;
    readonly total: number;
    readonly avail: number;
    readonly held: number;
    readonly sold: number;
  } | null;
}

export interface EventsReport {
  readonly outbox: EventsSample['outbox'];
  readonly groups: readonly {
    readonly name: string;
    readonly groupId: string;
    readonly lag: number;
    readonly partitions: number;
  }[];
  readonly deadLetters: number | null;
  /** The ceiling INV-5 held the dead letters to; null when they were only reported. */
  readonly maxDeadLetters: number | null;
}

export interface InvariantsReport {
  readonly version: 2;
  readonly ok: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly scope: { readonly mode: 'tracked' | 'filter'; readonly dropIds: readonly string[] };
  readonly quiescence: {
    readonly reached: boolean;
    readonly waitedMs: number;
    readonly timeoutMs: number;
    readonly checks: readonly QuiescenceCheck[];
  };
  readonly invariants: readonly InvariantResult[];
  /** Null when the event pipeline was not checked. */
  readonly events: EventsReport | null;
  readonly drops: readonly DropReport[];
}

interface JudgedDrop {
  readonly sample: DropSample;
  readonly pending: readonly PendingWork[];
}

interface Round {
  readonly drops: readonly JudgedDrop[];
  readonly events: { readonly sample: EventsSample; readonly pending: readonly PendingWork[] } | null;
}

const quiet = (round: Round) =>
  round.drops.every((drop) => drop.pending.length === 0) && (round.events?.pending.length ?? 0) === 0;

/**
 * One round: the event pipeline, every drop, then the event pipeline again. Only a round whose two event
 * samples are both quiet may judge the drops: while events are in flight a consumer may still change a drop
 * that looked idle (a PAID CAS, a refund, a settlement). A drop that was idle last round and has not changed
 * since keeps its sample; every other drop is read again.
 */
async function sampleRound(
  deps: SampleDeps,
  dropIds: readonly string[],
  previous: ReadonlyMap<string, JudgedDrop>,
): Promise<Round> {
  const before = deps.events === undefined ? undefined : await deps.events();
  const drops: JudgedDrop[] = [];
  for (const dropId of dropIds) {
    const last = previous.get(dropId);
    if (last !== undefined && last.pending.length === 0 && (await unchangedSince(deps, last.sample))) {
      drops.push(last);
      continue;
    }
    const sample = await sampleDrop(deps, dropId);
    if (sample === undefined) throw new Error(`drop ${dropId} does not exist`);
    drops.push({ sample, pending: pendingWork(sample) });
  }
  if (deps.events === undefined || before === undefined) return { drops, events: null };
  const after = await deps.events();
  return { drops, events: { sample: after, pending: pendingEvents(before, after) } };
}

/**
 * Waits until the event pipeline and every drop are quiescent in the same round (or `timeoutMs` passes),
 * then checks the invariants on that round.
 */
export async function verifyInvariants(deps: SampleDeps, options: VerifyOptions): Promise<InvariantsReport> {
  const startedAt = new Date();
  const dropIds = options.dropIds ?? (await listTrackedDrops(deps.db)).map((drop) => drop.id);
  let round: Round = { drops: [], events: null };
  let waitedMs: number;
  for (;;) {
    round = await sampleRound(deps, dropIds, new Map(round.drops.map((drop) => [drop.sample.dropId, drop])));
    waitedMs = Date.now() - startedAt.getTime();
    if (quiet(round) || waitedMs >= options.timeoutMs) break;
    await sleep(Math.min(options.pollMs ?? 500, options.timeoutMs - waitedMs));
  }

  const violations = [
    ...round.drops.flatMap(({ sample, pending }) => checkDrop(sample, pending)),
    ...checkEvents(round.events?.pending ?? []),
    ...(round.events === null
      ? []
      : checkDeadLetters(round.events.sample.deadLetters, options.maxDeadLetters)),
  ];
  const invariants = summarizeInvariants(violations, { eventsChecked: round.events !== null });
  const pendingKinds = new Set(
    [...round.drops.flatMap(({ pending }) => pending), ...(round.events?.pending ?? [])].map(
      (item) => item.kind,
    ),
  );
  return {
    version: 2,
    ok: invariants.every((result) => result.status !== 'fail'),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    scope: { mode: options.dropIds === undefined ? 'tracked' : 'filter', dropIds },
    quiescence: {
      reached: quiet(round),
      waitedMs,
      timeoutMs: options.timeoutMs,
      checks: (Object.entries(PENDING_KINDS) as [PendingKind, (typeof PENDING_KINDS)[PendingKind]][]).map(
        ([kind, { check }]): QuiescenceCheck =>
          round.events === null && EVENT_PENDING_KINDS.includes(kind)
            ? { name: check, status: 'skipped', detail: 'not checked: no Kafka connection' }
            : { name: check, status: pendingKinds.has(kind) ? 'fail' : 'pass' },
      ),
    },
    invariants,
    events: round.events === null ? null : eventsReport(round.events.sample, options.maxDeadLetters),
    drops: round.drops.map(({ sample, pending }) => dropReport(sample, pending)),
  };
}

function eventsReport(sample: EventsSample, maxDeadLetters: number | undefined): EventsReport {
  return {
    outbox: sample.outbox,
    groups: sample.groups.map((group) => ({
      name: group.name,
      groupId: group.groupId,
      lag: group.partitions.reduce((sum, partition) => sum + partition.lag, 0),
      partitions: group.partitions.length,
    })),
    deadLetters: sample.deadLetters,
    maxDeadLetters: maxDeadLetters ?? null,
  };
}

function dropReport(sample: DropSample, pending: readonly PendingWork[]): DropReport {
  const { pg } = sample;
  const orders: Record<string, number> = {};
  const charges: Record<string, number> = {};
  let capturedCents = 0;
  let refundedCents = 0;
  for (const order of pg.orders) {
    orders[order.status] = (orders[order.status] ?? 0) + 1;
    capturedCents += netCaptured(order);
    for (const charge of order.charges) {
      charges[charge.status] = (charges[charge.status] ?? 0) + 1;
      if (charge.status === 'refunded') refundedCents += charge.amountCents;
    }
  }
  const inv = pg.tracked && sample.redis.kind === 'ok' ? sample.redis.state.inv : null;
  return {
    dropId: sample.dropId,
    status: pg.status,
    tracked: pg.tracked,
    idle: pending.length === 0,
    stable: sample.stable,
    pending,
    postgres: {
      total: pg.total,
      available: pgAvailable(pg),
      reserved: pg.reserved,
      sold: pg.sold,
      redisGen: pg.redisGen,
      orders,
    },
    ledger: { charges, capturedCents, refundedCents },
    redis:
      inv === null
        ? null
        : {
            status: inv.status,
            gen: inv.gen,
            seq: inv.seq,
            total: inv.total,
            avail: inv.avail,
            held: inv.held,
            sold: inv.sold,
          },
  };
}
