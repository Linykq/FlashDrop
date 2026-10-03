import type { Logger } from '@flashdrop/config';
import {
  ClientClosedError,
  ClientOfflineError,
  ConnectionTimeoutError,
  createClient,
  ErrorReply,
  ReconnectStrategyError,
  SocketClosedUnexpectedlyError,
} from 'redis';
import { BULK_DEADLINE_MS, RedisDeadlineError, withDeadline } from './deadline';
import { FLASHDROP_FUNCTIONS } from './functions';
import { LIBRARY_VERSION, type LoadLibraryOptions, loadLibrary } from './library';

/*
 * Redis clients (design §14, M0 delta 12). Each process holds two: a command client for Functions and reads,
 * and a `duplicate()` subscriber that keeps pub/sub push traffic off the command connection.
 */

export interface RedisClientOptions {
  /** `REDIS_URL`. */
  readonly url: string;
  /** `CLIENT SETNAME`, e.g. `api-cmd` or `worker-sub`, so `CLIENT LIST` shows who is who. */
  readonly name: string;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * The command client. `disableOfflineQueue`: node-redis 6 would otherwise hold commands issued while Redis
 * is down until it reconnects; this client fails them at once with `ClientOfflineError`, which the API
 * answers with 503 `RETRY` (no sales beats wrong sales, §17). The `'error'` listener is mandatory: a
 * dropped socket emits `'error'`, and an unheard one crashes the process (spike §1.6).
 */
export function createCommandClient(options: RedisClientOptions) {
  const client = createClient({
    url: options.url,
    name: options.name,
    disableOfflineQueue: true,
    functions: FLASHDROP_FUNCTIONS,
  });
  client.on('error', (err: unknown) =>
    options.logger.warn({ err, redisClient: options.name }, 'redis error'),
  );
  return client;
}

/** A command client: typed `client.flashdrop.fd_*` Functions, no offline queue. */
export type FlashdropRedis = ReturnType<typeof createCommandClient>;

export interface CommandClientOptions extends RedisClientOptions {
  /** How the startup load treats a library Redis already holds (`loadLibrary`). */
  readonly library?: LoadLibraryOptions;
}

/**
 * Startup: a connected command client with the library loaded (§4.2). A copy of this version with other
 * code is kept, and warned about: it needs a version bump, not a silent replacement under the processes
 * that loaded it.
 */
export async function connectCommandClient(options: CommandClientOptions): Promise<FlashdropRedis> {
  const client = createCommandClient(options);
  await client.connect();
  const loaded = await withDeadline('library load', BULK_DEADLINE_MS, () =>
    loadLibrary(client, options.library),
  );
  if (loaded === 'CURRENT_DIFFERS') {
    options.logger.warn(
      { redisClient: options.name, version: LIBRARY_VERSION },
      'redis holds other code under this flashdrop library version; keeping it. Bump the version in lua/flashdrop.lua',
    );
  }
  return client;
}

export interface SubscriberOptions extends Omit<RedisClientOptions, 'url'> {
  /**
   * Called on every `'ready'` after the first, i.e. after a reconnect. Pub/sub is at-most-once, so a
   * gateway re-snapshots every topic it holds here; node-redis finishes resubscribing before it emits
   * `'ready'`, so nothing published after the snapshot can be missed (spike §1.5).
   */
  readonly onResubscribed?: () => void;
}

/**
 * The subscriber, a duplicate of the command client. It keeps the offline queue: a SUBSCRIBE issued during
 * a reconnect waits for the connection instead of failing, and node-redis restores every subscription on
 * reconnect anyway.
 */
export function createSubscriber(command: FlashdropRedis, options: SubscriberOptions): FlashdropRedis {
  const subscriber = command.duplicate({ name: options.name, disableOfflineQueue: false });
  subscriber.on('error', (err: unknown) =>
    options.logger.warn({ err, redisClient: options.name }, 'redis subscriber error'),
  );
  const { onResubscribed } = options;
  if (onResubscribed !== undefined) {
    let connectedBefore = false;
    subscriber.on('ready', () => {
      if (connectedBefore) onResubscribed();
      connectedBefore = true;
    });
  }
  return subscriber;
}

/**
 * Replies Redis gives when it cannot run a command right now: refused under `noeviction` memory pressure
 * (write Functions are refused up front, §4.7), loading its AOF, or blocked by a long script.
 */
const TRANSIENT_REPLY = /^(OOM|LOADING|BUSY|MASTERDOWN|TRYAGAIN) /;

/**
 * True when a Redis call failed because Redis is unavailable rather than because the call is wrong: `api`
 * answers 503 `RETRY` and consumers pause and retry. A command in flight when the socket died may or may
 * not have run; every caller retries with the same identity (rid, order id), which the Functions make
 * idempotent.
 */
export function isTransientRedisError(error: unknown): boolean {
  return (
    error instanceof RedisDeadlineError ||
    error instanceof ClientOfflineError ||
    error instanceof ClientClosedError ||
    error instanceof SocketClosedUnexpectedlyError ||
    error instanceof ConnectionTimeoutError ||
    error instanceof ReconnectStrategyError ||
    (error instanceof ErrorReply && TRANSIENT_REPLY.test(error.message)) ||
    (error instanceof Error &&
      'code' in error &&
      (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET'))
  );
}
