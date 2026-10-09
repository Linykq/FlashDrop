import { setTimeout as sleep } from 'node:timers/promises';
import { loadEnv, TestHooksEnv } from '@flashdrop/config';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import type { Executor } from './client';

/*
 * Race-matrix hook points (design §13). With `FD_TEST_HOOKS=true`, a named point in product code waits while
 * a test holds that point's advisory lock. A test can thereby stop one side of a race at an exact line, often
 * inside its transaction with its row locks held, run the other side against it, and only then let the first
 * side go on: interleavings that timing alone would hit only by luck.
 *
 * Off (the default, and always in the stack), a point is one cached boolean check: it never touches Postgres.
 * Advisory locks belong to one database, and every integration test file has its own, so files that use the
 * same point in parallel never meet.
 */

/**
 * Only points a test cannot reach from outside: inside a transaction the code under test owns, or between
 * two of its statements. Elsewhere tests interpose through what the code is given (the api reserve service's
 * ports, the fake PSP's callbacks).
 */
export const TEST_HOOK_POINTS = [
  /** `markPaid`: the CAS updated the order, whose row lock its transaction now holds until commit. */
  'paid.locked',
  /** expire-orders batch: the due orders are EXPIRED, their row locks held until commit. */
  'expired.locked',
  /** orphan-scan: Postgres had no order for an expired hold; the tombstone has not been written yet. */
  'orphan.unrecorded',
] as const;

export type TestHookPoint = (typeof TEST_HOOK_POINTS)[number];

/** The first key of every hook's two-key advisory lock: "FDTH" in ASCII. */
const HOOK_LOCK_CLASS = 0x4644_5448;

function hookKey(point: TestHookPoint): readonly [number, number] {
  return [HOOK_LOCK_CLASS, TEST_HOOK_POINTS.indexOf(point) + 1];
}

let enabled: boolean | undefined;

/** `FD_TEST_HOOKS`, validated and read once per process. */
function hooksEnabled(): boolean {
  enabled ??= loadEnv([TestHooksEnv]).FD_TEST_HOOKS;
  return enabled;
}

/**
 * A hook point: with hooks on, waits until no test holds `point`. The lock taken is shared and
 * transaction-scoped, so any number of sessions pass a point nobody holds. Inside a transaction (`db` is a
 * `Tx`) the share lasts until the transaction ends, so the point cannot be held again before then; outside one
 * it ends with the statement. A wait longer than the session's `statement_timeout` fails the caller.
 */
export async function testHook(db: Executor, point: TestHookPoint): Promise<void> {
  if (!hooksEnabled()) return;
  const [classId, objId] = hookKey(point);
  await db.execute(sql`SELECT pg_advisory_xact_lock_shared(${classId}::int, ${objId}::int)`);
}

/** A hook point a test holds: product code that reaches it waits until `release`. */
export interface HeldTestHook {
  /** Resolves once `count` sessions wait at the point; rejects after `timeoutMs`. */
  waitForArrivals(count?: number, timeoutMs?: number): Promise<void>;
  release(): Promise<void>;
}

const WAITERS = `
  SELECT count(*)::int AS waiting FROM pg_locks
  WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND classid = $1::int::oid AND objid = $2::int::oid`;

/**
 * Test side: takes `point` exclusively on a connection of its own (`pool` must reach the database the code
 * under test uses), so the code waits there until `release`. Needs `FD_TEST_HOOKS=true` in the process that
 * runs that code.
 */
export async function holdTestHook(pool: pg.Pool, point: TestHookPoint): Promise<HeldTestHook> {
  const [classId, objId] = hookKey(point);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [classId, objId]);
  } catch (error) {
    client.release();
    throw error;
  }
  let released = false;
  return {
    async waitForArrivals(count = 1, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { rows } = await client.query<{ waiting: number }>(WAITERS, [classId, objId]);
        if ((rows[0]?.waiting ?? 0) >= count) return;
        if (Date.now() > deadline) throw new Error(`${count} session(s) never reached test hook ${point}`);
        await sleep(10);
      }
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [classId, objId]);
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Test side: resolves once `count` sessions of this database wait for a row or transaction lock (not for a
 * hook point), e.g. a CAS queued behind a transaction a hook holds open.
 */
export async function waitForLockWaiters(pool: pg.Pool, count = 1, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ waiting: number }>(`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event <> 'advisory'`);
    if ((rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`${count} session(s) never queued on a row lock`);
    await sleep(10);
  }
}
