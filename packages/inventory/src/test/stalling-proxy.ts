import net from 'node:net';

/*
 * A TCP proxy in front of Redis that can stop forwarding while keeping every socket open: a paused
 * container or a blackholed network as the client sees it. Nothing errors and nothing closes, so only an
 * application deadline ends a call (integration tests only).
 */

export interface StallingProxy {
  /** The Redis URL through the proxy. */
  readonly url: string;
  /** From now on every byte in either direction is dropped; the sockets stay open. */
  freeze(): void;
  close(): Promise<void>;
}

export async function startStallingProxy(redisUrl: string): Promise<StallingProxy> {
  const target = new URL(redisUrl);
  let frozen = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 6379), target.hostname);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      sockets.add(from);
      from.on('data', (chunk) => {
        if (!frozen) to.write(chunk);
      });
      from.on('close', end);
      from.on('error', end);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('proxy has no TCP address');
  const url = new URL(redisUrl);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);

  return {
    url: url.href,
    freeze() {
      frozen = true;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
