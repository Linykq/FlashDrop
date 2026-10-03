import { BugError, RSV_STATES, type RsvState } from '@flashdrop/domain';
import { z } from 'zod';
import type { FlashdropRedis } from './client';
import { BULK_DEADLINE_MS, REDIS_DEADLINE_MS, withDeadline } from './deadline';
import { dropKeys } from './keys';
import { REDIS_DROP_STATUSES, type RedisDropStatus } from './replies';
import type { StockVersion } from './stock-message';

/*
 * Reading a drop's Redis state: the O(1) stock read every request path uses, and the full O(n) read that
 * only tests, the reconciler and `verify:invariants` use (design §4.2: conservation checks never run inside
 * a Function).
 */

export interface RedisStock extends StockVersion {
  readonly status: RedisDropStatus;
  readonly avail: number;
  readonly held: number;
  readonly sold: number;
}

/**
 * An integer exactly as the Lua library's `parse_int` (and Redis's own HINCRBY) accepts it: '0', or an
 * optional '-' and 1 to 16 digits with no leading zero. A field the Functions would refuse is malformed
 * here too, so the reconciler's structural check sees what makes every Function on the drop fail.
 */
const Int = z
  .string()
  .regex(/^(0|-?[1-9]\d{0,15})$/)
  .transform(Number)
  .pipe(z.int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER));
const STOCK_FIELDS = ['status', 'gen', 'seq', 'avail', 'held', 'sold'] as const;
const StockFields = z
  .tuple([z.enum(REDIS_DROP_STATUSES), Int, Int, Int, Int, Int])
  .transform(([status, gen, seq, avail, held, sold]) => ({ status, gen, seq, avail, held, sold }));

/**
 * The drop's stock from one HMGET of `inv`, an atomic snapshot (§4.1), or null when Redis has no drop
 * (no status or gen: the same test as the Functions' gate). A RECONCILING drop is returned as such; its
 * fail-closed counters are zero until the rebuild lands. Bounded by `REDIS_DEADLINE_MS`.
 */
export async function readStock(redis: FlashdropRedis, dropId: string): Promise<RedisStock | null> {
  const values = await withDeadline('stock read', REDIS_DEADLINE_MS, () =>
    redis.hmGet(dropKeys(dropId).inv, [...STOCK_FIELDS]),
  );
  if (values[0] == null || values[1] == null) return null;
  const parsed = StockFields.safeParse(values);
  if (!parsed.success) throw new BugError(`malformed inv hash of drop ${dropId}: ${JSON.stringify(values)}`);
  return parsed.data;
}

export interface RedisRsvEntry {
  readonly u: string;
  readonly q: number;
  readonly s: RsvState;
  readonly fp: string;
  readonly k: string;
}

export interface RedisInv extends RedisStock {
  readonly total: number;
  /** Absent only from the fail-closed hash of a drop whose first rebuild has not landed. */
  readonly meta?: {
    readonly startsAt: number;
    readonly endsAt: number;
    readonly holdMs: number;
    readonly limit: number;
    readonly retainAt: number;
    readonly productId: string;
  };
  readonly reconcilingSince?: number;
}

/** Every key of one drop, read in one MULTI so all four describe the same instant. */
export interface RedisDropState {
  readonly inv: RedisInv | null;
  readonly entries: ReadonlyMap<string, RedisRsvEntry>;
  readonly quotas: ReadonlyMap<string, number>;
  /** rid → `exp` score. */
  readonly expiries: ReadonlyMap<string, number>;
}

const Hash = z.record(z.string(), z.string());
const InvHash = z
  .object({
    status: z.enum(REDIS_DROP_STATUSES),
    gen: Int,
    seq: Int,
    total: Int,
    avail: Int,
    held: Int,
    sold: Int,
    startsAt: Int.optional(),
    endsAt: Int.optional(),
    holdMs: Int.optional(),
    limit: Int.optional(),
    retainAt: Int.optional(),
    productId: z.string().optional(),
    reconcilingSince: Int.optional(),
  })
  .transform(({ startsAt, endsAt, holdMs, limit, retainAt, productId, reconcilingSince, ...stock }) => ({
    ...stock,
    ...(startsAt !== undefined &&
    endsAt !== undefined &&
    holdMs !== undefined &&
    limit !== undefined &&
    retainAt !== undefined &&
    productId !== undefined
      ? { meta: { startsAt, endsAt, holdMs, limit, retainAt, productId } }
      : {}),
    ...(reconcilingSince !== undefined ? { reconcilingSince } : {}),
  }));
const RsvEntry = z.object({
  u: z.string(),
  q: z.int().min(1),
  s: z.enum(RSV_STATES),
  fp: z.string(),
  k: z.string(),
});
const ExpMembers = z.array(z.object({ value: z.string(), score: z.number() }));

/** O(n) in the drop's orders, so bounded by `BULK_DEADLINE_MS`. */
export async function readDropState(redis: FlashdropRedis, dropId: string): Promise<RedisDropState> {
  const k = dropKeys(dropId);
  const [inv, rsv, uq, exp] = await withDeadline('drop state read', BULK_DEADLINE_MS, () =>
    redis.multi().hGetAll(k.inv).hGetAll(k.rsv).hGetAll(k.uq).zRangeWithScores(k.exp, 0, -1).exec(),
  );
  const invHash = Hash.parse(inv);
  return {
    inv: Object.keys(invHash).length === 0 ? null : InvHash.parse(invHash),
    entries: new Map(
      Object.entries(Hash.parse(rsv)).map(([rid, raw]) => [rid, RsvEntry.parse(JSON.parse(raw))]),
    ),
    quotas: new Map(Object.entries(Hash.parse(uq)).map(([userId, units]) => [userId, Int.parse(units)])),
    expiries: new Map(ExpMembers.parse(exp).map((member) => [member.value, member.score])),
  };
}

/**
 * Redis-internal invariants of one drop, as messages (empty when all hold): INV-9 conservation
 * (`avail + held + sold = total`, nothing negative), the counters equal the sums of their `rsv` entries,
 * every user's `uq` equals that user's HELD plus COMMITTED units, and `exp` holds exactly the HELD rids.
 * The Functions keep all of these on every call; a rebuild restores them from a consistent Postgres view.
 */
export function redisDropViolations(state: RedisDropState): string[] {
  const { inv } = state;
  if (inv === null) return state.entries.size > 0 ? ['rsv entries without an inv hash'] : [];
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };

  check(inv.avail + inv.held + inv.sold === inv.total, `INV-9: avail+held+sold != total (${describe(inv)})`);
  check(inv.avail >= 0 && inv.held >= 0 && inv.sold >= 0, `INV-9: negative counter (${describe(inv)})`);

  let heldUnits = 0;
  let soldUnits = 0;
  const claimed = new Map<string, number>();
  for (const [rid, entry] of state.entries) {
    if (entry.s === 'HELD') heldUnits += entry.q;
    if (entry.s === 'COMMITTED') soldUnits += entry.q;
    if (entry.s !== 'RELEASED') claimed.set(entry.u, (claimed.get(entry.u) ?? 0) + entry.q);
    check((entry.s === 'HELD') === state.expiries.has(rid), `exp membership of ${rid} (${entry.s})`);
  }
  for (const rid of state.expiries.keys())
    check(state.entries.has(rid), `exp member ${rid} without rsv entry`);
  check(heldUnits === inv.held, `held ${inv.held} != HELD units ${heldUnits}`);
  check(soldUnits === inv.sold, `sold ${inv.sold} != COMMITTED units ${soldUnits}`);

  for (const userId of new Set([...claimed.keys(), ...state.quotas.keys()])) {
    const expected = claimed.get(userId) ?? 0;
    const actual = state.quotas.get(userId) ?? 0;
    check(actual === expected, `uq[${userId}] = ${actual}, entries say ${expected}`);
    check(!state.quotas.has(userId) || actual > 0, `uq[${userId}] kept at ${actual}`);
  }
  return problems;
}

function describe(inv: RedisInv): string {
  return `total ${inv.total}, avail ${inv.avail}, held ${inv.held}, sold ${inv.sold}`;
}
