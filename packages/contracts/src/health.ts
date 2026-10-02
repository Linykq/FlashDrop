import { z } from 'zod';

/**
 * `GET /api/v1/health` (readiness: every dependency answered; the Compose healthcheck) and
 * `GET /api/v1/health/live` (liveness: no dependency checks). A failed check answers 503 `RETRY` problem
 * details instead, naming the dependency.
 */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  checks: z.record(z.string(), z.literal('ok')),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
