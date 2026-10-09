import type { Publisher } from '@flashdrop/messaging';

/**
 * The relay's chaos test mode (`FD_CHAOS_DUP_DELIVERY`, design §13 `dup-delivery`): every batch goes out
 * twice, as one publish of the batch followed by its copy. One call, not two in a row, so both copies still
 * settle within the producer's one message timeout (10 s), below the relay session's 20 s transaction timeout
 * (§5.4); the idempotent producer keeps the send order per partition, so each partition receives the batch,
 * then the batch again, and every consumer group sees each event twice, within one fetch or across two.
 */
export function publishEveryBatchTwice(publisher: Publisher): Publisher {
  return {
    ready: () => publisher.ready(),
    publish: (records) => publisher.publish([...records, ...records]),
    close: () => publisher.close(),
  };
}
