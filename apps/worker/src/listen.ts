import type { Logger } from '@flashdrop/config';
import { BugError } from '@flashdrop/domain';
import pg from 'pg';

/*
 * LISTEN on a dedicated connection (design §4.7: `NOTIFY fd_sync`). Notifications are fire-and-forget: one
 * sent while this connection is down is lost. So the listener reconnects with backoff and calls `onListen`
 * after every successful LISTEN, the first included, and the caller re-checks everything then; its periodic
 * tick backs that up anyway. A notification only ever makes work happen sooner.
 */

export interface ListenOptions {
  readonly connectionString: string;
  readonly channel: string;
  readonly applicationName: string;
  readonly logger: Pick<Logger, 'warn'>;
  readonly onNotify: (payload: string) => void;
  readonly onListen?: () => void;
}

export interface Listener {
  close(): Promise<void>;
}

const CHANNEL = /^[a-z_][a-z0-9_]*$/;
const MAX_BACKOFF_MS = 30_000;

export function listen(options: ListenOptions): Listener {
  if (!CHANNEL.test(options.channel)) throw new BugError(`not a channel name: ${options.channel}`);
  let closed = false;
  let current: pg.Client | undefined;
  let retry: NodeJS.Timeout | undefined;
  let attempt = 0;

  const connect = () => {
    if (closed) return;
    const client = new pg.Client({
      connectionString: options.connectionString,
      application_name: options.applicationName,
    });
    let failed = false;
    const fail = (err?: unknown) => {
      if (failed) return;
      failed = true;
      if (current === client) current = undefined;
      client.end().catch(() => undefined);
      if (closed) return;
      // Full jitter, so instances that lost Postgres together do not reconnect in step.
      const delayMs = Math.random() * Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++);
      options.logger.warn({ err, channel: options.channel, retryInMs: Math.round(delayMs) }, 'LISTEN lost');
      retry = setTimeout(connect, delayMs);
    };
    client.on('error', fail);
    client.on('end', () => fail());
    client.on('notification', (message) => {
      if (message.channel === options.channel) options.onNotify(message.payload ?? '');
    });
    current = client;
    client
      .connect()
      .then(() => client.query(`LISTEN "${options.channel}"`))
      .then(() => {
        if (failed || closed) return;
        attempt = 0;
        options.onListen?.();
      }, fail);
  };

  connect();
  return {
    async close() {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      // The client may still be connecting: ending it makes its pending connect or LISTEN fail.
      const client = current;
      current = undefined;
      await client?.end().catch(() => undefined);
    },
  };
}
