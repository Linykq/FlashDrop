import { useEffect, useRef } from 'react';
import { announce } from '../components/ui/announcer';
import { stockAnnouncement } from './live-stock';
import type { StockState } from './stock';

/** At most one stock announcement per 3 s; the latest state wins (design-system §9.9, §13.3). */
const COOLDOWN_MS = 3_000;

/**
 * Announces a drop's live stock politely, on threshold crossings only (SD §8.3, design-system §9.9): never
 * every delta, never on first load, and never for the level the buyer's own press brought (`quiet`), which
 * the Buy button or its note speaks for. "Live updates paused" and "resumed" are announced once each.
 */
export function useStockAnnouncements(stock: StockState, paused: boolean, quiet: boolean): void {
  const previous = useRef(stock);
  const lastAt = useRef(Number.NEGATIVE_INFINITY);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wasPaused = useRef(paused);

  useEffect(() => {
    const text = stockAnnouncement(previous.current, stock);
    previous.current = stock;
    // The buyer's own press brought this level in, and its button or note speaks for it. An announcement
    // still waiting out the cooldown is older than this level and would contradict that note: dropped too.
    if (quiet) {
      clearTimeout(pending.current);
      return;
    }
    if (text === null) return;
    clearTimeout(pending.current);
    const say = () => {
      lastAt.current = Date.now();
      announce(text);
    };
    const wait = lastAt.current + COOLDOWN_MS - Date.now();
    if (wait <= 0) say();
    else pending.current = setTimeout(say, wait);
  }, [stock, quiet]);

  useEffect(() => () => clearTimeout(pending.current), []);

  useEffect(() => {
    if (paused === wasPaused.current) return;
    wasPaused.current = paused;
    announce(paused ? 'Live updates paused.' : 'Live updates resumed.');
  }, [paused]);
}
