import { describe, expect, it } from 'vitest';
import { type RedisDropState, type RedisRsvEntry, redisDropViolations } from './state';

const entry = (u: string, q: number, s: RedisRsvEntry['s']): RedisRsvEntry => ({ u, q, s, fp: 'f', k: 'k' });

function state(overrides: Partial<RedisDropState> = {}): RedisDropState {
  return {
    inv: { status: 'LIVE', gen: 1, seq: 9, total: 10, avail: 6, held: 3, sold: 1 },
    entries: new Map([
      ['r1', entry('u1', 2, 'HELD')],
      ['r2', entry('u2', 1, 'HELD')],
      ['r3', entry('u2', 1, 'COMMITTED')],
      ['r4', entry('u3', 2, 'RELEASED')],
    ]),
    quotas: new Map([
      ['u1', 2],
      ['u2', 2],
    ]),
    expiries: new Map([
      ['r1', 1],
      ['r2', 1],
    ]),
    ...overrides,
  };
}

describe('redisDropViolations', () => {
  it('finds nothing in a consistent drop, or in a drop Redis does not have', () => {
    expect(redisDropViolations(state())).toEqual([]);
    expect(redisDropViolations(state({ inv: null, entries: new Map() }))).toEqual([]);
  });

  it('reports a conservation breach (INV-9)', () => {
    const inv = { status: 'LIVE' as const, gen: 1, seq: 9, total: 10, avail: 7, held: 3, sold: 1 };
    expect(redisDropViolations(state({ inv }))).toEqual([expect.stringContaining('INV-9')]);
  });

  it('reports counters that disagree with the entries', () => {
    const inv = { status: 'LIVE' as const, gen: 1, seq: 9, total: 10, avail: 5, held: 4, sold: 1 };
    expect(redisDropViolations(state({ inv }))).toEqual(['held 4 != HELD units 3']);
  });

  it('reports a user quota that disagrees with that user entries, and a zero quota kept', () => {
    const quotas = new Map([
      ['u1', 1],
      ['u2', 2],
      ['u3', 0],
    ]);
    expect(redisDropViolations(state({ quotas }))).toEqual(['uq[u1] = 1, entries say 2', 'uq[u3] kept at 0']);
  });

  it('reports exp members that are not exactly the HELD entries', () => {
    const expiries = new Map([
      ['r1', 1],
      ['r3', 1],
      ['gone', 1],
    ]);
    expect(redisDropViolations(state({ expiries }))).toEqual([
      'exp membership of r2 (HELD)',
      'exp membership of r3 (COMMITTED)',
      'exp member gone without rsv entry',
    ]);
  });
});
