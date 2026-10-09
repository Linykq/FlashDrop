import type { LimitFunction } from 'p-limit';

/*
 * In-batch concurrency (design §6.3): a batch is split into units, one per order, each holding that order's
 * messages in log order. A unit runs its messages one after another, so two events of one order (or two
 * copies of one event) never race; units run concurrently under the consumer's limiter, because correctness
 * across orders rests on the orders CAS and PSP idempotency, not on processing order.
 *
 * A failure ends only its own unit: the rest of that order waits for the failed message, while other orders
 * keep starting until the batch deadline. Commits stay correct because only the contiguous finished prefix
 * is committed and the partition resumes at the first unfinished offset (`batchProgress`); a unit finished
 * past the gap is delivered again, which every handler tolerates. Stopping the whole batch at the first
 * failure instead cost the payment group most of its concurrency: with about 3% of charges failing
 * transiently on the first try (PSP 5xx, timeout after success), nearly every batch of ~85 charges stopped
 * early. After `retryBudget` failures in one batch no message starts, so an outage is not hit by every unit.
 */

/** Groups `messages` by `keyOf`, keeping log order inside each group; groups come in order of first message. */
export function groupInOrder<M>(messages: readonly M[], keyOf: (message: M) => string): M[][] {
  const groups = new Map<string, M[]>();
  for (const message of messages) {
    const key = keyOf(message);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [message]);
    else group.push(message);
  }
  return [...groups.values()];
}

/**
 * Why a message must be delivered again: a transient failure, an unclassified failure not yet given up on,
 * or a poison message whose dead-letter write failed (it is not done until the DLQ has it).
 */
export type RetryReason = 'transient' | 'unclassified' | 'dlq_unavailable';

export interface Retry {
  readonly reason: RetryReason;
  readonly error: unknown;
}

/** `done`: succeeded, skipped (a type this consumer ignores) or dead-lettered. */
export type MessageOutcome = { readonly kind: 'done' } | ({ readonly kind: 'retry' } & Retry);

export interface UnitsResult<M> {
  readonly done: ReadonlySet<M>;
  /** The first failure that asked for a retry; undefined when none did. */
  readonly retry: Retry | undefined;
  /** How many messages asked for a retry. */
  readonly retries: number;
}

export interface RunUnitsOptions<M> {
  readonly limit: LimitFunction;
  /**
   * Checked before each message starts. False once the batch deadline passed or the consumer is stopping:
   * the messages in flight finish and the rest stay pending, so one batch cannot hold the member (M0 delta 5).
   */
  readonly mayStart: () => boolean;
  /** Retry outcomes after which no new message starts; those in flight finish. */
  readonly retryBudget: number;
  /** Settles every failure into an outcome; a rejection is treated as an unclassified failure. */
  readonly work: (message: M) => Promise<MessageOutcome>;
}

export async function runUnits<M>(
  units: readonly (readonly M[])[],
  { limit, mayStart, retryBudget, work }: RunUnitsOptions<M>,
): Promise<UnitsResult<M>> {
  const done = new Set<M>();
  let retry: Retry | undefined;
  let retries = 0;

  const runUnit = async (unit: readonly M[]) => {
    for (const message of unit) {
      if (retries >= retryBudget || !mayStart()) return;
      let outcome: MessageOutcome;
      try {
        outcome = await work(message);
      } catch (error) {
        outcome = { kind: 'retry', reason: 'unclassified', error };
      }
      if (outcome.kind === 'retry') {
        retries++;
        retry ??= { reason: outcome.reason, error: outcome.error };
        // The rest of this order waits for the message that failed: never reorder within an order.
        return;
      }
      done.add(message);
    }
  };

  await Promise.all(units.map((unit) => limit(() => runUnit(unit))));
  return { done, retry, retries };
}
