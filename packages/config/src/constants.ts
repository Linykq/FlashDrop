/*
 * Shared runtime constants. This module imports nothing, so browser code can take it from
 * `@flashdrop/config/constants` without pulling the env loader and pino into the client bundle.
 */

/** Kafka topics (design §6.1). `kafka-init` creates them; brokers never auto-create topics. */
export const TOPICS = {
  orders: 'orders.v1',
  ordersDlq: 'orders.v1.dlq',
} as const;

/**
 * Partition count of `orders.v1`. Records are keyed by `productId` with Kafka's murmur2 partitioner, so a
 * product's events always land on `murmur2(productId) % ORDERS_PARTITIONS` (§6.1, §13 `partitioning`).
 */
export const ORDERS_PARTITIONS = 6;

/** Kafka consumer groups, one per role that consumes `orders.v1` (§6.3). */
export const CONSUMER_GROUPS = {
  payment: 'payment',
  settlement: 'inventory-settlement',
  dashboard: 'sales-dashboard',
} as const;

/**
 * The group whose committed offsets on `orders.v1.dlq` record how far `dlq:replay` has handled the dead
 * letters (§6.4). No consumer ever joins it: the replay commits its progress, and the admin health tile
 * counts the letters past it as the ones still to act on.
 */
export const DLQ_REPLAY_GROUP = 'dlq-replay';

/** Roles an `api` process can serve, selected with `API_ROLES` (§2, §7). */
export const API_ROLES = ['http', 'ws'] as const;
export type ApiRole = (typeof API_ROLES)[number];

/** Background roles a `worker` process can run, selected with `WORKER_ROLES` (§2). */
export const WORKER_ROLES = [
  'relay',
  'sweeper',
  'reconciler',
  'listing',
  'payment',
  'settlement',
  'dashboard',
] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

/** The signed session cookie set by `api` and read by `web` and the WebSocket gateway (§11). */
export const SESSION_COOKIE = 'fd_session';

/**
 * Who issues `fd_session` and for whom (§11): `api` sets both claims, and every verifier (api, the gateway,
 * `web`) requires them, so a token signed with the same key for another purpose is never a session.
 */
export const SESSION_ISSUER = 'flashdrop';
export const SESSION_AUDIENCE = 'flashdrop-web';

/** A session's lifetime (§11). Verifiers also refuse a token issued longer ago, whatever its `exp` says. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
