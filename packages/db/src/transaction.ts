/** Anything with Drizzle's `transaction(fn, config)` shape: a `Db`, or a `Tx` for a nested savepoint. */
export interface TransactionRunner<TTx, TConfig> {
  transaction<T>(fn: (tx: TTx) => Promise<T>, config?: TConfig): Promise<T>;
}

/**
 * Runs `fn` in a transaction and, on failure, throws the error `fn` threw. Use it instead of
 * `db.transaction`.
 *
 * Drizzle answers a failed callback with `ROLLBACK`. When the error killed the connection (a FATAL such as
 * `transaction_timeout`, or a dropped socket), that `ROLLBACK` fails too and Drizzle throws its error
 * (`Failed query: rollback`, no SQLSTATE) instead of the real one (design delta 7). Here the original wins,
 * with the rollback failure attached as `rollbackError`, so logs and the transient-error check see the cause.
 */
export async function transaction<TTx, TConfig, T>(
  db: TransactionRunner<TTx, TConfig>,
  fn: (tx: TTx) => Promise<T>,
  config?: TConfig,
): Promise<T> {
  let failure: { readonly error: unknown } | undefined;
  try {
    return await db.transaction(async (tx) => {
      try {
        return await fn(tx);
      } catch (error) {
        failure = { error };
        throw error;
      }
    }, config);
  } catch (error) {
    if (failure === undefined || error === failure.error) throw error;
    if (failure.error instanceof Error) Object.assign(failure.error, { rollbackError: error });
    throw failure.error;
  }
}
