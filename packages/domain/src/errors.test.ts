import { describe, expect, it } from 'vitest';
import {
  BugError,
  DomainError,
  ERROR_CODES,
  ERROR_STATUS,
  isDomainError,
  NotFoundError,
  RetryError,
  ValidationError,
} from './errors';

describe('DomainError', () => {
  it('maps every code to an HTTP error status', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_STATUS[code]).toBeLessThan(600);
    }
  });

  it.each([
    ['SOLD_OUT', 409],
    ['LIMIT_REACHED', 409],
    ['DROP_NOT_LIVE', 409],
    ['RESERVATION_EXPIRED', 410],
    ['IDEMPOTENCY_KEY_REUSED', 422],
    ['RETRY', 503],
  ] as const)('answers %s with %i, as §5.1 specifies', (code, status) => {
    expect(new DomainError(code).status).toBe(status);
  });

  it('keeps the cause and the subclass identity', () => {
    const cause = new Error('pg');
    const error = new NotFoundError('Product', { cause });

    expect(error).toBeInstanceOf(DomainError);
    expect(isDomainError(error)).toBe(true);
    expect(error).toMatchObject({ name: 'NotFoundError', code: 'NOT_FOUND', status: 404 });
    expect(error.message).toBe('Product not found');
    expect(error.cause).toBe(cause);
  });

  it('carries the data its caller needs', () => {
    expect(new ValidationError([{ path: 'qty', message: 'too big' }]).issues).toEqual([
      { path: 'qty', message: 'too big' },
    ]);
    expect(new RetryError().retryAfterSeconds).toBe(1);
    expect(new BugError('qty reached Lua unvalidated')).toMatchObject({ code: 'INTERNAL', status: 500 });
  });

  it('does not claim foreign errors', () => {
    expect(isDomainError(new Error('x'))).toBe(false);
    expect(isDomainError({ code: 'SOLD_OUT' })).toBe(false);
  });
});
