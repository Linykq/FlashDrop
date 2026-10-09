import { sessionStore } from './session-store';

/*
 * Where focus goes back to after signing in (design-system §13.2): a buyer who pressed "Sign in to buy" lands
 * back on the page they came from with focus on its Buy button, not at the top of the page. The sign-in form
 * names the page; the purchase panel takes the note once, if it is on that page.
 */

const KEY = 'fd-return-focus';

/** Called by the sign-in form just before it navigates to `path`. */
export function markReturnFocus(path: string): void {
  sessionStore.set(KEY, path);
}

/** Whether focus should go to the purchase action on `path`; the note is used up either way. */
export function takeReturnFocus(path: string): boolean {
  const marked = sessionStore.get(KEY);
  if (marked === null) return false;
  sessionStore.remove(KEY);
  return marked === path;
}
