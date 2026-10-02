import { describe, expect, it } from 'vitest';
import { type TransactionRunner, transaction } from './transaction';

interface FakeTx {
  readonly id: string;
}

/** Drizzle's behaviour: run the callback, and on failure ROLLBACK, whose own failure replaces the error. */
function fakeDb(
  rollback: 'succeeds' | 'fails',
): TransactionRunner<FakeTx, { readonly isolationLevel: string }> {
  return {
    async transaction(fn) {
      try {
        return await fn({ id: 'tx' });
      } catch (error) {
        if (rollback === 'fails') throw new Error('Failed query: rollback');
        throw error;
      }
    },
  };
}

describe('transaction', () => {
  it('returns the callback result', async () => {
    expect(await transaction(fakeDb('succeeds'), async (tx) => tx.id)).toBe('tx');
  });

  it('rethrows the callback error unchanged when the rollback works', async () => {
    const error = new Error('constraint');

    const thrown = await transaction(fakeDb('succeeds'), async () => {
      throw error;
    }).catch((caught: unknown) => caught);

    expect(thrown).toBe(error);
    expect(thrown).not.toHaveProperty('rollbackError');
  });

  it('keeps the original error when the rollback fails on a dead connection', async () => {
    const error = new Error('terminating connection due to transaction timeout');

    const thrown = await transaction(fakeDb('fails'), async () => {
      throw error;
    }).catch((caught: unknown) => caught);

    expect(thrown).toBe(error);
    expect(thrown).toHaveProperty('rollbackError.message', 'Failed query: rollback');
  });

  it('throws a non-Error rejection as it was', async () => {
    const thrown = await transaction(fakeDb('fails'), async () => {
      throw 'plain value';
    }).catch((caught: unknown) => caught);

    expect(thrown).toBe('plain value');
  });
});
