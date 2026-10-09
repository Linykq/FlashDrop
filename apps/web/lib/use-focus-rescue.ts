'use client';

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Keeps focus in `container` when the control that had it leaves the page: a hold that ends takes "Go to
 * checkout" with it, a sold-out drop swaps Buy for a link, a refusal at the limit replaces the row. Focus
 * would otherwise fall to <body> and a keyboard or screen-reader user would lose their place (WCAG 2.4.3,
 * design-system §13.2). After any render that left focus on <body> while it was last inside, `target()` takes
 * it, without scrolling.
 *
 * "Last inside" ends only when focus moved somewhere real: to another element, or to the page itself by a
 * click (the control is still on the page a frame later). A control that was removed is gone by then, and a
 * window that lost focus keeps its active element, so neither counts as leaving.
 */
export function useFocusRescue(
  container: RefObject<HTMLElement | null>,
  target: () => HTMLElement | null | undefined,
): void {
  const inside = useRef(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onFocusIn = () => {
      inside.current = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && element.contains(next)) return;
      if (next !== null) {
        inside.current = false;
        return;
      }
      const left = event.target;
      requestAnimationFrame(() => {
        if (left instanceof Node && left.isConnected && document.activeElement !== left)
          inside.current = false;
      });
    };
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    return () => {
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
    };
  }, [container]);

  // Every commit: the one that removed the focused control is the one to repair, before the next paint.
  useLayoutEffect(() => {
    if (!inside.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    target()?.focus({ preventScroll: true });
  });
}
