import type { DropStatus } from './statuses';

/*
 * Drop lifecycle rules (design §4.6, §4.7). Every status change runs under the per-drop lock and is a CAS on
 * the statuses listed here, so a lost race answers "wrong status" instead of overwriting a newer one.
 */

/**
 * How long after `ends_at` a drop stays tracked and its Redis keys live (`retainAt`, §4.1): idempotent
 * replays work through Redis until then, and the sweeper's loops keep repairing the drop.
 */
export const DROP_RETENTION_SECONDS = 24 * 60 * 60;

/** Limits the `drops` CHECKs enforce (§3). */
export const PER_USER_LIMIT_RANGE = { min: 1, max: 10 } as const;
export const HOLD_SECONDS_RANGE = { min: 10, max: 900 } as const;
export const PAYMENT_SECONDS_RANGE = { min: 10, max: 1800 } as const;

/**
 * Admin actions on an armed or draft drop and the statuses each may start from. `resume` lands on the
 * status the clock implies (SCHEDULED before `starts_at`, LIVE inside the window, ENDED after it), so a
 * paused drop never reopens outside its window.
 */
export const DROP_ACTION_FROM = {
  arm: ['DRAFT'],
  pause: ['SCHEDULED', 'LIVE'],
  resume: ['PAUSED'],
  end: ['SCHEDULED', 'LIVE', 'PAUSED'],
} as const satisfies Readonly<Record<string, readonly DropStatus[]>>;
export type DropAction = keyof typeof DROP_ACTION_FROM;
