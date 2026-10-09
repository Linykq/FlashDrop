import { INVARIANT_IDS, PUBLIC_DROP_STATUSES } from '@flashdrop/domain';
import { z } from 'zod';
import { DropStatus, DropStock } from './admin';
import { StockLevel } from './catalog';
import { Cents, Currency, IsoDateTime, Slug, Uuid } from './common';

/*
 * The live sales dashboard (design §9) and the operational health beside it (§12; design system §10.10,
 * §10.11). The `sales-dashboard` consumer projects every `orders.v1` event into per-minute buckets and
 * per-drop totals in Postgres, then publishes the drop's totals on `fd:ch:dash:<dropId>`; the WebSocket
 * gateway forwards them on the admin-only `dash:<dropId>` topic, coalesced like stock with `gen = 0` and
 * `seq = version` (§7).
 */

const count = z.int().nonnegative();

/**
 * What the projection counts, per drop and per minute: orders by the event that counted them, plus the units
 * and gross revenue of paid orders. Every event counts once (consumer dedupe), so these are funnel counts:
 * an order that was reserved, placed and paid counts in `reserved`, `placed` and `paid`.
 */
export const SalesCounters = z.object({
  /** `order.reserved`: orders that got a hold. */
  reserved: count,
  /** `order.placed`: checkouts submitted. */
  placed: count,
  /** `order.paid`. */
  paid: count,
  /** `order.payment_failed`. */
  failed: count,
  /** `order.expired`, from a hold or from checkout. */
  expired: count,
  /** `order.cancelled`, from a hold or from checkout. */
  cancelled: count,
  /** `order.rejected`: Postgres refused a hold Redis had admitted, or an orphaned hold was tombstoned. */
  rejected: count,
  /** Σ qty of `order.paid`. */
  unitsSold: count,
  /** Σ totalCents of `order.paid`, in the drop's currency. */
  revenueCents: count,
});
export type SalesCounters = z.infer<typeof SalesCounters>;
export type SalesCounter = keyof SalesCounters;
export const SALES_COUNTERS: readonly SalesCounter[] = SalesCounters.keyof().options;

/** A drop's totals: its counters and the event time of the newest event folded in. */
export const DashboardTotals = SalesCounters.extend({ lastEventAt: IsoDateTime.nullable() });
export type DashboardTotals = z.infer<typeof DashboardTotals>;

/**
 * The payload of `fd:ch:dash:<dropId>`, and the `dash:<dropId>` snapshot and delta data: totals, not deltas,
 * so a duplicate publish is harmless. `version` is `drop_sales_totals.version`, +1 in every projection
 * transaction that changes the drop (and in `dash:rebuild`'s reset, so it never goes back), so an older
 * publish arriving late (a zombie consumer after a rebalance) is recognised and ignored (`isNewerTotals`).
 */
export const DashboardTotalsMessage = z.object({
  version: count,
  totals: DashboardTotals,
});
export type DashboardTotalsMessage = z.infer<typeof DashboardTotalsMessage>;

/** Whether `incoming` should replace `current`: only a strictly newer version does (§9). */
export function isNewerTotals(
  current: Pick<DashboardTotalsMessage, 'version'> | null,
  incoming: Pick<DashboardTotalsMessage, 'version'>,
): boolean {
  return current === null || incoming.version > current.version;
}

/** One minute of a drop's sales, bucketed by event time (`occurredAt`), so a replay lands in the same minute. */
export const SalesMinute = SalesCounters.extend({ minute: IsoDateTime });
export type SalesMinute = z.infer<typeof SalesMinute>;

/** `outbox` rows the relay has not published yet (§5.4); alert above 10 s (§12). */
export const OutboxLag = z.object({
  pending: count,
  /** Age of the oldest unpublished row, by Postgres time; null when there is none. */
  oldestSeconds: z.number().nonnegative().nullable(),
});
export type OutboxLag = z.infer<typeof OutboxLag>;

/** How far one consumer group has committed on `orders.v1`, as the broker sees it. */
export const ConsumerGroupLag = z.object({
  /** The role that runs the group: payment, settlement or dashboard. */
  name: z.string().min(1),
  groupId: z.string().min(1),
  /** Records the group has yet to finish, over all partitions. */
  lag: count,
  partitions: z.array(
    z.object({
      partition: count,
      /** The committed offset; null when the group has committed nothing there. */
      committed: z.string().nullable(),
      lag: count,
    }),
  ),
});
export type ConsumerGroupLag = z.infer<typeof ConsumerGroupLag>;

/** The event pipeline at one instant: what the outbox, Kafka and the consumers still owe. */
export const EventPipelineHealth = z.object({
  outbox: OutboxLag,
  /** Null when Kafka did not answer. */
  consumers: z.array(ConsumerGroupLag).nullable(),
  /**
   * Dead letters `dlq:replay` has not handled yet: the records of `orders.v1.dlq` past the `dlq-replay`
   * group's committed offset. What an operator must act on; null when Kafka did not answer.
   */
  deadLetters: count.nullable(),
  /** Every record the DLQ topic still holds (30 days of them), replayed or not: context only. */
  deadLettersRetained: count.nullable(),
});
export type EventPipelineHealth = z.infer<typeof EventPipelineHealth>;

/** `GET /api/v1/admin/dashboard/drops/:dropId`. */
export const AdminDashboardParams = z.object({ dropId: Uuid });
export type AdminDashboardParams = z.infer<typeof AdminDashboardParams>;

/** The drop a dashboard is about. */
export const DashboardDrop = z.object({
  id: Uuid,
  status: DropStatus,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  /** When it became ENDED (an early end, or `endsAt` when the clock closed it); null until then. */
  endedAt: IsoDateTime.nullable(),
  priceCents: Cents,
  currency: Currency,
  /** `drop_inventory.total`: what sell-through is measured against. */
  total: DropStock,
  product: z.object({ id: Uuid, slug: Slug, title: z.string().min(1) }),
});
export type DashboardDrop = z.infer<typeof DashboardDrop>;

export const AdminDashboardResponse = z.object({
  drop: DashboardDrop,
  /** The projection's totals; the page then follows `dash:<dropId>` and applies only newer versions. */
  projection: DashboardTotalsMessage,
  /** Every minute with events, oldest first: units sold over time. Refetch it; frames carry totals only. */
  series: z.array(SalesMinute),
  /**
   * The minute in which the units sold reached the drop's total (time to sell-out, to the minute); null
   * while it has not sold out.
   */
  soldOutMinute: IsoDateTime.nullable(),
  /** Live Redis levels; null while the drop's Redis state is missing or being rebuilt. */
  stock: StockLevel.nullable(),
  /** Health tiles: the event pipeline, and this drop's Redis drift. */
  health: EventPipelineHealth.extend({
    /**
     * Redis `avail` minus Postgres available (`total - sold - reserved`) on a stable sample (§4.7): above 0
     * is optimistic (INV-7); below 0 while orders are in flight is normal, and once idle any non-zero value
     * is a leak (INV-6). Null when the two cannot be compared (no Redis state, a rebuild, an unstable sample).
     */
    redisDriftUnits: z.int().nullable(),
  }),
  serverNow: IsoDateTime,
});
export type AdminDashboardResponse = z.infer<typeof AdminDashboardResponse>;

export { INVARIANT_IDS };

/**
 * `holds`: no breach on anything checked. `breached`: at least one. `unchecked`: what it needs could not be
 * read this time (Kafka for INV-5, say).
 */
export const InvariantStatus = z.enum(['holds', 'breached', 'unchecked']);
export type InvariantStatus = z.infer<typeof InvariantStatus>;

export const InvariantCheck = z.object({
  id: z.enum(INVARIANT_IDS),
  title: z.string().min(1),
  status: InvariantStatus,
  /** What was checked, or why not: "12 drops", "3 drops not idle: equality waits". */
  detail: z.string(),
  /** The first breaches; `moreViolations` counts the rest. */
  violations: z.array(z.object({ dropId: Uuid.optional(), orderId: Uuid.optional(), message: z.string() })),
  moreViolations: count,
});
export type InvariantCheck = z.infer<typeof InvariantCheck>;

/** One tracked drop on the health page. */
export const DropHealth = z.object({
  dropId: Uuid,
  status: z.enum(PUBLIC_DROP_STATUSES),
  /** No work any loop or consumer still owes it (§13 quiescence), so equality checks ran. */
  idle: z.boolean(),
  /** What it is still waiting for, by the loop that will do it. */
  pending: z.array(z.string()),
  /** As in the dashboard's tile; null when not comparable. */
  redisDriftUnits: z.int().nullable(),
  /** When its Redis state entered RECONCILING; null when it is not being rebuilt. */
  rebuildingSince: IsoDateTime.nullable(),
});
export type DropHealth = z.infer<typeof DropHealth>;

/** `GET /api/v1/admin/health`: the live invariant checks and the tiles of design system §10.11. */
export const AdminHealthResponse = z.object({
  checkedAt: IsoDateTime,
  invariants: z.array(InvariantCheck),
  events: EventPipelineHealth,
  /** Rows of `sweeper_quarantine`: orders a sweeper loop gave up on (each one alerted). */
  quarantined: count,
  /** The tracked drops (armed, until 24 h after their end), in start order. */
  drops: z.array(DropHealth),
  /** Stores that did not answer this time; the checks that need them are `unchecked`. */
  unavailable: z.array(z.string()),
});
export type AdminHealthResponse = z.infer<typeof AdminHealthResponse>;
