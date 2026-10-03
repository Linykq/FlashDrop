import type { Logger } from '@flashdrop/config';
import { DROP_LOCK_NAMESPACE, type PoolProfile, pgErrorOf } from '@flashdrop/db';
import { BugError, DomainError, RetryError } from '@flashdrop/domain';
import type pg from 'pg';
import { canonicalUuid } from './keys';

/*
 * The drop lock (design §4.7): everything that rebuilds a drop or writes its Redis status runs under one
 * per-drop Postgres advisory lock, held by a session on a dedicated connection: `syncDropFromPostgres` (arm,
 * admin reconcile, every reconciler rebuild), admin pause/resume/end, and the drop scheduler. `api` and
 * `worker` share it through Postgres, so two rebuilds of one drop, or a rebuild and a status change, never
 * interleave. The lock is session-level: it vanishes with a dead holder's connection, which is how the
 * reconciler tells a dead rebuild from a slow one.
 *
 * Lock order: this lock is taken before any row lock and never while holding one, and the work under it
 * runs on other sessions, so it cannot join a deadlock cycle with the reserve transaction's row locks.
 */

/**
 * The pool the lock sessions come from. No `transaction_timeout`: the lock outlives the short transactions
 * that run on the caller's own pool while it is held. The statement and idle limits only bound a wedged
 * session; an admin's lock wait sets its own `lock_timeout` per acquisition.
 */
export const DROP_LOCK_POOL_PROFILE = {
  settings: { statement_timeout: '30s', idle_in_transaction_session_timeout: '15s' },
  connectionTimeoutMillis: 5_000,
} as const satisfies PoolProfile;

/** How long an admin call waits for a busy drop before answering 409 `DROP_BUSY` (§4.7). */
export const DROP_LOCK_TIMEOUT_MS = 10_000;

export interface DropLockDeps {
  /** A pool built with `DROP_LOCK_POOL_PROFILE`. */
  readonly pool: pg.Pool;
  readonly logger: Pick<Logger, 'warn'>;
}

/** Proof, handed to the callback, that the caller holds the lock of `dropId`. */
export interface HeldDropLock {
  readonly dropId: string;
  /** False once released, or once the lock session's connection was lost (the lock went with it). */
  readonly held: boolean;
}

const issued = new WeakSet<HeldDropLock>();

/**
 * Throws unless `lock` came from this module and is still held. A lock lost with its connection is a
 * `RetryError`: the drop may already be rebuilding under its next holder, so this one must stop writing.
 */
export function assertDropLockHeld(lock: HeldDropLock): void {
  if (!issued.has(lock)) throw new BugError('not a lock from withDropLock or tryWithDropLock');
  if (!lock.held) throw new RetryError(`drop lock of ${lock.dropId} is no longer held`);
}

// hashtextextended(..., 0) gives the bigint key the design specifies, as `dropLockKey` in packages/db
// spells it for the seed. Ids are bound lowercased, as Postgres prints a uuid, so every caller derives the
// same key.
const LOCK_KEY = `hashtextextended('${DROP_LOCK_NAMESPACE}' || $1::uuid::text, 0)`;

/**
 * Runs `fn` holding the drop lock, waiting up to `timeoutMs` for it (admin paths). A drop that stays busy
 * throws `DomainError('DROP_BUSY')`, which `api` answers with 409.
 */
export async function withDropLock<T>(
  deps: DropLockDeps,
  dropId: string,
  fn: (lock: HeldDropLock) => Promise<T>,
  options: { readonly timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DROP_LOCK_TIMEOUT_MS;
  const id = canonicalUuid('dropId', dropId);
  const client = await deps.pool.connect();
  try {
    // lock_timeout bounds only this wait. SET LOCAL needs a transaction; a session-level advisory lock taken
    // inside one survives its COMMIT. statement_timeout is lifted past lock_timeout, so a long wait ends as
    // a lock timeout (55P03, DROP_BUSY) rather than a cancelled statement.
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
      [`${timeoutMs}ms`, `${timeoutMs + 5_000}ms`],
    );
    await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`, [id]);
    await client.query('COMMIT');
  } catch (error) {
    // The session may hold a half-finished transaction (or be dead): never hand it back to the pool.
    client.release(true);
    if (isLockTimeout(error)) throw new DomainError('DROP_BUSY', `drop ${id} is busy`, { cause: error });
    throw error;
  }
  return runHeld(deps, client, id, fn);
}

/**
 * Runs `fn` holding the drop lock if it is free right now (background loops: a busy drop is skipped this
 * tick).
 */
export async function tryWithDropLock<T>(
  deps: DropLockDeps,
  dropId: string,
  fn: (lock: HeldDropLock) => Promise<T>,
): Promise<{ readonly acquired: true; readonly value: T } | { readonly acquired: false }> {
  const id = canonicalUuid('dropId', dropId);
  const client = await deps.pool.connect();
  let acquired: boolean;
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(${LOCK_KEY}) AS acquired`,
      [id],
    );
    acquired = rows[0]?.acquired === true;
  } catch (error) {
    client.release(true);
    throw error;
  }
  if (!acquired) {
    client.release();
    return { acquired: false };
  }
  return { acquired: true, value: await runHeld(deps, client, id, fn) };
}

async function runHeld<T>(
  deps: DropLockDeps,
  client: pg.PoolClient,
  dropId: string,
  fn: (lock: HeldDropLock) => Promise<T>,
): Promise<T> {
  let held = true;
  const lock: HeldDropLock = {
    dropId,
    get held() {
      return held;
    },
  };
  issued.add(lock);
  // A lost connection takes the lock with it; from then on another holder may already be rebuilding.
  const onLost = () => {
    held = false;
  };
  client.on('error', onLost);
  try {
    return await fn(lock);
  } finally {
    const wasHeld = held;
    held = false;
    client.off('error', onLost);
    await unlock(deps, client, dropId, wasHeld);
  }
}

/**
 * Releases the lock and returns the session to the pool. If that fails the session is destroyed, which
 * releases the lock too, so the outcome of `fn` stands either way.
 */
async function unlock(deps: DropLockDeps, client: pg.PoolClient, dropId: string, wasHeld: boolean) {
  if (!wasHeld) {
    client.release(true);
    return;
  }
  try {
    const { rows } = await client.query<{ released: boolean }>(
      `SELECT pg_advisory_unlock(${LOCK_KEY}) AS released`,
      [dropId],
    );
    if (rows[0]?.released !== true) throw new BugError(`drop lock of ${dropId} was not held by its session`);
    client.release();
  } catch (err) {
    deps.logger.warn({ err, dropId }, 'drop lock release failed; closing its session');
    client.release(true);
  }
}

function isLockTimeout(error: unknown): boolean {
  return pgErrorOf(error)?.code === '55P03'; // lock_not_available
}
