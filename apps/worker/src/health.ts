import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Logger, WorkerRole } from '@flashdrop/config';

/*
 * The worker's health endpoint for the Compose healthcheck (`node healthcheck.mjs <url>`, design §15).
 * `GET /health` answers 200 while every component of every role is healthy, and 503 otherwise:
 *
 * - a loop (sweeper, reconciler) has completed a tick recently; it fails when Postgres or Redis stays
 *   unreachable or a tick hangs. A standby that finds another instance holding a loop's lock still
 *   completes its tick, so standbys are healthy too;
 * - the relay has completed a batch (or found another relay holding the publisher lock) recently;
 * - a consumer group owns at least one partition (§6.4: healthy means assigned), so `up --wait` returns
 *   only once the consumers can actually receive events.
 */

/** One loop, the relay or one consumer group. Extra fields (a group's partitions, the relay's lag) pass through. */
export interface ComponentHealth {
  readonly name: string;
  readonly healthy: boolean;
  /** When it last made progress, ISO 8601; null before the first time. */
  readonly lastOkAt: string | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

export interface HealthReport {
  readonly status: 'ok' | 'unhealthy';
  readonly roles: readonly WorkerRole[];
  readonly components: readonly ComponentHealth[];
}

export interface HealthSource {
  readonly roles: readonly WorkerRole[];
  components(): readonly ComponentHealth[];
}

export function healthReport(source: HealthSource): HealthReport {
  const components = source.components();
  return {
    status: components.length > 0 && components.every((c) => c.healthy) ? 'ok' : 'unhealthy',
    roles: source.roles,
    components,
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
