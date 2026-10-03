/**
 * @packageDocumentation
 * PostgreSQL 17 access through Drizzle (design §3): the schema and its migrations (generated, plus the custom
 * trigger migrations), pools with per-role limits, the `transaction()` wrapper, the error classifiers, the
 * migrator, the development seed, and the guarantee-carrying statements of reservations, expiry, the outbox
 * and drop administration (§4.4-§4.7, §5.2), hand-written through Drizzle's `sql` template.
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
export * from './drops';
export * from './errors';
export * from './migrate';
export * from './orders';
export * from './outbox';
export * from './pool';
export { PgTimestamp, PgUuid, parseRows } from './rows';
export * from './schema';
export * from './seed';
export * from './sweeper';
export * from './test-support';
export * from './transaction';
export * from './transitions';
