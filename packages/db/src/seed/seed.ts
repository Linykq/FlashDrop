import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@flashdrop/config';
import type { ImageKey } from '@flashdrop/contracts';
import { OPEN_DROP_STATUSES } from '@flashdrop/domain';
import { and, eq, inArray, ne, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Tx } from '../client';
import { dropLockKey } from '../drops';
import {
  dropInventory,
  drops,
  orders,
  payments,
  products,
  pspCharges,
  rooms,
  userDropQuota,
  users,
} from '../schema';
import { transaction } from '../transaction';
import { loadCatalog, type SeedCatalog } from './catalog';
import { planSeed, type SeedPlan } from './plan';

export interface SeedOptions {
  /** The folder holding `catalog.json` and the product photos (`assets/catalog`). */
  readonly catalogDir: string;
  /** Where `api` serves `/uploads/<key>` from (`UPLOAD_DIR`). */
  readonly uploadDir: string;
  readonly logger: Pick<Logger, 'info'>;
  /** Drop windows are placed around this instant. */
  readonly now?: Date;
  /**
   * Hands the seeded drops to Redis once Postgres has committed them: the seed arms its drops through the
   * same service as `POST /admin/drops/:id/arm` (§15), which is `syncDropFromPostgres` (§4.7; `tools/seed.ts`
   * passes it). `packages/inventory` depends on this package, so the caller injects it.
   */
  readonly armDrops?: (dropIds: readonly string[]) => Promise<void>;
}

export interface SeedResult {
  /** Rows this run created; all zero when the database was already seeded. */
  readonly created: { readonly users: number; readonly products: number; readonly drops: number };
  /** Seeded drops this run moved back around `now`. */
  readonly movedDrops: number;
  readonly photosStored: number;
  /** Every seeded drop, created now or earlier. */
  readonly dropIds: readonly string[];
}

/**
 * Seeds the development catalog in one transaction: users, the live room, the catalog products with their
 * photos, and drops around `now`. Rows are matched by their stable ids and only inserted, and a drop's
 * history is written only by the run that creates the drop, so re-running at the same `now` changes nothing.
 *
 * The exception: seeded drops that nobody has ordered from follow the clock. Each run moves their window and
 * status back around `now` (under each drop's lock, see `moveIdleDrops`), so every `stack:up` (which runs
 * the seed) starts with a LIVE drop. A drop with orders keeps its window, because its orders happened
 * inside it. `pnpm db:reset-dev` starts over completely.
 */
export async function seedDatabase(db: Db, options: SeedOptions): Promise<SeedResult> {
  const catalog = await loadCatalog(options.catalogDir);
  const { keys, stored } = await storePhotos(catalog, options.catalogDir, options.uploadDir);
  const plan = planSeed(catalog, keys, options.now ?? new Date());

  const { created, movedDrops, dropIds } = await transaction(db, (tx) => writePlan(tx, plan));
  options.logger.info({ created, movedDrops, photosStored: stored }, 'seed applied');

  await options.armDrops?.(dropIds);
  return { created, movedDrops, photosStored: stored, dropIds };
}

/** Copies each photo to `<uploadDir>/<sha256>.jpg` once. Content-addressed, so existing files are kept. */
async function storePhotos(
  catalog: SeedCatalog,
  catalogDir: string,
  uploadDir: string,
): Promise<{ keys: Map<string, ImageKey>; stored: number }> {
  await mkdir(uploadDir, { recursive: true });
  const keys = new Map<string, ImageKey>();
  let stored = 0;
  for (const image of catalog.products.flatMap((product) => product.images)) {
    const bytes = await readFile(join(catalogDir, image.src));
    const key: ImageKey = `${createHash('sha256').update(bytes).digest('hex')}.jpg`;
    const target = join(uploadDir, key);
    if (!(await exists(target))) {
      // Write then rename, so a reader (or a crash) never sees half a file under the final name.
      const partial = `${target}.${process.pid}.partial`;
      await writeFile(partial, bytes);
      await rename(partial, target);
      stored++;
    }
    keys.set(image.src, key);
  }
  return { keys, stored };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writePlan(tx: Tx, plan: SeedPlan) {
  const newUsers = await tx
    .insert(users)
    .values([...plan.users])
    .onConflictDoNothing()
    .returning({ id: users.id });
  await tx.insert(rooms).values(plan.room).onConflictDoNothing();
  const newProducts = await tx
    .insert(products)
    .values([...plan.products])
    .onConflictDoNothing()
    .returning({ id: products.id });
  // Without a conflict target this also skips a drop whose product already has another open drop.
  const newDrops = await tx
    .insert(drops)
    .values(plan.drops.map((planned) => planned.drop))
    .onConflictDoNothing()
    .returning({ id: drops.id });

  const createdIds = new Set(newDrops.map((drop) => drop.id));
  const fresh = plan.drops.filter((planned) => createdIds.has(planned.drop.id));
  if (fresh.length > 0) {
    await tx.insert(dropInventory).values(fresh.map((planned) => planned.inventory));
  }

  // History goes through the real transitions, so the orders_guard trigger checks it too.
  const sales = fresh.flatMap((planned) => planned.sales);
  if (sales.length > 0) {
    await tx.insert(orders).values(sales.map((sale) => sale.reserve));
    for (const sale of sales) {
      await tx
        .update(orders)
        .set(sale.place)
        .where(and(eq(orders.id, sale.reserve.id), eq(orders.status, 'RESERVED')));
      await tx
        .update(orders)
        .set(sale.pay)
        .where(and(eq(orders.id, sale.reserve.id), eq(orders.status, 'PENDING_PAYMENT')));
    }
    await tx.insert(payments).values(sales.map((sale) => sale.payment));
    await tx.insert(pspCharges).values(sales.map((sale) => sale.charge));
    await tx.insert(userDropQuota).values(fresh.flatMap((planned) => planned.quotas));
  }

  const moved = await moveIdleDrops(
    tx,
    plan.drops.filter((planned) => !createdIds.has(planned.drop.id)),
  );

  const plannedIds = plan.drops.map((planned) => planned.drop.id);
  const seeded = await tx.select({ id: drops.id }).from(drops).where(inArray(drops.id, plannedIds));
  return {
    created: { users: newUsers.length, products: newProducts.length, drops: newDrops.length },
    movedDrops: moved,
    dropIds: seeded.map((drop) => drop.id),
  };
}

/**
 * Moves existing seeded drops without orders to their planned window and status (see `seedDatabase`).
 * Returns how many changed.
 *
 * Each drop is moved under its drop lock (§4.7), like every other write of an armed drop's status: the
 * transaction-level advisory lock on the same key conflicts with the session-level one that the scheduler,
 * the reconciler and admin actions hold, and this commit releases it. `armDrops` then rebuilds the drop's
 * Redis state from the moved window. Until it does, Redis may admit on the old window; the Postgres window
 * backstop refuses anything outside the new one. The row is locked only after its advisory lock, as every
 * holder of a drop lock does, so the two cannot deadlock.
 */
async function moveIdleDrops(tx: Tx, planned: SeedPlan['drops']): Promise<number> {
  const other = alias(drops, 'other');
  let moved = 0;
  for (const { drop } of planned) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${dropLockKey(drop.id)})`);
    const rows = await tx
      .update(drops)
      .set({ startsAt: drop.startsAt, endsAt: drop.endsAt, status: drop.status })
      .where(
        and(
          eq(drops.id, drop.id),
          or(ne(drops.startsAt, drop.startsAt), ne(drops.endsAt, drop.endsAt), ne(drops.status, drop.status)),
          notExists(tx.select({ id: orders.id }).from(orders).where(eq(orders.dropId, drops.id))),
          // Reopening an ended drop must not collide with a newer open drop of the same product.
          notExists(
            tx
              .select({ id: other.id })
              .from(other)
              .where(
                and(
                  eq(other.productId, drops.productId),
                  ne(other.id, drops.id),
                  inArray(other.status, OPEN_DROP_STATUSES),
                ),
              ),
          ),
        ),
      )
      .returning({ id: drops.id });
    moved += rows.length;
  }
  return moved;
}
