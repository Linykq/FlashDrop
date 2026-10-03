import { z } from 'zod';
import { REDIS_DROP_STATUSES, type RedisDropStatus } from './replies';

/*
 * The level message every mutating Function publishes on `stockChannel(dropId)` (design §4.2, §7):
 * `gen:seq:avail:held:sold:status:ts`. It is a level, not a delta, so a subscriber keeps only the newest by
 * `(gen, seq)` and a lost message costs nothing. `ts` is the Redis time of the mutation in ms, used to
 * measure propagation.
 */

/** A stock version: `gen` comes from Postgres and survives a wipe, `seq` restarts at 0 on every rebuild. */
export interface StockVersion {
  readonly gen: number;
  readonly seq: number;
}

export interface StockLevelMessage extends StockVersion {
  readonly avail: number;
  readonly held: number;
  readonly sold: number;
  readonly status: RedisDropStatus;
  readonly ts: number;
}

const Int = z
  .string()
  .regex(/^-?\d+$/)
  .transform(Number)
  .pipe(z.int());
const Count = Int.pipe(z.int().nonnegative());

const Fields = z
  .tuple([Int, Count, Count, Count, Count, z.enum(REDIS_DROP_STATUSES), Count])
  .transform(([gen, seq, avail, held, sold, status, ts]) => ({ gen, seq, avail, held, sold, status, ts }));

/**
 * Parses one stock message, or returns null for one that is not a complete level. `publish()` writes an
 * empty field for anything missing from the hash rather than failing its Function, so such messages exist
 * by design; a subscriber drops them and waits for the next level.
 */
export function parseStockMessage(message: string): StockLevelMessage | null {
  const result = Fields.safeParse(message.split(':'));
  return result.success ? result.data : null;
}

/** Lexicographic `(gen, seq)` order: negative if `a` is older than `b`, 0 if equal, positive if newer. */
export function compareStockVersions(a: StockVersion, b: StockVersion): number {
  return a.gen === b.gen ? a.seq - b.seq : a.gen - b.gen;
}
