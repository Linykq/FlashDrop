/*
 * Application deadlines on Redis calls (design §4.2). node-redis 6 stops applying a command's own timeout
 * once the command is written, and a frozen Redis or a blackholed network keeps the socket open until TCP
 * keepalive gives up, minutes later. `socketTimeout` is no way out: it fires on any socket idle that long,
 * and node-redis does not reconnect after a `SocketTimeoutError` (spike §1.5). So every call on a request
 * or loop path races a deadline instead, and a silent Redis becomes a transient error (503 `RETRY`, a
 * paused consumer, an ended tick) within seconds.
 */

/** Every O(1) command and Function: anything slower means Redis is not answering. */
export const REDIS_DEADLINE_MS = 2_000;
/** Calls that are O(n) in a drop's orders: `fd_rebuild`, which writes them all, and `readDropState`. */
export const BULK_DEADLINE_MS = 10_000;

/**
 * A Redis call that got no answer within its deadline. Transient (`isTransientRedisError`). The call may
 * still run afterwards, which is harmless: every Function is idempotent by its rid, order id or snapshot
 * generation, and the other commands on these paths are reads or idempotent writes (`ZADD XX`, `SET`).
 */
export class RedisDeadlineError extends Error {
  override name = 'RedisDeadlineError';
}

/** Runs `call` and rejects with `RedisDeadlineError` if it has not settled within `ms`. */
export async function withDeadline<T>(name: string, ms: number, call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RedisDeadlineError(`redis ${name} got no answer within ${ms} ms`)),
      ms,
    );
  });
  try {
    // Promise.race subscribes to both, so a call that settles after the deadline is never unhandled.
    return await Promise.race([call(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
