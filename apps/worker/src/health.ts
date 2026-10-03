import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Logger, WorkerRole } from '@flashdrop/config';
import type { LoopHealth } from './loop';

/*
 * The worker's health endpoint for the Compose healthcheck (`node healthcheck.mjs <url>`, design §15).
 * `GET /health` answers 200 while every loop of every role has completed a tick recently, and 503 before
 * the first ticks and whenever a loop keeps failing (Postgres or Redis unreachable) or hangs. A standby that
 * finds another instance holding a loop's lock still completes its tick, so standbys are healthy too.
 */

export interface HealthReport {
  readonly status: 'ok' | 'unhealthy';
  readonly roles: readonly WorkerRole[];
  readonly loops: readonly LoopHealth[];
}

export interface HealthSource {
  readonly roles: readonly WorkerRole[];
  loops(): readonly LoopHealth[];
}

export function healthReport(source: HealthSource): HealthReport {
  const loops = source.loops();
  return {
    status: loops.length > 0 && loops.every((loop) => loop.healthy) ? 'ok' : 'unhealthy',
    roles: source.roles,
    loops,
  };
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startHealthServer(options: {
  readonly host: string;
  readonly port: number;
  readonly source: HealthSource;
  readonly logger: Pick<Logger, 'info'>;
}): Promise<HealthServer> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    const report = healthReport(options.source);
    response
      .writeHead(report.status === 'ok' ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      .end(JSON.stringify(report));
  });
  server.listen(options.port, options.host);
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  options.logger.info({ host: options.host, port }, 'health endpoint listening');
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
