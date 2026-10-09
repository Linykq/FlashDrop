import { AdminHealthResponse } from '@flashdrop/contracts';
import type { Api } from '../../http/api';
import { adminOnly } from '../../http/session';
import type { AdminHealthService } from '../../services/admin-health';

/**
 * The live invariant checks and health tiles (design §12), admins only, never cached by a client: the page
 * polls it every 5 s (design system §10.11) and the service already shares one check between callers.
 */
export function adminHealthRoutes(app: Api, { health }: { readonly health: AdminHealthService }): void {
  app.get(
    '/admin/health',
    { onRequest: adminOnly, schema: { response: { 200: AdminHealthResponse } } },
    async (_request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return health.read();
    },
  );
}
