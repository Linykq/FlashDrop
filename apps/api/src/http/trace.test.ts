import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { parseTraceparent, traceIdOf } from './trace';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('parseTraceparent', () => {
  it('takes the trace id of a valid header', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-00f067aa0ba902b7-01`)).toBe(TRACE_ID);
    expect(parseTraceparent(` 00-${TRACE_ID.toUpperCase()}-00F067AA0BA902B7-00 `)).toBe(TRACE_ID);
  });

  it.each([
    undefined,
    ['a', 'b'],
    '',
    `00-${TRACE_ID}-00f067aa0ba902b7`,
    `ff-${TRACE_ID}-00f067aa0ba902b7-01`,
    `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    `00-${TRACE_ID}-${'0'.repeat(16)}-01`,
    `00-${TRACE_ID}x-00f067aa0ba902b7-01`,
  ])('rejects %j', (header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });
});

describe('traceIdOf', () => {
  const request = (headers: IncomingMessage['headers']) => ({ headers }) as IncomingMessage;

  it('uses the incoming trace id', () => {
    expect(traceIdOf(request({ traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` }))).toBe(TRACE_ID);
  });

  it('creates one per request otherwise, and keeps it', () => {
    const first = request({});
    const id = traceIdOf(first);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdOf(first)).toBe(id);
    expect(traceIdOf(request({}))).not.toBe(id);
  });
});
