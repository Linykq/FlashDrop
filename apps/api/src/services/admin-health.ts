import { CONSUMER_GROUPS, type Logger } from '@flashdrop/config';
import {
  type AdminHealthResponse,
  type ConsumerGroupLag,
  type DropHealth,
  type EventPipelineHealth,
  INVARIANT_IDS,
  type InvariantCheck,
  Uuid,
} from '@flashdrop/contracts';
import {
  type DashboardCheck,
  type Db,
  listTrackedDrops,
  outboxBacklog,
  parseRows,
  readDashboardChecks,
  sql,
  type TrackedDrop,
} from '@flashdrop/db';
import { BugError } from '@flashdrop/domain';
import {
  checkDashboard,
  checkDrop,
  type DropSample,
  type FlashdropRedis,
  INVARIANTS,
  isTransientRedisError,
  type PendingWork,
  pendingWork,
  redisDrift,
  sampleDrop,
  type Violation,
} from '@flashdrop/inventory';
import { z } from 'zod';
import type { KafkaProbe } from './kafka-probe';

/*
 * The live health checks (design §12, design system §10.11): the invariants of §1.1 checked with the same
 * reads and rules as `verify:invariants` (@flashdrop/inventory's `sampleDrop`, `checkDrop`,
 * `checkDashboard`), the event pipeline tiles and the sweeper quarantine.
 *
 * `verify:invariants` waits for quiescence and then counts unfinished work as a breach. A live page cannot
 * wait, so here work in flight is shown as pending and never as a breach; what holds at every instant
 * (INV-1 to INV-4, INV-9, and the optimistic direction of INV-7 on stable samples) is checked on every drop,
 * and the equality checks (INV-6, INV-8, and INV-5's dashboard totals) only on drops that are idle while the
 * whole event pipeline is quiet, before and after the drops are read, with nothing published in between (as
 * `verify:invariants` judges a round): an event in flight can still change a drop that looks idle, and the
 * dashboard trails its orders until the event is folded.
 *
 * Each drop's sample reads all its orders and its Redis keys, and the dashboards of the idle ones are read
 * together in one snapshot, so a check costs about one indexed read per tracked drop. It runs on the admin
 * pool (`wiring.ts`), never on the connections reserve and checkout use, and is shared: concurrent requests
 * (two admins, the page's poll) within `CACHE_MS` get the same one.
 */

export interface AdminHealthService {
  /** `GET /api/v1/admin/health`. */
  read(): Promise<AdminHealthResponse>;
  /** The event pipeline tiles. */
  events(): Promise<EventPipelineHealth>;
  /** One drop's Redis drift (see `DropHealth`); null when it cannot be compared or Redis did not answer. */
  drift(dropId: string): Promise<number | null>;
  /** Disconnects the Kafka clients. */
  close(): Promise<void>;
}

export interface AdminHealthDeps {
  /** The admin pool's: a check holds `SAMPLE_CONCURRENCY` connections while it samples. */
  readonly db: Db;
  readonly redis: FlashdropRedis;
  /** Absent when the process has no Kafka (tests): the pipeline tiles and INV-5 are then unchecked. */
  readonly kafka?: KafkaProbe;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** The groups the tiles show, by the role that runs them (§6.3). */
const GROUPS = [
  { name: 'payment', groupId: CONSUMER_GROUPS.payment },
  { name: 'settlement', groupId: CONSUMER_GROUPS.settlement },
  { name: 'dashboard', groupId: CONSUMER_GROUPS.dashboard },
] as const;

/**
 * How long one check serves every caller: at least the page's poll interval, so a page left open costs one
 * check per interval per api instance, however many admins watch it (design system §10.11).
 */
export const HEALTH_CACHE_MS = 10_000;
/** Drops sampled at once: each holds a Postgres connection of the admin pool for its snapshot. */
export const SAMPLE_CONCURRENCY = 2;
/** Breaches listed per invariant; the rest are counted. */
const LISTED_VIOLATIONS = 10;

/** The event pipeline at one instant, and the log end that tells whether anything was published since. */
interface PipelineSample {
  readonly health: EventPipelineHealth;
  /** The high watermarks of orders.v1; null when Kafka did not answer. */
  readonly logEnd: string | null;
}

const quietPipeline = ({ health }: PipelineSample) =>
  health.consumers !== null &&
  health.outbox.pending === 0 &&
  health.consumers.every((group) => group.lag === 0);

interface SampledDrop {
  readonly drop: TrackedDrop;
  /** Null when Redis did not answer. */
  readonly sample: DropSample | null;
  readonly pending: readonly PendingWork[];
}

interface ReadDrop extends SampledDrop {
  /** Its projection next to its orders, read where it may be compared. */
  readonly dashboard: DashboardCheck | null;
}

interface JudgedDrop extends ReadDrop {
  readonly idle: boolean;
  readonly violations: readonly Violation[];
  /** Its dashboard was compared with its orders. */
  readonly dashboardCompared: boolean;
}

/** One drop's breaches; the equality checks only when `settled`: the pipeline stayed quiet throughout. */
function judge(read: ReadDrop, settled: boolean): JudgedDrop {
  const { drop, sample, pending, dashboard } = read;
  if (sample === null) return { ...read, idle: false, violations: [], dashboardCompared: false };
  const idle = pending.length === 0 && settled;
  const violations = checkDrop(sample, pending, { pendingAreBreaches: false, idle });
  if (!idle || dashboard === null) return { ...read, idle, violations, dashboardCompared: false };
  const compared = checkDashboard(drop.id, dashboard);
  return {
    ...read,
    idle,
    violations: [...violations, ...compared.violations],
    dashboardCompared: compared.skipped === undefined,
  };
}

export function createAdminHealth(deps: AdminHealthDeps): AdminHealthService {
  const { db, redis, kafka, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function readPipeline(): Promise<PipelineSample> {
    const outbox = await outboxBacklog(db);
    const unread = { outbox, consumers: null, deadLetters: null, deadLettersRetained: null };
    if (kafka === undefined) return { health: unread, logEnd: null };
    try {
      const [lags, deadLetters] = await Promise.all([
        Promise.all(
          GROUPS.map(async (group) => ({ group, partitions: await kafka.groupLag(group.groupId) })),
        ),
        kafka.deadLetters(),
      ]);
      const consumers = lags.map(
        ({ group, partitions }): ConsumerGroupLag => ({
          ...group,
          lag: partitions.reduce((sum, partition) => sum + partition.lag, 0),
          partitions: partitions.map(({ partition, committed, lag }) => ({ partition, committed, lag })),
        }),
      );
      // Every group reads the same topic, so any group's partitions carry its log end.
      const logEnd = (lags[0]?.partitions ?? []).map((partition) => partition.end).join(',');
      return {
        health: {
          outbox,
          consumers,
          deadLetters: deadLetters.unreplayed,
          deadLettersRetained: deadLetters.retained,
        },
        logEnd,
      };
    } catch (err) {
      logger.warn({ err }, 'admin health: Kafka did not answer');
      return { health: unread, logEnd: null };
    }
  }

  async function sampleOne(drop: TrackedDrop): Promise<SampledDrop> {
    let sample: DropSample | undefined;
    try {
      sample = await sampleDrop({ db, redis }, drop.id);
    } catch (err) {
      if (!isTransientRedisError(err)) throw err;
      return { drop, sample: null, pending: [] };
    }
    // Drops are never deleted, and this one was just listed.
    if (sample === undefined) throw new BugError(`tracked drop ${drop.id} vanished`);
    return { drop, sample, pending: pendingWork(sample) };
  }

  /** The pipeline, every tracked drop, then the pipeline again: one round, as verify:invariants samples it. */
  async function compute(): Promise<AdminHealthResponse> {
    const checkedAt = now().toISOString();
    const before = await readPipeline();
    const { tracked, skipped } = await trackedToSample(db);
    const sampled = await mapLimited(tracked, SAMPLE_CONCURRENCY, sampleOne);
    // Dashboards only where the comparison can count: idle drops while the pipeline is quiet.
    const comparable = quietPipeline(before)
      ? sampled.filter((drop) => drop.sample !== null && drop.pending.length === 0)
      : [];
    const dashboards = await readDashboardChecks(
      db,
      comparable.map(({ drop }) => drop.id),
    );
    const read = sampled.map(
      (drop): ReadDrop => ({ ...drop, dashboard: dashboards.get(drop.drop.id) ?? null }),
    );
    const after = await readPipeline();
    const settled = quietPipeline(before) && quietPipeline(after) && before.logEnd === after.logEnd;
    const judged = read.map((drop) => judge(drop, settled));
    const quarantined = await countQuarantined(db);
    const events = after.health;
    const redisDown = judged.some((drop) => drop.sample === null);
    return {
      checkedAt,
      invariants: summarize(judged, events, skipped),
      events,
      quarantined,
      drops: judged.map(dropHealth),
      unavailable: [...(events.consumers === null ? ['kafka'] : []), ...(redisDown ? ['redis'] : [])],
    };
  }

  const cachedEvents = shared(async () => (await readPipeline()).health);
  const cachedHealth = shared(compute);

  return {
    read: cachedHealth,
    events: cachedEvents,
    async drift(dropId) {
      try {
        const sample = await sampleDrop({ db, redis }, dropId);
        return sample === undefined ? null : redisDrift(sample);
      } catch (err) {
        if (!isTransientRedisError(err)) throw err;
        return null;
      }
    },
    close: async () => kafka?.close(),
  };
}

/** One read per `HEALTH_CACHE_MS`, shared by every caller, the one in flight included; a failed one is not kept. */
function shared<T>(read: () => Promise<T>): () => Promise<T> {
  let last: { readonly at: number; readonly value: Promise<T> } | undefined;
  return () => {
    const at = Date.now();
    if (last !== undefined && at - last.at < HEALTH_CACHE_MS) return last.value;
    const value = read();
    const entry = { at, value };
    last = entry;
    value.catch(() => {
      if (last === entry) last = undefined;
    });
    return value;
  };
}

const QuarantineRow = z.object({ n: z.int() });
const IdRow = z.object({ id: Uuid });

/**
 * The tracked drops a check samples: all but the ENDED drops of test products (`POST /test/drops`). E2E and
 * load runs leave hundreds of those in the 24 h tracked window, each one a sample per check; a live page
 * gains nothing from re-reading them, and `verify:invariants` still checks every one. Returns how many it
 * left out, for the details.
 */
async function trackedToSample(db: Db): Promise<{ tracked: TrackedDrop[]; skipped: number }> {
  const tracked = await listTrackedDrops(db);
  const ended = tracked.filter((drop) => drop.status === 'ENDED').map((drop) => drop.id);
  if (ended.length === 0) return { tracked, skipped: 0 };
  const { rows } = await db.execute(sql`
    SELECT d.id FROM drops d JOIN products p ON p.id = d.product_id
    WHERE d.id = ANY(${sql.param(ended)}::uuid[]) AND p.source = 'test'`);
  const tests = new Set(parseRows(IdRow, rows, 'trackedToSample').map((row) => row.id));
  return { tracked: tracked.filter((drop) => !tests.has(drop.id)), skipped: tests.size };
}

async function countQuarantined(db: Db): Promise<number> {
  const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM sweeper_quarantine`);
  return parseRows(QuarantineRow, rows, 'countQuarantined')[0]?.n ?? 0;
}

function dropHealth(judged: JudgedDrop): DropHealth {
  const { drop, sample, pending, idle } = judged;
  const inv = sample?.redis.kind === 'ok' ? sample.redis.state.inv : null;
  return {
    dropId: drop.id,
    status: drop.status,
    idle,
    pending: sample === null ? ['Redis did not answer'] : pending.map((item) => item.message),
    redisDriftUnits: sample === null ? null : redisDrift(sample),
    rebuildingSince:
      inv?.status === 'RECONCILING' && inv.reconcilingSince !== undefined
        ? new Date(inv.reconcilingSince).toISOString()
        : null,
  };
}

/** One row per invariant: breached when anything checked breaks it, unchecked when nothing could be. */
function summarize(
  judged: readonly JudgedDrop[],
  events: EventPipelineHealth,
  skipped: number,
): InvariantCheck[] {
  const sampled = judged.filter((drop) => drop.sample !== null);
  const unread = judged.length - sampled.length;
  const stable = sampled.filter((drop) => drop.sample?.stable === true).length;
  const idle = sampled.filter((drop) => drop.idle).length;
  const compared = sampled.filter((drop) => drop.dashboardCompared).length;
  const violations = sampled.flatMap((drop) => drop.violations);
  const drops = (n: number) => (n === 1 ? '1 drop' : `${n} drops`);
  const unreadNote =
    (unread === 0 ? '' : `; Redis did not answer for ${drops(unread)}`) +
    (skipped === 0 ? '' : `; ${skipped} ended test ${skipped === 1 ? 'drop' : 'drops'} not sampled`);

  const detailOf = (id: (typeof INVARIANT_IDS)[number]): string => {
    switch (id) {
      case 'INV-1':
        return `reserved + sold <= total on ${drops(sampled.length)}${unreadNote}`;
      case 'INV-2':
        return `counters against orders on ${drops(sampled.length)}${unreadNote}`;
      case 'INV-3':
        return `per-user limits in both stores on ${drops(sampled.length)}${unreadNote}`;
      case 'INV-4':
        return `payments against the PSP ledger on ${drops(sampled.length)}${unreadNote}`;
      case 'INV-9':
        return `Redis conservation on ${drops(sampled.length)}${unreadNote}`;
      case 'INV-5':
        if (events.consumers === null) return 'Kafka did not answer';
        return `${events.outbox.pending} outbox rows unpublished, consumer lag ${events.consumers.reduce(
          (sum, group) => sum + group.lag,
          0,
        )}; ${drops(compared)} compared with the dashboard`;
      case 'INV-6':
      case 'INV-8':
        return `${drops(idle)} idle and compared, ${drops(sampled.length - idle)} in flight${unreadNote}`;
      case 'INV-7':
        return `${drops(stable)} on stable samples${unreadNote}`;
    }
  };

  return INVARIANT_IDS.map((id) => {
    const own = violations.filter((violation) => violation.invariant === id);
    const nothingChecked =
      id === 'INV-5' ? events.consumers === null : judged.length > 0 && sampled.length === 0;
    return {
      id,
      title: INVARIANTS[id],
      status: own.length > 0 ? 'breached' : nothingChecked ? 'unchecked' : 'holds',
      detail: detailOf(id),
      violations: own.slice(0, LISTED_VIOLATIONS).map(listed),
      moreViolations: Math.max(0, own.length - LISTED_VIOLATIONS),
    };
  });
}

/** A breach as the page lists it. A Redis entry's rid is an order id unless the entry is garbage, kept as text. */
function listed({ dropId, orderId, message }: Violation): InvariantCheck['violations'][number] {
  const order = orderId === undefined || Uuid.safeParse(orderId).success ? orderId : undefined;
  return {
    ...(dropId === undefined ? {} : { dropId }),
    ...(order === undefined ? {} : { orderId: order }),
    message: orderId !== undefined && order === undefined ? `${orderId}: ${message}` : message,
  };
}

/** Runs `work` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      // The index is below items.length, checked just above.
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
