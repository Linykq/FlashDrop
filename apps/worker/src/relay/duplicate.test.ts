import type { OutgoingRecord, Publisher } from '@flashdrop/messaging';
import { describe, expect, it, vi } from 'vitest';
import { publishEveryBatchTwice } from './duplicate';

const record = (key: string): OutgoingRecord => ({ topic: 'orders.v1', key, value: `{"k":"${key}"}` });

describe('publishEveryBatchTwice', () => {
  it('publishes the batch and then its copy in one call, and passes ready and close through', async () => {
    const inner = {
      ready: vi.fn(async () => undefined),
      publish: vi.fn(async (_records: readonly OutgoingRecord[]) => undefined),
      close: vi.fn(async () => undefined),
    } satisfies Publisher;
    const twice = publishEveryBatchTwice(inner);

    await twice.ready();
    await twice.publish([record('a'), record('b')]);
    await twice.close();

    expect(inner.ready).toHaveBeenCalledOnce();
    expect(inner.publish).toHaveBeenCalledOnce();
    expect(inner.publish.mock.calls[0]?.[0].map((r) => r.key)).toEqual(['a', 'b', 'a', 'b']);
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it('fails the batch when the publish fails, so the relay rolls it back as usual', async () => {
    const failure = new Error('broker unavailable');
    const twice = publishEveryBatchTwice({
      ready: async () => undefined,
      publish: async () => {
        throw failure;
      },
      close: async () => undefined,
    });
    await expect(twice.publish([record('a')])).rejects.toBe(failure);
  });
});
