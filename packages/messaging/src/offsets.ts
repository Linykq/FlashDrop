/*
 * Commit math for a batch whose messages finish out of order (in-batch concurrency, design §6.4).
 *
 * The client stores one offset per partition, the highest one resolved, and after a pause or a restart
 * resumes right after it. So the runner may resolve and commit only the end of the *contiguous* run of
 * finished messages from the batch's start: resolving a later, finished offset while an earlier one is
 * unfinished would skip the earlier one for good (M0 delta 4). Finished messages past the gap are simply
 * delivered again; every handler is idempotent.
 */

export interface BatchProgress {
  /** The last offset of the finished run at the batch's start; undefined when the first message is unfinished. */
  readonly lastDone: string | undefined;
  /** The first unfinished offset, where consumption must resume; undefined when the whole batch finished. */
  readonly firstPending: string | undefined;
}

/**
 * `offsets` are the batch's offsets in log order; `done` holds those that succeeded or were dead-lettered.
 */
export function batchProgress(offsets: readonly string[], done: ReadonlySet<string>): BatchProgress {
  let lastDone: string | undefined;
  for (const offset of offsets) {
    if (!done.has(offset)) return { lastDone, firstPending: offset };
    lastDone = offset;
  }
  return { lastDone, firstPending: undefined };
}

/** The offset after `offset`: what a commit stores, the position of the next message to read. */
export function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
}

/** Numeric comparison of two offsets (strings, because they are int64 on the wire). */
export function compareOffsets(a: string, b: string): number {
  const difference = BigInt(a) - BigInt(b);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}
