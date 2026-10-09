-- The application's own role (design §3, §11). api and the workers used to connect as the bootstrap role,
-- which owns the schema and is a superuser on the Compose server: any SQL injection would then be
-- `COPY ... TO PROGRAM` (code execution in the database container), DDL, or a rewrite of the psp ledger
-- that §3 isolates behind payment-mock's role. flashdrop_app reads and writes FlashDrop's tables, reads the
-- ledger (the admin health page checks INV-4 against it), and nothing else: no superuser, no CREATEDB or
-- CREATEROLE, no ownership, so no DDL and no TRUNCATE. Only the migrate job keeps the owner.
--
-- As in 0007: created NOLOGIN, because a password is a secret and this file is committed; the migrate job
-- enables login from APP_DB_PASSWORD (packages/db `enableRoleLogin`). Roles are global to the server while
-- this runs once per database, and integration tests migrate many databases at once: CREATE ROLE is skipped
-- when the role exists, and a concurrent creator that committed first surfaces as unique_violation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flashdrop_app') THEN
    CREATE ROLE flashdrop_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO flashdrop_app;
--> statement-breakpoint
-- Every row operation the transitions use; DELETE for the relay's outbox cleanup and processed_events
-- pruning. The fd_* functions are SECURITY INVOKER and executable by PUBLIC, so they run with exactly these
-- rights.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flashdrop_app;
--> statement-breakpoint
-- Tables a later migration adds (created by this same migrating role) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flashdrop_app;
--> statement-breakpoint
-- The ledger is the PSP's: read-only evidence for the invariant checks, never written from this side.
GRANT USAGE ON SCHEMA psp TO flashdrop_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA psp TO flashdrop_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA psp GRANT SELECT ON TABLES TO flashdrop_app;
