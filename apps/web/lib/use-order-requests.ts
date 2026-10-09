import { useEffect } from 'react';

/*
 * The order requests (`order-requests.ts`) load as their own chunk, so Zod and the contracts stay out of the
 * first load of checkout and the order page (design-system §14). Pages fetch it a moment after they settle;
 * an action that comes first loads it itself.
 */

const load = () => import('./order-requests');

export type OrderRequests = Awaited<ReturnType<typeof load>>;

/** After hydration, when the chunk is fetched: off the first load, long before a press needs it. */
const PREFETCH_MS = 1_000;

/** The requests, or `null` when their code could not load (offline, or a deploy replaced the chunk). */
export async function orderRequests(): Promise<OrderRequests | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

export function usePrefetchOrderRequests(): void {
  useEffect(() => {
    // A failed prefetch only means the first action loads the code itself, and reports its own failure.
    const timer = setTimeout(() => load().catch(() => undefined), PREFETCH_MS);
    return () => clearTimeout(timer);
  }, []);
}
