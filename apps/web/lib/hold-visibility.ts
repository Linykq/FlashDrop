import { type RefObject, useEffect, useSyncExternalStore } from 'react';

/*
 * Whether checkout's countdown is out of view: scrolled up under the navigation bar, as it is while the buyer
 * fills in the form on a phone. The time limit must stay visible while it runs (WCAG 2.2.1), so meanwhile the
 * checkout bar, an island of the layout, shows a compact copy of it (like the large title's compact copy,
 * design-system §9.19), and the page offers the extension by Pay. One flag per tab, set by the page.
 */

/** The hold card's id: the compact countdown in the bar links back to it, and it takes focus there. */
export const HOLD_CARD_ID = 'hold-card';

let hidden = false;
const listeners = new Set<() => void>();

function setHidden(value: boolean): void {
  if (hidden === value) return;
  hidden = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the countdown is out of view; `false` on the server, during hydration and off checkout. */
export function useHoldCountdownHidden(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => false,
  );
}

/**
 * Whether an observed element has wholly passed above the visible area (`rootTop`, the bottom edge of the
 * bar), rather than lying below it, as the card does in a viewport too short to reach it.
 */
export function scrolledAbove(
  { isIntersecting, bottom }: { isIntersecting: boolean; bottom: number },
  rootTop: number,
): boolean {
  return !isIntersecting && bottom <= rootTop;
}

/**
 * Watches the countdown `target` (the hold card's top row) against the viewport below the navigation bar,
 * like `ScrollEdge`: it is out of view once it has wholly passed under the bar. Unmounted, it is in view again.
 */
export function useWatchHoldCountdown(target: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const bar = document.querySelector<HTMLElement>('[data-nav-bar]');
    const observer = new IntersectionObserver(
      ([entry]) =>
        setHidden(
          entry !== undefined &&
            scrolledAbove(
              { isIntersecting: entry.isIntersecting, bottom: entry.boundingClientRect.bottom },
              entry.rootBounds?.top ?? 0,
            ),
        ),
      { rootMargin: `-${bar?.offsetHeight ?? 0}px 0px 0px 0px` },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      setHidden(false);
    };
  }, [target]);
}
