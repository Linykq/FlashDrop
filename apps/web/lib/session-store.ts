/*
 * Per-tab storage for Idempotency-Keys (SD §8.2): sessionStorage, so a reload or a retry in this tab sends the
 * same key again, while another tab starts its own intent. sessionStorage throws where site data is blocked
 * (some private modes); values then live in memory, which still covers retries on this page, just not a reload.
 */

const memory = new Map<string, string>();

export const sessionStore = {
  get(name: string): string | null {
    try {
      return sessionStorage.getItem(name);
    } catch {
      return memory.get(name) ?? null;
    }
  },
  set(name: string, value: string): void {
    try {
      sessionStorage.setItem(name, value);
    } catch {
      memory.set(name, value);
    }
  },
  remove(name: string): void {
    memory.delete(name);
    try {
      sessionStorage.removeItem(name);
    } catch {
      // Nothing was stored there: `set` fell back to memory, which is already cleared.
    }
  },
};
