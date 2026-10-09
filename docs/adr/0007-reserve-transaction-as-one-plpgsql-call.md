# ADR 0007: The reserve transaction is one PL/pgSQL call, hot row last

- **Status:** Accepted in M3, on measurements (escalation step 1 of §5.2)
- **Date:** M3 (migration `0006_reserve_function.sql`; cancel followed in `0009_cancel_function.sql`)
- **Design:** §3 "Global lock order", §5.2 "Hot row"

## Context

Every winner updates its drop's single `drop_inventory` row. The update is the last statement, so the row
lock is held for one statement plus the commit. In M2 the api still sent `COMMIT` after `takeStock` returned,
so each winner held the row across a round trip through an event loop that the burst keeps busy. Measured on
the `ci` burst: 91–112 commits/s on the hot row, and 6–11% of the api's backend samples showed a holder
`idle in transaction`.

## Decision

- The reserve runs server-side as one statement, `SELECT … FROM fd_record_reservation(…)`, outside an explicit
  transaction. In lock order it inserts the order, claims the quota, writes the `order.reserved` outbox row and
  calls `fd_take_stock` last. Postgres commits as it returns, in the same round trip.
- A refusal raises SQLSTATE `FD001` with the reason in `DETAIL`, so the winners' path needs no subtransaction.
- A timeout counts as hot-row contention only when its PL/pgSQL context names `fd_take_stock`, so it never
  trips the Postgres breaker.
- Cancel runs the same way (`fd_cancel_order`). The payment transitions stay statement by statement in the
  consumers, which no HTTP burst saturates.
- `synchronous_commit = off` is **not** acceptable: it can lose acknowledged reservations and their events.

## Consequences

- Measured in M3: hot-row commits on the `ci` burst rose from 91–112/s to 452–457/s; winners' p95 fell from
  0.90–1.15 s to 0.25 s; no backend was left `idle in transaction`.
- `order.reserved` and `order.cancelled` envelopes are now built in SQL, so Zod never sees them before the
  insert. Integration tests pin each to the TypeScript producer's envelope
  (`packages/db/src/reserve-function.int.test.ts`, `checkout.int.test.ts`).
- The row is still one row. On the laptop profile it caps new holds at about 450–540/s, and the winners'
  reserve p95 stays at 0.73–0.92 s against a 250 ms target (perf §1, §3.2). Lock waiting, not work, is the
  cost: 46–61% of active-backend samples wait on the row.
- **Next step, not built:** shard the inventory row into N rows, at the price of a more complex backstop.

## Alternatives rejected

- **Keeping the transaction in the api.** Measured slower under burst (above).
- **Moving the Postgres stock check to checkout.** Reintroduces Redis-only holds and Redis-clock expiry
  (ADR 0002).
