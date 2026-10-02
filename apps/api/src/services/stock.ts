import type { StockLevel } from '@flashdrop/contracts';
import { and, type Db, dropInventory, drops, eq, inArray, ne } from '@flashdrop/db';
import { stockFromCounters } from '@flashdrop/domain';
import { publicDropStatus } from './drop-status';

/**
 * Where live stock levels come from. M1 reads the stock of record, `drop_inventory`; M2 swaps in the Redis
 * reader (one `HMGET` of the `inv` hash per drop, §4.1) behind this same interface, so routes and the DTOs
 * they answer with do not change.
 */
export interface StockReader {
  /** Levels of the given drops. Unknown and DRAFT drops are absent from the result. */
  read(dropIds: readonly string[]): Promise<ReadonlyMap<string, StockLevel>>;
}

/**
 * Stock straight from Postgres, mapped the way the Redis rebuild maps it (§4.7): `gen` is the inventory's
 * `redis_gen` and `seq` stays 0, because nothing increments it before Redis owns the counters.
 */
export function createPostgresStockReader(db: Db): StockReader {
  return {
    async read(dropIds) {
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
    },
  };
}
