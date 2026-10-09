import type { PinnedDrop, RoomFrameData } from '@flashdrop/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { RoomReader } from '../services/rooms';
import type { Level } from './coalescer';
import type { ViewerStore } from './viewers';

/*
 * The `room:<roomId>` levels one gateway serves (design §7): the room's pinned drop, read from Postgres, and
 * its viewers, the sum of every instance's field in `fd:viewers:<roomId>`. The level is the gateway's own,
 * so its version is the gateway's clock in ms, strictly increasing here: a fresh snapshot is newer than
 * anything another instance sent a client before it reconnected here (all containers share the host clock).
 *
 * - A room is loaded once, when its first socket here joins: its pinned drop and its viewer count, read
 *   together. No level goes out before that, so no delta can precede the first snapshot.
 * - Every viewer beat (5 s) writes this instance's counts and re-reads the pinned drop of every loaded room
 *   in ONE statement: the safety net under the scheduler's nudges, which a lost publish or an admin status
 *   change (which does not publish on the room channel) would otherwise leave stale.
 * - Reads can overlap (a nudge during a beat), and one that started earlier can finish later: each read is
 *   numbered when it starts, and a room applies only reads newer than the last it applied.
 */

export interface RoomTrackerDeps {
  readonly reader: RoomReader;
  readonly viewers: ViewerStore;
  /** This instance's viewers of the room: the distinct principals among its sockets there. */
  readonly localViewers: (roomId: string) => number;
  /** A room's level changed: it goes to the coalescer, which writes it to the room's sockets. */
  readonly offer: (roomId: string, level: Level) => void;
  readonly log: FastifyBaseLogger;
  readonly now: () => number;
}

export interface RoomTracker {
  /** A socket here joined the room: track it (nothing is read until its snapshot is asked for). */
  open(roomId: string): void;
  /** The room's last socket here left: its viewer field is deleted at the next beat. */
  close(roomId: string): void;
  /**
   * The room's level for a joining socket, once the room is loaded; the first call loads it, and calls
   * meanwhile share that load. Rejects when the load failed: the next call tries again. Null for a room
   * that is not tracked (any more).
   */
  snapshot(roomId: string): Promise<Level | null>;
  /** The scheduler's nudge on the room channel: re-read the pinned drop (one read at a time per room). */
  nudge(roomId: string): void;
  /** Re-reads the pinned drop of every loaded room, in one statement. */
  refresh(): Promise<void>;
  /** The viewer beat: report this instance's counts, then `refresh`. */
  tick(): Promise<void>;
  /** Deletes this instance's viewer field of every room it held (shutdown). */
  forget(): Promise<void>;
}

interface RoomState {
  readonly roomId: string;
  pinned: PinnedDrop | null;
  viewers: number;
  /** True once loaded: no level goes out before the first snapshot could. */
  ready: boolean;
  loading: Promise<void> | undefined;
  /** The number of the newest pinned read this room applied. */
  appliedRead: number;
  nudging: boolean;
  nudgeAgain: boolean;
}

function samePinned(a: PinnedDrop | null, b: PinnedDrop | null): boolean {
  return a === b || (a !== null && b !== null && a.dropId === b.dropId && a.status === b.status);
}

export function createRoomTracker(deps: RoomTrackerDeps): RoomTracker {
  const { log, now } = deps;
  const rooms = new Map<string, RoomState>();
  /** Rooms this instance left since the last beat: their field is deleted at the next one. */
  const gone = new Set<string>();
  let clock = 0;
  let reads = 0;
  let ticking = false;

  function levelOf(room: RoomState): Level {
    clock = Math.max(clock + 1, now());
    const data: RoomFrameData = { pinned: room.pinned, viewers: room.viewers };
    return { gen: 0, seq: clock, ts: now(), data };
  }

  function offer(room: RoomState): void {
    if (room.ready && rooms.get(room.roomId) === room) deps.offer(room.roomId, levelOf(room));
  }

  async function readPinned(list: readonly RoomState[]): Promise<void> {
    if (list.length === 0) return;
    const read = ++reads;
    const pinned = await deps.reader.pinnedDrops(list.map((room) => room.roomId));
    for (const room of list) {
      if (read < room.appliedRead) continue;
      room.appliedRead = read;
      const next = pinned.get(room.roomId) ?? null;
      if (samePinned(room.pinned, next)) continue;
      room.pinned = next;
      offer(room);
    }
  }

  /** Writes this instance's counts and folds in the totals; `only` limits it to one room (its load). */
  async function report(only?: RoomState): Promise<void> {
    const counted = only === undefined ? [...rooms.values()] : [only];
    const counts = new Map(counted.map((room) => [room.roomId, deps.localViewers(room.roomId)]));
    const leaving = only === undefined ? [...gone].filter((roomId) => !rooms.has(roomId)) : [];
    for (const roomId of leaving) gone.delete(roomId);
    let totals: Map<string, number>;
    try {
      totals = await deps.viewers.report(counts, leaving);
    } catch (err) {
      // Deleted at the next beat instead; the field's TTL removes it meanwhile.
      for (const roomId of leaving) if (!rooms.has(roomId)) gone.add(roomId);
      throw err;
    }
    for (const [roomId, viewers] of totals) {
      const room = rooms.get(roomId);
      if (room === undefined || room.viewers === viewers) continue;
      room.viewers = viewers;
      offer(room);
    }
  }

  function load(room: RoomState): Promise<void> {
    room.loading ??= Promise.all([readPinned([room]), report(room)]).then(
      () => {
        room.ready = true;
      },
      (err: unknown) => {
        room.loading = undefined;
        throw err;
      },
    );
    return room.loading;
  }

  function loaded(): RoomState[] {
    return [...rooms.values()].filter((room) => room.ready);
  }

  return {
    open(roomId) {
      if (rooms.has(roomId)) return;
      gone.delete(roomId);
      rooms.set(roomId, {
        roomId,
        pinned: null,
        viewers: 0,
        ready: false,
        loading: undefined,
        appliedRead: 0,
        nudging: false,
        nudgeAgain: false,
      });
    },

    close(roomId) {
      if (rooms.delete(roomId)) gone.add(roomId);
    },

    async snapshot(roomId) {
      const room = rooms.get(roomId);
      if (room === undefined) return null;
      await load(room);
      return rooms.get(roomId) === room ? levelOf(room) : null;
    },

    nudge(roomId) {
      const room = rooms.get(roomId);
      if (room === undefined || !room.ready) return;
      if (room.nudging) {
        room.nudgeAgain = true;
        return;
      }
      room.nudging = true;
      void (async () => {
        try {
          do {
            room.nudgeAgain = false;
            await readPinned([room]);
          } while (room.nudgeAgain);
        } catch (err) {
          log.warn({ err, roomId }, 'room refresh failed; the next viewer beat reads it again');
        } finally {
          room.nudging = false;
        }
      })();
    },

    refresh: () => readPinned(loaded()),

    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        const [reported, refreshed] = await Promise.allSettled([report(), readPinned(loaded())]);
        if (reported.status === 'rejected') log.warn({ err: reported.reason }, 'viewer count report failed');
        if (refreshed.status === 'rejected') log.warn({ err: refreshed.reason }, 'room refresh failed');
      } finally {
        ticking = false;
      }
    },

    forget: () => deps.viewers.report(new Map(), [...rooms.keys(), ...gone]).then(() => undefined),
  };
}
