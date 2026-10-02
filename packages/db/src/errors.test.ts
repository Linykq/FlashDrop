import { DrizzleQueryError } from 'drizzle-orm/errors';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { constraintOf, isTransientDbError, pgErrorOf } from './errors';

function databaseError(fields: Partial<pg.DatabaseError>): pg.DatabaseError {
  return Object.assign(new pg.DatabaseError('postgres said no', 0, 'error'), fields);
}

/** How Drizzle reports a failed query: its own error, with the driver's as `cause`. */
const wrapped = (cause: Error) => new DrizzleQueryError('SELECT 1', [], cause);

describe('pgErrorOf and constraintOf', () => {
  it('find the Postgres error through Drizzle and further wrappers', () => {
    const cause = databaseError({ code: '23514', constraint: 'no_oversell' });
    const error = new Error('reserve failed', { cause: wrapped(cause) });

    expect(pgErrorOf(error)).toBe(cause);
    expect(constraintOf(error)).toBe('no_oversell');
  });

  it('return undefined for anything else', () => {
    expect(pgErrorOf(new Error('x'))).toBeUndefined();
    expect(constraintOf('not an error')).toBeUndefined();
  });

  it('stop on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;

    expect(pgErrorOf(a)).toBeUndefined();
  });
});

describe('isTransientDbError', () => {
  it.each([
    ['transaction_timeout', { code: '25P04', severity: 'FATAL' }],
    ['statement_timeout', { code: '57014', severity: 'ERROR' }],
    ['serialization failure', { code: '40001', severity: 'ERROR' }],
    ['deadlock', { code: '40P01', severity: 'ERROR' }],
    ['connection failure', { code: '08006', severity: 'ERROR' }],
    ['server shutting down', { code: '57P01', severity: 'FATAL' }],
    ['any FATAL', { code: 'XX000', severity: 'FATAL' }],
  ] as const)('retries a %s', (_name, fields) => {
    expect(isTransientDbError(wrapped(databaseError(fields)))).toBe(true);
  });

  it.each([
    ['a CHECK violation', { code: '23514', severity: 'ERROR' }],
    ['a unique violation', { code: '23505', severity: 'ERROR' }],
    ['a lock timeout, which the drop lock answers with DROP_BUSY', { code: '55P03', severity: 'ERROR' }],
    ['a syntax error', { code: '42601', severity: 'ERROR' }],
  ] as const)('does not retry %s', (_name, fields) => {
    expect(isTransientDbError(wrapped(databaseError(fields)))).toBe(false);
  });

  it('retries the connection losses pg reports without a SQLSTATE', () => {
    expect(isTransientDbError(wrapped(new Error('Connection terminated unexpectedly')))).toBe(true);
    expect(
      isTransientDbError(new Error('Client has encountered a connection error and is not queryable')),
    ).toBe(true);
  });

  it.each(['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout'])(
    'retries the pool giving up on a connection: %s',
    (message) => {
      expect(isTransientDbError(wrapped(new Error(message)))).toBe(true);
    },
  );

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
  ])('retries the socket or resolver failure %s', (code) => {
    const error = Object.assign(new Error(`connect ${code} postgres:5432`), { code });
    expect(isTransientDbError(wrapped(error))).toBe(true);
  });

  it('does not retry unrelated errors', () => {
    expect(isTransientDbError(new Error('boom'))).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});
