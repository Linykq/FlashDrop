/**
 * Runs `fn` over `items` with at most `limit` calls in flight and resolves, once every call has settled,
 * with their outcomes in the order of `items`. A rejection never cuts the batch short: the caller decides
 * per item (a sweeper quarantines one order, but ends the tick on an outage only after recording what
 * succeeded).
 */
export async function settleWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const outcomes: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      // Every index below items.length holds an item: `items` is a dense array.
      const item = items[index] as T;
      try {
        outcomes[index] = { status: 'fulfilled', value: await fn(item) };
      } catch (reason) {
        outcomes[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return outcomes;
}
