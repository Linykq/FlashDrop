import { describe, expect, it } from 'vitest';
import { batchProgress, compareOffsets, nextOffset } from './offsets';

const offsets = ['10', '11', '12', '13', '14'];

describe('batchProgress', () => {
  it('commits the whole batch when every message finished', () => {
    expect(batchProgress(offsets, new Set(offsets))).toEqual({ lastDone: '14', firstPending: undefined });
  });

  it('commits nothing and resumes at the start when the first message is unfinished', () => {
    expect(batchProgress(offsets, new Set(['11', '12', '13', '14']))).toEqual({
      lastDone: undefined,
      firstPending: '10',
    });
  });

  // M0 delta 4: resolving 14 while 12 is unfinished would skip 12 for good.
  it('stops at the first gap even when later messages finished', () => {
    expect(batchProgress(offsets, new Set(['10', '11', '13', '14']))).toEqual({
      lastDone: '11',
      firstPending: '12',
    });
  });

  it('treats a batch where nothing ran as entirely pending', () => {
    expect(batchProgress(offsets, new Set())).toEqual({ lastDone: undefined, firstPending: '10' });
  });

  it('follows the batch order, not numeric neighbours, across offset gaps (compaction, control records)', () => {
    expect(batchProgress(['5', '9', '20'], new Set(['5', '9']))).toEqual({
      lastDone: '9',
      firstPending: '20',
    });
  });
});

describe('nextOffset and compareOffsets', () => {
  it('handle int64 offsets beyond 2^53 exactly', () => {
    expect(nextOffset('9007199254740993')).toBe('9007199254740994');
    expect(compareOffsets('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareOffsets('2', '10')).toBe(-1);
    expect(compareOffsets('7', '7')).toBe(0);
  });
});
