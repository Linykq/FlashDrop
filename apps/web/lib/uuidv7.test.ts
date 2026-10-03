import { isIdempotencyKey } from '@flashdrop/domain';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuidv7';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('is a version-7, RFC 9562 variant uuid and a valid Idempotency-Key', () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv7();
      expect(id).toMatch(V7);
      expect(isIdempotencyKey(id)).toBe(true);
    }
  });

  it('starts with the time in milliseconds, so ids sort by creation', () => {
    const now = Date.UTC(2026, 9, 2, 19, 0, 0);
    const id = uuidv7(now);
    expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(now);
    expect(uuidv7(now) < uuidv7(now + 1)).toBe(true);
  });

  it('differs between calls in the same millisecond', () => {
    const now = Date.now();
    expect(new Set(Array.from({ length: 100 }, () => uuidv7(now))).size).toBe(100);
  });
});
