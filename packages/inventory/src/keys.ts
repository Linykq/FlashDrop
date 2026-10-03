import { BugError } from '@flashdrop/domain';

/*
 * The Redis key schema (design §4.1). All keys of a drop share the hash tag `{d:<dropId>}`, so each Function
 * call touches one slot and the layout is Cluster-ready; the stock channel carries the same tag, so moving
 * `publish()` to sharded SPUBLISH is a one-line change. Keys are only ever built here, from validated ids:
 * an id containing `}` would otherwise move the key out of its drop's slot.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rate-limit route names: no `:`, so `fd:rl:<route>:<subject>` splits unambiguously. */
const ROUTE = /^[A-Za-z0-9._-]{1,64}$/;
/** Rate-limit subjects: a user id or an IP address, IPv6 colons included. */
const SUBJECT = /^\S{1,256}$/;

/**
 * A uuid in the lowercase form Postgres returns, so ids from requests and ids from a rebuild name the same
 * `rsv` and `uq` fields.
 */
export function canonicalUuid(kind: string, id: string): string {
  if (!UUID.test(id)) throw new BugError(`${kind} must be a uuid: ${JSON.stringify(id)}`);
  return id.toLowerCase();
}

const uuid = canonicalUuid;

/** The four keys of one drop, in the order the Functions take them. */
export interface DropKeys {
  /** The drop id the keys were built from, lowercased: the Functions build the stock channel from it. */
  readonly dropId: string;
  /** HASH: status, window, limit, generation and stock counters. One HMGET is an atomic snapshot. */
  readonly inv: string;
  /** HASH: rid → JSON `{u, q, s, fp, k}`, the Redis-side idempotency record. */
  readonly rsv: string;
  /** HASH: userId → units HELD plus COMMITTED (the per-user limit gate). */
  readonly uq: string;
  /** ZSET: rid scored by hold expiry + 30 s grace; HELD entries only; picks safety-net candidates. */
  readonly exp: string;
}

export function dropKeys(dropId: string): DropKeys {
  const id = uuid('dropId', dropId);
  const tag = `{d:${id}}`;
  return { dropId: id, inv: `fd:${tag}:inv`, rsv: `fd:${tag}:rsv`, uq: `fd:${tag}:uq`, exp: `fd:${tag}:exp` };
}

/**
 * A uuid written after each full rebuild and mirrored in `system_state.redis_epoch`; missing or different
 * means the keyspace was wiped (§4.7).
 */
export const EPOCH_KEY = 'fd:epoch';

/** Level stock messages of one drop, `gen:seq:avail:held:sold:status:ts` (§7). Must match `publish()` in Lua. */
export function stockChannel(dropId: string): string {
  return `fd:ch:stock:{d:${uuid('dropId', dropId)}}`;
}

export function roomChannel(roomId: string): string {
  return `fd:ch:room:${uuid('roomId', roomId)}`;
}

export function userChannel(userId: string): string {
  return `fd:ch:user:${uuid('userId', userId)}`;
}

export function dashboardChannel(dropId: string): string {
  return `fd:ch:dash:${uuid('dropId', dropId)}`;
}

/** HASH instanceId → socket count, each field with `HEXPIRE 15` (§7). */
export function viewersKey(roomId: string): string {
  return `fd:viewers:${uuid('roomId', roomId)}`;
}

/** A fixed-window rate-limit counter, written only by `fd_rl_hit` (§11). */
export function rateLimitKey(route: string, subject: string): string {
  if (!ROUTE.test(route) || !SUBJECT.test(subject)) {
    throw new BugError(`invalid rate-limit key parts: ${JSON.stringify([route, subject])}`);
  }
  return `fd:rl:${route}:${subject}`;
}
