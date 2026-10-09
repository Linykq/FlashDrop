# ADR 0005: Postgres owns every deadline; sweepers, not key TTLs

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M2, tuned in M2–M3
- **Design:** §4.1 "Tracked drops", §4.6, §17

## Context

Unpaid holds must expire and return stock automatically, even when Kafka is down or an event is poisoned.
Redis key expiry is tempting but a key that expires can't return its stock anywhere, and keyspace
notifications are fire-and-forget.

## Decision

- Expiry is decided by Postgres `now()` on Postgres rows. The `expire-orders` loop locks up to 200 due rows
  `FOR UPDATE SKIP LOCKED`, moves them to `EXPIRED`, returns quota and `reserved` in lock order and writes the
  outbox rows, in one transaction. It drains: a full batch runs the next one within an 800 ms budget.
- Redis follows only after Postgres committed: through the settlement consumer, or through
  `settle-safety-net` (terminal orders with `redis_settled_at IS NULL` older than 10 s) when an event is lost,
  slow or dead-lettered.
- `orphan-scan` tombstones Redis holds that Postgres never recorded, re-scores live ones and force-settles
  holds a lost AOF tail resurrected.
- Every loop is leader-elected per tick with `pg_try_advisory_xact_lock` and reads the **tracked set** of
  drops from Postgres, never from Redis, so a Redis wipe can't hide a drop from the loops that repair it.
- A row a loop can't process goes to `sweeper_quarantine` with an alert; one bad row can't stop expiry.

## Consequences

- Measured: abandoned holds return to stock within about 1.1 s of expiry in the 1,000-unit soak, nothing
  leaked over 3 rounds (perf §4).
- With the consumers stopped, stock still returns through the safety net
  (`tools/system/safety-net.sys.test.ts`).
- Cost: polling loops add steady load, and the first version ran one batch per tick, which capped expiry at
  200/s and the safety net at 40/s, so a burst of abandoned holds came back minutes late. The drain loop fixed
  it (regression test in `apps/worker/src/sweeper/sweeper.int.test.ts`).

## Alternatives rejected

- **Redis key TTLs or keyspace notifications.** Fire-and-forget, and the stock of an expired key is lost.
- **A Redis set of active drops.** A wipe deletes it together with the data it should help repair.
