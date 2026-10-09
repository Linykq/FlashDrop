/**
 * @packageDocumentation
 * Kafka for FlashDrop (design §5.4, §6): the client and producer configuration, an awaitable publisher with
 * classified failures, the outbox relay loop, the consumer runner (grouped in-batch concurrency, contiguous
 * commits, pause/seek/backoff retries, the DLQ, bounded batches, assignment health), the direct-handler DLQ
 * replay, and Java's murmur2 partitioner. Also the one notification that is not an event: asking `web` to
 * revalidate a cache tag.
 */
export * from './backoff';
export * from './dlq-replay';
export * from './errors';
export * from './handlers';
export * from './headers';
export * from './kafka';
export * from './lag';
export * from './partitioner';
export * from './publisher';
export * from './relay';
export * from './runner';
export * from './web-revalidate';
