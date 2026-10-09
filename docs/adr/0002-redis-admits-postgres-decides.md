# ADR 0002: Redis admits, Postgres decides

- **Status:** Accepted
- **Date:** 2026-10-01 (design, after the red-team review); built in M2
- **Design:** §0, §4.3, §4.5, §17 "Rejected alternatives", Appendix A

## Context

A drop sells a few hundred or a thousand units to 10–100× as many buyers within seconds. The platform must
never oversell, never let a buyer past the per-user limit, and survive a Redis crash that loses up to a second
of acknowledged writes (AOF `everysec`). Postgres alone is correct but makes every loser queue on one row
lock. Redis alone is fast but has no durable arbiter.

## Decision

Two layers with a strict ordering rule:

1. **Redis admits.** The `fd_reserve` Function checks the window, the per-user limit and the stock atomically
   and takes a hold. Losers get a read-only O(1) answer and never reach Postgres.
2. **Postgres decides.** Every winner becomes an `orders` row in one transaction that also bumps
   `drop_inventory.reserved` under `CHECK (reserved + sold <= total)` and the user's quota under
   `CHECK (claimed <= limit_qty)`. The stock `UPDATE` re-checks the drop window against `drops`.
3. **Ordering rule.** Redis takes stock *before* Postgres records it, and gives stock back only *after*
   Postgres has committed the outcome. So Redis may be lower than Postgres, never higher (INV-7).

If Redis is ever optimistic (a lost AOF tail, a bug), Postgres refuses: the API writes a `REJECTED`
tombstone and its event in one statement, nudges the reconciler, and the buyer gets 409. That is an
under-sell, never an oversell.

## Consequences

- Postgres sees only winners: about stock plus churn transactions per drop. In the reserve-only laptop run,
  63,723 reserves produced 4,080 Postgres commits (perf §3.1).
- Every invariant has a hard backstop that does not depend on Redis being right (§1.1, §3).
- Cost: two stores to keep in agreement. That needs the settlement consumer, a Postgres-driven safety net,
  an orphan scan and a reconciler (ADR 0005, ADR 0006).
- Cost: every winner updates one `drop_inventory` row. Measured, it caps new holds at about 450–540/s on the
  dev machine (perf §3.2); ADR 0007 covers how the hold time was cut and what comes next.

## Alternatives rejected

- **Postgres-only stock.** Correct, but every loser queues on the row lock. Kept as the backstop instead.
- **Redis-only stock.** A Redis data loss means oversell; there is no durable arbiter.
- **Reservation only in Redis, Postgres at checkout.** Needs Redis-clock expiry, and a lost AOF tail strands
  Postgres stock. Rejected in review.
- **Stock check only at settlement, after payment.** One Redis crash allows paid orders beyond stock.
  Rejected in review as critical.
- **2PC between Redis and Postgres.** Not available; ordered effects plus an arbiter plus reconciliation
  replace it.
