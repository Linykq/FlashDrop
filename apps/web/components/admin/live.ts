'use client';

import {
  type DashboardTotals,
  DashboardTotals as DashboardTotalsSchema,
  type StockLevel,
  StockSnapshot,
} from '@flashdrop/contracts';
import { useEffect, useState } from 'react';
import { useRealtimeLevel, useRealtimeStatus } from '../../lib/realtime/hooks';
import { isNewer, parseStockData, topicOf, type Version } from '../../lib/realtime/protocol';

/*
 * The admin pages' live data (SD §7, §9) on the tab's real-time client: a drop's Redis stock (`stock:<id>`,
 * public) and its dashboard totals (`dash:<id>`, admin only). Every level carries its version, and a page
 * shows the newest of what it has: its server-rendered seed, the socket's frames and, while live updates are
 * paused (no socket for over 5 s), its own polls. Admin pages may use the Zod contracts in the browser; the
 * storefront's first-load budget (design system §14) doesn't apply here.
 */

const STOCK_POLL_MS = 3_000;

const newest = <T extends Version>(...levels: readonly (T | null)[]): T | null =>
  levels.reduce<T | null>(
    (best, level) => (level !== null && (best === null || isNewer(level, best)) ? level : best),
    null,
  );

/**
 * A drop's live Redis level, starting from `seed` (the server's snapshot), `null` for a drop without Redis
 * state (`dropId` null: a draft). While updates are paused it polls `GET /drops/:id/stock` every 3 s
 * (SD §7 step 5). A level read mid-rebuild (RECONCILING) is kept as such: admin shows "Rebuilding".
 */
export function useLiveStock(
  dropId: string | null,
  seed: StockLevel | null,
): { level: StockLevel | null; paused: boolean } {
  const frame = useRealtimeLevel(dropId === null ? null : topicOf('stock', dropId), parseStockData);
  const { paused } = useRealtimeStatus();
  const [polled, setPolled] = useState<StockLevel | null>(null);

  useEffect(() => {
    if (dropId === null || !paused) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/drops/${dropId}/stock`, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(STOCK_POLL_MS)]),
        });
        if (!response.ok) return;
        const snapshot = StockSnapshot.safeParse(await response.json());
        if (snapshot.success) setPolled(snapshot.data);
      } catch {
        // Stopped, or no network: the paused note already says the numbers may be stale.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), STOCK_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [dropId, paused]);

  const live = frame === null ? null : { ...frame.data, gen: frame.gen, seq: frame.seq };
  return { level: dropId === null ? null : newest(seed, live, polled), paused };
}

const parseTotals = (data: unknown): DashboardTotals | null => {
  const totals = DashboardTotalsSchema.safeParse(data);
  return totals.success ? totals.data : null;
};

/** Dashboard totals with their projection version (SD §9): `dash:<id>` frames carry it as `(0, version)`. */
export type VersionedTotals = { version: number; totals: DashboardTotals };

/**
 * A drop's dashboard totals: the newest of `seed` (the server render or the page's latest refetch) and the
 * `dash:<dropId>` frames. Only a strictly newer version replaces what is shown, so a zombie consumer's late
 * publish of older totals is ignored (SD §9).
 */
export function useLiveTotals(dropId: string, seed: VersionedTotals): VersionedTotals {
  const frame = useRealtimeLevel(topicOf('dash', dropId), parseTotals);
  return frame !== null && frame.seq > seed.version ? { version: frame.seq, totals: frame.data } : seed;
}

export { useRealtimeStatus };
