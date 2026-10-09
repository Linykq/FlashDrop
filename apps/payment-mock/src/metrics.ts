import { collectDefaultMetrics, Registry } from '@prometheus-io/client';
import type { PspApp } from './app';

/*
 * The mock PSP's Prometheus endpoint (design §12), on its own port, which only the Compose network reaches.
 * It carries the process series alone: the PSP's behaviour is measured where FlashDrop meets it, in the
 * payment consumer's `fd_psp_requests_total`, as it would be with a real PSP that exports nothing to us.
 */

export const registry = new Registry();

export const METRICS_PATH = '/metrics';

/** Node's own process metrics (CPU, memory, event loop, GC); once per process (main.ts). */
export function collectProcessMetrics(): void {
  collectDefaultMetrics({ register: registry });
}

/** `GET /metrics` in the Prometheus text format. */
export function metricsRoute(app: PspApp): void {
  app.get(METRICS_PATH, async (_request, reply) => {
    reply.header('content-type', registry.contentType).header('cache-control', 'no-store');
    return registry.metrics();
  });
}
