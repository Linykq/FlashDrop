import { InvariantViolation, TransientError } from '@flashdrop/domain';

/*
 * What a handler's failure means to the consumer runner (design §6.4):
 *
 *   transient     Postgres or Redis unavailable, PSP 5xx or timeout, Lua RETRY: pause the partition and
 *                 retry the same message after a backoff, forever. Stalling beats reordering or dropping.
 *   poison        `InvariantViolation` from `@flashdrop/domain` (a Lua CONFLICT, INV-8; a refund for a paid
 *                 order, INV-4): dead-letter at once and alert; the same input fails the same way again.
 *   unclassified  anything else, typically a bug: retried on a slower schedule, then dead-lettered once it
 *                 has failed 5 times and for a minute (the runner). Retrying a deterministic bug forever
 *                 would stall every product on the partition, and a dead-lettered event never leaks stock
 *                 or money: the sweeper, the settle safety net and the close-unpaid loop cover it (§6.4).
 */

export type FailureClass = 'transient' | 'poison' | 'unclassified';

const MAX_CAUSE_DEPTH = 8;

/**
 * Classifies a handler's error, looking through its `cause` chain so a wrapped error keeps its meaning.
 * `isTransient` recognises the infrastructure errors the caller knows about (Postgres, Redis, `RetryError`),
 * which do not extend `TransientError`.
 */
export function classifyFailure(error: unknown, isTransient: (error: unknown) => boolean): FailureClass {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof InvariantViolation) return 'poison';
    if (current instanceof TransientError) return 'transient';
    current = current.cause;
  }
  return isTransient(error) ? 'transient' : 'unclassified';
}

/** A one-line description for logs and the `x-error` header. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
