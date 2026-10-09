import type { ListingCall } from '@flashdrop/contracts';
import type { OutboxBacklog } from '@flashdrop/db';
import type { Publisher } from '@flashdrop/messaging';
import { Registry } from '@prometheus-io/client';
import { describe, expect, it } from 'vitest';
import {
  consumerGroupsOf,
  countingDeadLetters,
  countListingJob,
  countLlmTokens,
  countPspRequest,
  countQuarantine,
  countRebuild,
  registerScrapeGauges,
  registry,
} from './metrics';

/** The value of `name` for exactly these labels in `from`; undefined when that series has no sample. */
async function sample(
  name: string,
  labels: Readonly<Record<string, string>> = {},
  from: Registry = registry,
): Promise<number | undefined> {
  const metric = from.getSingleMetric(name);
  if (metric === undefined) throw new Error(`${name} is not registered`);
  const { values } = await metric.get();
  const wanted = Object.entries(labels);
  return values.find(
    (value) =>
      Object.keys(value.labels).length === wanted.length &&
      wanted.every(([key, label]) => value.labels[key] === label),
  )?.value;
}

const silent = { warn: () => undefined };

const call: ListingCall = {
  attempt: 1,
  model: 'claude-sonnet-5-5',
  effort: 'low',
  outcome: 'ok',
  stopReason: 'end_turn',
  inputTokens: 1_200,
  outputTokens: 300,
  cacheReadInputTokens: 50,
  cacheCreationInputTokens: 0,
  costUsd: 0.01,
  latencyMs: 2_000,
};

describe('the worker registry', () => {
  it('registers every event series of design §12 that the worker owns', async () => {
    const text = await registry.metrics();
    for (const [name, type] of [
      ['fd_rebuilds_total', 'counter'],
      ['fd_sweeper_quarantined_total', 'counter'],
      ['fd_dlq_total', 'counter'],
      ['fd_psp_requests_total', 'counter'],
      ['fd_listing_jobs_total', 'counter'],
      ['fd_llm_tokens_total', 'counter'],
    ]) {
      expect(text).toContain(`# TYPE ${name} ${type}`);
      expect(text).toMatch(new RegExp(`# HELP ${name} \\S`));
    }
  });

  it('starts the alerting counters at 0, so that increase() sees their first event', async () => {
    const text = await registry.metrics();
    expect(text).toContain('fd_rebuilds_total{reason="drift"} 0');
    expect(text).toContain('fd_rebuilds_total{reason="leak"} 0');
    expect(text).toContain('fd_rebuilds_total{reason="stuck_hold"} 0');
    expect(text).toContain('fd_sweeper_quarantined_total{loop="expire-orders"} 0');
    expect(text).toContain('fd_sweeper_quarantined_total{loop="close-unpaid"} 0');
  });

  it('counts each event under its labels', async () => {
    const before = (await sample('fd_rebuilds_total', { reason: 'wipe' })) ?? 0;
    countRebuild('wipe');
    countRebuild('wipe');
    expect(await sample('fd_rebuilds_total', { reason: 'wipe' })).toBe(before + 2);

    countQuarantine('settle-safety-net');
    expect(await sample('fd_sweeper_quarantined_total', { loop: 'settle-safety-net' })).toBeGreaterThan(0);

    countPspRequest('close', 'refunded');
    expect(await sample('fd_psp_requests_total', { op: 'close', result: 'refunded' })).toBeGreaterThan(0);

    countListingJob('NEEDS_REVIEW');
    expect(await sample('fd_listing_jobs_total', { status: 'needs_review' })).toBeGreaterThan(0);
  });

  it('counts a call’s tokens by kind', async () => {
    const provider = 'test-provider';
    countLlmTokens(provider, call);
    expect(await sample('fd_llm_tokens_total', { provider, kind: 'input' })).toBe(1_200);
    expect(await sample('fd_llm_tokens_total', { provider, kind: 'output' })).toBe(300);
    expect(await sample('fd_llm_tokens_total', { provider, kind: 'cache_read' })).toBe(50);
    expect(await sample('fd_llm_tokens_total', { provider, kind: 'cache_write' })).toBe(0);
  });
});

describe('countingDeadLetters', () => {
  const record = { topic: 'orders.v1.dlq', key: 'p', value: '{}' };

  function publisher(fail: boolean): Publisher {
    return {
      ready: async () => undefined,
      close: async () => undefined,
      publish: async () => {
        if (fail) throw new Error('broker unavailable');
      },
    };
  }

  it('counts a dead letter only once the DLQ acknowledged it', async () => {
    const consumer = 'test-consumer';
    await expect(countingDeadLetters(publisher(true), consumer).publish([record])).rejects.toThrow(
      'broker unavailable',
    );
    expect(await sample('fd_dlq_total', { consumer })).toBe(0);

    await countingDeadLetters(publisher(false), consumer).publish([record, record]);
    expect(await sample('fd_dlq_total', { consumer })).toBe(2);
  });
});

describe('registerScrapeGauges', () => {
  it('registers nothing for a process without the relay or a consumer role', async () => {
    const own = new Registry();
    registerScrapeGauges({ lag: { groupIds: [], read: async () => [] }, logger: silent }, own);
    expect(own.getMetricsAsArray()).toEqual([]);
  });

  it('reads the outbox age at scrape time: 0 when empty, NaN when unreadable', async () => {
    const own = new Registry();
    let read = async (): Promise<OutboxBacklog> => ({ pending: 3, oldestSeconds: 12.5 });
    registerScrapeGauges({ outbox: () => read(), logger: silent }, own);
    expect(await sample('fd_outbox_oldest_unpublished_seconds', {}, own)).toBe(12.5);

    read = async () => ({ pending: 0, oldestSeconds: null });
    expect(await sample('fd_outbox_oldest_unpublished_seconds', {}, own)).toBe(0);

    read = async () => {
      throw new Error('connection refused');
    };
    expect(await sample('fd_outbox_oldest_unpublished_seconds', {}, own)).toBeNaN();
  });

  it("sums each group's partition lags, NaN for a group whose read failed", async () => {
    const own = new Registry();
    const partition = (lag: number) => ({ partition: 0, committed: '1', end: '1', lag });
    registerScrapeGauges(
      {
        lag: {
          groupIds: ['payment', 'inventory-settlement'],
          read: async (group) => {
            if (group === 'inventory-settlement') throw new Error('coordinator not available');
            return [partition(4), partition(0), partition(7)];
          },
        },
        logger: silent,
      },
      own,
    );

    expect(await sample('fd_consumer_lag', { group: 'payment' }, own)).toBe(11);
    expect(await sample('fd_consumer_lag', { group: 'inventory-settlement' }, own)).toBeNaN();
    expect(await own.metrics()).toContain('fd_consumer_lag{group="payment"} 11');
  });
});

describe('consumerGroupsOf', () => {
  it('maps the consumer roles to their groups and skips the loops', () => {
    expect(consumerGroupsOf(['relay', 'sweeper', 'reconciler', 'listing'])).toEqual([]);
    expect(consumerGroupsOf(['payment', 'settlement'])).toEqual(['payment', 'inventory-settlement']);
    expect(consumerGroupsOf(['dashboard'])).toEqual(['sales-dashboard']);
  });
});
