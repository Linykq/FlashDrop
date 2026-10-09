import { describe, expect, it, vi } from 'vitest';
import { announceSessionChange, onSessionChange } from './session-signal';

describe('session signal', () => {
  it('tells this tab at once, and stops after the unsubscribe', () => {
    const listener = vi.fn();
    const stop = onSessionChange(listener);
    announceSessionChange();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    announceSessionChange();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hears another tab, and never its own message twice', async () => {
    const listener = vi.fn();
    const stop = onSessionChange(listener);
    const otherTab = new BroadcastChannel('fd-session');
    const heard = new Promise<void>((resolve) => {
      otherTab.addEventListener('message', () => resolve(), { once: true });
    });
    try {
      // This tab's own announcement reaches the other tab, and this tab only once (synchronously).
      announceSessionChange();
      await heard;
      expect(listener).toHaveBeenCalledTimes(1);

      otherTab.postMessage('changed');
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
      // Anything else another build might send is ignored.
      otherTab.postMessage({ kind: 'changed' });
      otherTab.postMessage('changed');
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3));
    } finally {
      stop();
      otherTab.close();
    }
  });
});
