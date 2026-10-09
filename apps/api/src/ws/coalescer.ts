import type { DeltaMessage, Topic } from '@flashdrop/contracts';
import { compareStockVersions, type StockVersion } from '@flashdrop/inventory';

/*
 * Burst coalescing (design §7). The Functions publish on every mutation, thousands per second in a burst,
 * and every socket on a drop wants only the newest level. So the gateway keeps one level per topic, replaced
 * only by a strictly newer `(gen, seq)`, and marks the topic dirty; every `intervalMs` it serializes each
 * dirty topic once and hands that frame to `deliver`, which writes it to the topic's sockets. A socket gets
 * at most one frame per topic per tick, the CPU cost is one JSON.stringify per topic per level, not per
 * socket, and a slow client costs O(topics) memory, not O(messages).
 *
 * A frame's `ts` is the time of the OLDEST change folded into it since the topic last went out to all its
 * sockets, not the newest: `receive - ts` must count the time a change waited in the coalescer (up to a
 * tick), or the propagation metric (§1, §7) would measure only the luckiest change of every frame.
 */

export interface Level extends StockVersion {
  /** When the change that made this level happened, in ms (stock: the Redis time of the mutation). */
  readonly ts: number;
  readonly data: unknown;
}

export interface Frame {
  readonly topic: Topic;
  readonly level: Level;
  /** The serialized `delta`, built once per level. */
  readonly json: string;
}

export interface CoalescerOptions {
  readonly intervalMs: number;
  /**
   * Writes the frame to the topic's sockets. False keeps the topic dirty, so the next tick offers the same
   * frame again: a backpressured socket skipped this one and must still get the latest level once it drains,
   * even if nothing changes any more.
   */
  readonly deliver: (frame: Frame) => boolean;
}

export interface Coalescer {
  /** Folds `level` in if it is strictly newer than the held one, and marks the topic dirty; true if it was. */
  offer(topic: Topic, level: Level): boolean;
  latest(topic: Topic): Level | undefined;
  /** Drops a topic that no local socket holds any more. */
  forget(topic: Topic): void;
  /** One tick: delivers every dirty topic. The timer calls it; tests may too. */
  flush(): void;
  start(): void;
  stop(): void;
}

interface Held {
  readonly level: Level;
  /** The oldest `ts` folded in since the topic was last delivered completely: the frame's `ts`. */
  readonly firstTs: number;
  json?: string;
}

/** Whether `next` is strictly newer than `current`; anything is newer than nothing. */
export function isNewer(next: StockVersion, current: StockVersion | undefined): boolean {
  return current === undefined || compareStockVersions(next, current) > 0;
}

export function createCoalescer(options: CoalescerOptions): Coalescer {
  const held = new Map<Topic, Held>();
  const dirty = new Set<Topic>();
  let timer: NodeJS.Timeout | undefined;

  function frameOf(topic: Topic, entry: Held): Frame {
    if (entry.json === undefined) {
      const { gen, seq, data } = entry.level;
      const message: DeltaMessage = { type: 'delta', topic, gen, seq, ts: entry.firstTs, data };
      entry.json = JSON.stringify(message);
    }
    return { topic, level: entry.level, json: entry.json };
  }

  function flush(): void {
    for (const topic of [...dirty]) {
      const entry = held.get(topic);
      if (entry === undefined || options.deliver(frameOf(topic, entry))) dirty.delete(topic);
    }
  }

  return {
    offer(topic, level) {
      const current = held.get(topic);
      if (!isNewer(level, current?.level)) return false;
      // Still dirty: an older change is waiting in this frame, so its time stays the frame's.
      const firstTs =
        current !== undefined && dirty.has(topic) ? Math.min(current.firstTs, level.ts) : level.ts;
      held.set(topic, { level, firstTs });
      dirty.add(topic);
      return true;
    },
    latest: (topic) => held.get(topic)?.level,
    forget(topic) {
      held.delete(topic);
      dirty.delete(topic);
    },
    flush,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(flush, options.intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
