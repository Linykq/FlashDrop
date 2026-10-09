import pg from 'pg';

/*
 * The database roles besides the owner (design §3, §11). Migrations create them without LOGIN, because a
 * password is a secret and migrations are committed; the migrate job lets each log in with a password from
 * its environment (`enableRoleLogin`). Roles are global to the server, so that is not a per-database
 * migration.
 *
 * - `flashdrop_app` (migration 0013): api and the workers. It reads and writes FlashDrop's tables and reads
 *   the PSP ledger (the admin health page's INV-4 evidence), and nothing more: it is no superuser, owns
 *   nothing, and creates nothing, so an injected statement cannot run `COPY ... TO PROGRAM`, change the
 *   schema, or rewrite the ledger.
 * - `flashdrop_psp` (migration 0007): payment-mock, a separate system that shares the server. It reads and
 *   writes the `psp` ledger and nothing else, so a PSP bug can neither read orders nor touch the stock of
 *   record, and the ledger it writes stays independent evidence for INV-4.
 */

/** The role api and the workers connect as: `postgres://flashdrop_app:<password>@.../flashdrop`. */
export const APP_DB_ROLE = 'flashdrop_app';

/** The role `apps/payment-mock` connects as: `postgres://flashdrop_psp:<password>@.../flashdrop`. */
export const PSP_DB_ROLE = 'flashdrop_psp';

export type DbRole = typeof APP_DB_ROLE | typeof PSP_DB_ROLE;

/**
 * Lets `role` log in with `password` (idempotent; a changed password replaces the old one), on a pool or a
 * client. `ALTER ROLE` takes no bind parameters, hence the escaped literal; the role is one of ours.
 */
export async function enableRoleLogin(
  db: Pick<pg.ClientBase, 'query'>,
  role: DbRole,
  password: string,
): Promise<void> {
  await db.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${pg.escapeLiteral(password)}`);
}
