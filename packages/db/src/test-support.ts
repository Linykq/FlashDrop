import { randomUUID } from 'node:crypto';
import { BugError } from '@flashdrop/domain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './client';
import { PgUuid, parseRows } from './rows';
import { dropInventory, drops, products } from './schema';
import { transaction } from './transaction';

/*
 * Rows behind the test-only routes (design §5.1, §13), which `api` serves only with
 * `ENABLE_TEST_ROUTES=true` and the `x-test-secret` header: fresh buyers for k6 sessions, and an isolated
 * product and drop per Playwright spec. Never used by the product itself.
 */

export interface TestDropSettings {
  readonly stock: number;
  readonly perUserLimit: number;
  readonly holdSeconds: number;
  readonly paymentSeconds: number;
  /** Defaults to Postgres's `now()`, so the drop is open as soon as it is armed. */
  readonly startsAt?: Date;
  readonly durationSeconds: number;
  readonly priceCents: number;
}

export interface TestDropRecord {
  readonly dropId: string;
  readonly productId: string;
  readonly productSlug: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * A new PUBLISHED product (showing the first catalog product's photos, so pages look real) and a DRAFT
 * drop of it with its inventory, in one transaction. The caller arms it the way an admin would, under the
 * drop lock (`applyDropAction(..., 'arm')` and the Redis sync), so tests exercise the real path.
 */
export async function createTestDrop(db: Db, settings: TestDropSettings): Promise<TestDropRecord> {
  const productId = randomUUID();
  const dropId = randomUUID();
  const tag = productId.slice(0, 8);
  const slug = `test-drop-${productId.replaceAll('-', '').slice(0, 16)}`;
  return transaction(db, async (tx) => {
    await tx.insert(products).values({
      id: productId,
      slug,
      title: `Test drop ${tag}`,
      description: 'A product created for one automated test. It is not part of the catalog.',
      imageKeys: sql`COALESCE((SELECT image_keys FROM products
                               WHERE status = 'PUBLISHED' AND cardinality(image_keys) > 0
                               ORDER BY slug LIMIT 1), '{}')`,
      status: 'PUBLISHED',
      // Reachable by URL like any product, but never listed: tests on a shared stack leave the catalog alone.
      source: 'test',
    });
    const startsAt =
      settings.startsAt === undefined ? sql`now()` : sql`${settings.startsAt.toISOString()}::timestamptz`;
    const [drop] = await tx
      .insert(drops)
      .values({
        id: dropId,
        productId,
        startsAt,
        endsAt: sql`${startsAt} + make_interval(secs => ${settings.durationSeconds})`,
        priceCents: settings.priceCents,
        perUserLimit: settings.perUserLimit,
        holdSeconds: settings.holdSeconds,
        paymentSeconds: settings.paymentSeconds,
        status: 'DRAFT',
      })
      .returning({ startsAt: drops.startsAt, endsAt: drops.endsAt });
    if (drop === undefined) throw new BugError('createTestDrop: the drop insert returned nothing');
    await tx.insert(dropInventory).values({ dropId, total: settings.stock });
    return { dropId, productId, productSlug: slug, startsAt: drop.startsAt, endsAt: drop.endsAt };
  });
}

export interface TestBuyer {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'buyer';
}

const BuyerRow = z
  .object({ id: PgUuid, email: z.string(), display_name: z.string() })
  .transform(
    (row): TestBuyer => ({ id: row.id, email: row.email, displayName: row.display_name, role: 'buyer' }),
  );

/**
 * `count` new buyers in one statement, for `POST /test/sessions` (k6 `setup()` mints a session for each).
 * They are not dev-login accounts: only the seeded users can sign in through the login page.
 */
export async function createTestBuyers(db: Db, count: number): Promise<TestBuyer[]> {
  const { rows } = await db.execute(sql`
    INSERT INTO users (id, email, display_name, role)
    SELECT id, 'load-' || id || '@load.test', 'Load buyer ' || n, 'buyer'
    FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${count}::int) AS n) AS fresh
    RETURNING id, email, display_name`);
  return parseRows(BuyerRow, rows, 'createTestBuyers');
}
