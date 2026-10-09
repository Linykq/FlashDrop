import {
  DropIdParams,
  DropListQuery,
  DropListResponse,
  ProductDetail,
  ProductSlugParams,
  RoomDetail,
  RoomSlugParams,
  StockSnapshot,
} from '@flashdrop/contracts';
import { NotFoundError, RetryError } from '@flashdrop/domain';
import type { Api } from '../http/api';
import { type CatalogStore, listDropSummaries, withStock } from '../services/catalog';
import type { StockReader } from '../services/stock';

export interface CatalogDeps {
  readonly catalog: CatalogStore;
  readonly stock: StockReader;
  readonly now: () => Date;
}

/** The catalog and live rooms `web` renders server-side, and the uncached stock snapshot (design §5.1, §8.1). */
export function catalogRoutes(app: Api, { catalog, stock, now }: CatalogDeps): void {
  app.get(
    '/drops',
    { schema: { querystring: DropListQuery, response: { 200: DropListResponse } } },
    async (request) => ({ drops: await listDropSummaries(catalog, stock, request.query, request.log) }),
  );

  app.get(
    '/products/:slug',
    { schema: { params: ProductSlugParams, response: { 200: ProductDetail } } },
    async (request) => {
      const detail = await catalog.productBySlug(request.params.slug);
      if (detail === undefined) throw new NotFoundError('Product');
      return detail;
    },
  );

  app.get(
    '/rooms/:slug',
    { schema: { params: RoomSlugParams, response: { 200: RoomDetail } } },
    async (request) => {
      const detail = await catalog.roomBySlug(request.params.slug);
      if (detail === undefined) throw new NotFoundError('Room');
      const [drop] = detail.drop === null ? [] : await withStock([detail.drop], stock, request.log);
      return { room: detail.room, drop: drop ?? null };
    },
  );

  app.get(
    '/drops/:dropId/stock',
    { schema: { params: DropIdParams, response: { 200: StockSnapshot } } },
    async (request, reply) => {
      // Never cached anywhere, a 404 included: a drop armed a moment later must show up at once.
      reply.header('cache-control', 'no-store');
      const level = await stock.snapshot(request.params.dropId);
      if (level === undefined) throw new NotFoundError('Drop');
      // Clients keep their last level and retry; they never see the fail-closed counters of a rebuild.
      if (level === 'RETRY') throw new RetryError('The drop is being rebuilt, retry');
      return { ...level, serverNow: now().toISOString() };
    },
  );
}
