import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DriftSample,
  type DriftSource,
  type DriftStreak,
  driftFindings,
  observeDrift,
  type PgDriftSide,
  type RedisDriftSide,
  sampleDrift,
} from './drift';

const DROP = '00000000-0000-4000-8000-000000000001';
const TOTAL = 12;
const LIMIT = 3;
const USERS = 5;

/*
 * The drift checker against one drop whose two stores move the way the ordering rule (§4.3) moves them:
 * reserves reach Redis first, releases and payments reach Postgres first, and any number of them are in
 * flight at once. The checker's four reads interleave with their steps at random, and its Redis read is two
 * commands (stock, then Σuq) with steps between them as well.
 */

/** One step of an operation in flight; returns the operation's next step, or undefined once it is over. */
type Step = () => Step | undefined;

type Move =
  | { readonly kind: 'reserve'; readonly user: number; readonly qty: number }
  | { readonly kind: 'release' | 'confirm' | 'advance'; readonly pick: number };

const moveArb: fc.Arbitrary<Move> = fc.oneof(
  fc.record({
    kind: fc.constant('reserve' as const),
    user: fc.nat({ max: USERS - 1 }),
    qty: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({ kind: fc.constantFrom('release' as const, 'confirm' as const), pick: fc.nat() }),
  // Advancing is what makes work land, so it is drawn as often as the other moves together.
  fc.record({ kind: fc.constant('advance' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('advance' as const), pick: fc.nat() }),
);

function createWorld() {
  const redis = { gen: 1, seq: 0, avail: TOTAL, held: 0, sold: 0, uq: new Array<number>(USERS).fill(0) };
  const pg = { reserved: 0, sold: 0, claimed: new Array<number>(USERS).fill(0), version: 0 };
  /** Holds Postgres recorded (RESERVED), not yet released or paid. */
  const holds: { readonly user: number; readonly qty: number }[] = [];
  const inFlight: Step[] = [];
  let refusals = 0;

  const redisRelease =
    (user: number, qty: number): Step =>
    () => {
      redis.held -= qty;
      redis.avail += qty;
      redis.uq[user] = (redis.uq[user] ?? 0) - qty;
      redis.seq++;
      return undefined;
    };

  const reserve =
    (user: number, qty: number): Step =>
    () => {
      // fd_reserve: check and take, or refuse without a write.
      if (redis.avail < qty || (redis.uq[user] ?? 0) + qty > LIMIT) return undefined;
      redis.avail -= qty;
      redis.held += qty;
      redis.uq[user] = (redis.uq[user] ?? 0) + qty;
      redis.seq++;
      // The Postgres transaction, later. A refusal (tombstone) is released in Redis afterwards.
      return () => {
        if (TOTAL - pg.sold - pg.reserved < qty || (pg.claimed[user] ?? 0) + qty > LIMIT) {
          refusals++;
          return redisRelease(user, qty);
        }
        pg.reserved += qty;
        pg.claimed[user] = (pg.claimed[user] ?? 0) + qty;
        pg.version++;
        holds.push({ user, qty });
        return undefined;
      };
    };

  /** Expiry, cancel or a failed payment: Postgres commits, then settlement releases in Redis. */
  const release =
    (user: number, qty: number): Step =>
    () => {
      pg.reserved -= qty;
      pg.claimed[user] = (pg.claimed[user] ?? 0) - qty;
      pg.version++;
      return redisRelease(user, qty);
    };

  /** PAID: Postgres commits, then settlement confirms in Redis. Bought units keep counting toward the limit. */
  const confirm =
    (qty: number): Step =>
    () => {
      pg.reserved -= qty;
      pg.sold += qty;
      pg.version++;
      return () => {
        redis.held -= qty;
        redis.sold += qty;
        redis.seq++;
        return undefined;
      };
    };

  const advance = (pick: number) => {
    if (inFlight.length === 0) return;
    const index = pick % inFlight.length;
    const step = inFlight[index] as Step; // index < length: an element of a dense array
    const next = step();
    if (next === undefined) inFlight.splice(index, 1);
    else inFlight[index] = next;
  };

  const apply = (move: Move) => {
    if (move.kind === 'reserve') {
      inFlight.push(reserve(move.user, move.qty));
    } else if (move.kind === 'advance') {
      advance(move.pick);
    } else if (holds.length > 0) {
      const [hold] = holds.splice(move.pick % holds.length, 1);
      if (hold !== undefined) {
        inFlight.push(move.kind === 'release' ? release(hold.user, hold.qty) : confirm(hold.qty));
      }
    }
  };

  const redisStock = (): Omit<RedisDriftSide, 'quota'> => ({
    status: 'LIVE',
    gen: redis.gen,
    seq: redis.seq,
    avail: redis.avail,
    held: redis.held,
    sold: redis.sold,
  });
  const pgSide = (): PgDriftSide => ({
    redisGen: redis.gen,
    available: TOTAL - pg.sold - pg.reserved,
    reserved: pg.reserved,
    sold: pg.sold,
    claimed: pg.claimed.reduce((sum, n) => sum + n, 0),
    version: String(pg.version),
  });

  return { redis, inFlight, apply, advance, redisStock, pgSide, refusals: () => refusals };
}

/** A source over the world that runs `between()` before every read, and between Redis's two commands. */
function sourceOf(world: ReturnType<typeof createWorld>, between: () => void): DriftSource {
  return {
    async readRedis() {
      between();
      const stock = world.redisStock();
      between();
      return [{ ...stock, quota: world.redis.uq.reduce((sum, n) => sum + n, 0) }];
    },
    async readPg() {
      between();
      return new Map([[DROP, world.pgSide()]]);
    },
    async readRedisVersions() {
      between();
      return [`${world.redis.gen}:${world.redis.seq}`];
    },
    async readPgVersions() {
      between();
      return new Map([[DROP, world.pgSide().version]]);
    },
  };
}

async function sampleOne(source: DriftSource): Promise<DriftSample> {
  const [sample] = await sampleDrift(source, [DROP]);
  if (sample === undefined) throw new Error('no sample');
  return sample;
}

describe('the drift checker under interleaved reserves, releases and payments', () => {
  it('never finds Redis optimistic, and finds nothing once the work has landed', async () => {
    const seen = { stable: 0, stableInFlight: 0, legitimatelyLower: 0, unstable: 0 };
    await fc.assert(
      fc.asyncProperty(
        fc.array(moveArb, { minLength: 1, maxLength: 120 }),
        // Mostly quiet between reads, so that many samples are stable while work is in flight.
        fc.array(
          fc.oneof(
            { weight: 3, arbitrary: fc.constant(0) },
            { weight: 1, arbitrary: fc.integer({ min: 1, max: 3 }) },
          ),
          { minLength: 1, maxLength: 16 },
        ),
        async (moves, gaps) => {
          const world = createWorld();
          let next = 0;
          let gap = 0;
          const between = () => {
            const count = gaps[gap++ % gaps.length] ?? 0;
            for (let i = 0; i < count && next < moves.length; i++) world.apply(moves[next++] as Move);
          };
          const source = sourceOf(world, between);
          let streak: DriftStreak | undefined;

          while (next < moves.length) {
            const before = next;
            const inFlight = world.inFlight.length > 0;
            const observed = observeDrift(streak, await sampleOne(source));
            streak = observed.streak;
            expect(observed.findings?.optimistic ?? []).toEqual([]);
            expect(observed.verdict).not.toBe('drift');
            if (observed.findings === null) seen.unstable++;
            else {
              seen.stable++;
              if (inFlight) seen.stableInFlight++;
              if (observed.findings.mismatch.length > 0) seen.legitimatelyLower++;
            }
            if (next === before) world.apply(moves[next++] as Move);
          }

          // Let every operation land; then the stores agree exactly and stay quiet.
          while (world.inFlight.length > 0) world.advance(0);
          const idle = sourceOf(world, () => undefined);
          for (let i = 0; i < 3; i++) {
            const observed = observeDrift(streak, await sampleOne(idle));
            streak = observed.streak;
            expect(observed.findings).toEqual({ units: 0, optimistic: [], mismatch: [] });
            expect(observed.verdict).toBeNull();
          }
          // Redis was never optimistic, so Postgres never refused what it admitted.
          expect(world.refusals()).toBe(0);
        },
      ),
      { numRuns: 400 },
    );
    // Not vacuous: the checker compared many instants with work in flight, Redis legitimately lower in many
    // of them, and skipped the samples the work moved under it.
    expect(seen.stableInFlight).toBeGreaterThan(200);
    expect(seen.legitimatelyLower).toBeGreaterThan(100);
    expect(seen.unstable).toBeGreaterThan(50);
  });

  it('does find drift injected into the same world, on the second stable sample', async () => {
    const world = createWorld();
    for (const move of [
      { kind: 'reserve', user: 0, qty: 2 },
      { kind: 'advance', pick: 0 },
      { kind: 'advance', pick: 0 },
    ] as const)
      world.apply(move);
    world.redis.avail += 10;
    const source = sourceOf(world, () => undefined);

    const first = observeDrift(undefined, await sampleOne(source));
    expect(first.findings?.units).toBe(10);
    expect(first.verdict).toBeNull();
    expect(observeDrift(first.streak, await sampleOne(source)).verdict).toBe('drift');
  });
});

const redisSide = (overrides: Partial<RedisDriftSide> = {}): RedisDriftSide => ({
  status: 'LIVE',
  gen: 4,
  seq: 10,
  avail: 5,
  held: 3,
  sold: 2,
  quota: 5,
  ...overrides,
});
const pgSide = (overrides: Partial<PgDriftSide> = {}): PgDriftSide => ({
  redisGen: 4,
  available: 5,
  reserved: 3,
  sold: 2,
  claimed: 5,
  version: '1700000000000001',
  ...overrides,
});
const sample = (
  redis: Partial<RedisDriftSide> | 'MISSING' = {},
  pg: Partial<PgDriftSide> = {},
  stable = true,
): DriftSample => ({
  dropId: DROP,
  redis: redis === 'MISSING' ? redis : redisSide(redis),
  pg: pgSide(pg),
  stable,
});

/** Folds samples in order; the observation of the last one. */
function observeAll(samples: readonly DriftSample[]) {
  let streak: DriftStreak | undefined;
  return samples.map((s) => {
    const observed = observeDrift(streak, s);
    streak = observed.streak;
    return observed;
  });
}

describe('driftFindings', () => {
  it('splits the optimistic direction from the legitimate one', () => {
    expect(driftFindings(sample())).toEqual({ units: 0, optimistic: [], mismatch: [] });
    // A hold Postgres has not recorded yet: Redis lower, nothing optimistic.
    const inFlight = driftFindings(sample({ avail: 4, held: 4, quota: 6 }));
    expect(inFlight?.optimistic).toEqual([]);
    expect(inFlight?.mismatch).toHaveLength(3);
    expect(inFlight?.units).toBe(-1);
    // Each optimistic reading on its own.
    expect(driftFindings(sample({ avail: 6, held: 2 }))?.optimistic).toEqual([
      'Redis avail 6, Postgres available 5',
      'Redis held 2, Postgres reserved 3',
    ]);
    expect(driftFindings(sample({ held: 2, sold: 3 }))?.optimistic).toEqual([
      'Redis held 2, Postgres reserved 3',
      'Redis sold 3, Postgres sold 2',
    ]);
    // Σuq is only ever a mismatch (design §4.7: the leak rule).
    expect(driftFindings(sample({ quota: 4 }))).toEqual({
      units: 0,
      optimistic: [],
      mismatch: ['Σuq 4, Σclaimed 5'],
    });
  });

  it('says nothing about an unstable sample, or one the structural check must repair first', () => {
    expect(driftFindings(sample({ avail: 9 }, {}, false))).toBeNull();
    expect(driftFindings(sample('MISSING'))).toBeNull();
    expect(driftFindings(sample({ status: 'RECONCILING', avail: 0, held: 0, sold: 0 }))).toBeNull();
    expect(driftFindings(sample({ gen: 3, avail: 9 }))).toBeNull();
  });
});

describe('observeDrift', () => {
  it('rebuilds for drift on the second consecutive optimistic stable sample, never on one', () => {
    const [first, second] = observeAll([sample({ avail: 8 }), sample({ avail: 8, seq: 11 })]);
    expect(first?.verdict).toBeNull();
    expect(second?.verdict).toBe('drift');
  });

  it('skips unstable samples without breaking a streak; a clean stable one ends it', () => {
    const skipped = observeAll([sample({ avail: 8 }), sample({}, {}, false), sample({ avail: 8, seq: 12 })]);
    expect(skipped.map((o) => o.verdict)).toEqual([null, null, 'drift']);
    const ended = observeAll([sample({ avail: 8 }), sample({ seq: 11 }), sample({ avail: 8, seq: 12 })]);
    expect(ended.map((o) => o.verdict)).toEqual([null, null, null]);
  });

  it('rebuilds for a leak only on the third mismatch at the same versions of both stores', () => {
    const leak = sample({ avail: 3, held: 5 });
    expect(observeAll([leak, leak, leak]).map((o) => o.verdict)).toEqual([null, null, 'leak']);
    const quota = sample({ quota: 7 });
    expect(observeAll([quota, quota, quota]).map((o) => o.verdict)).toEqual([null, null, 'leak']);
    // Work landed in between (another seq, another updated_at): the count starts over.
    const moved = observeAll([
      leak,
      leak,
      sample({ avail: 3, held: 5, seq: 11 }),
      sample({ avail: 3, held: 5, seq: 11 }),
      sample({ avail: 3, held: 5, seq: 11 }, { version: '1700000000000002' }),
    ]);
    expect(moved.map((o) => o.verdict)).toEqual([null, null, null, null, null]);
  });

  it('starts over after a rebuild, and forgets a drop it cannot compare', () => {
    expect(
      observeAll([sample({ avail: 8 }), sample({ gen: 5, seq: 0, avail: 8 }, { redisGen: 5 })])[1]?.verdict,
    ).toBeNull();
    const [, missing] = observeAll([sample({ avail: 8 }), sample('MISSING')]);
    expect(missing?.streak).toBeUndefined();
    expect(missing?.verdict).toBeNull();
  });
});
