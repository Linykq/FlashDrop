import { BugError } from '@flashdrop/domain';
import { z } from 'zod';

/*
 * Parsers for rows of hand-written SQL. Through Drizzle's node-postgres driver, `db.execute()` returns
 * `timestamptz` as text and `bigint`/`numeric` as strings (design delta 10), so every guarantee-carrying
 * statement maps its rows explicitly instead of trusting the row type it declares.
 */

/** `2026-10-02 06:25:58.197043+00` (or a `Date`, should a driver already parse it) to a `Date`. */
export const PgTimestamp = z.union([z.date(), z.string()]).transform((value, ctx) => {
  if (value instanceof Date) return value;
  // ISO 8601 needs the `T` and a `+hh:mm` offset; Postgres prints a space and may print `+hh` alone.
  const date = new Date(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: 'custom', message: `not a timestamptz: ${value}` });
    return z.NEVER;
  }
  return date;
});

/** A uuid column. Postgres always prints lowercase. */
export const PgUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const PgBytea = z.instanceof(Buffer);

/**
 * Parses the rows of a hand-written statement. A mismatch means the SQL and its mapping disagree, a bug, so
 * it throws `BugError` with the statement's name rather than leaking a half-typed row.
 */
export function parseRows<T extends z.ZodType>(
  schema: T,
  rows: readonly unknown[],
  statement: string,
): z.output<T>[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) {
    throw new BugError(`${statement}: unexpected row shape: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
