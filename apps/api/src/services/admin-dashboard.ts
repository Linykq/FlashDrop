import type { AdminDashboardResponse, DashboardDrop, SalesMinute } from '@flashdrop/contracts';
import {
  type Db,
  dropInventory,
  drops,
  eq,
  products,
  readSalesMinutes,
  readSalesTotals,
} from '@flashdrop/db';
import { NotFoundError } from '@flashdrop/domain';
import { isTransientRedisError } from '@flashdrop/inventory';
import type { AdminHealthService } from './admin-health';
import type { StockReader } from './stock';

/*
 * The live sales dashboard's first state (design §9): the projection's totals and minutes, live Redis
 * stock and the health tiles. The page renders it on the server, then follows `dash:<dropId>` (totals,
 * applied only when their version is newer) and `stock:<dropId>`.
 *
 * The projection lives in Postgres, so the page still answers while Redis is away: the stock tile then
 * shows nothing (`stock: null`, like a drop being rebuilt) and the drift tile says it could not compare.
 */

export interface AdminDashboardService {
  /** `GET /api/v1/admin/dashboard/drops/:dropId`; 404 for an unknown drop. */
  read(dropId: string): Promise<AdminDashboardResponse>;
}

export interface AdminDashboardDeps {
  readonly db: Db;
  readonly stock: StockReader;
  readonly health: Pick<AdminHealthService, 'events' | 'drift'>;
  readonly now?: () => Date;
}

export function createAdminDashboard(deps: AdminDashboardDeps): AdminDashboardService {
  const { db, stock, health } = deps;
  const now = deps.now ?? (() => new Date());

  async function dropOf(dropId: string): Promise<DashboardDrop> {
    const [row] = await db
      .select({ drop: drops, total: dropInventory.total, product: products })
      .from(drops)
      .innerJoin(dropInventory, eq(dropInventory.dropId, drops.id))
      .innerJoin(products, eq(products.id, drops.productId))
      .where(eq(drops.id, dropId));
    if (row === undefined) throw new NotFoundError('drop');
    const { drop, total, product } = row;
    return {
      id: drop.id,
      status: drop.status,
      startsAt: drop.startsAt.toISOString(),
      endsAt: drop.endsAt.toISOString(),
      endedAt: drop.endedAt?.toISOString() ?? null,
      priceCents: drop.priceCents,
      currency: drop.currency,
      total,
      product: { id: product.id, slug: product.slug, title: product.title },
    };
  }

  return {
    async read(dropId) {
      const drop = await dropOf(dropId);
      const [projection, series, level, events, redisDriftUnits] = await Promise.all([
        readSalesTotals(db, dropId),
        readSalesMinutes(db, dropId),
        stock.snapshot(dropId).catch((err: unknown) => {
          if (isTransientRedisError(err)) return undefined;
          throw err;
        }),
        health.events(),
        health.drift(dropId),
      ]);
      return {
        drop,
        projection,
        series,
        soldOutMinute: soldOutMinute(series, drop.total),
        stock: typeof level === 'object' ? level : null,
        health: { ...events, redisDriftUnits },
        serverNow: now().toISOString(),
      };
    },
  };
}

/** The minute in which the units sold, counted in event time, reached the drop's total; null until then. */
export function soldOutMinute(series: readonly SalesMinute[], total: number): string | null {
  let sold = 0;
  for (const minute of series) {
    sold += minute.unitsSold;
    if (sold >= total) return minute.minute;
  }
  return null;
}
