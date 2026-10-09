# ADR 0012: The sales dashboard is a disposable Postgres projection

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M7
- **Design:** §9, §14 "Dashboard store"

## Context

The admin dashboard shows units sold per minute, the funnel, GMV and payment failures live during a sale.
Events can be redelivered, reordered across a rebalance, or replayed in bulk. The totals must equal Postgres
truth once the pipeline is idle (INV-5).

## Decision

- The `sales-dashboard` group folds each batch in **one Postgres transaction**: insert the event ids into
  `processed_events … ON CONFLICT DO NOTHING RETURNING event_id`, fold only the returned (new) events by
  **event-time** minute into `sales_minute` and `drop_sales_totals`, and bump `version` in the same upsert.
- After the commit it publishes `{version, totals}` on `fd:ch:dash:<dropId>`. Totals, not deltas, make a
  duplicate publish harmless; the version makes an out-of-order publish harmless.
- The projection is disposable: `pnpm dash:rebuild` stops the group, zeroes the projection, resets the
  group's offsets to earliest and restarts it. The dashboard group runs as its own Compose service
  (`dashboard-consumers`), so a rebuild never pauses a charge or a settlement.

## Consequences

- Exactly-once effects for the projection, and identical numbers after a wipe and replay
  (`apps/worker/src/consumers/dashboard/dashboard.int.test.ts`, `tools/dashboard-rebuild.int.test.ts`).
- `verify:invariants` compares every tracked drop's dashboard with its orders.
- Cost: the replay window is Kafka's 7-day retention; a rebuild refuses when retention has already cut a
  partition short, unless told to accept the loss.

## Alternatives rejected

- **Redis hashes.** The dedupe record and the aggregate couldn't commit atomically, and a Redis restart would
  lose both.
