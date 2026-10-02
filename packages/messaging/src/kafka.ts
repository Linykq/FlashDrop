import { KafkaJS } from '@confluentinc/kafka-javascript';

const LOG_LEVELS = {
  nothing: KafkaJS.logLevel.NOTHING,
  error: KafkaJS.logLevel.ERROR,
  warn: KafkaJS.logLevel.WARN,
  info: KafkaJS.logLevel.INFO,
  debug: KafkaJS.logLevel.DEBUG,
} as const;

export type KafkaLogLevel = keyof typeof LOG_LEVELS;

export interface KafkaOptions {
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly logLevel?: KafkaLogLevel;
}

/** A client for the librdkafka-backed, KafkaJS-compatible API of `@confluentinc/kafka-javascript`. */
export function createKafka({ brokers, clientId, logLevel = 'warn' }: KafkaOptions): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: { brokers: [...brokers], clientId, logLevel: LOG_LEVELS[logLevel] },
  });
}

/**
 * The producer every FlashDrop process uses (design §6.1): idempotent, `acks=all`, lz4 batches that linger
 * 5 ms, and Java's murmur2 partitioner. librdkafka's own default (`consistent_random`, a CRC32 hash) would
 * put a product on a different partition than the JVM clients and tools do (§15), and per-product ordering
 * depends on every producer agreeing.
 */
export function createProducer(kafka: KafkaJS.Kafka): KafkaJS.Producer {
  return kafka.producer({
    kafkaJS: { idempotent: true, acks: -1, compression: KafkaJS.CompressionTypes.LZ4 },
    'linger.ms': 5,
    partitioner: 'murmur2_random',
  });
}
