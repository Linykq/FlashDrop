import type {
  AdminDropListing,
  AdminDropListQuery,
  AdminProductOption,
  AdminRoom,
} from '@flashdrop/contracts';
import { NotFoundError } from '@flashdrop/domain';
import type { AdminCatalogService } from '../services/admin-catalog';

/** An in-memory `AdminCatalogService` for `inject()` tests: the routes run for real, without Postgres. */
export interface FakeAdminCatalog extends AdminCatalogService {
  readonly drops: AdminDropListing[];
  readonly products: AdminProductOption[];
  readonly rooms: AdminRoom[];
  /** Every list query the routes passed on, after validation. */
  readonly queries: AdminDropListQuery[];
}

export function createFakeAdminCatalog(): FakeAdminCatalog {
  const drops: AdminDropListing[] = [];
  const products: AdminProductOption[] = [];
  const rooms: AdminRoom[] = [];
  const queries: AdminDropListQuery[] = [];
  return {
    drops,
    products,
    rooms,
    queries,
    async listDrops(query) {
      queries.push(query);
      return drops.filter((drop) => query.status.includes(drop.status)).slice(0, query.limit);
    },
    async getDrop(dropId) {
      const drop = drops.find((candidate) => candidate.id === dropId);
      if (drop === undefined) throw new NotFoundError('Drop');
      return drop;
    },
    listProducts: async () => products,
    listRooms: async () => rooms,
  };
}
