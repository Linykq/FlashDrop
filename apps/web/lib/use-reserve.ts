import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshLiveStock } from './live-stock';
import type { RefusalCode, ReserveOutcome, ReserveRequest, RetryCause } from './reserve';
import { forgetReserveKey, reserveKey } from './reserve-key';
import { checkoutHref, loginHref } from './routes';

/** After this long in flight the button says "Still trying…" (design-system §9.13). */
const SLOW_MS = 2_000;
/** How long "Reserved" shows before checkout opens: the celebrate spring is at its peak (§6.3, §9.13). */
const RESERVED_MS = 400;
/** After hydration, when the request code is fetched: off the first load, long before a press needs it. */
const PREFETCH_MS = 1_000;

/*
 * The request and its retries load as their own chunk, so they stay out of the product page's first load
 * (design-system §14), and are fetched a moment after the page settles. A press that comes first loads them
 * itself; a failed prefetch only means that press does.
 */
const loadReserve = () => import('./reserve');

/** Why the last press did not reserve, for the note under the button (§12.2). */
export type ReserveProblem =
  /** `qty` is what the refused press asked for: a SOLD_OUT is worded against it (§9.13). */
  | { kind: 'refused'; code: RefusalCode; qty: number }
  | { kind: 'unavailable'; cause: RetryCause }
  | { kind: 'failed' };

export type ReserveState = {
  phase: 'idle' | 'reserving' | 'reserved';
  /** Still in flight after 2 s: retrying a 503 while the drop is rebuilt, or a slow api. */
  slow: boolean;
  problem: ReserveProblem | null;
};

const IDLE: ReserveState = { phase: 'idle', slow: false, problem: null };

/** The request with its retries. Rejects only when `signal` aborts. */
async function send(request: ReserveRequest, signal: AbortSignal): Promise<ReserveOutcome> {
  let code: Awaited<ReturnType<typeof loadReserve>>;
  try {
    code = await loadReserve();
  } catch {
    // The code itself could not load: no network, or a deploy replaced the chunk. The key is kept.
    return { kind: 'unavailable', cause: navigator.onLine ? 'busy' : 'offline' };
  }
  try {
    return await code.reserve(request, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    // `reserve` only rejects on abort; anything else is a bug, reported like an uncaught error.
    reportError(error);
    return { kind: 'failed', status: 0 };
  }
}

/**
 * One press. A final refusal forgets the key, whether or not the page is still there to show it: the next
 * press is a new intent. It also refreshes the drop's stock and waits for it, briefly, because the note is
 * worded from that stock (§9.13), and the note and LiveStock must agree from the frame they appear in.
 */
async function press(request: ReserveRequest, signal: AbortSignal): Promise<ReserveOutcome> {
  const outcome = await send(request, signal);
  if (outcome.kind === 'refused') {
    forgetReserveKey(request.dropId);
    await refreshLiveStock(request.dropId);
  }
  return outcome;
}

/**
 * The Buy button's reserve flow (SD §8.2, design-system §9.13). One press runs one request with its
 * Idempotency-Key and its retries; further presses are ignored until it has an answer. A reservation opens
 * checkout; a final refusal forgets the key, so the next press is a new intent; a request that could not get
 * through keeps its key, so the next press continues it and can never reserve twice.
 */
export function useReserve(
  dropId: string,
  returnTo: string,
  { prefetch }: { prefetch: boolean },
): { state: ReserveState; buy: (qty: number) => void; dismiss: () => void } {
  const router = useRouter();
  const [state, setState] = useState<ReserveState>(IDLE);
  const running = useRef<AbortController | null>(null);
  const toCheckout = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Next keeps a page it navigated away from mounted but hidden (React <Activity>) and reveals it again on
  // Back or on a link to it: hiding runs these cleanups and revealing runs the effect again, with state kept.
  // So leaving abandons the request, and a page shown again starts at Buy, never at the "Reserved" or
  // "Reserving…" it was left with. An abandoned request keeps its key, so a later press replays its answer:
  // a hold it made is found again, never made twice.
  useEffect(() => {
    setState(IDLE);
    return () => {
      running.current?.abort();
      running.current = null;
      clearTimeout(toCheckout.current);
    };
  }, []);

  useEffect(() => {
    if (!prefetch) return;
    // A failed prefetch is retried by the press that needs the code, which reports its own failure.
    const timer = setTimeout(() => loadReserve().catch(() => undefined), PREFETCH_MS);
    return () => clearTimeout(timer);
  }, [prefetch]);

  const settle = useCallback(
    (outcome: ReserveOutcome, qty: number) => {
      switch (outcome.kind) {
        case 'reserved':
          forgetReserveKey(dropId);
          void refreshLiveStock(dropId);
          setState({ phase: 'reserved', slow: false, problem: null });
          // `running` stays set: the page is on its way to checkout and takes no further presses.
          toCheckout.current = setTimeout(() => router.push(checkoutHref(outcome.orderId)), RESERVED_MS);
          return;
        case 'signed-out':
          running.current = null;
          router.push(loginHref(returnTo));
          return;
        case 'refused':
        case 'unavailable':
        case 'failed':
          break;
      }
      running.current = null;
      setState({
        phase: 'idle',
        slow: false,
        problem:
          outcome.kind === 'refused'
            ? { kind: 'refused', code: outcome.code, qty }
            : outcome.kind === 'unavailable'
              ? { kind: 'unavailable', cause: outcome.cause }
              : { kind: 'failed' },
      });
    },
    [dropId, returnTo, router],
  );

  const buy = useCallback(
    (qty: number) => {
      if (running.current) return;
      const controller = new AbortController();
      running.current = controller;
      setState({ phase: 'reserving', slow: false, problem: null });
      const slow = setTimeout(
        () => setState((current) => (current.phase === 'reserving' ? { ...current, slow: true } : current)),
        SLOW_MS,
      );
      press({ dropId, qty, key: reserveKey(dropId, qty) }, controller.signal)
        .then(
          (outcome) => {
            // The page was left (or hidden) meanwhile: its answer is no longer this page's to show. A hold
            // it made keeps its key for the replay.
            if (running.current === controller) settle(outcome, qty);
          },
          // Aborted: the page was left. Nothing else rejects.
          () => undefined,
        )
        .finally(() => clearTimeout(slow));
    },
    [dropId, settle],
  );

  const dismiss = useCallback(() => {
    setState((current) => (current.problem ? { ...current, problem: null } : current));
  }, []);

  return { state, buy, dismiss };
}
