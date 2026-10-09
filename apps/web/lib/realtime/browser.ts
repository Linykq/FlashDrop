import { noteServerTime } from '../clock';
import { onSessionChange } from '../session-signal';
import { RealtimeClient, type SocketFactory } from './client';
import { GATEWAY_PATH } from './protocol';

/*
 * The tab's `RealtimeClient` (SD §8.2), created on first use in the browser. The socket is same-origin `/ws`,
 * derived from `location`, so one built image works behind any host (§8.1). `NEXT_PUBLIC_WS_URL` is inlined
 * at build time and only overrides that for `pnpm dev`, where web and api listen on different ports.
 */

/**
 * `?ws=1` pins the tab's first socket to one gateway instance through Caddy's `/ws/1` (§7: the fan-out test
 * and the two-browser demo). Only the first: a reconnect goes through `/ws`, which fails over to a live
 * instance, so the pinned tab of a killed instance reconnects and resyncs like any other.
 */
export function pinnedPath(search: string): string | null {
  const instance = new URLSearchParams(search).get('ws');
  return instance !== null && /^[1-9]\d?$/.test(instance) ? `${GATEWAY_PATH}/${instance}` : null;
}

/** The gateway's URL on the page's own origin. */
export function gatewayUrl(location: Pick<Location, 'protocol' | 'host'>, path: string): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}

const browserSocket: SocketFactory = (url, handlers) => {
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    // A malformed override: reported, then treated as a socket that closed at once, so the page polls.
    reportError(error);
    queueMicrotask(() => handlers.onClose(1006));
    return { send: () => {}, close: () => {} };
  }
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    // The gateway sends text frames only.
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  });
  socket.addEventListener('close', (event) => handlers.onClose(event.code));
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: (code, reason) => socket.close(code, reason),
  };
};

let client: RealtimeClient | undefined;

/** The tab's one client. Browser only: call it from effects and event handlers, never while rendering. */
export function realtime(): RealtimeClient {
  if (client !== undefined) return client;
  const override = process.env.NEXT_PUBLIC_WS_URL;
  let pinned = pinnedPath(window.location.search);
  client = new RealtimeClient({
    url: () => {
      if (override) return override;
      const path = pinned ?? GATEWAY_PATH;
      pinned = null;
      return gatewayUrl(window.location, path);
    },
    createSocket: browserSocket,
    onServerTime: noteServerTime,
    onNetwork: (listener) => {
      const online = () => listener(true);
      const offline = () => listener(false);
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      return () => {
        window.removeEventListener('online', online);
        window.removeEventListener('offline', offline);
      };
    },
    report: (error) => reportError(error),
    random: Math.random,
    now: Date.now,
  });
  // The tab's one client lives as long as the tab, so this subscription is never dropped.
  const created = client;
  onSessionChange(() => created.reconnect());
  return client;
}
