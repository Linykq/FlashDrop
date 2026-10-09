import { AdminDashboardParams, AdminDashboardResponse } from '@flashdrop/contracts';
import type { Api } from '../../http/api';
import { adminOnly } from '../../http/session';
import type { AdminDashboardService } from '../../services/admin-dashboard';

/**
 * The live sales dashboard's first state (design §9), admins only. Never cached: it is the base the page's
 * WebSocket frames build on, and a stale base would hide the frames older than it.
 */
export function adminDashboardRoutes(
  app: Api,
  { dashboard }: { readonly dashboard: AdminDashboardService },
): void {
  app.get(
    '/admin/dashboard/drops/:dropId',
    {
      onRequest: adminOnly,
      schema: { params: AdminDashboardParams, response: { 200: AdminDashboardResponse } },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      return dashboard.read(request.params.dropId);
    },
  );
}
