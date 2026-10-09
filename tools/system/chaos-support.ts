import { CONSUMER_GROUPS, TOPICS } from '@flashdrop/config';
import {
  type RedisStock,
  readLiveRedisIdentity,
  readStock,
  readStoredRedisIdentity,
} from '@flashdrop/inventory';
import { z } from 'zod';
import type { Stores } from './support';

/*
 * What the chaos runs (tests/chaos, design §13) read beside the system tests' support: evidence that a fault
 * happened, and of what the stack did about it. Read-only, like the rest of the support. tests/chaos takes
 * the workspace packages only through tools/system, whose package depends on them.
 */

export type { RedisStock };
export { CONSUMER_GROUPS, TOPICS };

/** Records in `orders.v1.dlq` now, counted as `verify:invariants` counts them for `--max-dead-letters`. */
export async function deadLetters(stores: Stores): Promise<number> {
  const watermarks = await stores.admin.fetchTopicOffsets(TOPICS.ordersDlq);
  return watermarks.reduce((sum, w) => sum + Number(BigInt(w.high) - BigInt(w.low)), 0);
}

/**
 * The member that owns each `orders.v1` partition in a group, by Kafka client id (`worker:<hostname>`; a
 * replica's hostname is its container's short id). A partition between owners (a dead member's, until the
 * broker's session timeout evicts it) is absent.
 */
export async function partitionOwners(stores: Stores, groupId: string): Promise<Map<number, string>> {
  const { groups } = await stores.admin.describeGroups([groupId]);
  const owners = new Map<number, string>();
  for (const member of groups.find((group) => group.groupId === groupId)?.members ?? []) {
    for (const tp of member.assignment.topicPartitions) {
      if (tp.topic === TOPICS.orders) owners.set(tp.partition, member.clientId);
    }
  }
  return owners;
}

const OrderStatusRow = z.object({ id: z.string(), status: z.string() });

/** Each order's Postgres status, by id. */
export async function orderStatuses(
  stores: Stores,
  orderIds: readonly string[],
): Promise<Map<string, string>> {
  const { rows } = await stores.pool.query('SELECT id::text, status FROM orders WHERE id = ANY($1::uuid[])', [
    orderIds,
  ]);
  return new Map(
    z
      .array(OrderStatusRow)
      .parse(rows)
      .map((row) => [row.id, row.status]),
  );
}

/** The drop's orders still live: a hold not yet expired, or a submit not yet paid or failed. */
export async function liveOrders(stores: Stores, dropId: string): Promise<number> {
  const { rows } = await stores.pool.query(
    `SELECT count(*)::int AS n FROM orders WHERE drop_id = $1 AND status IN ('RESERVED', 'PENDING_PAYMENT')`,
    [dropId],
  );
  return z.array(z.object({ n: z.int() })).parse(rows)[0]?.n ?? 0;
}

/** `drop_inventory.redis_gen`: every rebuild of the drop's Redis state fences it one higher (§4.7). */
export async function redisGeneration(stores: Stores, dropId: string): Promise<number> {
  const { rows } = await stores.pool.query('SELECT redis_gen FROM drop_inventory WHERE drop_id = $1', [
    dropId,
  ]);
  const [row] = z.array(z.object({ redis_gen: z.int() })).parse(rows);
  if (row === undefined) throw new Error(`no drop_inventory row for drop ${dropId}`);
  return row.redis_gen;
}

/** The drop's stock counters in Redis, with their generation and sequence (one HMGET); null without a drop. */
export function redisStock(stores: Stores, dropId: string): Promise<RedisStock | null> {
  return readStock(stores.redis, dropId);
}

/**
 * Redis's `run_id` now and the one the reconciler recorded after its last full rebuild (§4.7): they differ
 * from a restart until the rebuild of every tracked drop is done.
 */
export async function redisIdentity(stores: Stores): Promise<{ live: string; recorded: string | null }> {
  const [live, stored] = await Promise.all([
    readLiveRedisIdentity(stores.redis),
    readStoredRedisIdentity(stores.db),
  ]);
  return { live: live.runId, recorded: stored.runId };
}
