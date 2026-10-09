import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelOrder } from './checkout';
import { createDb, type Db } from './client';
import { APP_DB_ROLE, enableRoleLogin } from './db-roles';
import { applyDropAction, createDraftDrop, getAdminDrop } from './drops';
import { pgErrorOf } from './errors';
import { getOrder } from './orders';
import { markPaid } from './payments';
import { deletePublishedOutbox, relayOutboxBatch } from './relay';
import { products } from './schema';
import { expireDueOrders } from './sweeper';
import { createTestDatabase, type TestDatabase } from './test-database';
import { createDrop, createUsers } from './test-fixtures';
import { holdOrder, lapse, placeOrder } from './test-orders';

/*
 * The application role (migration 0013, design §3, §11): api and the workers run every transition as
 * flashdrop_app, which may read and write FlashDrop's tables and read the PSP ledger, and nothing else.
 * Roles are global to the shared server, so the role is assumed per connection (the startup setting
 * `role`, which the owner may set) and never changed; the one ALTER ROLE below is rolled back.
 */

let test: TestDatabase;
/** Every statement of this pool runs as flashdrop_app. */
let app: Db;
let appPool: pg.Pool;
let client: pg.Client;

beforeAll(async () => {
  test = await createTestDatabase();
  // The role is a startup setting, so it holds before the first statement of every connection.
  appPool = new pg.Pool({ connectionString: test.url, options: `-c role=${APP_DB_ROLE}`, max: 4 });
  app = createDb(appPool);
  client = new pg.Client({ connectionString: test.url });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await appPool?.end();
  await test?.drop();
});

async function sqlstateAsApp(statement: string): Promise<string | undefined> {
  try {
    await appPool.query(statement);
    return undefined;
  } catch (error) {
    return pgErrorOf(error)?.code ?? 'unknown';
  }
}

describe('the application role', () => {
  it('is the session user of the pool, and no superuser', async () => {
    const { rows } = await appPool.query<{ role: string; superuser: boolean }>(
      `SELECT current_user AS role, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows).toEqual([{ role: APP_DB_ROLE, superuser: false }]);
  });

  it('runs the transitions: admin, reserve, checkout, payment, cancel, expiry and the relay', async () => {
    const productId = randomUUID();
    await app.insert(products).values({
      id: productId,
      slug: `p-${productId}`,
      title: 'Application role product',
      description: 'Exists only in this test database.',
      imageKeys: [],
      status: 'PUBLISHED',
    });
    const draft = await createDraftDrop(app, {
      productId,
      roomId: null,
      startsAt: new Date(Date.now() + 3_600_000),
      endsAt: new Date(Date.now() + 7_200_000),
      priceCents: 2_500,
      currency: 'USD',
      perUserLimit: 2,
      holdSeconds: 120,
      paymentSeconds: 300,
      stock: 10,
    });
    expect(await applyDropAction(app, draft.drop.id, 'arm')).toEqual({ from: 'DRAFT', to: 'SCHEDULED' });

    const { dropId } = await createDrop(app, { status: 'LIVE', total: 10 });
    const [paying, cancelling, lapsing] = await createUsers(app, 3);
    if (paying === undefined || cancelling === undefined || lapsing === undefined)
      throw new Error('no users');
    const { orderId } = await placeOrder(app, dropId, paying);
    expect(await markPaid(app, { orderId, pspChargeId: `ch_${orderId}` })).toMatchObject({ kind: 'won' });
    const held = await holdOrder(app, dropId, cancelling);
    expect(await cancelOrder(app, { orderId: held, userId: cancelling })).toMatchObject({
      kind: 'cancelled',
    });
    const expiring = await holdOrder(app, dropId, lapsing);
    await lapse(app, expiring);
    await expireDueOrders(app);
    expect((await getOrder(app, expiring))?.status).toBe('EXPIRED');

    const batch = await relayOutboxBatch(app, async () => undefined);
    expect(batch.kind).toBe('published');
    expect(await deletePublishedOutbox(app, { retentionSeconds: 0 })).toBeGreaterThan(0);
    expect((await getAdminDrop(app, dropId))?.inventory).toMatchObject({ sold: 1, reserved: 0 });
  });

  it('reads the PSP ledger, the evidence the admin health checks compare against', async () => {
    await app.execute(sql`SELECT reference, id, status, amount_cents FROM psp.charges LIMIT 1`);
  });

  it.each([
    ['write the PSP ledger', `INSERT INTO psp.references (reference) VALUES ('${randomUUID()}')`],
    ['refund in the PSP ledger', `UPDATE psp.charges SET status = 'refunded'`],
    ['run a program on the database host', `COPY (SELECT 1) TO PROGRAM 'id'`],
    ['read server files', `SELECT pg_read_file('postgresql.conf')`],
    ['create a table', 'CREATE TABLE extra (id int)'],
    ['change the schema', 'ALTER TABLE orders ADD COLUMN extra int'],
    ['drop a table', 'DROP TABLE outbox'],
    ['truncate a table', 'TRUNCATE orders CASCADE'],
    ['create a role', 'CREATE ROLE intruder'],
  ])('may not %s', async (_what, statement) => {
    expect(await sqlstateAsApp(statement)).toBe('42501');
  });

  it('lets the migrate job enable LOGIN, with the password escaped', async () => {
    await client.query('BEGIN');
    try {
      await enableRoleLogin(client, APP_DB_ROLE, `a-long-dev-password-with-a-quote'`);
      const { rows } = await client.query<{ login: boolean; password: boolean }>(
        `SELECT rolcanlogin AS login, rolpassword IS NOT NULL AS password FROM pg_authid WHERE rolname = $1`,
        [APP_DB_ROLE],
      );
      expect(rows[0]).toEqual({ login: true, password: true });
    } finally {
      // ALTER ROLE is transactional: the shared server's role is left exactly as it was.
      await client.query('ROLLBACK');
    }
  });
});
