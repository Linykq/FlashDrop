import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fdConfirm, fdRateLimitHit, fdRebuild, fdRelease, fdReserve, fdSetStatus } from './calls';
import type { FlashdropRedis } from './client';
import { dropKeys, rateLimitKey } from './keys';
import { armTestDrop, connectTestRedis, deleteDropKeys, emptySnapshot, reserveInput } from './test/redis';

/*
 * Redis does not roll back a Function that errors after a write, so every Function must either error before
 * its first write or not error at all (design §4.2, §13). Each Function runs here against missing and
 * partially written keys; whenever it errors, the four keys must be exactly as before, TTLs included.
 */

let redis: FlashdropRedis;

beforeAll(async () => {
  redis = await connectTestRedis();
});

afterAll(async () => {
  await redis.close();
});

/** Everything observable about one key: its type, content and absolute expiry. */
async function dumpKey(key: string) {
  const type = await redis.type(key);
  const expiresAt = await redis.pExpireTime(key);
  if (type === 'hash') return { type, expiresAt, content: await redis.hGetAll(key) };
  if (type === 'zset') return { type, expiresAt, content: await redis.zRangeWithScores(key, 0, -1) };
  if (type === 'string') return { type, expiresAt, content: await redis.get(key) };
  return { type, expiresAt };
}

async function dumpDrop(dropId: string) {
  const k = dropKeys(dropId);
  return Promise.all([k.inv, k.rsv, k.uq, k.exp].map(dumpKey));
}

interface Fixture {
  readonly dropId: string;
  /** The rid of a HELD entry, when the scenario has one. */
  readonly held: ReturnType<typeof reserveInput>;
}

/** A drop with one HELD entry of 2 units, then damaged by `damage`. */
async function prepare(damage: (fixture: Fixture) => Promise<unknown>): Promise<Fixture> {
  const { dropId } = await armTestDrop(redis, { total: 10, limit: 4 });
  const held = reserveInput(dropId, randomUUID(), 2);
  const reserved = await fdReserve(redis, held);
  if (reserved.kind !== 'RESERVED') throw new Error(`setup reserve answered ${reserved.kind}`);
  await damage({ dropId, held });
  return { dropId, held };
}

const INV_FIELDS = [
  'status',
  'gen',
  'seq',
  'total',
  'avail',
  'held',
  'sold',
  'startsAt',
  'endsAt',
  'holdMs',
  'limit',
  'retainAt',
  'productId',
];

/**
 * Integers as `tonumber()` reads them but Redis's HINCRBY (string2ll) refuses: a check with `tonumber()`
 * passed them, and the Function then failed at its HINCRBY after its first writes.
 */
const LOOSE_INTEGERS = ['1.0', ' 1', '1e0', '0x1'] as const;

const looseScenarios = (value: string): Record<string, (fixture: Fixture) => Promise<unknown>> => ({
  // The field fd_release decrements and fd_reserve increments for the same user.
  [`the holder's uq value ${JSON.stringify(value)}`]: ({ dropId, held }) =>
    redis.hSet(dropKeys(dropId).uq, held.userId, value),
  [`inv held ${JSON.stringify(value)}`]: ({ dropId }) => redis.hSet(dropKeys(dropId).inv, 'held', value),
  [`inv seq ${JSON.stringify(value)}`]: ({ dropId }) => redis.hSet(dropKeys(dropId).inv, 'seq', value),
  [`inv gen ${JSON.stringify(value)}`]: ({ dropId }) => redis.hSet(dropKeys(dropId).inv, 'gen', value),
});

const scenarios: Record<string, (fixture: Fixture) => Promise<unknown>> = {
  'no keys at all': ({ dropId }) => deleteDropKeys(redis, dropId),
  'only the fail-closed hash': async ({ dropId }) => {
    await deleteDropKeys(redis, dropId);
    await fdSetStatus(redis, dropId, 'RECONCILING');
  },
  'inv only': ({ dropId }) => redis.del([dropKeys(dropId).rsv, dropKeys(dropId).uq, dropKeys(dropId).exp]),
  'rsv missing': ({ dropId }) => redis.del(dropKeys(dropId).rsv),
  'uq missing': ({ dropId }) => redis.del(dropKeys(dropId).uq),
  'exp missing': ({ dropId }) => redis.del(dropKeys(dropId).exp),
  'rsv entry not JSON': ({ dropId, held }) => redis.hSet(dropKeys(dropId).rsv, held.rid, 'not json'),
  'rsv entry without qty': ({ dropId, held }) =>
    redis.hSet(
      dropKeys(dropId).rsv,
      held.rid,
      JSON.stringify({ u: held.userId, s: 'HELD', fp: 'x', k: 'k' }),
    ),
  'uq value not an integer': ({ dropId }) => redis.hSet(dropKeys(dropId).uq, 'someone', '1.5'),
  // The field fd_release decrements, so it must be checked before the release's first write.
  "the holder's uq value not an integer": ({ dropId, held }) =>
    redis.hSet(dropKeys(dropId).uq, held.userId, '1.5'),
  'inv seq not an integer': ({ dropId }) => redis.hSet(dropKeys(dropId).inv, 'seq', 'x'),
  ...Object.assign({}, ...LOOSE_INTEGERS.map(looseScenarios)),
  ...Object.fromEntries(
    (['rsv', 'uq', 'exp'] as const).map((name) => [
      `${name} of another type`,
      async ({ dropId }: Fixture) => {
        const key = dropKeys(dropId)[name];
        await redis.del(key);
        await redis.set(key, 'not a hash or zset', { expiration: { type: 'PX', value: 600_000 } });
      },
    ]),
  ),
  ...Object.fromEntries(
    INV_FIELDS.map((field) => [
      `inv without ${field}`,
      ({ dropId }: Fixture) => redis.hDel(dropKeys(dropId).inv, field),
    ]),
  ),
};

const calls: Record<string, (fixture: Fixture) => Promise<unknown>> = {
  'fd_reserve, new rid': ({ dropId }) => fdReserve(redis, reserveInput(dropId, randomUUID(), 1)),
  'fd_reserve, replay': ({ held }) => fdReserve(redis, held),
  'fd_reserve, same user again': ({ dropId, held }) => fdReserve(redis, reserveInput(dropId, held.userId, 1)),
  fd_confirm: ({ dropId, held }) => fdConfirm(redis, dropId, held.rid),
  fd_release: ({ dropId, held }) => fdRelease(redis, dropId, held.rid),
  'fd_rebuild, valid': ({ dropId }) => fdRebuild(redis, dropId, emptySnapshot({ gen: 99 })),
  'fd_rebuild, malformed': ({ dropId }) =>
    fdRebuild(redis, dropId, { ...emptySnapshot({ gen: 99 }), total: -1 }),
  'fd_set_status LIVE': ({ dropId }) => fdSetStatus(redis, dropId, 'LIVE'),
  'fd_set_status ENDED': ({ dropId }) => fdSetStatus(redis, dropId, 'ENDED'),
  'fd_set_status RECONCILING': ({ dropId }) => fdSetStatus(redis, dropId, 'RECONCILING'),
};

/** Calls that must error (before any write) in a scenario, not just leave the keys alone. */
const REFUSED_UP_FRONT: Readonly<Record<string, readonly string[]>> = {
  "the holder's uq value not an integer": ['fd_release', 'fd_reserve, same user again'],
  'exp of another type': ['fd_reserve, new rid', 'fd_confirm', 'fd_release'],
  'uq of another type': ['fd_reserve, new rid', 'fd_release'],
  'rsv of another type': ['fd_reserve, new rid', 'fd_confirm', 'fd_release'],
  'inv seq not an integer': ['fd_set_status ENDED'],
  ...Object.fromEntries(
    LOOSE_INTEGERS.flatMap((value) => {
      const counters = ['fd_reserve, new rid', 'fd_reserve, same user again', 'fd_confirm', 'fd_release'];
      return [
        [`the holder's uq value ${JSON.stringify(value)}`, ['fd_release', 'fd_reserve, same user again']],
        [`inv held ${JSON.stringify(value)}`, counters],
        [`inv seq ${JSON.stringify(value)}`, [...counters, 'fd_set_status ENDED']],
        [`inv gen ${JSON.stringify(value)}`, ['fd_reserve, new rid', 'fd_reserve, same user again']],
      ];
    }),
  ),
};

/** Scenarios where `fd_set_status RECONCILING` must still succeed: it starts the rebuild that repairs them. */
const RECONCILES = new Set([
  'inv seq not an integer',
  ...LOOSE_INTEGERS.flatMap((value) => [
    `inv seq ${JSON.stringify(value)}`,
    `inv gen ${JSON.stringify(value)}`,
  ]),
]);

describe('every Function on missing and partial keys', () => {
  for (const [scenario, damage] of Object.entries(scenarios)) {
    it(`errors before its first write or not at all: ${scenario}`, async () => {
      const outcomes: Record<string, string> = {};
      for (const [name, call] of Object.entries(calls)) {
        const fixture = await prepare(damage);
        try {
          const before = await dumpDrop(fixture.dropId);
          const result = await call(fixture).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          if (result.ok) {
            outcomes[name] = JSON.stringify(result.value);
          } else {
            outcomes[name] = `error: ${String(result.error)}`;
            expect(await dumpDrop(fixture.dropId), `${name} wrote before failing`).toEqual(before);
          }
        } finally {
          await deleteDropKeys(redis, fixture.dropId);
        }
      }
      // A partial hash is never the outcome of a status change: only RECONCILING may create inv.
      if (scenario === 'no keys at all') {
        expect(outcomes['fd_set_status LIVE']).toBe(JSON.stringify({ kind: 'NO_DROP' }));
        expect(outcomes['fd_reserve, new rid']).toBe(JSON.stringify({ kind: 'NO_DROP' }));
      }
      // Regressions: these used to fail after their first writes (a RELEASED entry with its stock back
      // but its quota and exp member left; a HELD entry without an exp member). Now they are refused.
      const refused = REFUSED_UP_FRONT[scenario] ?? [];
      for (const name of refused) expect(outcomes[name], name).toMatch(/^error: /);
      // RECONCILING starts the rebuild that repairs a corrupt seq or gen, so it must still succeed.
      if (RECONCILES.has(scenario)) {
        expect(outcomes['fd_set_status RECONCILING']).toBe(JSON.stringify({ kind: 'OK' }));
      }
    });
  }

  it('refuses a reserve on a hash that lost a field it writes or schedules with, instead of half applying it', async () => {
    for (const field of ['holdMs', 'retainAt', 'held', 'seq']) {
      const fixture = await prepare(({ dropId }) => redis.hDel(dropKeys(dropId).inv, field));
      try {
        await expect(fdReserve(redis, reserveInput(fixture.dropId, randomUUID(), 1))).rejects.toThrow(
          `inv field ${field} missing`,
        );
      } finally {
        await deleteDropKeys(redis, fixture.dropId);
      }
    }
  });

  // Regression: with seq '1.0', fd_set_status RECONCILING wrote the status and then failed at its HINCRBY,
  // so every rebuild failed at its first step and the drop stayed RECONCILING (503) until a manual repair.
  it('lets a sync repair a seq or gen that Redis would refuse to increment', async () => {
    for (const field of ['seq', 'gen']) {
      for (const value of LOOSE_INTEGERS) {
        const fixture = await prepare(({ dropId }) => redis.hSet(dropKeys(dropId).inv, field, value));
        try {
          expect(await fdSetStatus(redis, fixture.dropId, 'RECONCILING')).toEqual({ kind: 'OK' });
          expect(await fdRebuild(redis, fixture.dropId, emptySnapshot({ total: 10, gen: 7 }))).toEqual({
            kind: 'OK',
          });
          expect(await fdReserve(redis, reserveInput(fixture.dropId, randomUUID(), 1))).toEqual({
            kind: 'RESERVED',
            gen: 7,
          });
        } finally {
          await deleteDropKeys(redis, fixture.dropId);
        }
      }
    }
  });

  it('refuses a rate-limit hit with a bad window before counting it', async () => {
    const key = rateLimitKey('inventory-test', randomUUID());
    await expect(fdRateLimitHit(redis, key, 0)).rejects.toThrow('rate-limit window');
    expect(await redis.exists(key)).toBe(0);
  });
});
