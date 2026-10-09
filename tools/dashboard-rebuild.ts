import { KafkaJS } from '@confluentinc/kafka-javascript';
import { CONSUMER_GROUPS, TOPICS } from '@flashdrop/config';
import { type DashboardTotalsMessage, SALES_COUNTERS } from '@flashdrop/contracts';
import { type DashboardCheck, type Db, resetSalesProjection } from '@flashdrop/db';
import { checkDashboard } from '@flashdrop/inventory';
import { z } from 'zod';

/*
 * The steps of `pnpm dash:rebuild` (design §9) between stopping the sales-dashboard consumers and starting
 * them again, apart from the CLI so the integration test drives them on a throwaway group and database.
 *
 * Order matters. The group's offsets go first, and only if Kafka agrees the group has no member (it refuses
 * to delete a non-empty group): if the reset failed after that, the consumers would start from the earliest
 * offset against a projection whose dedupe records still exist, skip everything and leave it as it was,
 * and a second run completes the rebuild. The other order could leave a zeroed projection with consumers
 * resuming from their old offsets, which never refills it. A consumer that joins between the two steps would
 * commit offsets past events whose effects the reset then erases, so the group is checked again at the end.
 *
 * Before either, the topic must still hold its whole history: the replay can only restore what retention
 * kept, and the wipe is not undoable.
 */

/** A consumer of the group is up: the rebuild would race it. */
export class ConsumersRunningError extends Error {
  override name = 'ConsumersRunningError';
}

/** Retention deleted events of the topic: a wipe would lose totals the replay cannot restore. */
export class HistoryLostError extends Error {
  override name = 'HistoryLostError';
}

/** What the rebuild asks of Kafka's admin API (a connected `KafkaJS.Admin`). */
export type RebuildAdmin = Pick<KafkaJS.Admin, 'describeGroups' | 'deleteGroups' | 'fetchTopicOffsets'>;

export interface RebuildDeps {
  readonly db: Db;
  readonly admin: RebuildAdmin;
  /** Publishes a drop's zeroed totals, so open dashboards show the reset; must not throw. */
  readonly publish: (dropId: string, message: DashboardTotalsMessage) => Promise<void>;
  /** The design's `sales-dashboard` unless a test passes its own. */
  readonly groupId?: string;
  /** The design's `orders.v1` unless a test passes its own. */
  readonly topic?: string;
  /** Rebuild even though retention deleted part of the topic (`--accept-history-loss`). */
  readonly acceptHistoryLoss?: boolean;
}

const DeleteGroupsFailure = z.object({
  groups: z.array(z.object({ groupId: z.string(), errorCode: z.number().nullish() })),
});

async function assertNoMembers(admin: RebuildAdmin, groupId: string, when: string): Promise<void> {
  const { groups } = await admin.describeGroups([groupId]);
  const members = groups.find((group) => group.groupId === groupId)?.members.length ?? 0;
  if (members > 0) {
    throw new ConsumersRunningError(
      `${when}: group ${groupId} has ${members} member${members === 1 ? '' : 's'}. Stop the dashboard ` +
        'consumers first (docker compose --profile app stop dashboard-consumers, or pass --compose), then ' +
        'run again.',
    );
  }
}

/**
 * Refuses when a partition no longer starts at offset 0. Kafka deletes whole segments past retention (7 days,
 * §6.1), so a stack older than that has lost the events of its oldest drops: the wipe would zero their totals
 * for good, and INV-5 would then report every one of them.
 */
async function assertFullHistory(admin: RebuildAdmin, topic: string): Promise<void> {
  const truncated = (await admin.fetchTopicOffsets(topic)).filter(({ low }) => BigInt(low) > 0n);
  if (truncated.length === 0) return;
  const partitions = truncated
    .sort((a, b) => a.partition - b.partition)
    .map(({ partition, low }) => `${partition} (starts at offset ${low})`)
    .join(', ');
  throw new HistoryLostError(
    `retention has deleted the start of ${topic}, partitions ${partitions}: the replay cannot restore the ` +
      'totals those events made, and the wipe is permanent. Nothing was changed. Pass ' +
      '--accept-history-loss to rebuild from what is left.',
  );
}

/** Deletes the group's committed offsets; its consumers then start at the earliest offset (§6.4). */
async function deleteGroupOffsets(admin: RebuildAdmin, groupId: string): Promise<void> {
  try {
    await admin.deleteGroups([groupId]);
  } catch (error) {
    const failure = DeleteGroupsFailure.safeParse(error);
    const codes = failure.success ? failure.data.groups.map((group) => group.errorCode) : [];
    // A group that never committed, or whose offsets a previous run deleted: nothing to reset.
    if (codes.length > 0 && codes.every((code) => code === KafkaJS.ErrorCodes.ERR_GROUP_ID_NOT_FOUND)) return;
    if (codes.includes(KafkaJS.ErrorCodes.ERR_NON_EMPTY_GROUP)) {
      throw new ConsumersRunningError(`group ${groupId} is not empty: stop the dashboard consumers first`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Resets the group to the earliest offset and zeroes the projection; returns the zeroed totals by drop.
 * Throws `ConsumersRunningError` while a consumer of the group is up, and `HistoryLostError` when retention
 * cut the topic short (unless `acceptHistoryLoss`), both before changing anything.
 */
export async function rebuildDashboardProjection(
  deps: RebuildDeps,
): Promise<ReadonlyMap<string, DashboardTotalsMessage>> {
  const { db, admin, publish } = deps;
  const groupId = deps.groupId ?? CONSUMER_GROUPS.dashboard;
  await assertNoMembers(admin, groupId, 'before the rebuild');
  if (deps.acceptHistoryLoss !== true) await assertFullHistory(admin, deps.topic ?? TOPICS.orders);
  await deleteGroupOffsets(admin, groupId);
  const zeroed = await resetSalesProjection(db);
  for (const [dropId, message] of zeroed) await publish(dropId, message);
  await assertNoMembers(admin, groupId, 'a consumer joined during the rebuild; it is incomplete');
  return zeroed;
}

export interface TotalsDifference {
  readonly dropId: string;
  /** Each counter that changed, `paid 3 -> 2`. */
  readonly detail: string;
}

/** The drops whose replayed totals differ from the ones before the wipe, with what differs. */
export function totalsDifferences(
  before: ReadonlyMap<string, DashboardTotalsMessage>,
  after: ReadonlyMap<string, DashboardTotalsMessage>,
): TotalsDifference[] {
  const differences: TotalsDifference[] = [];
  for (const dropId of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(dropId)?.totals;
    const now = after.get(dropId)?.totals;
    const changed = SALES_COUNTERS.filter((counter) => (was?.[counter] ?? 0) !== (now?.[counter] ?? 0));
    if (changed.length > 0) {
      differences.push({
        dropId,
        detail: changed
          .map((counter) => `${counter} ${was?.[counter] ?? 0} -> ${now?.[counter] ?? 0}`)
          .join(', '),
      });
    }
  }
  return differences;
}

/**
 * The drop's orders its dashboard does not count. The projection counts every order exactly once, as
 * reserved or as rejected, so this needs no events: it also sees orders whose events orders.v1 lost, or
 * never carried, where INV-5 cannot compare (their outbox rows are past retention, or never existed).
 */
export function ordersMissing(check: DashboardCheck): number {
  const orders = check.truth.reserved + check.truth.rejected + check.eventless;
  return Math.max(0, orders - check.totals.reserved - check.totals.rejected);
}

export interface ReplayJudgement {
  /** Drops whose replayed projection equals the Postgres truth of their orders (INV-5). */
  readonly agree: readonly string[];
  /**
   * Drops whose dashboard leaves out orders, with how many: the topic does not hold their events (recreated
   * after they were published, or they were written without any), so no replay can restore them.
   */
  readonly lost: ReadonlyMap<string, number>;
  /** INV-5's messages for each drop that counts every order yet disagrees with them: a wrong replay. */
  readonly disagree: ReadonlyMap<string, readonly string[]>;
  /**
   * Drops that count every order but that INV-5 cannot compare counter by counter, with why (orders whose
   * events are past the outbox's retention).
   */
  readonly skipped: ReadonlyMap<string, string>;
}

/**
 * Judges replayed drops against their orders rather than against the snapshot before the wipe: the events of
 * orders placed while the consumers were stopped, or still lagging when they stopped, are in the replay but
 * not in the snapshot, and INV-5 tells such a legitimate change from a replay that counted wrong. Run on
 * every drop with orders, not only those that changed: a projection already short of orders before the wipe
 * comes back identical, and only its orders show what the topic lacks.
 */
export function judgeReplay(checks: ReadonlyMap<string, DashboardCheck>): ReplayJudgement {
  const agree: string[] = [];
  const lost = new Map<string, number>();
  const disagree = new Map<string, string[]>();
  const skipped = new Map<string, string>();
  for (const [dropId, check] of checks) {
    const missing = ordersMissing(check);
    const result = checkDashboard(dropId, check);
    if (missing > 0) lost.set(dropId, missing);
    else if (result.skipped !== undefined) skipped.set(dropId, result.skipped);
    else if (result.violations.length > 0)
      disagree.set(
        dropId,
        result.violations.map((violation) => violation.message),
      );
    else agree.push(dropId);
  }
  return { agree, lost, disagree, skipped };
}
