import { ProblemDetails } from '@flashdrop/contracts';
import { BugError, DomainError, NotFoundError, RetryError, ValidationError } from '@flashdrop/domain';
import { ClientOfflineError, ErrorReply, SocketClosedUnexpectedlyError } from 'redis';
import { describe, expect, it } from 'vitest';
import { toProblem } from './problem';
import { RateLimitedError } from './rate-limit';

const TRACE = 'f'.repeat(32);

function fastifyError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code: 'FST_ERR_SOMETHING' });
}

describe('toProblem', () => {
  it('maps a domain error to its code and status, with its message as detail', () => {
    const { body, headers } = toProblem(new NotFoundError('Drop'), TRACE);
    expect(ProblemDetails.parse(body)).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Drop not found',
      traceId: TRACE,
    });
    expect(headers).toEqual({});
  });

  it('lists the field problems of a validation error and names the request part', () => {
    const error = Object.assign(new ValidationError([{ path: 'qty', message: 'Too big' }]), {
      validationContext: 'body',
    });
    expect(toProblem(error, TRACE).body).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: 'Invalid body',
      errors: [{ path: 'qty', message: 'Too big' }],
    });
  });

  it('adds Retry-After to a RETRY', () => {
    const { body, headers } = toProblem(new RetryError('reconciling', 3), TRACE);
    expect(body).toMatchObject({ status: 503, code: 'RETRY' });
    expect(headers).toEqual({ 'retry-after': '3' });
  });

  it('never shows the message of a BugError', () => {
    const { body } = toProblem(new BugError('qty reached Lua unvalidated'), TRACE);
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL',
      traceId: TRACE,
    });
  });

  it('turns transient database failures into 503 RETRY, wherever they sit in the cause chain', () => {
    const lost = new Error('Connection terminated unexpectedly');
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' });
    for (const error of [lost, new Error('Failed query: select', { cause: refused })]) {
      const { body, headers } = toProblem(error, TRACE);
      expect(body).toMatchObject({ status: 503, code: 'RETRY' });
      expect(headers).toEqual({ 'retry-after': '1' });
    }
  });

  it('turns an unreachable or refusing Redis into 503 RETRY', () => {
    const offline = new ClientOfflineError();
    const oom = new ErrorReply("OOM command not allowed when used memory > 'maxmemory'.");
    for (const error of [offline, new SocketClosedUnexpectedlyError(), oom]) {
      const { body, headers } = toProblem(error, TRACE);
      expect(body).toMatchObject({ status: 503, code: 'RETRY' });
      expect(headers).toEqual({ 'retry-after': '1' });
    }
    expect(toProblem(new ErrorReply('ERR syntax error'), TRACE).body).toMatchObject({ status: 500 });
  });

  it('answers a rate limit with 429 and the seconds until the window resets', () => {
    const { body, headers } = toProblem(new RateLimitedError(2), TRACE);
    expect(body).toMatchObject({ status: 429, code: 'RATE_LIMITED', title: 'Too Many Requests' });
    expect(headers).toEqual({ 'retry-after': '2' });
  });

  it.each([
    [415, 'VALIDATION_FAILED'],
    [413, 'VALIDATION_FAILED'],
    [400, 'VALIDATION_FAILED'],
    [429, 'RATE_LIMITED'],
  ])('keeps the status of a Fastify %i and gives it the code %s', (status, code) => {
    const { body } = toProblem(fastifyError(status, 'Unsupported Media Type'), TRACE);
    expect(body).toMatchObject({ status, code, detail: 'Unsupported Media Type' });
  });

  it('reveals nothing about an unexpected error', () => {
    for (const error of [new Error('password=hunter2'), fastifyError(500, 'internal'), 'a string']) {
      const { body } = toProblem(error, TRACE);
      expect(body).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL',
        traceId: TRACE,
      });
    }
  });

  it('takes the status of a domain code from the shared table', () => {
    expect(toProblem(new DomainError('SOLD_OUT'), TRACE).body).toMatchObject({
      status: 409,
      title: 'Conflict',
    });
    expect(toProblem(new DomainError('RESERVATION_EXPIRED'), TRACE).body).toMatchObject({
      status: 410,
      title: 'Gone',
    });
  });
});
