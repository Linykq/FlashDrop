import { InvariantViolation, TransientError } from '@flashdrop/domain';
import { describe, expect, it } from 'vitest';
import { classifyFailure, describeError } from './errors';

const never = () => false;
const conflict = () => new InvariantViolation('INV-8', 'redis holds COMMITTED for an EXPIRED order');

describe('classifyFailure', () => {
  it('dead-letters a broken invariant and retries a transient error', () => {
    expect(classifyFailure(conflict(), never)).toBe('poison');
    expect(classifyFailure(new TransientError('drop reconciling'), never)).toBe('transient');
  });

  it('looks through the cause chain', () => {
    const wrapped = new Error('settle failed', { cause: new TransientError('redis away') });
    expect(classifyFailure(wrapped, never)).toBe('transient');
    const deep = new Error('a', { cause: new Error('b', { cause: conflict() }) });
    expect(classifyFailure(deep, never)).toBe('poison');
  });

  it('asks the caller about infrastructure errors it does not know', () => {
    const pgDown = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyFailure(pgDown, (error) => error === pgDown)).toBe('transient');
    expect(classifyFailure(pgDown, never)).toBe('unclassified');
  });

  it('leaves everything else unclassified, including non-errors', () => {
    expect(classifyFailure(new TypeError('x is undefined'), never)).toBe('unclassified');
    expect(classifyFailure('boom', never)).toBe('unclassified');
  });

  it('prefers poison when an invariant violation wraps a transient error', () => {
    const violation = new InvariantViolation('INV-4', 'refund of a paid order', {
      cause: new TransientError('psp slow'),
    });
    expect(classifyFailure(violation, () => true)).toBe('poison');
  });
});

describe('describeError', () => {
  it('names the error class', () => {
    expect(describeError(conflict())).toBe(
      'InvariantViolation: INV-8: redis holds COMMITTED for an EXPIRED order',
    );
    expect(describeError(42)).toBe('42');
  });
});
