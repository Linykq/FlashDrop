/*
 * Typed errors every layer throws (CLAUDE.md). Each carries a stable machine `code` from the API reference
 * (design §5.1, §5.2); `api` turns them into problem details (`ProblemDetails` in `packages/contracts`) with
 * the status from `ERROR_STATUS`, so the code-to-status mapping exists exactly once.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'SOLD_OUT',
  'LIMIT_REACHED',
  'DROP_NOT_LIVE',
  'ALREADY_SUBMITTED',
  'DROP_ARMED',
  'DROP_BUSY',
  'WINDOW_PASSED',
  'RESERVATION_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'INTERNAL',
  'RETRY',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  // Also for other users' orders: §11 answers 404, never 403, so ids cannot be probed.
  NOT_FOUND: 404,
  // A compare-and-set that lost, without a more specific reason (extend, cancel, checkout of a closed order).
  CONFLICT: 409,
  SOLD_OUT: 409,
  LIMIT_REACHED: 409,
  DROP_NOT_LIVE: 409,
  ALREADY_SUBMITTED: 409,
  DROP_ARMED: 409,
  DROP_BUSY: 409,
  // Arming a drop whose window is over would end it at once, for good: its times must be edited first.
  WINDOW_PASSED: 409,
  RESERVATION_EXPIRED: 410,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  // The drop is reconciling or a dependency is briefly unavailable: retry with the same Idempotency-Key.
  RETRY: 503,
};

/** Base class: an expected outcome with a stable code, safe to show to the caller. */
export class DomainError extends Error {
  override name = 'DomainError';
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export class NotFoundError extends DomainError {
  override name = 'NotFoundError';

  constructor(resource: string, options?: ErrorOptions) {
    super('NOT_FOUND', `${resource} not found`, options);
  }
}

export interface ValidationIssue {
  /** Dotted path into the input, e.g. `shipping.postalCode`; empty for the input as a whole. */
  readonly path: string;
  readonly message: string;
}

export class ValidationError extends DomainError {
  override name = 'ValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[], options?: ErrorOptions) {
    super('VALIDATION_FAILED', 'The request is invalid', options);
    this.issues = issues;
  }
}

/**
 * A compare-and-set lost to another writer, so the work now belongs to someone else (a lease taken over, a
 * fenced job). Nothing to retry: the winner carries on.
 */
export class ConflictError extends DomainError {
  override name = 'ConflictError';

  constructor(message: string, options?: ErrorOptions) {
    super('CONFLICT', message, options);
  }
}

/**
 * Input accepted earlier that the work it was submitted for cannot use (a stored photo gone missing, a photo
 * no recorded answer exists for). The same input fails the same way every time, so it is reported, never
 * retried; the message is meant for the person who submitted it.
 */
export class UnprocessableInputError extends DomainError {
  override name = 'UnprocessableInputError';

  constructor(message: string, options?: ErrorOptions) {
    super('VALIDATION_FAILED', message, options);
  }
}

/** 503 with `Retry-After`: the caller should retry the same request, with the same Idempotency-Key. */
export class RetryError extends DomainError {
  override name = 'RetryError';
  readonly retryAfterSeconds: number;

  constructor(message = 'Temporarily unavailable, retry', retryAfterSeconds = 1, options?: ErrorOptions) {
    super('RETRY', message, options);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * A failure that says nothing about the input, only that a dependency cannot answer now (a PSP timeout, a
 * drop still rebuilding): retry the same work later. A consumer pauses the partition and retries the
 * message forever; it is never dead-lettered for it (design §6.4). Postgres and Redis outages are
 * recognised by their own classifiers instead.
 */
export class TransientError extends Error {
  override name = 'TransientError';
}

/**
 * A broken internal assumption, e.g. an unvalidated `qty` reaching Lua (§5.2). Answered with 500 and an
 * alert; the message is for logs, never for the caller.
 */
export class BugError extends DomainError {
  override name = 'BugError';

  constructor(message: string, options?: ErrorOptions) {
    super('INTERNAL', message, options);
  }
}

/** The invariants of design §1.1, in order: the one list the checks, the health API and the tools share. */
export const INVARIANT_IDS = [
  'INV-1',
  'INV-2',
  'INV-3',
  'INV-4',
  'INV-5',
  'INV-6',
  'INV-7',
  'INV-8',
  'INV-9',
] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

/**
 * Stored state that breaks one of the §1.1 invariants, found at run time: Redis holding the opposite
 * terminal state of an order (INV-8, a Lua `CONFLICT`), or a refund to record for an order that was paid or
 * is still live (INV-4). Consumers dead-letter the event and alert instead of retrying it, because the same
 * input fails the same way every time (§6.4).
 */
export class InvariantViolation extends DomainError {
  override name = 'InvariantViolation';
  readonly invariant: InvariantId;

  constructor(invariant: InvariantId, message: string, options?: ErrorOptions) {
    super('INTERNAL', `${invariant}: ${message}`, options);
    this.invariant = invariant;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
