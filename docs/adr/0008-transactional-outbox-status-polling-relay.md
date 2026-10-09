# ADR 0008: Transactional outbox with a status-polling, single-publisher relay

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M3, ordering fix in the M4 review
- **Design:** §5.4, §17

## Context

Checkout must not depend on Kafka or the PSP, yet no status change may ever be lost on its way to the
consumers (INV-5). Writing to Postgres and Kafka in one request is a dual write: either can fail after the
other succeeded.

## Decision

- Every status change writes its event into `outbox` **in the same transaction**. Checkout submit is one CAS
  plus an outbox row; the request ends at the commit with 202.
- The relay (worker `relay` role) polls `WHERE published_at IS NULL ORDER BY id LIMIT 500` every 250 ms, and
  wakes early on `LISTEN outbox`. Only low-rate paths notify (checkout submit, expiry batches): a notifying
  commit takes a database-wide lock, which would add a second serialization point next to the hot row.
- **Status polling, not an id cursor.** Identity order is not commit order; a cursor would skip a row that
  commits late.
- **One publisher, fenced per batch** by `pg_try_advisory_xact_lock` on the batch connection itself. If the
  connection dies, the batch and the lock go with it.
- **`FOR UPDATE`, not `SKIP LOCKED`.** The M4 review found that skipping a row another session happened to
  lock let the same order's later event go first (`order.expired` before `order.placed`).
- The producer connects before `BEGIN`, and `message.timeout.ms` (10 s) is below the relay's
  `transaction_timeout` (20 s), so a Kafka outage never pins the xmin horizon for long.

## Consequences

- With Kafka and the PSP stopped, checkout still answers 202 and the outbox grows; after a restart every order
  is PAID (`tools/system/checkout-decoupled.sys.test.ts`).
- A crash after send but before the mark republishes the batch: at-least-once, deduped by the consumers
  (ADR 0010). The chaos `relay-kill` run SIGKILLed the worker with a 500-row batch in flight: 9 events were
  delivered twice, none lost.
- Measured relay latency: submit → published p95 about 0.1–0.25 s (perf §3.3).
- Cost: reserve, payment and cancel events wait for the 250 ms poll.

## Alternatives rejected

- **Debezium/CDC.** Kafka Connect, `wal_level=logical` and replication-slot monitoring are too much to operate
  for one developer. The outbox table stays, so CDC could replace the relay later.
- **Four sharded relays.** Throughput is far above what a drop needs; one fenced publisher is simpler to prove.
