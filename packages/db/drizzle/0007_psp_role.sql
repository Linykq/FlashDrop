-- payment-mock's own role (design §2, §3: "payment-mock's own schema (separate role)"). The PSP shares the
-- Postgres server but is a separate system: its role reads and writes the psp ledger and nothing else, so a
-- PSP bug can neither read orders nor change the stock of record, and the ledger stays independent evidence
-- for INV-4. It gets SELECT, INSERT and UPDATE (UPDATE also for the per-reference row lock, SELECT ... FOR
-- UPDATE), never DELETE or TRUNCATE: the ledger is append-only apart from marking refunds and closing
-- references. Tables in public need explicit grants, so the role sees none of them.
--
-- The role is created NOLOGIN: a password is a secret and this file is committed, so the migrate job enables
-- login from PSP_DB_PASSWORD (packages/db `enablePspLogin`). Roles are global to the server while this runs
-- once per database, and integration tests migrate many databases at once: CREATE ROLE is skipped when the
-- role exists, and a concurrent creator that committed first surfaces as unique_violation, also skipped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flashdrop_psp') THEN
    CREATE ROLE flashdrop_psp NOLOGIN;
  END IF;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA psp TO flashdrop_psp;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA psp TO flashdrop_psp;
--> statement-breakpoint
-- Tables a later migration adds to psp (created by this same migrating role) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA psp GRANT SELECT, INSERT, UPDATE ON TABLES TO flashdrop_psp;
