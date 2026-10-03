import { BugError } from '@flashdrop/domain';
import { describe, expect, it } from 'vitest';
import {
  parseConfirmReply,
  parseRateLimitReply,
  parseRebuildReply,
  parseReserveReply,
  parseSetStatusReply,
} from './replies';

describe('fd_reserve replies', () => {
  it('parse the gen of RESERVED (a Lua number) and of EXISTING (an HGET string)', () => {
    expect(parseReserveReply(['RESERVED', 3])).toEqual({ kind: 'RESERVED', gen: 3 });
    expect(parseReserveReply(['EXISTING', 'HELD', '3'])).toEqual({ kind: 'EXISTING', state: 'HELD', gen: 3 });
    expect(parseReserveReply(['EXISTING', 'RELEASED', 7])).toEqual({
      kind: 'EXISTING',
      state: 'RELEASED',
      gen: 7,
    });
  });

  it('parse every refusal', () => {
    for (const kind of ['RETRY', 'NO_DROP', 'NOT_LIVE', 'LIMIT', 'SOLD_OUT', 'FP_MISMATCH', 'BAD_QTY']) {
      expect(parseReserveReply([kind])).toEqual({ kind });
    }
  });

  it('treat anything else as a bug', () => {
    for (const reply of [
      ['RESERVED'],
      ['EXISTING', 'GONE', '1'],
      ['NOPE'],
      'RESERVED',
      null,
      ['RESERVED', 'x'],
    ]) {
      expect(() => parseReserveReply(reply)).toThrow(BugError);
    }
  });
});

describe('single-code replies', () => {
  it('map to { kind }', () => {
    expect(parseConfirmReply('MISSING')).toEqual({ kind: 'MISSING' });
    expect(parseRebuildReply('STALE')).toEqual({ kind: 'STALE' });
    expect(parseSetStatusReply('RETRY')).toEqual({ kind: 'RETRY' });
    expect(() => parseRebuildReply('NOOP')).toThrow(BugError);
    expect(() => parseSetStatusReply(['OK'])).toThrow(BugError);
  });

  it('parse a rate-limit hit', () => {
    expect(parseRateLimitReply([1, 1000])).toEqual({ count: 1, ttlMs: 1000 });
    expect(() => parseRateLimitReply([0, 1000])).toThrow(BugError);
  });
});
