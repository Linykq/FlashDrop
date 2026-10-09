# ADR 0010: At-least-once delivery with idempotent effects, no Kafka transactions

- **Status:** Accepted
- **Date:** 2026-10-01 (design); runner built in M3, hardened in M4
- **Design:** §6.3, §6.4, §6.5, §17

## Context

Every hop can redeliver: the relay republishes after a crash, a rebalance gives two members the same
partition, a transient failure seeks back over finished messages. The effects land in Postgres, Redis and the
PSP, not in Kafka.

## Decision

- Delivery is at-least-once everywhere; each effect is made idempotent by its own mechanism:
  - payment: PSP keys `charge:<orderId>` and `close:<orderId>`, the orders CAS, the `payments` primary key;
  - settlement: re-read the Postgres status, the Lua state machine (`NOOP`), `redis_settled_at`;
  - dashboard: `processed_events` inserted in the projection transaction.
- Offsets are committed manually, only up to the highest contiguous finished offset per partition, and
  confirmed every 5 s by reading them back (a commit sent during a cooperative rebalance can be dropped).
- New groups start at the earliest offset; a consumer is healthy only while each group owns a partition.
- **Transient failures stall, never drop:** pause the partition, seek explicitly to the first unfinished
  offset, back off 100 ms → 30 s with jitter, indefinitely. Unknown PSP outcomes are retried with the same key
  and never dead-lettered.
- **Poison goes to the DLQ** (Zod failure, unknown type, `InvariantViolation`), with an alert. Unclassified
  errors are dead-lettered only after 5 failures **and** 60 s.
- `pnpm dlq:replay` runs the handler named in `x-consumer` directly and never re-produces to `orders.v1`.

## Consequences

- The chaos `dup-delivery` run delivered all 1,744 events exactly twice: no double charge, and dashboard totals
  still equal Postgres. `consumer-kill` killed the payment partition's owner mid-burst; the survivor took over
  and every invariant held.
- A DLQ'd event never leaks stock or money: expiry, the settlement safety net and the `close-unpaid` loop all
  run from Postgres.
- Cost: a stuck transient failure pins its partition; an alert fires after 5 minutes. Stalling beats
  reordering or dropping.
- Cost: correctness rests on many small mechanisms, which is why `verify:invariants` checks the result across
  all stores after every load and chaos run.

## Alternatives rejected

- **Kafka exactly-once transactions.** They cover Kafka → Kafka only; every effect here is outside Kafka.
- **kafkajs.** No release since February 2023. `@confluentinc/kafka-javascript` (librdkafka) is used instead.
