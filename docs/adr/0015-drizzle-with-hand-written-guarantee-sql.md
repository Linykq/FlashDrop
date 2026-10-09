# ADR 0015: Drizzle for the schema, hand-written SQL for every guarantee

- **Status:** Accepted (owner decision)
- **Date:** 2026-10-01
- **Design:** §3, §14 "SQL access"

## Context

The schema needs named CHECK constraints, partial unique indexes, a generated column, enums, a second schema
(`psp`) and a trigger. The statements that carry guarantees (the conditional stock `UPDATE`, the one-statement
tombstone CTE, the expiry CTE, the relay batch) must keep their exact shape, lock order and isolation.

## Decision

- The schema is TypeScript (`packages/db/src/schema/*.ts`, drizzle-orm 0.45.3), so row types come from it with
  no codegen. `drizzle-kit generate` writes reviewed SQL migrations; triggers and PL/pgSQL functions are custom
  migrations. An applied migration is never edited, and CI fails if `generate` produces a diff.
- **Guarantee-carrying SQL is hand-written** through Drizzle's `sql` template and mapped explicitly; the query
  builder covers plain CRUD and reads. The ORM never decides lock order or the shape of a hot-path statement.
- `packages/db` wraps transactions so the callback's first error is rethrown (Drizzle replaced it with its
  failed `ROLLBACK`'s error, which has no SQLSTATE), and every pool attaches a per-client error listener
  (a FATAL `transaction_timeout` otherwise crashes the process).
- Every constraint is named, and an integration test checks them by name (`packages/db/src/schema.int.test.ts`).

## Consequences

- One language for schema and code; migrations stay reviewable SQL.
- Cost: raw-SQL rows need explicit mapping (`timestamptz` arrives as a string through `db.execute()`, `bigint`
  and `numeric` as strings), and `= ANY(...)` must bind `sql.param(ids)`.

## Alternatives rejected

- **Kysely 0.29 + kysely-codegen + node-pg-migrate.** Equally capable; the owner chose Drizzle for fluency.
- **Prisma.** Its query engine shapes the SQL, which the hot path can't accept.
- **drizzle-orm 1.0.** Still a release candidate on 2026-10-01; revisit after M10.
