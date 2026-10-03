import {
  BugError,
  PUBLIC_DROP_STATUSES,
  type RESERVE_REPLY_CODES,
  RSV_STATES,
  type RsvState,
} from '@flashdrop/domain';
import { z } from 'zod';

/*
 * Every Lua reply is validated at the boundary (spike §1.7) and turned into a discriminated union on `kind`.
 * With RESP3 (node-redis 6's default) a Lua string arrives as a string, a Lua number as a number, and a
 * missing HMGET field as null (spike §1.1); the gen in `fd_reserve`'s replies is therefore a number for
 * RESERVED and a string for EXISTING, and both parse to a number here.
 */

/** Drop statuses as Redis holds them: the public ones, plus RECONCILING while a rebuild runs (§4.7). */
export const REDIS_DROP_STATUSES = [...PUBLIC_DROP_STATUSES, 'RECONCILING'] as const;
export type RedisDropStatus = (typeof REDIS_DROP_STATUSES)[number];

/** `fd_reserve` answers that end the request in Redis, read-only. */
export const RESERVE_REFUSALS = [
  'RETRY',
  'NO_DROP',
  'NOT_LIVE',
  'LIMIT',
  'SOLD_OUT',
  'FP_MISMATCH',
  'BAD_QTY',
] as const satisfies readonly (typeof RESERVE_REPLY_CODES)[number][];
export type ReserveRefusal = (typeof RESERVE_REFUSALS)[number];

export type ReserveResult =
  /** A new hold under generation `gen`; the Postgres transaction must still record it under that gen. */
  | { readonly kind: 'RESERVED'; readonly gen: number }
  /** The rid already has an entry (same fingerprint): a replay, decided by Postgres. */
  | { readonly kind: 'EXISTING'; readonly state: RsvState; readonly gen: number }
  | { readonly kind: ReserveRefusal };

/** `fd_confirm` (HELD → COMMITTED) and `fd_release` (HELD → RELEASED). */
export type SettleReply =
  | 'OK'
  /** Already in the target state: a duplicate. */
  | 'NOOP'
  /** No entry in this generation: the rebuild that dropped it already counted the outcome. */
  | 'MISSING'
  /** The entry is in the opposite terminal state: an INV-8 breach. */
  | 'CONFLICT'
  | 'NO_DROP'
  | 'RETRY';
export type SettleResult = { readonly kind: SettleReply };

export type RebuildResult = { readonly kind: 'OK' | 'STALE' | 'BAD_SNAPSHOT' };
export type SetStatusResult = { readonly kind: 'OK' | 'NOOP' | 'NO_DROP' | 'RETRY' | 'BAD_STATUS' };
export interface RateLimitHit {
  /** Hits in the current window, this one included. */
  readonly count: number;
  /** Milliseconds until the window resets. */
  readonly ttlMs: number;
}

/** A gen as Lua returns it; the string form only as the library's `parse_int` would accept it. */
const Gen = z.union([
  z.int(),
  z
    .string()
    .regex(/^(0|-?[1-9]\d{0,15})$/)
    .transform(Number),
]);

const ReserveReply = z.union([
  z.tuple([z.literal('RESERVED'), Gen]).transform(([kind, gen]) => ({ kind, gen })),
  z
    .tuple([z.literal('EXISTING'), z.enum(RSV_STATES), Gen])
    .transform(([kind, state, gen]) => ({ kind, state, gen })),
  z.tuple([z.enum(RESERVE_REFUSALS)]).transform(([kind]) => ({ kind })),
]) satisfies z.ZodType<ReserveResult>;

const code = <const T extends readonly [string, ...string[]]>(codes: T) =>
  z.enum(codes).transform((kind) => ({ kind }));

const SettleCode = code([
  'OK',
  'NOOP',
  'MISSING',
  'CONFLICT',
  'NO_DROP',
  'RETRY',
]) satisfies z.ZodType<SettleResult>;
const RebuildCode = code(['OK', 'STALE', 'BAD_SNAPSHOT']) satisfies z.ZodType<RebuildResult>;
const SetStatusCode = code([
  'OK',
  'NOOP',
  'NO_DROP',
  'RETRY',
  'BAD_STATUS',
]) satisfies z.ZodType<SetStatusResult>;
const RateLimitReply = z
  .tuple([z.int().positive(), z.int().nonnegative()])
  .transform(([count, ttlMs]) => ({ count, ttlMs })) satisfies z.ZodType<RateLimitHit>;

/** An unexpected reply means this code and the loaded library disagree: a bug, never a user error. */
function parse<T>(schema: z.ZodType<T>, fn: string, reply: unknown): T {
  const result = schema.safeParse(reply);
  if (!result.success) throw new BugError(`${fn} answered ${JSON.stringify(reply)}`, { cause: result.error });
  return result.data;
}

export const parseReserveReply = (reply: unknown): ReserveResult => parse(ReserveReply, 'fd_reserve', reply);
export const parseConfirmReply = (reply: unknown): SettleResult => parse(SettleCode, 'fd_confirm', reply);
export const parseReleaseReply = (reply: unknown): SettleResult => parse(SettleCode, 'fd_release', reply);
export const parseRebuildReply = (reply: unknown): RebuildResult => parse(RebuildCode, 'fd_rebuild', reply);
export const parseSetStatusReply = (reply: unknown): SetStatusResult =>
  parse(SetStatusCode, 'fd_set_status', reply);
export const parseRateLimitReply = (reply: unknown): RateLimitHit =>
  parse(RateLimitReply, 'fd_rl_hit', reply);
