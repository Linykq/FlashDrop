/**
 * Native-binding smoke test (design §14, §15). pnpm 10 skips dependency build scripts that are not
 * allow-listed, and a missing librdkafka binding only fails at the first import, long after `pnpm install`
 * reported success. Load both native dependencies, exercise them once, and print what was loaded.
 */

import { RdKafka } from '@confluentinc/kafka-javascript';
import kafkaPackage from '@confluentinc/kafka-javascript/package.json' with { type: 'json' };
import sharp from 'sharp';

// The producer compresses batches with lz4 (§6.1), so the binding must have been built with it.
if (!RdKafka.features.includes('lz4')) {
  throw new Error(`librdkafka ${RdKafka.librdkafkaVersion} was built without lz4 support`);
}

const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
  .jpeg()
  .toBuffer();
const { format } = await sharp(jpeg).metadata();
if (format !== 'jpeg') {
  throw new Error(`sharp re-read its own JPEG as ${format ?? 'an unknown format'}`);
}

const rows: [name: string, detail: string][] = [
  [
    `@confluentinc/kafka-javascript ${kafkaPackage.version}`,
    `librdkafka ${RdKafka.librdkafkaVersion} (${RdKafka.features.join(', ')})`,
  ],
  [`sharp ${sharp.versions.sharp ?? 'unknown'}`, `libvips ${sharp.versions.vips}`],
];
const width = Math.max(...rows.map(([name]) => name.length));
console.log(`Native bindings load on ${process.platform}-${process.arch}, Node ${process.version}:`);
for (const [name, detail] of rows) console.log(`  ${name.padEnd(width)}  ${detail}`);
