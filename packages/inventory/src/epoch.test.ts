import { describe, expect, it } from 'vitest';
import { keyspaceLoss } from './epoch';
import { structuralIssue } from './holds';

describe('keyspaceLoss', () => {
  const stored = { epoch: 'e1', runId: 'r1' };
  const live = {
    epoch: 'e1',
    runId: 'r1',
    libraryLoaded: true,
    libraryOutdated: false,
    libraryDiffers: false,
  };

  it('is null while Redis is the instance and the keyspace of the last full rebuild', () => {
    expect(keyspaceLoss(live, stored)).toBeNull();
  });

  it('reports a restart first: the AOF tail may be lost even though the keys look intact', () => {
    expect(keyspaceLoss({ ...live, runId: 'r2' }, stored)).toBe('restart');
    expect(keyspaceLoss({ ...live, runId: 'r2', epoch: null, libraryLoaded: false }, stored)).toBe('restart');
  });

  it('reports a wipe when the epoch is missing or another one', () => {
    expect(keyspaceLoss({ ...live, epoch: null }, stored)).toBe('wipe');
    expect(keyspaceLoss({ ...live, epoch: 'e0' }, stored)).toBe('wipe');
  });

  it('reports a missing library', () => {
    expect(keyspaceLoss({ ...live, libraryLoaded: false }, stored)).toBe('library');
  });

  it('asks for a first full rebuild when nothing was ever recorded', () => {
    expect(keyspaceLoss({ ...live, epoch: null }, { epoch: null, runId: null })).toBe('restart');
  });
});

describe('structuralIssue', () => {
  const stock = { status: 'LIVE' as const, gen: 3, seq: 0, avail: 1, held: 0, sold: 0 };

  it('flags a missing hash, a dead rebuild and a generation mismatch', () => {
    expect(structuralIssue(null, 3)).toBe('MISSING');
    expect(structuralIssue({ ...stock, status: 'RECONCILING' }, 3)).toBe('RECONCILING');
    expect(structuralIssue(stock, 4)).toBe('GEN_MISMATCH');
    expect(structuralIssue(stock, 3)).toBeNull();
  });
});
