# ADR 0011: Asynchronous payment: charge, then close by reference

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M4
- **Design:** §5.2 "Why payment is asynchronous", §6.5, §17, §19 item 5

## Context

The PSP is slow (100–800 ms), fails (503s) and sometimes succeeds without answering (timeout after success).
A payment can succeed just as its order expires or is cancelled. The guarantee is "no double charge": for every
order, net captured equals the total if PAID, else 0 (INV-4).

## Decision

- Checkout ends at a CAS to `PENDING_PAYMENT` plus an outbox row. The payment consumer charges with
  `Idempotency-Key: charge:<orderId>`, then CASes the order to `PAID` or `PAYMENT_FAILED`.
- The **orders row lock is the single linearization point** for payment vs. expiry and payment vs. cancel.
- A loser (the CAS lost to expiry or cancel, or a redelivery after the order ended) calls
  **close-by-reference** on the PSP: refund any succeeded charge for that order and reject every later one.
  The mock serializes per reference, so close and an in-flight charge are strictly ordered.
- A `close-unpaid` loop closes, from Postgres, every order that ended after checkout without a recorded closure,
  in case its event never reached the payment group.
- `payment-mock` runs behind a real socket with a ledger in its own `psp` schema and role. The ledger is the
  evidence `verify:invariants` reads.

## Consequences

- PSP latency and outages never hold HTTP handlers or database connections; consumer concurrency caps the
  rate sent to the PSP.
- Proven by the race matrix (payment CAS vs. expiry in both orders, cancel vs. payment, duplicate
  `order.placed` in one batch), by timeout-after-success on every charge (`tools/system/payments.sys.test.ts`)
  and by the chaos `psp-outage` run (503 for 60 s, partition paused 11 times, caught up after).
- Across the 18 measured load runs: 3,294 PAID orders, 3,294 succeeded payments, net capture correct for every
  order (perf §4).
- Cost: buyers see "Processing…" and the order page follows over WebSocket. Measured submit → PAID is far
  above the 2 s target under a sale (ADR 0009).

## Alternatives rejected

- **Synchronous payment in the request.** Ties up handlers and connections during the burst.
- **Auth/capture/void.** More realistic card-hold semantics, more states, the same guarantee here. Left as a
  stretch.
