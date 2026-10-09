/**
 * Whether the buyer has already put focus somewhere on the page: an element other than <body> that is still
 * shown. A page's load focus (checkout's and the order page's `h1`, SD §8.3) runs at hydration, which on a
 * slow phone comes a second or more after the markup is usable; by then the buyer may be typing in a field,
 * and moving focus would drop their keystrokes. A control left focused on the page navigated away from is
 * hidden by then (Next keeps that page in a hidden <Activity>), so it doesn't count.
 */
export function userHasFocus(
  active: Pick<Element, 'checkVisibility'> | null,
  body: Pick<Element, 'checkVisibility'> | null,
): boolean {
  if (active === null || active === body) return false;
  // Browsers before checkVisibility() (Safari < 17.4) count any focused element as the buyer's.
  return typeof active.checkVisibility !== 'function' || active.checkVisibility();
}

/** Focuses a page's heading on load, unless the buyer got there first (`userHasFocus`). */
export function focusOnLoad(heading: HTMLElement | null): void {
  if (!userHasFocus(document.activeElement, document.body)) heading?.focus();
}

/**
 * Focus for when the control that had it left the page (an action set re-rendered after the action, a
 * dismissed banner): the first action of the page header, or its large title, never `<body>` (WCAG 2.4.3).
 * Only the header's own buttons count; its confirmation dialogs sit beside them, closed.
 */
export function focusPageStart(): void {
  const target =
    document.querySelector<HTMLElement>('[data-page-actions] > button:not([aria-disabled="true"])') ??
    document.querySelector<HTMLElement>('[data-large-title]');
  target?.focus();
}
