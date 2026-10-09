import { KafkaJS } from '@confluentinc/kafka-javascript';
import { describe, expect, it } from 'vitest';
import { kafkaLogger } from './kafka';
import { captureLogger } from './test/support';

describe('kafkaLogger', () => {
  it("writes the client's lines through pino, filtered at the level the client sets", () => {
    const log = captureLogger();
    const logger = kafkaLogger(log.logger);
    logger.setLogLevel(KafkaJS.logLevel.WARN);

    logger.error('Broker transport failure', { fac: 'FAIL', name: 'rdkafka#producer-1', timestamp: 1 });
    logger.warn('Disconnected', { fac: 'REQTMOUT', name: 'rdkafka#producer-1', timestamp: 2 });
    logger.info('Producer connected', { name: 'rdkafka#producer-1' });
    logger.debug('fetch', {});

    expect(log.lines.map(({ msg, kafka }) => ({ msg, kafka }))).toEqual([
      { msg: 'Broker transport failure', kafka: { fac: 'FAIL', name: 'rdkafka#producer-1', timestamp: 1 } },
      { msg: 'Disconnected', kafka: { fac: 'REQTMOUT', name: 'rdkafka#producer-1', timestamp: 2 } },
    ]);
    expect(logger.namespace('consumer')).toBe(logger);
  });
});
