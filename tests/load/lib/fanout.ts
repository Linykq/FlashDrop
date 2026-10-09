/*
 * How the WebSocket fan-out script (ws-fanout.ts) reads and judges what the gateway sends (design §7): the
 * frame shapes of `@flashdrop/contracts` (realtime.ts) checked by hand, because k6 runs no Node modules and so
 * has no Zod; stock versions; the frames-per-second meter; and the comparison of a socket's final level with
 * Redis. Plain TypeScript without k6 imports, so the Vitest unit project tests the same logic k6 runs
 * (fanout.test.ts).
 */

/** A stock level as snapshot and delta frames carry it, and as `GET /drops/:dropId/stock` answers it. */
export interface Level {
  readonly gen: number;
  readonly seq: number;
  readonly avail: number;
  readonly held: number;
  readonly sold: number;
  readonly status: string;
}

/** One server frame on a socket that holds a single stock topic, as far as the script cares. */
export type Frame =
  | { readonly kind: 'hello'; readonly instanceId: string }
  | { readonly kind: 'snapshot'; readonly level: Level }
  /** `ts`: the Redis time (ms) of the newest mutation folded into the delta (§7). */
  | { readonly kind: 'delta'; readonly level: Level; readonly ts: number }
  /** `TopicErrorMessage`: the gateway refused a topic of the `sub`. */
  | { readonly kind: 'topic-error'; readonly code: string }
  /** Anything else: not JSON, an unknown or unexpected type, another topic, a field of the wrong shape. */
  | { readonly kind: 'malformed'; readonly reason: string };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** The level of a snapshot or delta: the frame's version plus its `data` (`StockFrameData`). */
function levelOf(message: Json): Level | string {
  const { gen, seq, data } = message;
  if (!Number.isInteger(gen) || (gen as number) < -1 || !isCount(seq))
    return 'a version that is not (gen, seq)';
  if (!isRecord(data)) return 'no data';
  const { avail, held, sold, status } = data;
  if (!isCount(avail) || !isCount(held) || !isCount(sold) || typeof status !== 'string') {
    return `stock data of the wrong shape: ${JSON.stringify(data)}`;
  }
  return { gen: gen as number, seq, avail, held, sold, status };
}

/**
 * Reads one text frame of a socket subscribed to `topic` only. An anonymous socket never gets the owner's
 * `order` or `listing` events, so those are malformed here too.
 */
export function parseFrame(text: string, topic: string): Frame {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { kind: 'malformed', reason: 'not JSON' };
  }
  if (!isRecord(message)) return { kind: 'malformed', reason: 'not a JSON object' };
  switch (message.type) {
    case 'hello':
      return typeof message.instanceId === 'string' && message.instanceId.length > 0
        ? { kind: 'hello', instanceId: message.instanceId }
        : { kind: 'malformed', reason: 'a hello without an instanceId' };
    case 'error':
      return { kind: 'topic-error', code: String(message.code) };
    case 'snapshot':
    case 'delta': {
      if (message.topic !== topic)
        return { kind: 'malformed', reason: `a frame for ${String(message.topic)}` };
      const level = levelOf(message);
      if (typeof level === 'string') return { kind: 'malformed', reason: level };
      if (message.type === 'snapshot') return { kind: 'snapshot', level };
      return isCount(message.ts)
        ? { kind: 'delta', level, ts: message.ts }
        : { kind: 'malformed', reason: 'a delta without its ts' };
    }
    default:
      return { kind: 'malformed', reason: `unexpected type ${String(message.type)}` };
  }
}

/** Lexicographic `(gen, seq)` order (§4.1): negative if `a` is older than `b`, 0 if equal, positive if newer. */
export function compareVersions(a: Level, b: Level): number {
  return a.gen === b.gen ? a.seq - b.seq : a.gen - b.gen;
}

/** INV-9 (Redis conservation), which every published level satisfies: `avail + held + sold = total`. */
export function isConserved(level: Level, units: number): boolean {
  return level.avail + level.held + level.sold === units;
}

/** Nothing held any more: every hold was released (cancelled or expired) or sold. */
export function isSettled(level: Level, units: number): boolean {
  return level.held === 0 && level.avail + level.sold === units;
}

/**
 * How many mutations a frame folds in: its `seq` advance over the level before it (each Function call that
 * mutates bumps `seq` once, §4.2). A new generation (a rebuild) counts as one change; the first level as none.
 */
export function changesSince(previous: Level | undefined, next: Level): number {
  if (previous === undefined) return 0;
  return next.gen === previous.gen ? Math.max(0, next.seq - previous.seq) : 1;
}

/**
 * The sliding window the frame cap is judged over. Receipt times are k6's: a VU whose event loop stalls for
 * a few hundred ms reads the frames that arrived meanwhile at once, so a whole second can show 12 frames the
 * gateway sent 100 ms apart (measured at saturation). Over 2 s that bunching is a small share of the window,
 * while a gateway that wrote every change would still exceed the cap several times over.
 */
export const FRAME_WINDOW_MS = 2_000;

/**
 * Level frames, and the mutations they carry, on one socket, by receipt time. The coalescer flushes every
 * 100 ms (§7), so a second holds 10 ticks, 11 when a tick that left late crosses its boundary. Kept: the
 * busiest whole second for frames (reported) and for changes (which shows that the cap held while the level
 * changed faster: coalescing, not a quiet drop), and the most frames in any `FRAME_WINDOW_MS` (gated).
 */
export interface RateMeter {
  record(atMs: number, changes: number): void;
  /** The most frames received in one whole second. */
  peakFrames(): number;
  /** The most changes carried in one whole second. */
  peakChanges(): number;
  /** The most frames received within any `FRAME_WINDOW_MS`. */
  peakWindowFrames(): number;
}

export function createRateMeter(): RateMeter {
  let second = Number.NaN;
  let frames = 0;
  let changes = 0;
  let peakFrames = 0;
  let peakChanges = 0;
  // Receipt times within the last FRAME_WINDOW_MS, oldest first: at most a window's worth of frames.
  const window: number[] = [];
  let peakWindowFrames = 0;
  return {
    record(atMs, folded) {
      const s = Math.floor(atMs / 1_000);
      if (s !== second) {
        second = s;
        frames = 0;
        changes = 0;
      }
      frames += 1;
      changes += folded;
      peakFrames = Math.max(peakFrames, frames);
      peakChanges = Math.max(peakChanges, changes);
      window.push(atMs);
      while ((window[0] ?? atMs) <= atMs - FRAME_WINDOW_MS) window.shift();
      peakWindowFrames = Math.max(peakWindowFrames, window.length);
    },
    peakFrames: () => peakFrames,
    peakChanges: () => peakChanges,
    peakWindowFrames: () => peakWindowFrames,
  };
}

/**
 * A socket's final level against Redis's, read once the level stopped moving. `behind`: the socket missed
 * the newest level (or never got one), unless its frame is still on the way; `ahead`: the read is older than
 * what the socket saw, so it is read again; `differs`: the same version with other counts, a corrupt frame.
 */
export type FinalVerdict = 'match' | 'behind' | 'ahead' | 'differs';

export function judgeFinal(socket: Level | undefined, redis: Level): FinalVerdict {
  if (socket === undefined) return 'behind';
  const order = compareVersions(socket, redis);
  if (order < 0) return 'behind';
  if (order > 0) return 'ahead';
  return socket.avail === redis.avail &&
    socket.held === redis.held &&
    socket.sold === redis.sold &&
    socket.status === redis.status
    ? 'match'
    : 'differs';
}

/**
 * §7 determinism: Caddy pins `/ws/1` to api-1 and `/ws/2` to api-2. True when every URL's sockets met
 * exactly one instance and no two URLs met the same one.
 */
export function isPinned(hellos: readonly { readonly url: string; readonly instanceId: string }[]): boolean {
  const byUrl = new Map<string, Set<string>>();
  for (const { url, instanceId } of hellos) {
    const ids = byUrl.get(url) ?? new Set<string>();
    ids.add(instanceId);
    byUrl.set(url, ids);
  }
  const instances = [...byUrl.values()];
  return (
    instances.every((ids) => ids.size === 1) &&
    new Set(instances.flatMap((ids) => [...ids])).size === byUrl.size
  );
}
