import { randomUUID } from 'node:crypto';
import {
  type CloseReason,
  canTransition,
  INITIAL_ORDER_STATUSES,
  isTerminalOrderStatus,
  ORDER_STATUSES,
  type OrderStatus,
} from '@flashdrop/domain';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { constraintOf } from './errors';
import { migrateDatabase } from './migrate';
import { dropInventory, drops, orders, products, rooms, userDropQuota, users } from './schema';
import { createTestDatabase, type TestDatabase } from './test-database';

let test: TestDatabase;

beforeAll(async () => {
  test = await createTestDatabase();
});

afterAll(async () => {
  await test?.drop();
});

/** Runs `statement` and returns the constraint that rejected it, or undefined when it succeeded. */
async function rejection(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
    return undefined;
  } catch (error) {
    const constraint = constraintOf(error);
    if (constraint === undefined) throw error;
    return constraint;
  }
}

describe('migrations', () => {
  it('are recorded once, and a second run is a no-op', async () => {
    expect(await migrateDatabase(test.pool)).toEqual({ applied: 0, total: 6 });
  });

  it('create every named constraint (§3)', async () => {
    const { rows } = await test.pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname IN ('public', 'psp')`,
    );
    const defs = new Map(rows.map((row) => [row.conname, row.def]));

    expect([...defs.keys()]).toEqual(
      expect.arrayContaining([
        'users_pkey',
        'users_email_key',
        'users_role_check',
        'rooms_slug_key',
        'rooms_slug_check',
        'products_slug_key',
        'products_slug_check',
        'products_title_check',
        'products_image_keys_check',
        'products_status_check',
        'products_source_check',
        'drops_window',
        'drops_price_cents_check',
        'drops_currency_check',
        'drops_per_user_limit_check',
        'drops_hold_seconds_check',
        'drops_payment_seconds_check',
        'drop_inventory_pkey',
        'drop_inventory_total_check',
        'drop_inventory_reserved_check',
        'drop_inventory_sold_check',
        'no_oversell',
        'user_drop_quota_pkey',
        'within_limit',
        'orders_pkey',
        'orders_user_drop_idempotency_key',
        'orders_qty_check',
        'orders_unit_price_cents_check',
        'orders_close_reason_check',
        'orders_extensions_check',
        'orders_paid_at_matches_status',
        'orders_closed_at_matches_status',
        'payments_pkey',
        'payments_psp_charge_id_key',
        'payments_amount_cents_check',
        'outbox_pkey',
        'outbox_event_id_key',
        'processed_events_pkey',
        'sales_minute_pkey',
        'drop_sales_totals_pkey',
        'listing_jobs_status_check',
        'system_state_pkey',
        'sweeper_quarantine_pkey',
        'charges_idempotency_key_key',
        'charges_status_check',
        'references_pkey',
      ]),
    );
    expect(defs.get('no_oversell')).toBe('CHECK (((reserved + sold) <= total))');
    expect(defs.get('within_limit')).toBe('CHECK (((claimed >= 0) AND (claimed <= limit_qty)))');
    expect(defs.get('orders_user_drop_idempotency_key')).toBe('UNIQUE (user_id, drop_id, idempotency_key)');
    expect(defs.get('processed_events_pkey')).toBe('PRIMARY KEY (consumer, event_id)');
  });

  it('create the named partial indexes (§3)', async () => {
    const { rows } = await test.pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE indexname IN ('one_open_drop_per_product', 'orders_due', 'orders_unsettled', 'outbox_pending',
                           'orders_drop_id', 'user_drop_quota_drop_id')
       ORDER BY indexname`,
    );
    const defs = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));

    expect(defs.one_open_drop_per_product).toMatch(
      /^CREATE UNIQUE INDEX .* ON public\.drops .*\(product_id\) WHERE \(status = ANY \(ARRAY\['SCHEDULED'::drop_status, 'LIVE'::drop_status, 'PAUSED'::drop_status\]\)\)$/,
    );
    expect(defs.orders_due).toMatch(
      /ON public\.orders .*\(expires_at\) WHERE \(status = ANY \(ARRAY\['RESERVED'::order_status, 'PENDING_PAYMENT'::order_status\]\)\)$/,
    );
    expect(defs.orders_unsettled).toMatch(
      /ON public\.orders .*\(updated_at\) WHERE \(\(redis_settled_at IS NULL\)/,
    );
    expect(defs.outbox_pending).toMatch(/ON public\.outbox .*\(id\) WHERE \(published_at IS NULL\)$/);
    expect(defs.orders_drop_id).toMatch(/ON public\.orders .*\(drop_id, id\)$/);
    expect(defs.user_drop_quota_drop_id).toMatch(
      /ON public\.user_drop_quota .*\(drop_id\) WHERE \(claimed > 0\)$/,
    );
  });

  it('install the orders_guard trigger for inserts and updates', async () => {
    const { rows } = await test.pool.query<{ tgenabled: string; tgtype: number }>(
      `SELECT tgenabled, tgtype FROM pg_trigger WHERE tgname = 'orders_guard' AND tgrelid = 'orders'::regclass`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tgenabled).toBe('O');
    // tgtype bits: ROW (1) | BEFORE (2) | INSERT (4) | UPDATE (16).
    expect(rows[0]?.tgtype).toBe(1 | 2 | 4 | 16);
  });

  it('install the drop_inventory_touch trigger for updates', async () => {
    const { rows } = await test.pool.query<{ tgenabled: string; tgtype: number }>(
      `SELECT tgenabled, tgtype FROM pg_trigger
       WHERE tgname = 'drop_inventory_touch' AND tgrelid = 'drop_inventory'::regclass`,
    );

    expect(rows).toEqual([{ tgenabled: 'O', tgtype: 1 | 2 | 16 }]);
  });
});

describe('guarantees', () => {
  const userId = randomUUID();
  const productId = randomUUID();
  const dropId = randomUUID();

  beforeAll(async () => {
    await test.db.insert(users).values({ id: userId, email: `${userId}@example.test`, displayName: 'Test' });
    await test.db.insert(products).values({
      id: productId,
      slug: `test-${productId}`,
      title: 'Integration test product',
      description: 'A product that exists only in this test database.',
      imageKeys: [],
      status: 'PUBLISHED',
    });
    await test.db.insert(drops).values({
      id: dropId,
      productId,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      priceCents: 1999,
      perUserLimit: 2,
      status: 'LIVE',
    });
    await test.db.insert(dropInventory).values({ dropId, total: 10 });
  });

  describe('orders_guard', () => {
    /** Columns that keep the status CHECKs satisfied, so the trigger is the only thing that can say no. */
    const CLOSE_REASON: Partial<Record<OrderStatus, CloseReason>> = {
      PAYMENT_FAILED: 'DECLINED',
      EXPIRED: 'TIMEOUT',
      CANCELLED: 'USER',
      REJECTED: 'SOLD_OUT',
    };

    function columnsFor(status: OrderStatus) {
      return {
        status,
        paidAt: status === 'PAID' ? new Date() : null,
        closedAt: isTerminalOrderStatus(status) && status !== 'PAID' ? new Date() : null,
        closeReason: CLOSE_REASON[status] ?? null,
      };
    }

    function insertOrder(status: OrderStatus) {
      const id = randomUUID();
      return {
        id,
        statement: test.db.insert(orders).values({
          id,
          userId,
          dropId,
          productId,
          qty: 1,
          unitPriceCents: 1999,
          currency: 'USD',
          idempotencyKey: id,
          requestHash: Buffer.from('fingerprint'),
          expiresAt: new Date(Date.now() + 120_000),
          ...columnsFor(status),
        }),
      };
    }

    const moveTo = (id: string, status: OrderStatus) =>
      test.db.update(orders).set(columnsFor(status)).where(eq(orders.id, id));

    /** An order that reached `status` along legal edges only. */
    async function orderIn(status: OrderStatus): Promise<string> {
      const { id, statement } = insertOrder(status === 'REJECTED' ? 'REJECTED' : 'RESERVED');
      await statement;
      const path: Partial<Record<OrderStatus, readonly OrderStatus[]>> = {
        PENDING_PAYMENT: ['PENDING_PAYMENT'],
        PAID: ['PENDING_PAYMENT', 'PAID'],
        PAYMENT_FAILED: ['PENDING_PAYMENT', 'PAYMENT_FAILED'],
        EXPIRED: ['EXPIRED'],
        CANCELLED: ['CANCELLED'],
      };
      for (const step of path[status] ?? []) await moveTo(id, step);
      return id;
    }

    it.each(ORDER_STATUSES)('inserts as %s only if it is a hold or a tombstone', async (status) => {
      const allowed = (INITIAL_ORDER_STATUSES as readonly OrderStatus[]).includes(status);

      expect(await rejection(insertOrder(status).statement)).toBe(allowed ? undefined : 'orders_guard');
    });

    const changes = ORDER_STATUSES.flatMap((from) =>
      ORDER_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
    );

    it.each(changes)('%s -> %s is allowed exactly when §4.4 lists it', async (from, to) => {
      const id = await orderIn(from);

      expect(await rejection(moveTo(id, to))).toBe(canTransition(from, to) ? undefined : 'orders_guard');
    });

    it('lets a live order change without a status change (extend)', async () => {
      const id = await orderIn('RESERVED');

      await test.db
        .update(orders)
        .set({ extensions: 1, expiresAt: sql`expires_at + interval '60 seconds'`, version: sql`version + 1` })
        .where(and(eq(orders.id, id), eq(orders.status, 'RESERVED')));
    });

    // Every column whose change would break INV-2 or an idempotency check, each on a live order.
    it.each([
      ['qty', { qty: 2 }],
      ['unit_price_cents', { unitPriceCents: 999 }],
      ['currency', { currency: 'EUR' }],
      ['user_id', { userId: randomUUID() }],
      ['drop_id', { dropId: randomUUID() }],
      ['product_id', { productId: randomUUID() }],
      ['idempotency_key', { idempotencyKey: 'another-key' }],
      ['request_hash', { requestHash: Buffer.from('another body') }],
      ['created_at', { createdAt: new Date(0) }],
      ['id', { id: randomUUID() }],
    ] as const)('freezes %s from the insert on', async (_column, change) => {
      const id = await orderIn('RESERVED');

      expect(await rejection(test.db.update(orders).set(change).where(eq(orders.id, id)))).toBe(
        'orders_guard',
      );
    });

    it('refuses an amount change smuggled into a legal transition', async () => {
      const id = await orderIn('RESERVED');

      expect(
        await rejection(
          test.db
            .update(orders)
            .set({ ...columnsFor('PENDING_PAYMENT'), qty: 2 })
            .where(eq(orders.id, id)),
        ),
      ).toBe('orders_guard');
      expect(await rejection(moveTo(id, 'PENDING_PAYMENT'))).toBe(undefined);
    });

    it('freezes a terminal order apart from redis_settled_at', async () => {
      const id = await orderIn('PAID');

      expect(
        await rejection(test.db.update(orders).set({ redisSettledAt: new Date() }).where(eq(orders.id, id))),
      ).toBe(undefined);
      expect(await rejection(test.db.update(orders).set({ qty: 2 }).where(eq(orders.id, id)))).toBe(
        'orders_guard',
      );
      expect(
        await rejection(test.db.update(orders).set({ updatedAt: new Date() }).where(eq(orders.id, id))),
      ).toBe('orders_guard');
    });
  });

  it('no_oversell refuses more units than the total, and the conditional UPDATE never tries', async () => {
    const take = (qty: number) =>
      test.db
        .update(dropInventory)
        .set({ reserved: sql`${dropInventory.reserved} + ${qty}` })
        .where(and(eq(dropInventory.dropId, dropId), sql`total - sold - reserved >= ${qty}`))
        .returning({ reserved: dropInventory.reserved });

    expect(await take(8)).toEqual([{ reserved: 8 }]);
    expect(await take(3)).toEqual([]);
    expect(
      await rejection(test.db.update(dropInventory).set({ sold: 3 }).where(eq(dropInventory.dropId, dropId))),
    ).toBe('no_oversell');
  });

  it('drop_inventory.updated_at moves on every update, whatever the statement sets', async () => {
    const endedDrop = randomUUID();
    await test.db.insert(drops).values({
      id: endedDrop,
      productId,
      startsAt: new Date('2026-01-01T10:00:00Z'),
      endsAt: new Date('2026-01-01T11:00:00Z'),
      priceCents: 1999,
      perUserLimit: 1,
      status: 'ENDED',
    });
    const longAgo = new Date('2020-01-01T00:00:00Z');
    await test.db.insert(dropInventory).values({ dropId: endedDrop, total: 5, updatedAt: longAgo });
    const updatedAt = async () => {
      const [row] = await test.db
        .select({ updatedAt: dropInventory.updatedAt })
        .from(dropInventory)
        .where(eq(dropInventory.dropId, endedDrop));
      return row?.updatedAt.getTime() ?? Number.NaN;
    };

    await test.db.update(dropInventory).set({ sold: 1 }).where(eq(dropInventory.dropId, endedDrop));
    const touched = await updatedAt();
    expect(touched).toBeGreaterThan(longAgo.getTime());

    await test.db
      .update(dropInventory)
      .set({ sold: 2, updatedAt: longAgo })
      .where(eq(dropInventory.dropId, endedDrop));
    expect(await updatedAt()).toBeGreaterThan(touched);
  });

  it('format CHECKs refuse what the catalog contracts would refuse to serve', async () => {
    const product = (patch: Partial<typeof products.$inferInsert>) => {
      const id = randomUUID();
      return test.db.insert(products).values({
        id,
        slug: `format-${id}`,
        title: 'Format check product',
        description: 'Exists only in this test database.',
        imageKeys: [`${'a'.repeat(64)}.jpg`, `${'b'.repeat(64)}.jpg`],
        status: 'PUBLISHED',
        ...patch,
      });
    };
    const drop = (currency: string) =>
      test.db.insert(drops).values({
        id: randomUUID(),
        productId,
        startsAt: new Date('2026-01-01T10:00:00Z'),
        endsAt: new Date('2026-01-01T11:00:00Z'),
        priceCents: 1999,
        currency,
        perUserLimit: 1,
        status: 'ENDED',
      });
    const room = (slug: string) =>
      test.db.insert(rooms).values({ id: randomUUID(), slug, title: 'Room', hlsUrl: '/hls/live.m3u8' });

    expect(await rejection(product({}))).toBe(undefined);
    expect(await rejection(product({ imageKeys: [] }))).toBe(undefined);
    expect(await rejection(product({ slug: 'Not A Slug' }))).toBe('products_slug_check');
    expect(await rejection(product({ slug: `a${'-b'.repeat(48)}` }))).toBe('products_slug_check');
    expect(await rejection(product({ imageKeys: ['photo.jpg'] }))).toBe('products_image_keys_check');
    expect(await rejection(product({ imageKeys: [`${'a'.repeat(64)}.jpg`, ''] }))).toBe(
      'products_image_keys_check',
    );
    expect(
      await rejection(
        test.db.insert(products).values({
          id: randomUUID(),
          slug: `format-null-${randomUUID()}`,
          title: 'Format check product',
          description: 'Exists only in this test database.',
          imageKeys: sql`ARRAY[NULL]::text[]`,
          status: 'PUBLISHED',
        }),
      ),
    ).toBe('products_image_keys_check');
    expect(await rejection(drop('EUR'))).toBe(undefined);
    expect(await rejection(drop('usd'))).toBe('drops_currency_check');
    expect(await rejection(drop('US'))).toBe('drops_currency_check');
    expect(await rejection(room(`room-${randomUUID()}`))).toBe(undefined);
    expect(await rejection(room('Studio'))).toBe('rooms_slug_check');
  });

  it('within_limit refuses a claim over the per-user limit', async () => {
    const quota = { userId, dropId, limitQty: 2 };

    expect(await rejection(test.db.insert(userDropQuota).values({ ...quota, claimed: 3 }))).toBe(
      'within_limit',
    );
    expect(await rejection(test.db.insert(userDropQuota).values({ ...quota, claimed: 2 }))).toBe(undefined);
  });

  it('one_open_drop_per_product allows one open drop per product, and any number of ended ones', async () => {
    const drop = (status: 'SCHEDULED' | 'ENDED') =>
      test.db.insert(drops).values({
        id: randomUUID(),
        productId,
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 7_200_000),
        priceCents: 1999,
        perUserLimit: 1,
        status,
      });

    expect(await rejection(drop('SCHEDULED'))).toBe('one_open_drop_per_product');
    expect(await rejection(drop('ENDED'))).toBe(undefined);
    expect(await rejection(drop('ENDED'))).toBe(undefined);
  });
});
