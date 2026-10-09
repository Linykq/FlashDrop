import type { Topic, UserEventMessage } from '@flashdrop/contracts';
import { useCallback, useEffect, useEffectEvent, useMemo, useSyncExternalStore } from 'react';
import { realtime } from './browser';
import type { LevelFrame, RealtimeStatus } from './client';
import type { Version } from './protocol';

/*
 * React's view of the tab's real-time client (SD §8.2): components read it through `useSyncExternalStore`,
 * so every island showing a topic renders the same level, and the server render and hydration see the
 * initial state, so the markup always matches.
 */

const OFFLINE: RealtimeStatus = { connected: false, paused: false, instanceId: null };

const subscribeStatus = (listener: () => void) => realtime().onStatus(listener);
const readStatus = () => realtime().status();
const serverStatus = () => OFFLINE;

/** Whether the socket is open, and whether live updates are paused (no socket for over 5 s, SD §7). */
export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(subscribeStatus, readStatus, serverStatus);
}

/** A level with its version, as `useRealtimeLevel` returns it. */
export type Versioned<T> = Version & { data: T };

/**
 * The newest level received on `topic` (none for `null`), with its `data` checked by `parse`; `null` until
 * the first frame. Callers compare its version with their own seed, an SSR snapshot, and show the newer.
 * `parse` must be stable (a module-level function). A frame `parse` refuses is reported and shows nothing.
 */
export function useRealtimeLevel<T>(
  topic: Topic | null,
  parse: (data: unknown) => T | null,
): Versioned<T> | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (topic === null) return () => {};
      return realtime().subscribe(topic, (frame) => {
        if (parse(frame.data) === null) {
          reportError(new Error(`malformed ${frame.kind} data on ${frame.topic}`));
        }
        listener();
      });
    },
    [topic, parse],
  );
  // The parsed level is kept per frame: useSyncExternalStore needs the same object until the level changes.
  const read = useMemo(() => {
    let cached: { frame: LevelFrame; level: Versioned<T> | null } | null = null;
    return (): Versioned<T> | null => {
      const frame = topic === null ? null : realtime().latest(topic);
      if (frame === null) return null;
      if (cached?.frame !== frame) {
        const data = parse(frame.data);
        cached = { frame, level: data === null ? null : { gen: frame.gen, seq: frame.seq, data } };
      }
      return cached.level;
    };
  }, [topic, parse]);
  return useSyncExternalStore(subscribe, read, () => null);
}

/**
 * Calls `listener` with the signed-in viewer's `order` and `listing` events while `enabled` (SD §7). Best
 * effort: pages that use them keep polling, since a socket can miss events while it reconnects.
 */
export function useUserEvents(listener: (event: UserEventMessage) => void, enabled = true): void {
  const onEvent = useEffectEvent(listener);
  useEffect(() => {
    if (!enabled) return;
    return realtime().onUserEvent((event) => onEvent(event));
  }, [enabled]);
}
