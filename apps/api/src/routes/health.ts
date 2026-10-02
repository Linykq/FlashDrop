import { HealthResponse } from '@flashdrop/contracts';
import { RetryError } from '@flashdrop/domain';
import type { Api } from '../http/api';
import type { DependencyCheck } from '../services/health';

/** Probe routes; their request logs are muted, because Compose polls them every few seconds. */
export const PROBE_ROUTES = new Set(['/api/v1/health', '/api/v1/health/live']);

/**
 * `GET /health` is the readiness probe: every dependency must answer (Postgres in M1; Redis joins in M2).
 * Compose gates Caddy on it. `GET /health/live` only shows that the process serves requests, so an
 * orchestrator never restarts a healthy api because the database is down.
 */
export function healthRoutes(app: Api, checks: Readonly<Record<string, DependencyCheck>>): void {
  const response = { 200: HealthResponse };

  app.get('/health/live', { schema: { response } }, async () => ({ status: 'ok' as const, checks: {} }));

  app.get('/health', { schema: { response } }, async () => {
    const names = Object.keys(checks);
    const results = await Promise.allSettled(Object.values(checks).map((check) => check()));
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (failures.length > 0) {
      const failed = names.filter((_, index) => results[index]?.status === 'rejected');
      throw new RetryError(`${failed.join(', ')} unavailable`, 1, { cause: new AggregateError(failures) });
    }
    return { status: 'ok' as const, checks: Object.fromEntries(names.map((name) => [name, 'ok' as const])) };
  });
}
