'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { z } from 'zod';

/**
 * A read that takes longer is abandoned and counts as failed. Generous: the health check runs every invariant
 * query over all tracked drops, which takes seconds on a busy database, and the next poll waits for this one.
 */
const TIMEOUT_MS = 15_000;

type PollOptions<S extends z.ZodType> = {
  /** A same-origin api path; the admin's session cookie goes with it. */
  url: string;
  schema: S;
  intervalMs: number;
  /** `false` freezes the poll (the admin paused updates). */
  enabled: boolean;
  onData: (data: z.output<S>, receivedAt: number) => void;
};

/**
 * Polls an admin read every `intervalMs` while `enabled` and the tab is visible (a hidden tab's timers are
 * throttled anyway), and at once when the tab comes back or polling resumes after a pause: the page starts
 * from server-rendered data, so only the first read waits a full interval. `refresh()` asks for a read now,
 * coalesced with one in flight. `failed` is set while the last read failed, so the page can say its numbers
 * may be stale.
 */
export function usePoll<S extends z.ZodType>({ url, schema, intervalMs, enabled, onData }: PollOptions<S>) {
  const [failed, setFailed] = useState(false);
  const deliver = useEffectEvent(onData);
  const trigger = useRef<() => void>(() => {});
  const started = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: AbortController | undefined;
    let stopped = false;

    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(() => void read(), delay);
    };

    const read = async () => {
      if (inflight) return;
      const controller = new AbortController();
      inflight = controller;
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
        if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
        const parsed = schema.safeParse(await response.json());
        if (!parsed.success) throw new Error(`GET ${url} broke its contract`);
        if (!stopped) {
          deliver(parsed.data, Date.now());
          setFailed(false);
        }
      } catch (error) {
        if (stopped) return;
        // A timeout or an outage is the stale state below; a broken contract is a bug worth reporting.
        if (error instanceof Error && error.message.endsWith('contract')) reportError(error);
        setFailed(true);
      } finally {
        if (inflight === controller) inflight = undefined;
        schedule(intervalMs);
      }
    };

    const onVisibility = () => {
      if (document.hidden) clearTimeout(timer);
      else schedule(0);
    };

    trigger.current = () => schedule(0);
    schedule(started.current ? 0 : intervalMs);
    started.current = true;
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      trigger.current = () => {};
      clearTimeout(timer);
      inflight?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [url, schema, intervalMs, enabled]);

  const refresh = useCallback(() => trigger.current(), []);
  return { failed, refresh };
}
