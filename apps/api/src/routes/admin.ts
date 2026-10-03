import {
  ADMIN_DROP_ACTIONS,
  AdminDropParams,
  AdminDropResponse,
  CreateDropBody,
  PatchDropBody,
} from '@flashdrop/contracts';
import type { Api } from '../http/api';
import { adminOnly } from '../http/session';
import type { AdminDropService } from '../services/admin-drops';

/**
 * Drop administration (design §4.7, §5.1), admins only. Every action except create runs under the drop
 * lock: 409 `DROP_BUSY` when it stays taken for 10 s, 409 `DROP_ARMED` for an edit or arm of an armed drop,
 * 409 `CONFLICT` for an action the drop's status does not allow.
 */
export function adminRoutes(app: Api, { adminDrops }: { readonly adminDrops: AdminDropService }): void {
  const response = { 200: AdminDropResponse };

  app.post(
    '/admin/drops',
    { onRequest: adminOnly, schema: { body: CreateDropBody, response: { 201: AdminDropResponse } } },
    async (request, reply) => {
      reply.code(201);
      return { drop: await adminDrops.create(request.body) };
    },
  );

  app.patch(
    '/admin/drops/:id',
    { onRequest: adminOnly, schema: { params: AdminDropParams, body: PatchDropBody, response } },
    async (request) => ({ drop: await adminDrops.patch(request.params.id, request.body) }),
  );

  for (const action of ADMIN_DROP_ACTIONS) {
    app.post(
      `/admin/drops/:id/${action}`,
      { onRequest: adminOnly, schema: { params: AdminDropParams, response } },
      async (request) => ({ drop: await adminDrops.act(request.params.id, action) }),
    );
  }
}
