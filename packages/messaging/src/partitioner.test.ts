import { describe, expect, it } from 'vitest';
import { murmur2, partitionForKey } from './partitioner';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('murmur2', () => {
  // Test vectors from Kafka's own UtilsTest.testMurmur2.
  it.each([
    ['21', -973932308],
    ['foobar', -790332482],
    ['a-little-bit-long-string', -985981536],
    ['a-little-bit-longer-string', -1486304829],
    ['lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8', -58897971],
    ['abc', 479470107],
  ])('hashes %j like the Java client', (key, expected) => {
    expect(murmur2(bytes(key))).toBe(expected);
  });

  it('hashes a view into a larger buffer by its own bytes', () => {
    const buffer = bytes('xxfoobarxx');

    expect(murmur2(buffer.subarray(2, 8))).toBe(murmur2(bytes('foobar')));
  });
});

describe('partitionForKey', () => {
  // Where kafka-console-producer.sh put these keys on the 6-partition orders.v1 (§15 environment check).
  it.each([
    ['prod-A', 3],
    ['prod-B', 2],
  ])('puts %s on partition %i of 6, like the Java producer', (key, partition) => {
    expect(partitionForKey(key, 6)).toBe(partition);
  });

  it('always returns a partition in range', () => {
    for (let i = 0; i < 1000; i++) {
      const partition = partitionForKey(`product-${i}`, 6);
      expect(partition).toBeGreaterThanOrEqual(0);
      expect(partition).toBeLessThan(6);
    }
  });
});
