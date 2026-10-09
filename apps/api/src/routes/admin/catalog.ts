import {
  AdminDropDetailResponse,
  AdminDropListQuery,
  AdminDropListResponse,
  AdminDropParams,
  AdminProductListResponse,
  AdminRoomListResponse,
} from '@flashdrop/contracts';
import type { FastifyReply } from 'fastify';
import type { Api } from '../../http/api';
import { adminOnly } from '../../http/session';
import type { AdminCatalogService } from '../../services/admin-catalog';

/** Admin reads change with every action an admin takes, so no client or proxy may keep one. */
function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'private, no-store');
}

/**
 * The reads behind the admin drop pages (design §5.1, design system §10.8), admins only:
 *
 *   GET /admin/drops       drops in any status, with product, room and stock of record
 *   GET /admin/drops/:id   one drop, the same shape
 *   GET /admin/products    PUBLISHED products for the "New drop" sheet, with their open drop
 *   GET /admin/rooms       live rooms for the same sheet
 */
export function adminCatalogRoutes(app: Api, { catalog }: { readonly catalog: AdminCatalogService }): void {
  app.get(
    '/admin/drops',
    {
      onRequest: adminOnly,
      schema: { querystring: AdminDropListQuery, response: { 200: AdminDropListResponse } },
    },
    async (request, reply) => {
      noStore(reply);
      return { drops: await catalog.listDrops(request.query) };
    },
  );

  app.get(
    '/admin/drops/:id',
    { onRequest: adminOnly, schema: { params: AdminDropParams, response: { 200: AdminDropDetailResponse } } },
    async (request, reply) => {
      noStore(reply);
      return { drop: await catalog.getDrop(request.params.id) };
    },
  );

  app.get(
    '/admin/products',
    { onRequest: adminOnly, schema: { response: { 200: AdminProductListResponse } } },
    async (_request, reply) => {
      noStore(reply);
      return { products: await catalog.listProducts() };
    },
  );

  app.get(
    '/admin/rooms',
    { onRequest: adminOnly, schema: { response: { 200: AdminRoomListResponse } } },
    async (_request, reply) => {
      noStore(reply);
      return { rooms: await catalog.listRooms() };
    },
  );
}
