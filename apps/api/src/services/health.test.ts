import { RetryError } from '@flashdrop/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postgresCheck } from './health';

afterEach(() => {
  vi.useRealTimers();
});

describe('postgresCheck', () => {
  it('resolves when SELECT 1 answers', async () => {
    const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
    await expect(postgresCheck({ query })()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('passes a query failure on', async () => {
    const failure = new Error('connect ECONNREFUSED');
    await expect(postgresCheck({ query: async () => Promise.reject(failure) })()).rejects.toBe(failure);
  });

  it('gives up after the timeout instead of hanging the probe', async () => {
    vi.useFakeTimers();
    const pending = postgresCheck({ query: () => new Promise(() => undefined) }, 1_500)();
    const outcome = expect(pending).rejects.toBeInstanceOf(RetryError);
    await vi.advanceTimersByTimeAsync(1_500);
    await outcome;
  });
});
