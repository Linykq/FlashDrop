import { CONSUMER_GROUPS, type WorkerRole } from '@flashdrop/config';
import {
  type ConsumerRunner,
  type ConsumerRunnerOptions,
  createConsumerRunner,
  type OrderEventHandlers,
  type Publisher,
} from '@flashdrop/messaging';
import type { WorkerDeps } from '../deps';
import { isTransientError } from '../loop';
import { paymentHandlers } from './payment';
import type { PspClient } from './psp-client';
import { settlementHandlers } from './settlement';

/*
 * The consumer-group roles (design §6.3), run by the `consumers` service: one runner (one Kafka consumer
 * instance) per group, so one group's slow batch never stalls another's (M0 delta 5).
 */

export type ConsumerName = 'payment' | 'settlement';

interface ConsumerSpec {
  readonly groupId: string;
  /** Orders in flight at once across the member's batches (§6.3). */
  readonly concurrency: number;
  /** Messages per batch (`js.consumer.max.batch.size`); the runner's default when unset. */
  readonly maxBatchSize?: number;
}

const CONSUMERS: Readonly<Record<ConsumerName, ConsumerSpec>> = {
  // A flash sale is one product, so one partition: 32 orders in flight is what lets 1,000 orders at about
  // 450 ms of PSP latency get paid in about 15 s rather than 7.5 minutes (§6.3). Batches of a partition run
  // one after another, so a batch must hold more than 32 orders' worth of messages for 32 to be in flight:
  // with the client's default of 32 messages, about a third of them order.placed (the rest reserved,
  // cancelled, paid...), only some 10 charges ran at once, and a CI burst took 9 s from submit to PAID at
  // p50 (M4 integration). The batch deadline still bounds a batch: no new message starts after 5 s.
  payment: { groupId: CONSUMER_GROUPS.payment, concurrency: 32, maxBatchSize: 256 },
  settlement: { groupId: CONSUMER_GROUPS.settlement, concurrency: 16 },
};

/**
 * Postgres connections the consumer roles among `roles` can use at once: one per order in flight, since each
 * handler holds at most one (a read, or its CAS transaction) at a time. The worker sizes its pool with it. A
 * pool smaller than the handlers queues them for a connection behind PAID CASes waiting on the hot
 * inventory row, until the 5 s connect timeout fails them as transient and stalls the partition.
 */
export function consumerConnections(roles: readonly WorkerRole[]): number {
  return roles.filter(isConsumerName).reduce((sum, name) => sum + CONSUMERS[name].concurrency, 0);
}

function isConsumerName(role: WorkerRole): role is ConsumerName {
  return Object.hasOwn(CONSUMERS, role);
}

/** What the handlers use: Postgres, the Redis command client, the sync nudger and the PSP. */
export interface ConsumerDeps extends Pick<WorkerDeps, 'db' | 'redis' | 'nudger' | 'logger'> {
  readonly psp: PspClient;
}

/**
 * Every consumer's handlers by the name its runner writes into `x-consumer` on a dead letter, so
 * `dlq:replay` runs exactly the handler, and the idempotency checks, of the first delivery (§6.4).
 */
export function consumerRegistry(deps: ConsumerDeps): Readonly<Record<ConsumerName, OrderEventHandlers>> {
  return { payment: paymentHandlers(deps), settlement: settlementHandlers(deps) };
}

export interface ConsumerRoleOptions {
  readonly kafka: ConsumerRunnerOptions['kafka'];
  /** Dead letters go here; one producer per process. */
  readonly dlq: Publisher;
  /** Tests run against throwaway topics and groups; production uses the design's names. */
  readonly topic?: string;
  readonly dlqTopic?: string;
  readonly groupId?: string;
  readonly backoff?: ConsumerRunnerOptions['backoff'];
}

/**
 * Starts one group's runner. Resolves once it has joined and is consuming; it reports healthy only once
 * it owns a partition (§6.4).
 */
export async function startConsumer(
  name: ConsumerName,
  deps: ConsumerDeps,
  options: ConsumerRoleOptions,
): Promise<ConsumerRunner> {
  const spec = CONSUMERS[name];
  const logger = deps.logger.child({ role: name });
  const runner = createConsumerRunner({
    kafka: options.kafka,
    name,
    groupId: options.groupId ?? spec.groupId,
    handlers: consumerRegistry({ ...deps, logger })[name],
    dlq: options.dlq,
    logger,
    concurrency: spec.concurrency,
    maxBatchSize: spec.maxBatchSize,
    // Postgres or Redis away, RetryError: pause and retry the partition, never dead-letter.
    isTransient: isTransientError,
    topic: options.topic,
    dlqTopic: options.dlqTopic,
    backoff: options.backoff,
  });
  try {
    await runner.start();
  } catch (err) {
    // The start's own error is the one to report; a failed cleanup is only logged beside it.
    await runner
      .stop()
      .catch((stopErr: unknown) => logger.warn({ err: stopErr }, 'stop after a failed start failed'));
    throw err;
  }
  return runner;
}
