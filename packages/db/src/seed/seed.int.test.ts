import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageKey, ProductAttributes, SessionUser } from '@flashdrop/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DROP_LOCK_NAMESPACE } from '../drops';
import { createTestDatabase, type TestDatabase } from '../test-database';
import { REPO_CATALOG_DIR } from './catalog';
import { SEED_USERS } from './plan';
import { type SeedResult, seedDatabase } from './seed';

const NOW = new Date('2026-10-02T17:23:45.678Z');
const logger = { info: () => undefined };

let test: TestDatabase;
let uploadDir: string;
let first: SeedResult;
// Plain bookkeeping rather than vi.fn: mock state is cleared between tests, and the call happens in beforeAll.
const armed: (readonly string[])[] = [];
const armDrops = async (dropIds: readonly string[]) => void armed.push(dropIds);

/** Every row of every seeded table, in a stable order. */
async function snapshot() {
  const tables = [
    'users',
    'rooms',
    'products',
    'drops',
    'drop_inventory',
    'orders',
    'payments',
    'user_drop_quota',
    'psp.charges',
    'outbox',
  ];
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) {
    rows[table] = (await test.pool.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows;
  }
  return rows;
}

beforeAll(async () => {
  test = await createTestDatabase();
  uploadDir = await mkdtemp(join(tmpdir(), 'fd-seed-'));
  first = await seedDatabase(test.db, {
    catalogDir: REPO_CATALOG_DIR,
    uploadDir,
    logger,
    now: NOW,
    armDrops,
  });
});

afterAll(async () => {
  await test?.drop();
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

describe('seedDatabase', () => {
  it('creates the users, products and drops, and stores every photo by its hash', async () => {
    expect(first.created).toEqual({ users: 6, products: 8, drops: 4 });
    expect(first.movedDrops).toBe(0);

    const files = await readdir(uploadDir);
    expect(files).toHaveLength(first.photosStored);
    for (const file of files) {
      const hash = createHash('sha256')
        .update(await readFile(join(uploadDir, file)))
        .digest('hex');
      expect(file).toBe(`${hash}.jpg`);
    }
  });

  it('is idempotent', async () => {
    const before = await snapshot();

    const again = await seedDatabase(test.db, { catalogDir: REPO_CATALOG_DIR, uploadDir, logger, now: NOW });

    expect(again).toEqual({
      created: { users: 0, products: 0, drops: 0 },
      movedDrops: 0,
      photosStored: 0,
      dropIds: first.dropIds,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('hands every seeded drop to the arming hook after the commit', () => {
    expect(armed).toEqual([first.dropIds]);
    expect(first.dropIds).toHaveLength(4);
  });

  it('writes rows that the API contracts accept', async () => {
    const products = await test.pool.query<{ attributes: unknown; image_keys: string[] }>(
      'SELECT attributes, image_keys FROM products',
    );
    for (const product of products.rows) {
      const attributes = ProductAttributes.parse(product.attributes);
      expect(product.image_keys.length).toBeGreaterThan(0);
      expect(attributes.photoCredits.map((credit) => credit.imageKey)).toEqual(
        product.image_keys.map((key) => ImageKey.parse(key)),
      );
    }

    const users = await test.pool.query('SELECT id, email, display_name AS "displayName", role FROM users');
    expect(users.rows.map((user) => SessionUser.parse(user).email).sort()).toEqual(
      SEED_USERS.map((user) => user.email).sort(),
    );
  });

  it('places one drop live now, two later, and one sold out in the past', async () => {
    const { rows } = await test.pool.query<{
      status: string;
      live_now: boolean;
      future: boolean;
      past: boolean;
    }>(
      `SELECT status, starts_at <= $1 AND $1 < ends_at AS live_now, starts_at > $1 AS future, ends_at <= $1 AS past
       FROM drops ORDER BY starts_at`,
      [NOW],
    );

    expect(rows).toEqual([
      { status: 'ENDED', live_now: false, future: false, past: true },
      { status: 'LIVE', live_now: true, future: false, past: false },
      { status: 'SCHEDULED', live_now: false, future: true, past: false },
      { status: 'SCHEDULED', live_now: false, future: true, past: false },
    ]);
  });

  it('keeps INV-1 to INV-4 true for the seeded history', async () => {
    // INV-1 and INV-2: counters match the orders, and nothing is oversold.
    const counters = await test.pool.query(
      `SELECT d.status, i.total, i.reserved, i.sold,
              coalesce(sum(o.qty) FILTER (WHERE o.status IN ('RESERVED', 'PENDING_PAYMENT')), 0)::int AS live_units,
              coalesce(sum(o.qty) FILTER (WHERE o.status = 'PAID'), 0)::int AS paid_units
       FROM drops d JOIN drop_inventory i ON i.drop_id = d.id LEFT JOIN orders o ON o.drop_id = d.id
       GROUP BY d.id, i.drop_id ORDER BY d.starts_at`,
    );
    for (const row of counters.rows) {
      expect(row.reserved).toBe(row.live_units);
      expect(row.sold).toBe(row.paid_units);
      expect(row.reserved + row.sold).toBeLessThanOrEqual(row.total);
    }
    expect(counters.rows[0]).toMatchObject({ status: 'ENDED', total: 50, sold: 50, reserved: 0 });

    // INV-3: quotas match the orders and respect the limit.
    const quotas = await test.pool.query(
      `SELECT q.claimed, q.limit_qty, d.per_user_limit,
              (SELECT coalesce(sum(qty), 0)::int FROM orders o
               WHERE o.user_id = q.user_id AND o.drop_id = q.drop_id
                 AND o.status IN ('RESERVED', 'PENDING_PAYMENT', 'PAID')) AS units
       FROM user_drop_quota q JOIN drops d ON d.id = q.drop_id`,
    );
    expect(quotas.rows).toHaveLength(5);
    for (const row of quotas.rows) {
      expect(row.claimed).toBe(row.units);
      expect(row.limit_qty).toBe(row.per_user_limit);
      expect(row.claimed).toBeLessThanOrEqual(row.limit_qty);
    }

    // INV-4: every PAID order has one SUCCEEDED payment and one succeeded charge for its exact total.
    const money = await test.pool.query(
      `SELECT o.total_cents, p.status AS payment, p.amount_cents, c.status AS charge, c.amount_cents AS charged
       FROM orders o
       LEFT JOIN payments p ON p.order_id = o.id
       LEFT JOIN psp.charges c ON c.reference = o.id::text
       WHERE o.status = 'PAID'`,
    );
    expect(money.rows).toHaveLength(5);
    for (const row of money.rows) {
      expect(row).toEqual({
        total_cents: row.amount_cents,
        payment: 'SUCCEEDED',
        amount_cents: row.charged,
        charge: 'succeeded',
        charged: 34_000,
      });
    }
  });

  // Last: it moves the drops the tests above place around NOW.
  it('moves the drops nobody ordered from around a later time, and leaves the rest alone', async () => {
    const later = new Date(NOW.getTime() + 86_400_000);
    const before = await snapshot();

    // Another writer of the drop's status (the scheduler, an admin action) holds its drop lock: the seed
    // waits for it before moving the drop, like every writer of an armed drop's status (§4.7).
    const holder = await test.pool.connect();
    const [locked = ''] = first.dropIds;
    const key = `hashtextextended('${DROP_LOCK_NAMESPACE}' || $1::text, 0)`;
    await holder.query(`SELECT pg_advisory_lock(${key})`, [locked]);
    let finished = false;
    const seeding = seedDatabase(test.db, { catalogDir: REPO_CATALOG_DIR, uploadDir, logger, now: later });
    void seeding.finally(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    await holder.query(`SELECT pg_advisory_unlock(${key})`, [locked]);
    holder.release();
    const again = await seeding;

    expect(again.created).toEqual({ users: 0, products: 0, drops: 0 });
    expect(again.movedDrops).toBe(3);
    const { rows } = await test.pool.query<{ status: string; live_now: boolean; future: boolean }>(
      `SELECT status, starts_at <= $1 AND $1 < ends_at AS live_now, starts_at > $1 AS future
       FROM drops WHERE NOT EXISTS (SELECT 1 FROM orders WHERE orders.drop_id = drops.id) ORDER BY starts_at`,
      [later],
    );
    expect(rows).toEqual([
      { status: 'LIVE', live_now: true, future: false },
      { status: 'SCHEDULED', live_now: false, future: true },
      { status: 'SCHEDULED', live_now: false, future: true },
    ]);

    // The sold-out drop keeps the window its orders happened in, and nothing but the moved drops changed.
    const after = await snapshot();
    const soldOut = (rows: unknown[]) => rows.filter((row) => (row as { status: string }).status === 'ENDED');
    expect(soldOut(after.drops ?? [])).toEqual(soldOut(before.drops ?? []));
    expect({ ...after, drops: [] }).toEqual({ ...before, drops: [] });
  });
});
