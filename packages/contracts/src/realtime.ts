import { PUBLIC_DROP_STATUSES } from '@flashdrop/domain';
import { z } from 'zod';
import { StockLevel } from './catalog';
import { Uuid } from './common';
import { ListingStatusMessage } from './listing';
import { OrderStatus } from './reservations';

/*
 * The real-time protocol (design §7): JSON text frames on one WebSocket per tab, `GET /ws` (`/ws/1` and
 * `/ws/2` through Caddy pin an instance). A client subscribes to topics; the gateway answers each with a
 * `snapshot`, then pushes coalesced `delta`s (at most one per topic every 100 ms). Every snapshot and delta
 * carries a full level with its version `(gen, seq)`, compared lexicographically: clients apply a frame only
 * if it is strictly newer than what they hold, so a snapshot and a delta, or two instances, can arrive in
 * any order. Signed-in sockets also get their owner's `order` and `listing` events, never coalesced.
 *
 * The second half of this module is what publishers put on the Redis channels the gateway subscribes to.
 */

/** Same-origin path of the gateway; Caddy also routes `/ws/1` and `/ws/2` to one instance each. */
export const WS_PATH = '/ws';
/** The largest client frame the gateway accepts; a bigger one closes the socket with 1009. */
export const WS_MAX_PAYLOAD_BYTES = 4 * 1024;
/** Client frames per second per socket; one more closes the socket with 1008. */
export const WS_MAX_CLIENT_MESSAGES_PER_SECOND = 20;
/** Topics one socket may hold at once (and name in one `sub`). */
export const WS_MAX_TOPICS_PER_SOCKET = 64;
/**
 * Topic joins one socket may make per `WS_JOIN_WINDOW_MS`; one more closes it with 1008. Each join can cost
 * a Redis read, a SUBSCRIBE or a Postgres lookup, so churning topics is what an abusive client would do. The
 * storefront's busiest page holds 20 stock topics and a tab re-joins them only after a 2 s linger, so a
 * fast-clicking visitor stays well inside two full sockets' worth; a reconnect gets a fresh budget.
 */
export const WS_MAX_JOINS_PER_WINDOW = 2 * WS_MAX_TOPICS_PER_SOCKET;
export const WS_JOIN_WINDOW_MS = 10_000;

/**
 * Application-level liveness (§7). Server pings are control frames that browser JavaScript cannot see, so a
 * gateway that hangs, or a silent network partition, would leave a page showing stale stock as live until
 * TCP gives up minutes later. A client that opts in with `?beat=1` on the upgrade URL gets a `beat` on any
 * socket that has sent it nothing for `intervalMs`, so it hears from the gateway at least that often, and
 * treats `deadAfterMs` of silence as a lost socket: it closes it, reconnects and, after 5 s, shows "Live
 * updates paused" and polls. Opt-in, because a client that does not know the frame would report it as
 * malformed.
 */
export const WS_HEARTBEAT = {
  query: 'beat',
  intervalMs: 10_000,
  deadAfterMs: 25_000,
} as const;

/**
 * Close codes the gateway uses. A client reconnects with full-jitter backoff after any of them; after
 * `POLICY` it has a bug to fix first (a malformed or too frequent frame).
 */
export const WS_CLOSE = {
  /** The instance is shutting down: reconnect (Caddy picks another instance). */
  GOING_AWAY: 1001,
  /** A binary frame. */
  UNSUPPORTED_DATA: 1003,
  /** A frame that is not JSON, fails the schema, or exceeds the message rate. */
  POLICY: 1008,
  /**
   * The socket stalled (its send buffer stayed full, design §7 backpressure), or the gateway could not set
   * up a topic it asked for (Redis or Postgres did not answer): the reconnect resubscribes everything and
   * gets fresh snapshots.
   */
  TRY_AGAIN_LATER: 1013,
  /** The session the socket was opened with expired: reconnect, with the current cookie or anonymously. */
  SESSION_EXPIRED: 4401,
} as const;

/** Milliseconds since the Unix epoch. */
const EpochMs = z.int().nonnegative();

/** A uuid as Postgres renders it (lowercase), so one drop never has two topic spellings. */
const TopicId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a lowercase uuid');

export const TOPIC_KINDS = ['stock', 'room', 'dash'] as const;
export const TopicKind = z.enum(TOPIC_KINDS);
export type TopicKind = z.infer<typeof TopicKind>;

/**
 * A subscribable topic. `stock:<dropId>` and `room:<roomId>` are public; `dash:<dropId>` is admin only. The
 * owner's `user` topic is implicit: every signed-in socket has it and never names it.
 */
export const Topic = z.templateLiteral([TopicKind, ':', TopicId]);
export type Topic = z.infer<typeof Topic>;

export function topicOf(kind: TopicKind, id: string): Topic {
  return `${kind}:${id.toLowerCase()}`;
}

/** Splits a topic into its kind and id. */
export function splitTopic(topic: Topic): { readonly kind: TopicKind; readonly id: string } {
  const at = topic.indexOf(':');
  return { kind: TopicKind.parse(topic.slice(0, at)), id: topic.slice(at + 1) };
}

// ---------------------------------------------------------------------------------------------------------
// Client to server

export const SubscribeMessage = z.object({
  type: z.literal('sub'),
  topics: z.array(Topic).min(1).max(WS_MAX_TOPICS_PER_SOCKET),
});
export type SubscribeMessage = z.infer<typeof SubscribeMessage>;

export const UnsubscribeMessage = z.object({
  type: z.literal('unsub'),
  topics: z.array(Topic).min(1).max(WS_MAX_TOPICS_PER_SOCKET),
});
export type UnsubscribeMessage = z.infer<typeof UnsubscribeMessage>;

export const ClientMessage = z.discriminatedUnion('type', [SubscribeMessage, UnsubscribeMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------------------------------------
// Server to client

/**
 * The first frame on every socket. `instanceId` names the api instance (tests assert that `/ws/1` and
 * `/ws/2` differ); `serverTime` lets countdowns correct the client clock's offset.
 */
export const HelloMessage = z.object({
  type: z.literal('hello'),
  instanceId: z.string().min(1).max(64),
  serverTime: EpochMs,
});
export type HelloMessage = z.infer<typeof HelloMessage>;

/**
 * A level's version. Stock: `(drop_inventory.redis_gen, Redis seq)`. Dashboard: `(0,
 * drop_sales_totals.version)`. Room: `(0, the gateway's clock in ms when the level was last known true)`;
 * all containers share the host clock (§1), so a fresh snapshot from another instance is newer than what a
 * reconnecting client holds.
 */
const Version = {
  gen: z.int().min(-1),
  seq: z.int().nonnegative(),
};

/** The topic's full level as of `(gen, seq)`, sent right after `sub` (and never older than a sent delta). */
export const SnapshotMessage = z.object({
  type: z.literal('snapshot'),
  topic: Topic,
  ...Version,
  data: z.unknown(),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessage>;

/**
 * The topic's newest full level, coalesced: at most one per topic every 100 ms. `ts` is when the OLDEST
 * change folded into it since the previous frame happened, in ms; for stock it is the Redis `TIME` of that
 * mutation. So `receive time - ts` is the mutation-to-client latency of the frame's longest-waiting change,
 * coalescing delay included (§7): the newest change's time would hide up to a tick of it.
 */
export const DeltaMessage = z.object({
  type: z.literal('delta'),
  topic: Topic,
  ...Version,
  ts: EpochMs,
  data: z.unknown(),
});
export type DeltaMessage = z.infer<typeof DeltaMessage>;

/**
 * `order{orderId, status, version}`: the owner's order changed. `version` is `orders.version` after the
 * change, so a client keeps the newest message per order and ignores older ones that arrive late; it then
 * reads the order itself for the details.
 */
export const OrderStatusMessage = z.object({
  type: z.literal('order'),
  orderId: Uuid,
  status: OrderStatus,
  version: z.int().positive(),
});
export type OrderStatusMessage = z.infer<typeof OrderStatusMessage>;

/**
 * Topics of a `sub` the gateway did not subscribe: `FORBIDDEN` (a `dash:` topic without an admin session),
 * `TOO_MANY_TOPICS` (the socket already holds `WS_MAX_TOPICS_PER_SOCKET`), `NOT_FOUND` (no such drop or
 * room). The rest of the `sub` applies.
 */
export const TOPIC_ERROR_CODES = ['FORBIDDEN', 'TOO_MANY_TOPICS', 'NOT_FOUND'] as const;
export const TopicErrorMessage = z.object({
  type: z.literal('error'),
  code: z.enum(TOPIC_ERROR_CODES),
  topics: z.array(Topic).min(1),
});
export type TopicErrorMessage = z.infer<typeof TopicErrorMessage>;

/** Sent only to sockets that opted in (`WS_HEARTBEAT`): the gateway is alive, though nothing changed. */
export const BeatMessage = z.object({
  type: z.literal('beat'),
  serverTime: EpochMs,
});
export type BeatMessage = z.infer<typeof BeatMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  HelloMessage,
  SnapshotMessage,
  DeltaMessage,
  OrderStatusMessage,
  ListingStatusMessage,
  TopicErrorMessage,
  BeatMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---------------------------------------------------------------------------------------------------------
// `data` of snapshots and deltas, by topic kind

/** `stock:<dropId>`: the drop's level; its version is the frame's `(gen, seq)`. */
export const StockFrameData = StockLevel.omit({ gen: true, seq: true });
export type StockFrameData = z.infer<typeof StockFrameData>;

/**
 * The drop a live room is selling: its LIVE or PAUSED drop, else its next SCHEDULED one, else the one that
 * ended last. A client whose page shows another drop reloads it.
 */
export const PinnedDrop = z.object({
  dropId: Uuid,
  status: z.enum(PUBLIC_DROP_STATUSES),
});
export type PinnedDrop = z.infer<typeof PinnedDrop>;

/** `room:<roomId>`: the pinned drop (null when the room has none) and the viewers across all instances. */
export const RoomFrameData = z.object({
  pinned: PinnedDrop.nullable(),
  viewers: z.int().nonnegative(),
});
export type RoomFrameData = z.infer<typeof RoomFrameData>;

// `dash:<dropId>`: `DashboardTotals` (./dashboard), the `totals` of the consumer's `DashboardTotalsMessage`,
// whose `version` is the frame's `seq`.

// ---------------------------------------------------------------------------------------------------------
// Redis channels (publisher to gateway). Stock levels are published by the Lua Functions themselves, as
// `gen:seq:avail:held:sold:status:ts` (`parseStockMessage` in packages/inventory); dashboard totals by the
// `sales-dashboard` consumer, as `DashboardTotalsMessage` (./dashboard). The others are below.

/**
 * On `fd:ch:user:<userId>`: forwarded unchanged to that user's sockets, never coalesced. Best effort: the
 * pages that use them also poll.
 */
export const UserEventMessage = z.discriminatedUnion('type', [OrderStatusMessage, ListingStatusMessage]);
export type UserEventMessage = z.infer<typeof UserEventMessage>;

/**
 * On `fd:ch:room:<roomId>`: a drop of the room changed status (the drop scheduler's transitions, §4.6). A
 * nudge, not state: the gateway re-reads the room's pinned drop from Postgres, so a lost or reordered
 * message costs at most the gateway's periodic re-read.
 */
export const RoomChangedMessage = z.object({
  type: z.literal('drop'),
  dropId: Uuid,
  status: z.enum(PUBLIC_DROP_STATUSES),
});
export type RoomChangedMessage = z.infer<typeof RoomChangedMessage>;
