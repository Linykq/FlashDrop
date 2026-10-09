import pg from 'pg';

/*
 * payment-mock's own database role (design §2, §3). The PSP is a separate system that happens to share the
 * Postgres server: its role can read and write the `psp` ledger and nothing else, so a PSP bug can neither
 * read orders nor touch the stock of record, and the ledger it writes stays independent evidence for INV-4.
 *
 * Migration 0007 creates the role without LOGIN and grants it the `psp` schema. A password is a secret, and
 * migrations are committed, so the migrate job sets it from the environment (`enablePspLogin`).
 */

/** The role `apps/payment-mock` connects as: `postgres://flashdrop_psp:<password>@.../flashdrop`. */
export const PSP_DB_ROLE = 'flashdrop_psp';

/**
 * Lets the PSP role log in with `password` (idempotent; a changed password replaces the old one), on a pool
 * or a client. Roles are global to the server, so this is not a per-database migration. `ALTER ROLE` takes
 * no bind parameters, hence the escaped literal.
 */
export async function enablePspLogin(db: Pick<pg.ClientBase, 'query'>, password: string): Promise<void> {
  await db.query(`ALTER ROLE ${PSP_DB_ROLE} WITH LOGIN PASSWORD ${pg.escapeLiteral(password)}`);
}
