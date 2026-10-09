import { CONSUMER_GROUPS } from '@flashdrop/config';
import type {
  DashboardTotalsMessage,
  OrderEvent,
  SalesCounter,
  SalesCounters,
  SalesMinute,
} from '@flashdrop/contracts';
import { BugError } from '@flashdrop/domain';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Executor } from './client';
import { insertProcessedEvents } from './processed-events';
import { OUTBOX_RETENTION_SECONDS } from './relay';
import { PgTimestamp, PgUuid, parseRows } from './rows';
import { dropSalesTotals, salesMinute } from './schema';
import { transaction } from './transaction';

/*
 * The sales dashboard projection (design §9): `sales_minute` and `drop_sales_totals`, folded from
 * `orders.v1` by the `sales-dashboard` group.
 *
 * Exactly-once effects: one transaction inserts the batch's event ids into `processed_events`, folds only the
 * ids that were new, and upserts the folded counters, so the dedupe record and the aggregate commit together
 * (and survive a Redis restart, which is why the projection lives here). A redelivered event (relay re-send,
 * rebalance, zombie consumer, DLQ replay, `dash:rebuild` replaying the whole log) finds its row and is
 * skipped. Counters are bucketed by event time (`occurredAt`), never by processing time, so a replay lands
 * every event in the minute it happened and the projection is a pure function of the set of events: wiping
 * it and replaying the log gives identical totals and series.
 *
 * Lock order: `processed_events` (ids sorted), then `sales_minute` rows sorted by (drop, minute), then
 * `drop_sales_totals` rows sorted by drop. Two transactions folding overlapping batches (a zombie and its
 * replacement during a rebalance) take their locks in the same order and cannot deadlock. Products key the
 * partitions, so outside a rebalance one consumer writes each drop's hot totals row.
 *
 * Seeded history goes through the outbox like any sale (`seed/plan.ts`), so it is projected too. INV-5 reads
 * the Postgres truth over the orders whose events the outbox holds (`readDashboardChecks`), which leaves out
 * orders older than the outbox's retention.
 */

/** `processed_events.consumer` of the projection: the group's id. */
export const DASHBOARD_CONSUMER = CONSUMER_GROUPS.dashboard;

const zero = (): SalesCounters => ({
  reserved: 0,
  placed: 0,
  paid: 0,
  failed: 0,
  expired: 0,
  cancelled: 0,
  rejected: 0,
  unitsSold: 0,
  revenueCents: 0,
});

const MINUTE_MS = 60_000;

/** The event's minute, by event time: what makes a replay land where the first delivery did. */
export function minuteOf(occurredAt: string): string {
  const ms = Date.parse(occurredAt);
  if (Number.isNaN(ms)) throw new BugError(`not an instant: ${occurredAt}`);
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** What one event adds: one order to its stage, and for a payment its units and revenue. */
function count(counters: SalesCounters, event: OrderEvent): void {
  switch (event.type) {
    case 'order.reserved':
      counters.reserved += 1;
      return;
    case 'order.placed':
      counters.placed += 1;
      return;
    case 'order.paid':
      counters.paid += 1;
      counters.unitsSold += event.data.qty;
      counters.revenueCents += event.data.totalCents;
      return;
    case 'order.payment_failed':
      counters.failed += 1;
      return;
    case 'order.expired':
      counters.expired += 1;
      return;
    case 'order.cancelled':
      counters.cancelled += 1;
      return;
    case 'order.rejected':
      counters.rejected += 1;
      return;
  }
}

/** One drop's share of a batch: the counters to add to its totals and to each minute. */
export interface DropSalesDelta {
  readonly dropId: string;
  readonly totals: SalesCounters;
  /** The newest `occurredAt` folded in. */
  readonly lastEventAt: string;
  /** Minute (ISO 8601, UTC) to the counters to add to it. */
  readonly minutes: ReadonlyMap<string, SalesCounters>;
}

/**
 * Folds events into per-drop deltas, bucketed by event-time minute. Pure, and commutative: the order of the
 * events does not matter, only the set. The caller passes each event once (`projectSalesEvents` folds only
 * the ids `processed_events` had not seen).
 */
export function foldSalesEvents(events: readonly OrderEvent[]): Map<string, DropSalesDelta> {
  const drops = new Map<
    string,
    { totals: SalesCounters; lastMs: number; minutes: Map<string, SalesCounters> }
  >();
  for (const event of events) {
    // Lowercase, as Postgres prints a uuid: one row per drop, however a producer spelled it.
    const dropId = event.dropId.toLowerCase();
    let drop = drops.get(dropId);
    if (drop === undefined) {
      drop = { totals: zero(), lastMs: Number.NEGATIVE_INFINITY, minutes: new Map() };
      drops.set(dropId, drop);
    }
    const minute = minuteOf(event.occurredAt);
    let bucket = drop.minutes.get(minute);
    if (bucket === undefined) {
      bucket = zero();
      drop.minutes.set(minute, bucket);
    }
    count(drop.totals, event);
    count(bucket, event);
    drop.lastMs = Math.max(drop.lastMs, Date.parse(event.occurredAt));
  }
  return new Map(
    [...drops].map(([dropId, drop]) => [
      dropId,
      {
        dropId,
        totals: drop.totals,
        lastEventAt: new Date(drop.lastMs).toISOString(),
        minutes: drop.minutes,
      },
    ]),
  );
}

/** What one projection transaction did. */
export interface ProjectedSales {
  /** Events folded in: new to `processed_events`. */
  readonly applied: number;
  /** Events skipped as already processed, duplicates within the batch included. */
  readonly duplicates: number;
  /**
   * The committed totals of every drop the batch named, changed or not, to publish: a batch of duplicates
   * republishes the current totals, which heals a publish lost to a crash between commit and publish.
   */
  readonly totals: ReadonlyMap<string, DashboardTotalsMessage>;
}

/**
 * The projection transaction of §9: records the batch's event ids for `sales-dashboard`, folds only the new
 * ones and upserts their minutes and totals (`version + 1` on every totals row it changes). An event's
 * effect commits exactly when its dedupe record does.
 */
export async function projectSalesEvents(db: Db, events: readonly OrderEvent[]): Promise<ProjectedSales> {
  if (events.length === 0) return { applied: 0, duplicates: 0, totals: new Map() };
  return transaction(db, async (tx) => {
    const fresh = await insertProcessedEvents(
      tx,
      DASHBOARD_CONSUMER,
      events.map((event) => event.eventId),
    );
    // The returned ids are lowercase; a batch may also carry one event twice, which counts once.
    const taken = new Set<string>();
    const folded = events.filter((event) => {
      const id = event.eventId.toLowerCase();
      if (!fresh.has(id) || taken.has(id)) return false;
      taken.add(id);
      return true;
    });
    const deltas = [...foldSalesEvents(folded).values()].sort((a, b) => compare(a.dropId, b.dropId));
    if (deltas.length > 0) {
      await upsertMinutes(tx, deltas);
      await upsertTotals(tx, deltas);
    }
    const named = [...new Set(events.map((event) => event.dropId.toLowerCase()))];
    return {
      applied: folded.length,
      duplicates: events.length - folded.length,
      totals: await readTotalsOf(tx, named),
    };
  });
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One array per column, in the order the statements below unnest them. */
function columns(rows: readonly SalesCounters[]) {
  const of = (counter: SalesCounter) => sql.param(rows.map((row) => row[counter]));
  return {
    reserved: of('reserved'),
    placed: of('placed'),
    paid: of('paid'),
    failed: of('failed'),
    expired: of('expired'),
    cancelled: of('cancelled'),
    rejected: of('rejected'),
    unitsSold: of('unitsSold'),
    revenueCents: of('revenueCents'),
  };
}

async function upsertMinutes(tx: Executor, deltas: readonly DropSalesDelta[]): Promise<void> {
  const rows = deltas.flatMap((delta) =>
    [...delta.minutes]
      .sort(([a], [b]) => compare(a, b))
      .map(([minute, counters]) => ({ dropId: delta.dropId, minute, ...counters })),
  );
  const c = columns(rows);
  // ORDER BY: rows are locked in (drop, minute) order, the same in every transaction.
  await tx.execute(sql`
    INSERT INTO sales_minute AS m (drop_id, minute, reserved, placed, paid, failed, expired, cancelled,
                                   rejected, units_sold, revenue_cents)
    SELECT * FROM unnest(${sql.param(rows.map((row) => row.dropId))}::uuid[],
                         ${sql.param(rows.map((row) => row.minute))}::timestamptz[],
                         ${c.reserved}::int[], ${c.placed}::int[], ${c.paid}::int[], ${c.failed}::int[],
                         ${c.expired}::int[], ${c.cancelled}::int[], ${c.rejected}::int[],
                         ${c.unitsSold}::int[], ${c.revenueCents}::bigint[])
    ORDER BY 1, 2
    ON CONFLICT (drop_id, minute) DO UPDATE SET
      reserved = m.reserved + excluded.reserved,
      placed = m.placed + excluded.placed,
      paid = m.paid + excluded.paid,
      failed = m.failed + excluded.failed,
      expired = m.expired + excluded.expired,
      cancelled = m.cancelled + excluded.cancelled,
      rejected = m.rejected + excluded.rejected,
      units_sold = m.units_sold + excluded.units_sold,
      revenue_cents = m.revenue_cents + excluded.revenue_cents`);
}

async function upsertTotals(tx: Executor, deltas: readonly DropSalesDelta[]): Promise<void> {
  const c = columns(deltas.map((delta) => delta.totals));
  // version + 1 in the same upsert: the frame order of §9. GREATEST skips a NULL last_event_at.
  await tx.execute(sql`
    INSERT INTO drop_sales_totals AS t (drop_id, reserved, placed, paid, failed, expired, cancelled, rejected,
                                        units_sold, revenue_cents, last_event_at, version)
    SELECT *, 1 FROM unnest(${sql.param(deltas.map((delta) => delta.dropId))}::uuid[],
                            ${c.reserved}::int[], ${c.placed}::int[], ${c.paid}::int[], ${c.failed}::int[],
                            ${c.expired}::int[], ${c.cancelled}::int[], ${c.rejected}::int[],
                            ${c.unitsSold}::int[], ${c.revenueCents}::bigint[],
                            ${sql.param(deltas.map((delta) => delta.lastEventAt))}::timestamptz[])
    ORDER BY 1
    ON CONFLICT (drop_id) DO UPDATE SET
      reserved = t.reserved + excluded.reserved,
      placed = t.placed + excluded.placed,
      paid = t.paid + excluded.paid,
      failed = t.failed + excluded.failed,
      expired = t.expired + excluded.expired,
      cancelled = t.cancelled + excluded.cancelled,
      rejected = t.rejected + excluded.rejected,
      units_sold = t.units_sold + excluded.units_sold,
      revenue_cents = t.revenue_cents + excluded.revenue_cents,
      last_event_at = GREATEST(t.last_event_at, excluded.last_event_at),
      version = t.version + 1`);
}

/** bigint and numeric arrive as strings through `db.execute()` (design delta 10). */
const PgCount = z.union([z.int(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.int().nonnegative());

const CounterColumns = {
  reserved: PgCount,
  placed: PgCount,
  paid: PgCount,
  failed: PgCount,
  expired: PgCount,
  cancelled: PgCount,
  rejected: PgCount,
  units_sold: PgCount,
  revenue_cents: PgCount,
};
type CounterRow = { readonly [K in keyof typeof CounterColumns]: number };

/** The counters of a query-builder row (or of totals), without the rest it carries. */
const pickCounters = (row: SalesCounters): SalesCounters => ({
  reserved: row.reserved,
  placed: row.placed,
  paid: row.paid,
  failed: row.failed,
  expired: row.expired,
  cancelled: row.cancelled,
  rejected: row.rejected,
  unitsSold: row.unitsSold,
  revenueCents: row.revenueCents,
});

/** The counters of a hand-written statement's row (snake_case columns). */
const counters = (row: CounterRow): SalesCounters => ({
  reserved: row.reserved,
  placed: row.placed,
  paid: row.paid,
  failed: row.failed,
  expired: row.expired,
  cancelled: row.cancelled,
  rejected: row.rejected,
  unitsSold: row.units_sold,
  revenueCents: row.revenue_cents,
});

const TotalsRow = z.object({
  drop_id: PgUuid,
  ...CounterColumns,
  last_event_at: PgTimestamp.nullable(),
  version: PgCount,
});

function totalsMessage(row: z.output<typeof TotalsRow>): DashboardTotalsMessage {
  return {
    version: row.version,
    totals: { ...counters(row), lastEventAt: row.last_event_at?.toISOString() ?? null },
  };
}

async function readTotalsOf(
  tx: Executor,
  dropIds: readonly string[],
): Promise<Map<string, DashboardTotalsMessage>> {
  const { rows } = await tx.execute(sql`
    SELECT * FROM drop_sales_totals WHERE drop_id = ANY(${sql.param(dropIds)}::uuid[])`);
  return new Map(parseRows(TotalsRow, rows, 'readTotalsOf').map((row) => [row.drop_id, totalsMessage(row)]));
}

/** The totals of a drop the projection has not seen: what a dashboard starts from. */
export const EMPTY_TOTALS: DashboardTotalsMessage = { version: 0, totals: { ...zero(), lastEventAt: null } };

/** A drop's totals as the projection holds them; `EMPTY_TOTALS` before its first event. */
export async function readSalesTotals(db: Executor, dropId: string): Promise<DashboardTotalsMessage> {
  const [row] = await db.select().from(dropSalesTotals).where(eq(dropSalesTotals.dropId, dropId));
  if (row === undefined) return EMPTY_TOTALS;
  return {
    version: row.version,
    totals: { ...pickCounters(row), lastEventAt: row.lastEventAt?.toISOString() ?? null },
  };
}

/** Every drop's totals, by drop id: what `dash:rebuild` compares the replay with. */
export async function readAllSalesTotals(db: Executor): Promise<Map<string, DashboardTotalsMessage>> {
  const { rows } = await db.execute(sql`SELECT * FROM drop_sales_totals`);
  return new Map(
    parseRows(TotalsRow, rows, 'readAllSalesTotals').map((row) => [row.drop_id, totalsMessage(row)]),
  );
}

/** Every minute of the drop with events, oldest first. */
export async function readSalesMinutes(db: Executor, dropId: string): Promise<SalesMinute[]> {
  const rows = await db
    .select()
    .from(salesMinute)
    .where(eq(salesMinute.dropId, dropId))
    .orderBy(asc(salesMinute.minute));
  return rows.map((row) => ({ ...pickCounters(row), minute: row.minute.toISOString() }));
}

/**
 * Zeroes the projection for `dash:rebuild` (§9), in one transaction: forgets every event the group
 * processed and empties `sales_minute`. `drop_sales_totals` rows are zeroed rather than deleted, with
 * `version + 1`: clients and the gateway accept only a strictly newer version, so a version that restarted at
 * 1 would freeze every dashboard left open through the rebuild. Returns the zeroed totals, to publish.
 * Run it only while no `sales-dashboard` consumer runs: one folding meanwhile would be left with offsets past
 * events whose effects were just erased.
 */
export async function resetSalesProjection(db: Db): Promise<Map<string, DashboardTotalsMessage>> {
  return transaction(db, async (tx) => {
    await tx.execute(sql`DELETE FROM processed_events WHERE consumer = ${DASHBOARD_CONSUMER}`);
    await tx.execute(sql`TRUNCATE sales_minute`);
    const { rows } = await tx.execute(sql`
      UPDATE drop_sales_totals
      SET reserved = 0, placed = 0, paid = 0, failed = 0, expired = 0, cancelled = 0, rejected = 0,
          units_sold = 0, revenue_cents = 0, last_event_at = NULL, version = version + 1
      RETURNING *`);
    return new Map(
      parseRows(TotalsRow, rows, 'resetSalesProjection').map((row) => [row.drop_id, totalsMessage(row)]),
    );
  });
}

/** One drop's projection next to the Postgres truth it must equal once idle (INV-5, §1.1). */
export interface DashboardCheck {
  /** `drop_sales_totals`, zeros before the first event. */
  readonly totals: SalesCounters;
  /** Σ of the drop's `sales_minute` rows: must equal `totals`, or the projection disagrees with itself. */
  readonly minutes: SalesCounters;
  /**
   * The same counters derived from the drop's orders whose events the outbox holds: every order but a
   * REJECTED one was reserved; one with a checkout key was placed; the rest by status.
   */
  readonly truth: SalesCounters;
  /** Orders without an outbox row: seeded history (written without events), or rows past retention. */
  readonly eventless: number;
  /**
   * Of those, the ones older than the outbox's retention: the relay deleted their rows, so they cannot be
   * told from orders the pipeline never carried, and the comparison cannot be made.
   */
  readonly eventlessPastRetention: number;
}

const CheckRow = z.object({
  drop_id: PgUuid,
  ...CounterColumns,
  eventless: PgCount,
  eventless_past_retention: PgCount,
});
const MinuteSumRow = z.object({ drop_id: PgUuid, ...CounterColumns });

/**
 * Reads the projection and the truth of each drop in one READ ONLY REPEATABLE READ snapshot, with one
 * statement per table for all of them: the admin health check compares hundreds of drops every few seconds,
 * and a statement per drop scanned the outbox once each. A drop's events are found through its product
 * (`partition_key`, indexed); the outbox has no index on the order. Drops the projection has not seen, or
 * with no orders, come back with zeros.
 */
export async function readDashboardChecks(
  db: Db,
  dropIds: readonly string[],
): Promise<Map<string, DashboardCheck>> {
  const ids = [...new Set(dropIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return new Map();
  return transaction(
    db,
    async (tx) => {
      const wanted = sql`${sql.param(ids)}::uuid[]`;
      const projected = await readTotalsOf(tx, ids);
      const minuteRows = await tx.execute(sql`
        SELECT drop_id, coalesce(sum(reserved), 0) AS reserved, coalesce(sum(placed), 0) AS placed,
               coalesce(sum(paid), 0) AS paid, coalesce(sum(failed), 0) AS failed,
               coalesce(sum(expired), 0) AS expired, coalesce(sum(cancelled), 0) AS cancelled,
               coalesce(sum(rejected), 0) AS rejected, coalesce(sum(units_sold), 0) AS units_sold,
               coalesce(sum(revenue_cents), 0) AS revenue_cents
        FROM sales_minute WHERE drop_id = ANY(${wanted}) GROUP BY drop_id`);
      const truthRows = await tx.execute(sql`
        WITH wanted AS (SELECT d.id, d.product_id::text AS product FROM drops d WHERE d.id = ANY(${wanted})),
        evented AS (
          SELECT DISTINCT (ob.payload->>'orderId')::uuid AS order_id
          FROM wanted w JOIN outbox ob ON ob.partition_key = w.product AND ob.payload->>'dropId' = w.id::text
        )
        SELECT
          o.drop_id,
          count(*) FILTER (WHERE e.order_id IS NOT NULL AND o.status <> 'REJECTED') AS reserved,
          count(*) FILTER (WHERE e.order_id IS NOT NULL AND o.checkout_key IS NOT NULL) AS placed,
          count(*) FILTER (WHERE e.order_id IS NOT NULL AND o.status = 'PAID') AS paid,
          count(*) FILTER (WHERE e.order_id IS NOT NULL AND o.status = 'PAYMENT_FAILED') AS failed,
          count(*) FILTER (WHERE e.order_id IS NOT NULL AND o.status = 'EXPIRED') AS expired,
          count(*) FILTER (WHERE e.order_id IS NOT NULL AND o.status = 'CANCELLED') AS cancelled,
          count(*) FILTER (WHERE e.order_id IS NOT NULL AND o.status = 'REJECTED') AS rejected,
          coalesce(sum(o.qty) FILTER (WHERE e.order_id IS NOT NULL AND o.status = 'PAID'), 0) AS units_sold,
          coalesce(sum(o.total_cents) FILTER (WHERE e.order_id IS NOT NULL AND o.status = 'PAID'), 0)
            AS revenue_cents,
          count(*) FILTER (WHERE e.order_id IS NULL) AS eventless,
          count(*) FILTER (WHERE e.order_id IS NULL
                             AND o.created_at < now() - make_interval(secs => ${OUTBOX_RETENTION_SECONDS}))
            AS eventless_past_retention
        FROM orders o LEFT JOIN evented e ON e.order_id = o.id
        WHERE o.drop_id = ANY(${wanted})
        GROUP BY o.drop_id`);
      const minutes = new Map(
        parseRows(MinuteSumRow, minuteRows.rows, 'readDashboardChecks minutes').map((row) => [
          row.drop_id,
          counters(row),
        ]),
      );
      const truths = new Map(
        parseRows(CheckRow, truthRows.rows, 'readDashboardChecks truth').map((row) => [row.drop_id, row]),
      );
      return new Map(
        ids.map((id): [string, DashboardCheck] => {
          const truth = truths.get(id);
          return [
            id,
            {
              totals: pickCounters((projected.get(id) ?? EMPTY_TOTALS).totals),
              minutes: minutes.get(id) ?? zero(),
              truth: truth === undefined ? zero() : counters(truth),
              eventless: truth?.eventless ?? 0,
              eventlessPastRetention: truth?.eventless_past_retention ?? 0,
            },
          ];
        }),
      );
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** One drop's `readDashboardChecks`. */
export async function readDashboardCheck(db: Db, dropId: string): Promise<DashboardCheck> {
  const check = (await readDashboardChecks(db, [dropId])).get(dropId.toLowerCase());
  if (check === undefined) throw new BugError('readDashboardChecks: a requested drop has no check');
  return check;
}
