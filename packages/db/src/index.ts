/**
 * @packageDocumentation
 * PostgreSQL 17 access through Drizzle (design §3): the schema and its migrations (generated, plus the custom
 * trigger migrations), pools with per-role limits, the `transaction()` wrapper, the error classifiers, the
 * migrator and the development seed.
 */

// The query helpers every caller needs, re-exported so all packages share this package's drizzle-orm.
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
export * from './client';
export * from './errors';
export * from './migrate';
export * from './pool';
export * from './schema';
export * from './seed';
export * from './transaction';
