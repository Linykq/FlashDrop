import { type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, customType, timestamp } from 'drizzle-orm/pg-core';

/** drizzle-orm 0.45 has no bytea column; node-postgres already returns bytea as a Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Every timestamp is `timestamptz`, read as a `Date` by the query builder. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** A SQL string literal inlined into DDL, where a CHECK or index predicate cannot take parameters. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * `'a', 'b'` inlined, for `status IN (...)` in hand-written queries: a literal list (unlike a bound array)
 * lets the planner match the predicate of a partial index such as `orders_due` or `orders_unsettled`.
 */
export function literalList(values: readonly string[]): SQL {
  return sql.raw(values.map(literal).join(', '));
}

/**
 * `column IN ('a', 'b')` for CHECKs and partial indexes, built from the value sets in `@flashdrop/domain`,
 * so the database and the code cannot list different values. A changed set changes the generated SQL, and
 * `drizzle-kit generate` then writes the migration for it.
 */
export function inList(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${literalList(values)})`;
}

/**
 * `value ~ '^pattern$'` for CHECKs, from the unanchored pattern sources in `@flashdrop/contracts`, so the
 * database refuses exactly what the response schemas would refuse to serve.
 */
export function matchesWhole(value: AnyPgColumn | SQL, pattern: string): SQL {
  return sql`${value} ~ ${sql.raw(literal(`^${pattern}$`))}`;
}
