import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** The transaction handle `transaction()` passes to its callback. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type TxConfig = NonNullable<Parameters<Db['transaction']>[1]>;
/**
 * Where a statement runs: the pool (its own implicit transaction) or an open transaction. Statements that
 * must share a transaction with others say so and take a `Tx`.
 */
export type Executor = Db | Tx;

/**
 * The Drizzle client over a pool from `createPool`. Note that raw `db.execute()` results map `timestamptz`
 * to strings and `bigint`/`numeric` to strings (design delta 10): hand-written SQL maps its rows explicitly.
 */
export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}
