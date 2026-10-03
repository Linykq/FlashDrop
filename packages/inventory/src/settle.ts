import { type Db, getOrder, isPastRetention, markRedisSettled } from '@flashdrop/db';
import { isTerminalOrderStatus, type OrderStatus } from '@flashdrop/domain';
import { fdConfirm, fdRelease } from './calls';
import type { FlashdropRedis } from './client';
import type { SyncNudger } from './nudge';

/*
 * `settleRedis` (design §6.5): applies an order's terminal Postgres outcome to Redis, then records that in
 * `redis_settled_at`. Shared by the settlement consumer (the fast path), the sweeper's settle-safety-net
 * (lost, slow or dead-lettered events) and orphan-scan. It always reads Postgres first: Redis gives stock
 * back only after Postgres committed the outcome (the ordering rule, §4.3), and the Lua state machine makes
 * every repeat a NOOP, so concurrent or duplicate callers are harmless.
 */

export interface SettleDeps {
  readonly db: Db;
  readonly redis: FlashdropRedis;
  readonly nudger: SyncNudger;
}

/**
 * How Redis came to reflect the outcome: `OK` applied now, `NOOP` already applied, `MISSING` not in this
 * generation (the rebuild counted the outcome), `PAST_RETENTION` the drop's keys are gone for good (ENDED
 * more than 24 h ago).
 */
export type SettledVia = 'OK' | 'NOOP' | 'MISSING' | 'PAST_RETENTION';

/**
 * Transient: the drop is RECONCILING, or not in Redis yet (a rebuild was nudged). Consumers pause and retry;
 * the safety net tries again next tick.
 */
export interface SettleRetry {
  readonly kind: 'RETRY';
  readonly reason: 'RECONCILING' | 'NO_DROP';
}

/** INV-8 breach: Redis holds the opposite terminal state. Dead-letter or quarantine, and alert. */
export interface SettleConflict {
  readonly kind: 'CONFLICT';
  readonly status: OrderStatus;
}

export type SettleOutcome =
  /** Redis reflects the outcome and `redis_settled_at` is set. */
  | { readonly kind: 'SETTLED'; readonly via: SettledVia }
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_TERMINAL' | 'ALREADY_SETTLED' }
  | SettleRetry
  | SettleConflict
  | { readonly kind: 'UNKNOWN_ORDER' };

/** A terminal order, as read from Postgres. Terminal statuses never change, so the read stays true. */
export interface TerminalOrderRef {
  readonly id: string;
  readonly dropId: string;
  readonly status: OrderStatus;
}

export type ApplyOutcome =
  | { readonly kind: 'APPLIED'; readonly via: SettledVia }
  | SettleRetry
  | SettleConflict;

/**
 * The Redis half of a settlement, for a terminal order the caller has just read from Postgres. It does not
 * write `redis_settled_at`: on `APPLIED` the caller records it, one order at a time (`settleRedis`) or for a
 * whole batch at once (the safety net's `markRedisSettledMany`).
 */
export async function applySettlement(deps: SettleDeps, order: TerminalOrderRef): Promise<ApplyOutcome> {
  // REJECTED releases too: Postgres never granted its stock, but Redis may still hold it.
  const result =
    order.status === 'PAID'
      ? await fdConfirm(deps.redis, order.dropId, order.id)
      : await fdRelease(deps.redis, order.dropId, order.id);
  switch (result.kind) {
    case 'RETRY':
      return { kind: 'RETRY', reason: 'RECONCILING' };
    case 'NO_DROP':
      if (await isPastRetention(deps.db, order.dropId)) return { kind: 'APPLIED', via: 'PAST_RETENTION' };
      await deps.nudger.nudge(order.dropId);
      return { kind: 'RETRY', reason: 'NO_DROP' };
    case 'CONFLICT':
      return { kind: 'CONFLICT', status: order.status };
    case 'OK':
    case 'NOOP':
    case 'MISSING':
      return { kind: 'APPLIED', via: result.kind };
  }
}

/**
 * `force` (orphan-scan) settles even when `redis_settled_at` is set: its candidate is a HELD entry by
 * construction, e.g. one a lost AOF tail resurrected after Postgres settled it, and only this call repairs
 * it.
 */
export async function settleRedis(
  deps: SettleDeps,
  orderId: string,
  options: { readonly force?: boolean } = {},
): Promise<SettleOutcome> {
  const order = await getOrder(deps.db, orderId);
  if (order === undefined) return { kind: 'UNKNOWN_ORDER' };
  if (!isTerminalOrderStatus(order.status)) return { kind: 'SKIPPED', reason: 'NOT_TERMINAL' };
  if (order.redisSettledAt !== null && options.force !== true) {
    return { kind: 'SKIPPED', reason: 'ALREADY_SETTLED' };
  }
  const applied = await applySettlement(deps, order);
  if (applied.kind !== 'APPLIED') return applied;
  await markRedisSettled(deps.db, orderId);
  return { kind: 'SETTLED', via: applied.via };
}
