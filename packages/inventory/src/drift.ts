import { type Db, PgUuid, parseRows, sql } from '@flashdrop/db';
import { BugError } from '@flashdrop/domain';
import { z } from 'zod';
import type { FlashdropRedis } from './client';
import { BULK_DEADLINE_MS, withDeadline } from './deadline';
import { dropKeys } from './keys';
import { type RedisStock, readStock } from './state';

/*
 * The reconciler's drift checker (design §4.7). By the ordering rule (§4.3) Redis is never *higher* than
 * Postgres (INV-7): a reserve takes Redis stock before Postgres records it, and a release or a payment
 * reaches Redis only after Postgres has committed it. At any one instant, work in flight can leave Redis
 * legitimately *lower* (a hold Postgres has not recorded yet, an outcome Redis has not applied yet), never
 * optimistic. So:
 *
 *   - optimistic (Redis avail > Postgres available, held < reserved, or sold > sold) is impossible at one
 *     instant unless Redis drifted. Two consecutive stable samples of it: rebuild (`drift`).
 *   - any other difference, Σuq ≠ Σclaimed included, is normal while work is in flight. It counts only when
 *     three consecutive stable samples see it at the same versions of both stores (quiescent): rebuild
 *     (`leak`).
 *
 * A **stable sample** reads Redis (stock, then Σuq), then Postgres (stock and Σclaimed in one statement),
 * then Redis's version again, then Postgres's version again. If neither version moved, Redis's state held
 * from its first read to its version re-read and Postgres's from its read to its re-read; the two intervals
 * overlap, so both describe one instant without any lock. Otherwise the sample is skipped.
 *
 * - Redis's version is `gen:seq`: every Function write bumps `seq`, every `uq` write happens inside one of
 *   those writes, and a rebuild sets a newer `gen` (its `seq` restarts at 0).
 * - Postgres's version is `drop_inventory.updated_at`, which a trigger sets on every update (migration
 *   0003). `claimed` only changes in a transaction that also updates the drop's inventory row (reserve,
 *   expiry, cancel, failed payment, §4.4), so the version covers Σclaimed too.
 *
 * Every read is batched over the drops of a round: four round trips per round, not four per drop.
 */

/** Redis's side of a sample: the `inv` stock and Σuq, the units its per-user gate counts. */
export interface RedisDriftSide extends RedisStock {
  readonly quota: number;
}

/** What Redis holds for a drop: its side, or why it cannot be compared (the structural check's cases). */
export type RedisDriftRead = RedisDriftSide | 'MISSING' | 'MALFORMED';

/** Postgres's side of a sample. */
export interface PgDriftSide {
  readonly redisGen: number;
  /** `total − sold − reserved`. */
  readonly available: number;
  readonly reserved: number;
  readonly sold: number;
  /** Σ `user_drop_quota.claimed`. */
  readonly claimed: number;
  /** `drop_inventory.updated_at` in microseconds: changes on every update of the row. */
  readonly version: string;
}

/** The four reads of a stable sample, each over every drop of the round. */
export interface DriftSource {
  /** In the order of `dropIds`. */
  readRedis(dropIds: readonly string[]): Promise<RedisDriftRead[]>;
  /** `redisVersion` of each drop, in the order of `dropIds`. */
  readRedisVersions(dropIds: readonly string[]): Promise<string[]>;
  /** By drop id; a drop without an inventory row is absent. */
  readPg(dropIds: readonly string[]): Promise<ReadonlyMap<string, PgDriftSide>>;
  readPgVersions(dropIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export interface DriftSample {
  readonly dropId: string;
  readonly redis: RedisDriftRead;
  readonly pg: PgDriftSide;
  /** Neither store changed the drop while it was sampled, so both sides describe one instant. */
  readonly stable: boolean;
}

/** The version a stable sample compares; MISSING and MALFORMED stand for themselves. */
function redisVersion(read: RedisDriftRead | RedisStock | null): string {
  if (read === null) return 'MISSING';
  return typeof read === 'string' ? read : `${read.gen}:${read.seq}`;
}

/**
 * One stable-sample attempt per drop, in the order of `dropIds`. A drop without an inventory row is left
 * out: the structural check reports it.
 */
export async function sampleDrift(source: DriftSource, dropIds: readonly string[]): Promise<DriftSample[]> {
  if (dropIds.length === 0) return [];
  const redis = await source.readRedis(dropIds);
  const pg = await source.readPg(dropIds);
  const redisAfter = await source.readRedisVersions(dropIds);
  const pgAfter = await source.readPgVersions(dropIds);
  const samples: DriftSample[] = [];
  for (const [i, dropId] of dropIds.entries()) {
    const redisSide = redis[i];
    const pgSide = pg.get(dropId);
    if (redisSide === undefined || pgSide === undefined) continue;
    const stable = redisVersion(redisSide) === redisAfter[i] && pgSide.version === pgAfter.get(dropId);
    samples.push({ dropId, redis: redisSide, pg: pgSide, stable });
  }
  return samples;
}

export interface DriftFindings {
  /** Redis avail − Postgres available: when positive, units Redis would admit that Postgres no longer has. */
  readonly units: number;
  /** INV-7 breaches at the sampled instant. */
  readonly optimistic: readonly string[];
  /** Every difference, the optimistic ones included. */
  readonly mismatch: readonly string[];
}

/**
 * What a sample says about drift, or null when it says nothing: it was not stable, or Redis is missing,
 * malformed, RECONCILING or at another generation than Postgres (the structural check repairs those).
 */
export function driftFindings(sample: DriftSample): DriftFindings | null {
  const { redis, pg } = sample;
  if (!sample.stable || typeof redis === 'string') return null;
  if (redis.status === 'RECONCILING' || redis.gen !== pg.redisGen) return null;
  const avail = `Redis avail ${redis.avail}, Postgres available ${pg.available}`;
  const held = `Redis held ${redis.held}, Postgres reserved ${pg.reserved}`;
  const sold = `Redis sold ${redis.sold}, Postgres sold ${pg.sold}`;
  const optimistic: string[] = [];
  if (redis.avail > pg.available) optimistic.push(avail);
  if (redis.held < pg.reserved) optimistic.push(held);
  if (redis.sold > pg.sold) optimistic.push(sold);
  const conservative: string[] = [];
  if (redis.avail < pg.available) conservative.push(avail);
  if (redis.held > pg.reserved) conservative.push(held);
  if (redis.sold < pg.sold) conservative.push(sold);
  if (redis.quota !== pg.claimed) conservative.push(`Σuq ${redis.quota}, Σclaimed ${pg.claimed}`);
  return { units: redis.avail - pg.available, optimistic, mismatch: [...optimistic, ...conservative] };
}

/** Consecutive stable samples with an optimistic reading that trigger a `drift` rebuild. */
const DRIFT_SAMPLES = 2;
/** Consecutive quiescent samples with a mismatch that trigger a `leak` rebuild. */
const LEAK_SAMPLES = 3;

/** What the checker remembers about one drop between rounds. Absent: nothing to count. */
export interface DriftStreak {
  /** The Redis generation the counts are about; a rebuild starts them over. */
  readonly gen: number;
  /** Consecutive stable samples with an optimistic reading. */
  readonly optimistic: number;
  /** Consecutive stable samples with a mismatch, all at `versions`. */
  readonly quiescent: number;
  /** Both stores' versions at the last sample with a mismatch. */
  readonly versions: string;
}

export type DriftVerdict = 'drift' | 'leak';

export interface DriftObservation {
  readonly streak: DriftStreak | undefined;
  /** Null when the sample said nothing about drift (`driftFindings`). */
  readonly findings: DriftFindings | null;
  /** Rebuild now, and why; null: not (yet). */
  readonly verdict: DriftVerdict | null;
}

/**
 * Folds one sample into the drop's streak. An unstable sample is skipped: it neither counts nor breaks a
 * streak, since it says nothing about either store. A stable sample without a finding (or one that cannot be
 * compared) ends the streak.
 */
export function observeDrift(streak: DriftStreak | undefined, sample: DriftSample): DriftObservation {
  if (!sample.stable) return { streak, findings: null, verdict: null };
  const findings = driftFindings(sample);
  if (findings === null) return { streak: undefined, findings, verdict: null };
  // Findings mean Redis is at Postgres's generation.
  const gen = sample.pg.redisGen;
  const previous = streak?.gen === gen ? streak : undefined;
  const versions = `${redisVersion(sample.redis)}|${sample.pg.version}`;
  const optimistic = findings.optimistic.length > 0 ? (previous?.optimistic ?? 0) + 1 : 0;
  const quiescent =
    findings.mismatch.length === 0 ? 0 : previous?.versions === versions ? previous.quiescent + 1 : 1;
  const next = quiescent === 0 ? undefined : { gen, optimistic, quiescent, versions };
  const verdict = optimistic >= DRIFT_SAMPLES ? 'drift' : quiescent >= LEAK_SAMPLES ? 'leak' : null;
  return { streak: next, findings, verdict };
}

const Units = z.array(
  z
    .string()
    .regex(/^(0|-?[1-9]\d{0,15})$/)
    .transform(Number),
);

const PgDriftRow = z.object({
  drop_id: PgUuid,
  redis_gen: z.int(),
  available: z.int(),
  reserved: z.int(),
  sold: z.int(),
  claimed: z.int(),
  version: z.string(),
});
const PgVersionRow = z.object({ drop_id: PgUuid, version: z.string() });

/** `updated_at` to the microsecond Postgres stores: a JavaScript Date would drop the last three digits. */
const PG_VERSION = sql`(extract(epoch FROM i.updated_at) * 1000000)::bigint::text`;

/** The stores themselves. */
export function driftSource(deps: { readonly db: Db; readonly redis: FlashdropRedis }): DriftSource {
  /** The stock, or MISSING / MALFORMED: a partial `inv` hash is the structural check's to repair. */
  const stockOf = async (dropId: string): Promise<RedisStock | 'MISSING' | 'MALFORMED'> => {
    try {
      return (await readStock(deps.redis, dropId)) ?? 'MISSING';
    } catch (err) {
      if (err instanceof BugError) return 'MALFORMED';
      throw err;
    }
  };
  return {
    // Issued together, so node-redis pipelines them on the one command connection.
    readRedis: (dropIds) =>
      Promise.all(
        dropIds.map(async (dropId): Promise<RedisDriftRead> => {
          const stock = await stockOf(dropId);
          if (typeof stock === 'string') return stock;
          // O(users of the drop), so the bulk deadline. Read after the stock, which is fine: a `uq` write
          // bumps `seq`, so the version re-read tells whether this read still matches the stock.
          const values = await withDeadline('quota read', BULK_DEADLINE_MS, () =>
            deps.redis.hVals(dropKeys(dropId).uq),
          );
          const units = Units.safeParse(values);
          if (!units.success) return 'MALFORMED';
          return { ...stock, quota: units.data.reduce((sum, n) => sum + n, 0) };
        }),
      ),
    readRedisVersions: (dropIds) =>
      Promise.all(dropIds.map(async (dropId) => redisVersion(await stockOf(dropId)))),
    async readPg(dropIds) {
      const ids = sql.param([...dropIds]);
      // One statement, so one snapshot: each drop's stock and its quotas describe the same instant.
      const { rows } = await deps.db.execute(sql`
        SELECT i.drop_id, i.redis_gen, i.total - i.sold - i.reserved AS available, i.reserved, i.sold,
               coalesce(q.claimed, 0)::int AS claimed, ${PG_VERSION} AS version
        FROM drop_inventory i
        LEFT JOIN (SELECT drop_id, sum(claimed) AS claimed FROM user_drop_quota
                   WHERE drop_id = ANY(${ids}::uuid[]) AND claimed > 0 GROUP BY drop_id) q
          ON q.drop_id = i.drop_id
        WHERE i.drop_id = ANY(${ids}::uuid[])`);
      return new Map(
        parseRows(PgDriftRow, rows, 'drift sample').map((row) => [
          row.drop_id,
          {
            redisGen: row.redis_gen,
            available: row.available,
            reserved: row.reserved,
            sold: row.sold,
            claimed: row.claimed,
            version: row.version,
          },
        ]),
      );
    },
    async readPgVersions(dropIds) {
      const { rows } = await deps.db.execute(sql`
        SELECT i.drop_id, ${PG_VERSION} AS version
        FROM drop_inventory i WHERE i.drop_id = ANY(${sql.param([...dropIds])}::uuid[])`);
      return new Map(parseRows(PgVersionRow, rows, 'drift version').map((row) => [row.drop_id, row.version]));
    },
  };
}
