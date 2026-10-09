/*
 * A fixed-window counter: how the gateway caps what one socket may do per window (frames per second, topic
 * joins per 10 s, §7, §11). One per socket and limit, kept in memory: a socket lives on one instance.
 */

export interface FixedWindow {
  /** Counts one event at `now` (ms); false once the window's limit is passed. */
  take(now: number): boolean;
}

export function fixedWindow(limit: number, windowMs: number, start: number): FixedWindow {
  let windowStart = start;
  let count = 0;
  return {
    take(now) {
      if (now - windowStart >= windowMs) {
        windowStart = now;
        count = 0;
      }
      count += 1;
      return count <= limit;
    },
  };
}
