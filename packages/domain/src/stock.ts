/** The stock of record for one drop: a `drop_inventory` row (design §3). */
export interface InventoryCounters {
  readonly total: number;
  /** Units in RESERVED and PENDING_PAYMENT orders. */
  readonly reserved: number;
  /** Units in PAID orders. */
  readonly sold: number;
}

/** Stock as buyers see it, in the shape of the Redis `inv` hash (§4.1). */
export interface StockLevels {
  readonly avail: number;
  readonly held: number;
  readonly sold: number;
}

/**
 * Postgres counters to buyer-facing stock, by the same mapping the Redis rebuild uses (§4.7 step 4):
 * `avail = total − sold − reserved`, `held = reserved`. The `no_oversell` CHECK keeps `avail` non-negative.
 */
export function stockFromCounters({ total, reserved, sold }: InventoryCounters): StockLevels {
  return { avail: total - sold - reserved, held: reserved, sold };
}
