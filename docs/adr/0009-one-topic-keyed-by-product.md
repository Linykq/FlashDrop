# ADR 0009: One topic, `orders.v1`, keyed by `productId`

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M3
- **Design:** §6.1, §6.3, §6.5 "What keying by productId buys", §17

## Context

Three consumer groups (payment, inventory settlement, sales dashboard) need the whole order lifecycle. Each
order's events must arrive in causal order. The dashboard folds events into one aggregate row per drop, which
should have a single writer.

## Decision

- One topic, `orders.v1`, 6 partitions, 7-day retention, carrying all seven event types; a dead-letter topic
  `orders.v1.dlq`.
- Key = `productId`, with librdkafka's `murmur2_random` partitioner so a key lands where a Java producer would
  put it (the default `consistent_random` does not).
- Envelopes are a Zod discriminated union in `packages/contracts`, validated before the outbox insert and on
  consume. Only additive changes within v1; a breaking change means `orders.v2`.
- The payment group runs up to 32 orders concurrently inside a partition, grouped by `orderId` so work for one
  order stays sequential.

## Consequences

- All events of one order share a partition, so per-order order holds end to end.
- One consumer instance owns each product's events: the dashboard writes one upsert per drop per batch with no
  cross-consumer lock contention.
- Proven: every record's partition equals `murmur2(productId) % 6` (`packages/messaging/src/relay.int.test.ts`,
  `apps/worker/src/pipeline.int.test.ts`, `tools/system/events.sys.test.ts`).
- **Cost, measured: a flash sale is one hot partition.** All its payments go through one partition with 32
  charges in flight, draining 35–37 PAID/s without PSP faults and about 17/s with them; every injected PSP
  503 or timeout pauses the whole partition. Submit → PAID p95 was 40 s on the laptop profile and 14–16 s on
  the nightly profile, against a 2 s target (perf §3.3). Meeting it would need more in-partition concurrency,
  a key that spreads one drop over partitions (giving up per-product locality) or a faster PSP. None was built.

## Alternatives rejected

- **Key by `orderId`.** Better balance, but it loses the single writer per product aggregate.
- **A topic per event type.** Loses per-order ordering across types.
- **Schema registry / Avro.** Zod in a shared workspace package plus versioned topics are enough here.
