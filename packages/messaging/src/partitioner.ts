const SEED = 0x9747b28c;
const M = 0x5bd1e995;
const R = 24;

const encoder = new TextEncoder();

/**
 * Kafka's murmur2 hash (`org.apache.kafka.common.utils.Utils.murmur2`) as a signed 32-bit integer. It is
 * what the Java producer and librdkafka's `murmur2_random` partitioner hash record keys with.
 */
export function murmur2(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  const tail = length & ~3;
  let h = SEED ^ length;

  for (let i = 0; i < tail; i += 4) {
    let k = Math.imul(view.getUint32(i, true), M);
    k ^= k >>> R;
    h = Math.imul(h, M) ^ Math.imul(k, M);
  }

  const rest = length & 3;
  if (rest === 3) h ^= view.getUint8(tail + 2) << 16;
  if (rest >= 2) h ^= view.getUint8(tail + 1) << 8;
  if (rest >= 1) h = Math.imul(h ^ view.getUint8(tail), M);

  h ^= h >>> 13;
  h = Math.imul(h, M);
  h ^= h >>> 15;
  return h | 0;
}

/** The partition the Java producer, and our `murmur2_random` producer, choose for a non-null key. */
export function partitionForKey(key: string, partitionCount: number): number {
  return (murmur2(encoder.encode(key)) & 0x7fffffff) % partitionCount;
}
