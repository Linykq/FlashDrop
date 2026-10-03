import { randomUUID } from 'node:crypto';
import type { RebuildSnapshot } from '@flashdrop/db';
import type { RsvState } from '@flashdrop/domain';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fdConfirm, fdRebuild, fdRelease, fdReserve, fdSetStatus } from './calls';
import type { FlashdropRedis } from './client';
import type { RedisDropStatus } from './replies';
import { readDropState, redisDropViolations } from './state';
import { armTestDrop, connectTestRedis, deleteDropKeys, reserveInput } from './test/redis';

/*
 * Model-based test of the library (design §13): random sequences of reserve, confirm, release, rebuild and
 * set-status calls, duplicates included, run against Redis and against a pure TypeScript model of the Lua
 * semantics. After every step the replies must match, the counters must equal the model's, and INV-9 plus
 * the uq sums must hold (`redisDropViolations`).
 */

const USERS = 3;
const KEYS_PER_USER = 2;

interface Entry {
  readonly u: string;
  readonly q: number;
  s: RsvState;
}

interface Model {
  readonly dropId: string;
  readonly users: readonly string[];
  /** rids[user][key]: the same (user, key) always maps to the same rid, like the real rid derivation. */
  readonly rids: readonly (readonly string[])[];
  readonly total: number;
  readonly limit: number;
  readonly snapshot: RebuildSnapshot;
  status: RedisDropStatus;
  /** The status Postgres has, which a rebuild writes back. */
  pgStatus: Exclude<RedisDropStatus, 'RECONCILING'>;
  gen: number;
  seq: number;
  avail: number;
  held: number;
  sold: number;
  readonly entries: Map<string, Entry>;
  readonly uq: Map<string, number>;
}

interface Real {
  readonly redis: FlashdropRedis;
}

type Command = fc.AsyncCommand<Model, Real>;

const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('empty pool');
  return item;
};

async function expectMatches(model: Model, real: Real): Promise<void> {
  const state = await readDropState(real.redis, model.dropId);
  expect(state.inv).toMatchObject({
    status: model.status,
    gen: model.gen,
    seq: model.seq,
    total: model.total,
    avail: model.avail,
    held: model.held,
    sold: model.sold,
  });
  expect(new Map([...state.entries].map(([rid, e]) => [rid, e.s]))).toEqual(
    new Map([...model.entries].map(([rid, e]) => [rid, e.s])),
  );
  expect(state.quotas).toEqual(model.uq);
  expect(redisDropViolations(state)).toEqual([]);
}

class Reserve implements Command {
  readonly user: number;
  readonly key: number;
  readonly qty: number;
  constructor(user: number, key: number, qty: number) {
    this.user = user;
    this.key = key;
    this.qty = qty;
  }
  check = () => true;
  async run(model: Model, real: Real) {
    const userId = at(model.users, this.user);
    const rid = at(at(model.rids, this.user), this.key);
    const result = await fdReserve(real.redis, reserveInput(model.dropId, userId, this.qty, rid));

    const expected = ((): unknown => {
      if (!Number.isInteger(this.qty) || this.qty < 1 || this.qty > 10) return { kind: 'BAD_QTY' };
      if (model.status === 'RECONCILING') return { kind: 'RETRY' };
      const existing = model.entries.get(rid);
      if (existing !== undefined) {
        return existing.q === this.qty
          ? { kind: 'EXISTING', state: existing.s, gen: model.gen }
          : { kind: 'FP_MISMATCH' };
      }
      if (model.status !== 'LIVE' && model.status !== 'SCHEDULED') return { kind: 'NOT_LIVE' };
      if ((model.uq.get(userId) ?? 0) + this.qty > model.limit) return { kind: 'LIMIT' };
      if (model.avail < this.qty) return { kind: 'SOLD_OUT' };
      model.avail -= this.qty;
      model.held += this.qty;
      model.seq += 1;
      model.uq.set(userId, (model.uq.get(userId) ?? 0) + this.qty);
      model.entries.set(rid, { u: userId, q: this.qty, s: 'HELD' });
      return { kind: 'RESERVED', gen: model.gen };
    })();
    expect(result).toEqual(expected);
    await expectMatches(model, real);
  }
  toString = () => `reserve(u${this.user}, k${this.key}, ${this.qty})`;
}

class Settle implements Command {
  readonly outcome: 'confirm' | 'release';
  readonly user: number;
  readonly key: number;
  constructor(outcome: 'confirm' | 'release', user: number, key: number) {
    this.outcome = outcome;
    this.user = user;
    this.key = key;
  }
  check = () => true;
  async run(model: Model, real: Real) {
    const rid = at(at(model.rids, this.user), this.key);
    const result =
      this.outcome === 'confirm'
        ? await fdConfirm(real.redis, model.dropId, rid)
        : await fdRelease(real.redis, model.dropId, rid);

    const expected = ((): string => {
      if (model.status === 'RECONCILING') return 'RETRY';
      const entry = model.entries.get(rid);
      if (entry === undefined) return 'MISSING';
      const target = this.outcome === 'confirm' ? 'COMMITTED' : 'RELEASED';
      if (entry.s === target) return 'NOOP';
      if (entry.s !== 'HELD') return 'CONFLICT';
      entry.s = target;
      model.held -= entry.q;
      model.seq += 1;
      if (target === 'COMMITTED') {
        model.sold += entry.q;
      } else {
        model.avail += entry.q;
        const left = (model.uq.get(entry.u) ?? 0) - entry.q;
        if (left > 0) model.uq.set(entry.u, left);
        else model.uq.delete(entry.u);
      }
      return 'OK';
    })();
    expect(result).toEqual({ kind: expected });
    await expectMatches(model, real);
  }
  toString = () => `${this.outcome}(u${this.user}, k${this.key})`;
}

class SetStatus implements Command {
  readonly status: RedisDropStatus;
  constructor(status: RedisDropStatus) {
    this.status = status;
  }
  check = () => true;
  async run(model: Model, real: Real) {
    const result = await fdSetStatus(real.redis, model.dropId, this.status);

    const expected = ((): string => {
      if (this.status === 'RECONCILING') {
        model.status = 'RECONCILING';
        model.seq += 1;
        return 'OK';
      }
      if (model.status === 'RECONCILING') return 'RETRY';
      if (model.status === this.status) return 'NOOP';
      model.status = this.status;
      model.pgStatus = this.status;
      model.seq += 1;
      return 'OK';
    })();
    expect(result).toEqual({ kind: expected });
    await expectMatches(model, real);
  }
  toString = () => `setStatus(${this.status})`;
}

/**
 * A rebuild from a Postgres view of the model. `orphans` drops HELD entries from that view, like holds
 * Postgres never recorded (an API crash between Lua and Postgres); `stale` reuses the current generation.
 */
class Rebuild implements Command {
  readonly orphans: readonly boolean[];
  readonly stale: boolean;
  constructor(orphans: readonly boolean[], stale: boolean) {
    this.orphans = orphans;
    this.stale = stale;
  }
  check = () => true;
  async run(model: Model, real: Real) {
    const kept = [...model.entries].filter(
      ([, entry], i) => !(entry.s === 'HELD' && this.orphans[i % this.orphans.length] === true),
    );
    const units = (state: RsvState) => kept.reduce((sum, [, e]) => sum + (e.s === state ? e.q : 0), 0);
    const quotas: Record<string, number> = {};
    for (const [, e] of kept) if (e.s !== 'RELEASED') quotas[e.u] = (quotas[e.u] ?? 0) + e.q;
    const gen = this.stale ? model.gen : model.gen + 1;
    const snapshot: RebuildSnapshot = {
      ...model.snapshot,
      gen,
      reserved: units('HELD'),
      sold: units('COMMITTED'),
      meta: { ...model.snapshot.meta, status: model.pgStatus },
      entries: kept.map(([rid, e]) => ({
        rid,
        u: e.u,
        q: e.q,
        s: e.s,
        fp: fpOf(model, e.q),
        k: 'k',
        expAt: 1,
      })),
      quotas,
    };

    const result = await fdRebuild(real.redis, model.dropId, snapshot);

    if (this.stale) {
      expect(result).toEqual({ kind: 'STALE' });
    } else {
      expect(result).toEqual({ kind: 'OK' });
      model.entries.clear();
      for (const [rid, e] of kept) model.entries.set(rid, e);
      model.uq.clear();
      for (const [userId, n] of Object.entries(quotas)) model.uq.set(userId, n);
      model.gen = gen;
      model.seq = 0;
      model.status = model.pgStatus;
      model.held = snapshot.reserved;
      model.sold = snapshot.sold;
      model.avail = model.total - snapshot.reserved - snapshot.sold;
    }
    await expectMatches(model, real);
  }
  toString = () => `rebuild(${this.stale ? 'stale' : `orphans ${this.orphans.map(Number).join('')}`})`;
}

/** The fingerprint Redis stores for a reserve of `qty` on the model's drop. */
const fpOf = (model: Model, qty: number) => {
  const { fingerprint } = reserveInput(model.dropId, model.users[0] ?? '', qty);
  return Buffer.from(fingerprint).toString('hex');
};

const user = fc.nat({ max: USERS - 1 });
const key = fc.nat({ max: KEYS_PER_USER - 1 });
const qty = fc.oneof(
  { arbitrary: fc.integer({ min: 1, max: 2 }), weight: 9 },
  { arbitrary: fc.constantFrom(0, 3, 11), weight: 1 },
);
const reserve = fc.tuple(user, key, qty).map(([u, k, q]) => new Reserve(u, k, q));
const confirm = fc.tuple(user, key).map(([u, k]) => new Settle('confirm', u, k));
const release = fc.tuple(user, key).map(([u, k]) => new Settle('release', u, k));
const setStatus = fc
  .constantFrom<RedisDropStatus>('LIVE', 'LIVE', 'SCHEDULED', 'PAUSED', 'ENDED', 'RECONCILING')
  .map((status) => new SetStatus(status));
const rebuild = fc
  .tuple(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), fc.boolean())
  .map(([orphans, stale]) => new Rebuild(orphans, stale));
// Listed more than once to weight them: admissions and releases are where the arithmetic happens.
const commands = fc.commands(
  [reserve, reserve, reserve, confirm, confirm, release, release, setStatus, rebuild],
  {
    maxCommands: 50,
  },
);

let redis: FlashdropRedis;

beforeAll(async () => {
  redis = await connectTestRedis();
});

afterAll(async () => {
  await redis.close();
});

describe('the flashdrop library against a pure model', () => {
  it('agrees on every reply and keeps INV-9 and the uq sums after every step', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 4 }),
        commands,
        async (total, limit, cmds) => {
          const { dropId, snapshot } = await armTestDrop(redis, { total, limit });
          try {
            const users = Array.from({ length: USERS }, () => randomUUID());
            const model: Model = {
              dropId,
              users,
              rids: users.map(() => Array.from({ length: KEYS_PER_USER }, () => randomUUID())),
              total,
              limit,
              snapshot,
              status: 'LIVE',
              pgStatus: 'LIVE',
              gen: 1,
              seq: 0,
              avail: total,
              held: 0,
              sold: 0,
              entries: new Map(),
              uq: new Map(),
            };
            await fc.asyncModelRun(() => ({ model, real: { redis } }), cmds);
          } finally {
            await deleteDropKeys(redis, dropId);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
