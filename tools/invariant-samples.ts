import { setTimeout as sleep } from 'node:timers/promises';
import type { SalesCounters } from '@flashdrop/contracts';
import { type DashboardCheck, listTrackedDrops, readDashboardCheck } from '@flashdrop/db';
import {
  type CheckStatus,
  checkDashboard,
  checkDeadLetters,
  checkDrop,
  checkEvents,
  type DropSample,
  type DropSampleDeps,
  EVENT_PENDING_KINDS,
  type EventsSample,
  type InvariantResult,
  netCaptured,
  PENDING_KINDS,
  type PendingKind,
  type PendingWork,
  type PgDropSnapshot,
  pendingEvents,
  pendingWork,
  pgAvailable,
  sampleDrop,
  summarizeInvariants,
  unchangedSince,
  type Violation,
} from '@flashdrop/inventory';
import type { EventsProbe } from './event-samples';

/*
 * `verify:invariants` (design §13): stable samples of each drop (§4.7, read by @flashdrop/inventory's
 * `sampleDrop`, the same reads the api's admin health page runs) and samples of the event pipeline around
 * them, repeated until everything is quiescent or the wait runs out, then the report. Read-only everywhere:
 * the Redis client never loads the Functions library, every Postgres read runs in a READ ONLY transaction,
 * and Kafka is read through the admin API.
 */

export interface SampleDeps extends DropSampleDeps {
  /** Samples the outbox and the consumer groups; without it INV-5 is skipped. */
  readonly events?: EventsProbe;
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
  /**
   * The sales-dashboard projection's totals (§9), read once the round was quiet enough to compare them;
   * null when it was not. `skipped` says why the comparison could not be made.
   */
  readonly dashboard: {
    readonly totals: SalesCounters;
    /** Orders without events (seeded history), outside the comparison. */
    readonly eventless: number;
    readonly skipped?: string;
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
  /** Each drop's projection next to its orders; null unless the round looked quiet while it was read. */
  readonly dashboards: ReadonlyMap<string, DashboardCheck> | null;
}

/** The role whose group writes the sales dashboard projection (`EventsSample` groups are named by role). */
const DASHBOARD_ROLE = 'dashboard';

const quiet = (round: Round) =>
  round.drops.every((drop) => drop.pending.length === 0) && (round.events?.pending.length ?? 0) === 0;

/**
 * One round: the event pipeline, every drop, the dashboard projection of every drop, then the event
 * pipeline again. Only a round whose two event samples are both quiet may judge the drops: while events are
 * in flight a consumer may still change a drop that looked idle (a PAID CAS, a refund, a settlement, a
 * dashboard fold). A drop that was idle last round and has not changed since keeps its sample; every other
 * drop is read again. The projections, one outbox scan per drop, are read only once nothing else is pending.
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
  if (deps.events === undefined || before === undefined) return { drops, events: null, dashboards: null };
  // The projection can only be held to its orders when the group that writes it is among those caught up.
  const projected = before.groups.some((group) => group.name === DASHBOARD_ROLE);
  const calm = pendingEvents(before, before).length === 0 && drops.every((drop) => drop.pending.length === 0);
  const dashboards =
    projected && calm
      ? new Map(
          await Promise.all(dropIds.map(async (id) => [id, await readDashboardCheck(deps.db, id)] as const)),
        )
      : null;
  const after = await deps.events();
  return { drops, events: { sample: after, pending: pendingEvents(before, after) }, dashboards };
}

/** INV-5 on every drop's projection, with the comparisons that could not be made. */
function judgeDashboards(round: Round): { violations: Violation[]; skipped: Map<string, string> } {
  const violations: Violation[] = [];
  const skipped = new Map<string, string>();
  for (const [dropId, check] of round.dashboards ?? []) {
    const result = checkDashboard(dropId, check);
    violations.push(...result.violations);
    if (result.skipped !== undefined) skipped.set(dropId, result.skipped);
  }
  return { violations, skipped };
}

/**
 * Waits until the event pipeline and every drop are quiescent in the same round (or `timeoutMs` passes),
 * then checks the invariants on that round.
 */
export async function verifyInvariants(deps: SampleDeps, options: VerifyOptions): Promise<InvariantsReport> {
  const startedAt = new Date();
  const dropIds = options.dropIds ?? (await listTrackedDrops(deps.db)).map((drop) => drop.id);
  let round: Round = { drops: [], events: null, dashboards: null };
  let waitedMs: number;
  for (;;) {
    round = await sampleRound(deps, dropIds, new Map(round.drops.map((drop) => [drop.sample.dropId, drop])));
    waitedMs = Date.now() - startedAt.getTime();
    if (quiet(round) || waitedMs >= options.timeoutMs) break;
    await sleep(Math.min(options.pollMs ?? 500, options.timeoutMs - waitedMs));
  }

  // The projections are compared only on a quiet round: in flight, the dashboard trails its orders.
  const judged = quiet(round) ? round : { ...round, dashboards: null };
  const dashboards = judgeDashboards(judged);
  const violations = [
    ...round.drops.flatMap(({ sample, pending }) => checkDrop(sample, pending)),
    ...checkEvents(round.events?.pending ?? []),
    ...dashboards.violations,
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
    drops: round.drops.map(({ sample, pending }) => {
      const check = judged.dashboards?.get(sample.dropId);
      const skipped = dashboards.skipped.get(sample.dropId);
      return dropReport(
        sample,
        pending,
        check === undefined
          ? null
          : {
              totals: check.totals,
              eventless: check.eventless,
              ...(skipped === undefined ? {} : { skipped }),
            },
      );
    }),
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

function dropReport(
  sample: DropSample,
  pending: readonly PendingWork[],
  dashboard: DropReport['dashboard'],
): DropReport {
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
    dashboard,
  };
}
