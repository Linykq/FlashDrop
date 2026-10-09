import { CONSUMER_GROUPS, type Logger, type WorkerRole } from '@flashdrop/config';
import type { ListingCall } from '@flashdrop/contracts';
import { type OutboxBacklog, SWEEPER_LOOPS, type SweeperLoop } from '@flashdrop/db';
import type { PartitionLag, Publisher } from '@flashdrop/messaging';
import { Counter, collectDefaultMetrics, Gauge, Registry } from '@prometheus-io/client';
import type { RunOutcome } from './listing/run';

/*
 * The worker's Prometheus series (design §12), served at `GET /metrics` beside `/health` (health.ts), on
 * the Compose network only. Every worker service (worker, listing, consumers, dashboard-consumers) runs this
 * entry, so each exposes the series of its own roles.
 *
 * Counters count an event where it happens, once it has happened: a dead letter once the DLQ acknowledged
 * it, a quarantine once its row exists. The gauges that describe shared state (the outbox, a group's lag)
 * are read at scrape time instead, so they cost nothing while nobody scrapes. Every replica then reports
 * the same value, so dashboards aggregate them with max(), never sum(). A read that fails reports NaN, not
 * 0, which would look like an empty outbox or a group that has caught up.
 *
 * The rare events that alert (rebuilds, quarantines, dead letters) start every known label set at 0. A
 * series created by its first event starts at 1, and increase() over it shows nothing: the first DLQ write
 * or quarantine would never reach a dashboard or an alert rule.
 */

export const registry = new Registry();

/**
 * Why the worker rebuilds a drop from Postgres (§4.7): keyspace loss (restart, wipe, a lost Functions
 * library), structure, the drift checks (drift, refusal, leak), and the orphan scan's stuck holds.
 */
const REBUILD_REASONS = [
  'restart',
  'wipe',
  'library',
  'structural',
  'drift',
  'refusal',
  'leak',
  'stuck_hold',
] as const;
export type RebuildReason = (typeof REBUILD_REASONS)[number];

/** What one call to the PSP came to, as the payment consumer saw it (§6.5). */
export type PspResult =
  // A charge's answer.
  | 'succeeded'
  | 'declined'
  | 'reference_closed'
  // A close's answer: a captured charge was refunded, or there was nothing to refund.
  | 'refunded'
  | 'closed'
  // Unknown outcomes, retried with the same key: no answer in time, a failed socket, 408, 429 or 5xx.
  | 'timeout'
  | 'unreachable'
  | 'unavailable'
  // Our request or the PSP is wrong: any other 4xx, or a 200 outside the contract.
  | 'refused'
  | 'invalid';

const rebuilds = new Counter({
  name: 'fd_rebuilds_total',
  help: 'Drops rebuilt from Postgres by this process, by reason (§4.7).',
  labelNames: ['reason'] as const,
  registers: [registry],
});

for (const reason of REBUILD_REASONS) rebuilds.inc({ reason }, 0);

const quarantined = new Counter({
  name: 'fd_sweeper_quarantined_total',
  help: 'Orders a loop parked after failing to process them; each one is also an alert (§4.6).',
  labelNames: ['loop'] as const,
  registers: [registry],
});

for (const loop of SWEEPER_LOOPS) quarantined.inc({ loop }, 0);

const deadLetters = new Counter({
  name: 'fd_dlq_total',
  help: 'Messages a consumer dead-lettered, counted once the DLQ topic acknowledged them (§6.4).',
  labelNames: ['consumer'] as const,
  registers: [registry],
});

const pspRequests = new Counter({
  name: 'fd_psp_requests_total',
  help: 'Calls to the PSP by operation and result, as the payment consumer saw them (§6.5).',
  labelNames: ['op', 'result'] as const,
  registers: [registry],
});

const listingJobs = new Counter({
  name: 'fd_listing_jobs_total',
  help: 'Listing job runs by how they ended: a final status, released to the queue, or lost (§10).',
  labelNames: ['status'] as const,
  registers: [registry],
});

const llmTokens = new Counter({
  name: 'fd_llm_tokens_total',
  help: 'Tokens of listing model calls by provider and kind; the fixture provider replays recorded usage (§10).',
  labelNames: ['provider', 'kind'] as const,
  registers: [registry],
});

export function countRebuild(reason: RebuildReason): void {
  rebuilds.inc({ reason });
}

export function countQuarantine(loop: SweeperLoop): void {
  quarantined.inc({ loop });
}

export function countPspRequest(op: 'charge' | 'close', result: PspResult): void {
  pspRequests.inc({ op, result });
}

export function countListingJob(status: RunOutcome): void {
  listingJobs.inc({ status: status.toLowerCase() });
}

export function countLlmTokens(provider: string, call: ListingCall): void {
  llmTokens.inc({ provider, kind: 'input' }, call.inputTokens);
  llmTokens.inc({ provider, kind: 'output' }, call.outputTokens);
  llmTokens.inc({ provider, kind: 'cache_read' }, call.cacheReadInputTokens);
  llmTokens.inc({ provider, kind: 'cache_write' }, call.cacheCreationInputTokens);
}

/**
 * A consumer runner's `dlq` publisher that counts what it dead-letters, once the DLQ acknowledged it: a
 * failed write is retried by the runner (`dlq_unavailable`), so nothing is counted twice or too early.
 */
export function countingDeadLetters(dlq: Publisher, consumer: string): Publisher {
  deadLetters.inc({ consumer }, 0);
  return {
    ready: () => dlq.ready(),
    close: () => dlq.close(),
    async publish(records) {
      await dlq.publish(records);
      deadLetters.inc({ consumer }, records.length);
    },
  };
}

/** What the scrape-time gauges read; each one only in a process whose roles own that state. */
export interface ScrapeSources {
  /** The relay role: the outbox backlog (`outboxBacklog`: Postgres time, the pending index only). */
  readonly outbox?: () => Promise<OutboxBacklog>;
  /** The consumer roles: their groups, and the broker's view of a group's lag (`createGroupLagReader`). */
  readonly lag?: {
    readonly groupIds: readonly string[];
    read(groupId: string): Promise<readonly PartitionLag[]>;
  };
  readonly logger: Pick<Logger, 'warn'>;
}

/** The consumer groups among `roles`, whose lag the process reports. */
export function consumerGroupsOf(roles: readonly WorkerRole[]): string[] {
  return roles.filter(isConsumerRole).map((role) => CONSUMER_GROUPS[role]);
}

function isConsumerRole(role: WorkerRole): role is keyof typeof CONSUMER_GROUPS {
  return Object.hasOwn(CONSUMER_GROUPS, role);
}

/** Registers the gauges read at scrape time, once per process (main.ts); tests pass a registry of their own. */
export function registerScrapeGauges(sources: ScrapeSources, into: Registry = registry): void {
  const { outbox, lag, logger } = sources;
  if (outbox !== undefined) {
    new Gauge({
      name: 'fd_outbox_oldest_unpublished_seconds',
      help: 'Age of the oldest outbox row not published to Kafka yet, 0 when none; alert above 10 s (§5.4).',
      registers: [into],
      async collect() {
        try {
          this.set((await outbox()).oldestSeconds ?? 0);
        } catch (err) {
          this.set(Number.NaN);
          logger.warn({ err }, 'outbox backlog unreadable for /metrics');
        }
      },
    });
  }
  if (lag !== undefined && lag.groupIds.length > 0) {
    new Gauge({
      name: 'fd_consumer_lag',
      help: 'Records of orders.v1 a consumer group has not committed yet, over all partitions (§6.4).',
      labelNames: ['group'] as const,
      registers: [into],
      async collect() {
        await Promise.all(
          lag.groupIds.map(async (group) => {
            try {
              const partitions = await lag.read(group);
              this.set(
                { group },
                partitions.reduce((sum, partition) => sum + partition.lag, 0),
              );
            } catch (err) {
              this.set({ group }, Number.NaN);
              logger.warn({ err, groupId: group }, 'consumer lag unreadable for /metrics');
            }
          }),
        );
      },
    });
  }
}

/** Node's own process metrics (CPU, memory, event loop, GC) beside ours; once per process. */
export function collectProcessMetrics(into: Registry = registry): void {
  collectDefaultMetrics({ register: into });
}
