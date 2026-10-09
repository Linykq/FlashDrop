import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgErrorOf } from './errors';
import { enablePspLogin, PSP_DB_ROLE } from './psp-role';
import { createTestDatabase, type TestDatabase } from './test-database';

/*
 * payment-mock's role (migration 0007, design §2, §3): the psp ledger and nothing else. Checked as the role
 * itself (`SET LOCAL ROLE` in a rolled-back transaction), because roles are global to the shared server:
 * no test may leave a change to one behind.
 */

let test: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  test = await createTestDatabase();
  client = new pg.Client({ connectionString: test.url });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await test?.drop();
});

/** Runs `fn` as the PSP role inside a transaction that is always rolled back. */
async function asPsp<T>(fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${PSP_DB_ROLE}`);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** The SQLSTATE `statement` fails with as the PSP role (rolled back either way); undefined if it succeeds. */
async function sqlstateAsPsp(statement: string): Promise<string | undefined> {
  return asPsp(async () => {
    try {
      await client.query(statement);
      return undefined;
    } catch (error) {
      return pgErrorOf(error)?.code ?? 'unknown';
    }
  });
}

describe('the payment-mock role', () => {
  it('reads and writes the ledger, and locks a reference row per charge', async () => {
    const charged = await asPsp(async () => {
      await client.query(`INSERT INTO psp.references (reference) VALUES ('ref-1')`);
      await client.query(`SELECT * FROM psp.references WHERE reference = 'ref-1' FOR UPDATE`);
      await client.query(`
        INSERT INTO psp.charges (id, idempotency_key, reference, amount_cents, method, status)
        VALUES ('ch_1', 'charge:ref-1', 'ref-1', 1999, 'pm_ok', 'succeeded')`);
      await client.query(`UPDATE psp.charges SET status = 'refunded', refunded_at = now() WHERE id = 'ch_1'`);
      await client.query(`UPDATE psp.references SET closed_at = now() WHERE reference = 'ref-1'`);
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM psp.charges WHERE id = 'ch_1'`,
      );
      return rows[0]?.status;
    });

    expect(charged).toBe('refunded');
  });

  it.each([
    ['read orders', 'SELECT * FROM orders LIMIT 1'],
    ['read payments', 'SELECT * FROM payments LIMIT 1'],
    ['change the stock of record', 'UPDATE drop_inventory SET total = total + 1'],
    ['delete from the ledger', 'DELETE FROM psp.charges'],
    ['truncate the ledger', 'TRUNCATE psp.references'],
    ['create tables in psp', 'CREATE TABLE psp.extra (id int)'],
  ])('may not %s', async (_what, statement) => {
    expect(await sqlstateAsPsp(statement)).toBe('42501');
  });

  it('lets the migrate job enable LOGIN, with the password escaped', async () => {
    await client.query('BEGIN');
    try {
      await enablePspLogin(client, `a-long-dev-password-with-a-quote'`);
      const { rows } = await client.query<{ login: boolean; password: boolean }>(
        `SELECT rolcanlogin AS login, rolpassword IS NOT NULL AS password FROM pg_authid WHERE rolname = $1`,
        [PSP_DB_ROLE],
      );
      expect(rows[0]).toEqual({ login: true, password: true });
    } finally {
      // ALTER ROLE is transactional: the shared server's role is left exactly as it was.
      await client.query('ROLLBACK');
    }
  });
});
