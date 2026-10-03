import { setTimeout as sleep } from 'node:timers/promises';
import { type Db, listTrackedDrops, PgUuid, parseRows, sql, transaction } from '@flashdrop/db';
import { BugError, DROP_RETENTION_SECONDS, DROP_STATUSES, ORDER_STATUSES } from '@flashdrop/domain';
import { type FlashdropRedis, readDropState, readStock } from '@flashdrop/inventory';
import { z } from 'zod';
import {
  type CheckStatus,
  checkDrop,
  type DropSample,
  type InvariantResult,
  PENDING_KINDS,
  type PendingKind,
  type PendingWork,
  type PgDropSnapshot,
  pendingWork,
  pgAvailable,
  type RedisRead,
  summarizeInvariants,
} from './invariants';

/*
 * Reading the stores for `verify:invariants` (design §13): stable samples of each drop (§4.7), repeated
 * until the drop is idle or the wait runs out, then the report. Read-only on both stores: the Redis client
 * never loads the Functions library, and every Postgres read runs in a READ ONLY transaction.
 */

export interface SampleDeps {
  readonly db: Db;
  readonly redis: FlashdropRedis;
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
  fp: z.string(),
  idempotency_key: z.string(),
  due: z.boolean(),
  settled: z.boolean(),
  quarantined_by: z.array(z.string()),
});
const QuotaRow = z.object({ user_id: PgUuid, claimed: z.int(), limit_qty: z.int() });
const VersionRow = z.object({ version: z.string() });

/**
 * Everything that changes when the drop's inventory, orders, quotas or quarantine rows change, as one
 * opaque string. Quotas change only together with an order (same transaction), and `redis_settled_at`
 * changes the unsettled count, so comparing two of these tells whether Postgres moved in between.
 */
const VERSION = sql`concat_ws('|', d.status, i.updated_at, i.redis_gen, i.reserved, i.sold,
  (SELECT count(*) FROM orders o WHERE o.drop_id = d.id),
  (SELECT count(*) FROM orders o WHERE o.drop_id = d.id AND o.redis_settled_at IS NULL),
  (SELECT max(o.updated_at) FROM orders o WHERE o.drop_id = d.id),
  (SELECT count(*) FROM sweeper_quarantine q JOIN orders o ON o.id = q.order_id WHERE o.drop_id = d.id))`;

/** The drop's Postgres side in one REPEATABLE READ snapshot; undefined for an unknown drop. */
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
        SELECT o.id, o.user_id, o.qty, o.status, encode(o.request_hash, 'hex') AS fp, o.idempotency_key,
               o.expires_at < now() AS due, o.redis_settled_at IS NOT NULL AS settled,
               ARRAY(SELECT q.loop FROM sweeper_quarantine q WHERE q.order_id = o.id ORDER BY q.loop)
                 AS quarantined_by
        FROM orders o WHERE o.drop_id = ${dropId} ORDER BY o.id`);
      const quotaRows = await tx.execute(sql`
        SELECT user_id, claimed, limit_qty FROM user_drop_quota WHERE drop_id = ${dropId} ORDER BY user_id`);
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
          fp: order.fp,
          idempotencyKey: order.idempotency_key,
          due: order.due,
          settled: order.settled,
          quarantinedBy: order.quarantined_by,
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
async function readRedis(
  redis: FlashdropRedis,
  dropId: string,
): Promise<{ read: RedisRead; version: string }> {
  try {
    const state = await readDropState(redis, dropId);
    return {
      read: { kind: 'ok', state },
      version: state.inv === null ? 'none' : `${state.inv.gen}:${state.inv.seq}`,
    };
  } catch (error) {
    if (!isMalformed(error)) throw error;
    return { read: { kind: 'malformed', message: error.message }, version: 'malformed' };
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
  return { dropId, pg, redis: redis.read, stable: redis.version === redisAfter && pg.version === pgAfter };
}

export interface VerifyOptions {
  /** Check these drops instead of the tracked set. */
  readonly dropIds?: readonly string[];
  /** How long to wait for every drop to become idle before checking what is there. */
  readonly timeoutMs: number;
  readonly pollMs?: number;
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

export interface InvariantsReport {
  readonly version: 1;
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
  readonly drops: readonly DropReport[];
}

/** Quiescence conditions that need the relay and the consumers (§13), which arrive in M3. */
const DEFERRED_QUIESCENCE: readonly QuiescenceCheck[] = [
  {
    name: 'Outbox drained',
    status: 'skipped',
    detail: 'skipped until M3: no relay publishes the outbox yet',
  },
  {
    name: 'Consumer groups caught up (lag 0)',
    status: 'skipped',
    detail: 'skipped until M3: no consumers yet',
  },
];

/**
 * Waits until every drop is idle (or `timeoutMs` passes), then checks the invariants on each drop's last
 * sample. A drop that became idle is not sampled again: its idle sample is the instant it is judged at.
 */
export async function verifyInvariants(deps: SampleDeps, options: VerifyOptions): Promise<InvariantsReport> {
  const startedAt = new Date();
  const dropIds = options.dropIds ?? (await listTrackedDrops(deps.db)).map((drop) => drop.id);
  const samples = new Map<string, { sample: DropSample; pending: PendingWork[] }>();
  let waiting = [...dropIds];
  let waitedMs = 0;
  for (;;) {
    const stillWaiting: string[] = [];
    for (const dropId of waiting) {
      const sample = await sampleDrop(deps, dropId);
      if (sample === undefined) throw new Error(`drop ${dropId} does not exist`);
      const pending = pendingWork(sample);
      samples.set(dropId, { sample, pending });
      if (pending.length > 0) stillWaiting.push(dropId);
    }
    waiting = stillWaiting;
    waitedMs = Date.now() - startedAt.getTime();
    if (waiting.length === 0 || waitedMs >= options.timeoutMs) break;
    await sleep(Math.min(options.pollMs ?? 500, options.timeoutMs - waitedMs));
  }

  const judged = dropIds.flatMap((dropId) => {
    const entry = samples.get(dropId);
    return entry === undefined ? [] : [entry];
  });
  const violations = judged.flatMap(({ sample, pending }) => checkDrop(sample, pending));
  const invariants = summarizeInvariants(violations);
  const pendingKinds = new Set(judged.flatMap(({ pending }) => pending.map((item) => item.kind)));
  return {
    version: 1,
    ok: invariants.every((result) => result.status !== 'fail'),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    scope: { mode: options.dropIds === undefined ? 'tracked' : 'filter', dropIds },
    quiescence: {
      reached: waiting.length === 0,
      waitedMs,
      timeoutMs: options.timeoutMs,
      checks: [
        ...(Object.entries(PENDING_KINDS) as [PendingKind, string][]).map(
          ([kind, name]): QuiescenceCheck => ({ name, status: pendingKinds.has(kind) ? 'fail' : 'pass' }),
        ),
        ...DEFERRED_QUIESCENCE,
      ],
    },
    invariants,
    drops: judged.map(({ sample, pending }) => dropReport(sample, pending)),
  };
}

function dropReport(sample: DropSample, pending: readonly PendingWork[]): DropReport {
  const { pg } = sample;
  const orders: Record<string, number> = {};
  for (const order of pg.orders) orders[order.status] = (orders[order.status] ?? 0) + 1;
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
