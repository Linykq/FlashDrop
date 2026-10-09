/*
 * "The session changed": sign-in, sign-out or an account switch, in this tab or another one (the cookie is
 * shared by every tab). The gateway fixes a socket's principal at the upgrade, from the cookie it carried
 * then (SD §7, §11), so a tab's real-time client replaces its socket on this signal: otherwise the tab of a
 * buyer who just signed in would never get its `order` pushes, and a tab where another account signed in
 * would keep the last one's `user` channel and admin rights.
 *
 * In this tab listeners are called synchronously. Other tabs hear it through a BroadcastChannel; a tab never
 * receives its own messages, because everything here goes through one channel object per tab. A browser
 * without BroadcastChannel misses only the other tabs, whose sockets the gateway closes at the session's
 * expiry anyway.
 */

const CHANNEL_NAME = 'fd-session';
const CHANGED = 'changed';

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function tabChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
    channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.data === CHANGED) notify();
    });
  }
  return channel;
}

/** Says the session changed, here and in the other tabs. Call it once api answered the change. */
export function announceSessionChange(): void {
  notify();
  tabChannel()?.postMessage(CHANGED);
}

/** Calls `listener` whenever the session changes, in this tab or another; returns the unsubscribe. */
export function onSessionChange(listener: () => void): () => void {
  tabChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
