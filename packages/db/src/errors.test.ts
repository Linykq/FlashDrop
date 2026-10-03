import { DrizzleQueryError } from 'drizzle-orm/errors';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  constraintOf,
  HotRowBusyError,
  isPostgresUnavailableError,
  isTransientDbError,
  isUnknownUserError,
  pgErrorOf,
} from './errors';

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

describe('isUnknownUserError', () => {
  it('recognises a reservation refused because its user does not exist', () => {
    for (const constraint of ['orders_user_id_users_id_fk', 'user_drop_quota_user_id_users_id_fk']) {
      expect(isUnknownUserError(wrapped(databaseError({ code: '23503', constraint })))).toBe(true);
    }
  });

  it('ignores other foreign keys and other errors', () => {
    expect(
      isUnknownUserError(wrapped(databaseError({ code: '23503', constraint: 'orders_drop_id_drops_id_fk' }))),
    ).toBe(false);
    expect(
      isUnknownUserError(wrapped(databaseError({ code: '23505', constraint: 'orders_user_id_users_id_fk' }))),
    ).toBe(false);
    expect(isUnknownUserError(new Error('x'))).toBe(false);
  });
});

describe('isPostgresUnavailableError', () => {
  it.each([
    ['a lost connection', wrapped(new Error('Connection terminated unexpectedly'))],
    ['a new session that timed out opening', new Error('Connection terminated due to connection timeout')],
    ['a refused socket', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['too many connections', wrapped(databaseError({ code: '53300', severity: 'FATAL' }))],
    ['a server shutting down', wrapped(databaseError({ code: '57P01', severity: 'FATAL' }))],
    ['a server starting up', wrapped(databaseError({ code: '57P03', severity: 'FATAL' }))],
    ['a statement Postgres could not finish in time', wrapped(databaseError({ code: '57014' }))],
    ['a transaction past transaction_timeout', wrapped(databaseError({ code: '25P04', severity: 'FATAL' }))],
  ])('counts %s', (_name, error) => {
    expect(isPostgresUnavailableError(error)).toBe(true);
  });

  // Regression: under a burst against a healthy Postgres these opened the reserve breaker 19 times in
  // 250 ms and turned away buyers before Lua.
  it.each([
    ['a full pool in this process', wrapped(new Error('timeout exceeded when trying to connect'))],
    [
      'the hot row queue past the statement timeout',
      new HotRowBusyError('busy', { cause: wrapped(databaseError({ code: '57014' })) }),
    ],
    ['a serialization failure', wrapped(databaseError({ code: '40001' }))],
    ['a deadlock', wrapped(databaseError({ code: '40P01' }))],
  ])('does not count %s, which stays transient', (_name, error) => {
    expect(isTransientDbError(error)).toBe(true);
    expect(isPostgresUnavailableError(error)).toBe(false);
  });

  it('does not count errors that are the request’s own fault', () => {
    expect(isPostgresUnavailableError(wrapped(databaseError({ code: '23505' })))).toBe(false);
    expect(isPostgresUnavailableError(new Error('boom'))).toBe(false);
  });
});
