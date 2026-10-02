#!/bin/sh
# Creates FlashDrop's Kafka topics (design §6.1). Runs in the one-shot kafka-init container, which uses the
# broker image's CLI tools. Idempotent, so `pnpm infra:up` runs it every time.
set -eu

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:19092}"
DAY_MS=86400000

create_topic() {
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
    --topic "$1" --partitions "$2" --replication-factor 1 --config "retention.ms=$3"
}

# The whole order lifecycle, keyed by productId.
create_topic orders.v1 6 $((7 * DAY_MS))
# Poison messages, kept for `pnpm dlq:replay` (§6.4).
create_topic orders.v1.dlq 1 $((30 * DAY_MS))

/opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BOOTSTRAP" --describe --topic 'orders\.v1.*'
