import { type DependencyCheck, failedChecks } from '@flashdrop/config';
import { HealthResponse } from '@flashdrop/contracts';
import { RetryError } from '@flashdrop/domain';
import type { Api } from '../http/api';

/** Probe routes; their request logs are muted, because Compose polls them every few seconds. */
export const PROBE_ROUTES = new Set(['/api/v1/health', '/api/v1/health/live']);

/**
 * `GET /health` is the readiness probe: every dependency (Postgres and Redis) must answer. Compose gates
 * Caddy on it. `GET /health/live` only shows that the process serves requests, so an orchestrator never
 * restarts a healthy api because the database is down.
 */
export function healthRoutes(app: Api, checks: Readonly<Record<string, DependencyCheck>>): void {
  const response = { 200: HealthResponse };

  app.get('/health/live', { schema: { response } }, async () => ({ status: 'ok' as const, checks: {} }));

  app.get('/health', { schema: { response } }, async (request) => {
    const failed = await failedChecks(checks, request.log);
    if (failed.length > 0) throw new RetryError(`${failed.join(', ')} unavailable`);
    return {
      status: 'ok' as const,
      checks: Object.fromEntries(Object.keys(checks).map((name) => [name, 'ok' as const])),
    };
  });
}
