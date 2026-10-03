import type { Logger } from '@flashdrop/config';
import type { StockLevel } from '@flashdrop/contracts';
import { and, type Db, dropInventory, drops, eq, inArray, isTrackedDrop, ne } from '@flashdrop/db';
import { stockFromCounters } from '@flashdrop/domain';
import {
  type FlashdropRedis,
  isTransientRedisError,
  type RedisStock,
  readStock,
  type SyncNudger,
} from '@flashdrop/inventory';
import { publicDropStatus } from './drop-status';

/** Where live stock levels come from: Redis since M2 (design §4.1), behind the interface M1 introduced. */
export interface StockReader {
  /**
   * Levels for the catalog. Unknown and DRAFT drops are absent from the result. A drop whose Redis state is
   * missing or being rebuilt shows its Postgres level instead, so one rebuild never empties the storefront.
   */
  read(dropIds: readonly string[]): Promise<ReadonlyMap<string, StockLevel>>;
  /**
   * The level behind `GET /drops/:dropId/stock`. `RETRY` while the drop's Redis state is RECONCILING or
   * not yet rebuilt; undefined for unknown and DRAFT drops.
   */
  snapshot(dropId: string): Promise<StockLevel | 'RETRY' | undefined>;
}

/**
 * Stock straight from Postgres, mapped the way the Redis rebuild maps it (§4.7): `gen` is the inventory's
 * `redis_gen` and `seq` is 0, the value a rebuild starts from.
 */
export function createPostgresStockReader(db: Db): StockReader {
  async function read(dropIds: readonly string[]): Promise<ReadonlyMap<string, StockLevel>> {
    if (dropIds.length === 0) return new Map();
    const rows = await db
      .select({
        dropId: dropInventory.dropId,
        status: drops.status,
        total: dropInventory.total,
        reserved: dropInventory.reserved,
        sold: dropInventory.sold,
        gen: dropInventory.redisGen,
      })
      .from(dropInventory)
      .innerJoin(drops, eq(drops.id, dropInventory.dropId))
      .where(and(inArray(dropInventory.dropId, [...dropIds]), ne(drops.status, 'DRAFT')));
    return new Map(
      rows.map((row) => [
        row.dropId,
        { ...stockFromCounters(row), status: publicDropStatus(row.status), gen: row.gen, seq: 0 },
      ]),
    );
  }
  return { read, snapshot: async (dropId) => (await read([dropId])).get(dropId) };
}

export interface RedisStockDeps {
  readonly redis: FlashdropRedis;
  readonly db: Db;
  /** Postgres levels: the catalog's fallback, and the final level of a drop past its 24 h retention. */
  readonly postgres: StockReader;
  readonly nudger: SyncNudger;
  readonly logger: Pick<Logger, 'warn'>;
}

/** A drop whose Redis level can be shown: present, and not in the middle of a rebuild. */
function servable(level: RedisStock | null): level is RedisStock {
  return level !== null && level.status !== 'RECONCILING';
}

/** A Redis level as the DTO carries it; `servable` already ruled out RECONCILING. */
function toStockLevel({ avail, held, sold, status, gen, seq }: RedisStock): StockLevel {
  return { avail, held, sold, status, gen, seq };
}

/**
 * Stock from the drop's `inv` hash: one HMGET, an atomic snapshot of counters, status and version (§4.1).
 * node-redis pipelines the concurrent HMGETs of a catalog page into one round trip.
 */
export function createRedisStockReader(deps: RedisStockDeps): StockReader {
  const { redis, postgres } = deps;
  return {
    async read(dropIds) {
      let levels: (RedisStock | null)[];
      try {
        levels = await Promise.all(dropIds.map((dropId) => readStock(redis, dropId)));
      } catch (err) {
        // The storefront keeps rendering from Postgres while Redis is away; buying needs Redis anyway.
        if (!isTransientRedisError(err)) throw err;
        deps.logger.warn({ err }, 'redis unavailable; catalog stock from postgres');
        return postgres.read(dropIds);
      }
      const result = new Map<string, StockLevel>();
      const fallback: string[] = [];
      dropIds.forEach((dropId, index) => {
        const level = levels[index] ?? null;
        if (servable(level)) result.set(dropId, toStockLevel(level));
        else fallback.push(dropId);
      });
      for (const [dropId, level] of await postgres.read(fallback)) result.set(dropId, level);
      return result;
    },

    async snapshot(dropId) {
      const level = await readStock(redis, dropId);
      if (servable(level)) return toStockLevel(level);
      if (level !== null) return 'RETRY';
      // Not in Redis. A tracked drop is waiting for its rebuild (a wipe, or armed a moment ago): nudge the
      // reconciler like a reserve would. A drop past its retention keeps its final Postgres level.
      if (await isTrackedDrop(deps.db, dropId)) {
        await deps.nudger.nudge(dropId);
        return 'RETRY';
      }
      return postgres.snapshot(dropId);
    },
  };
}
