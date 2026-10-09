# ADR 0004: A deterministic reservation id is the idempotency record

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M2–M3
- **Design:** §4.5, §5.2, §17 "Rejected alternatives"

## Context

Buyers double-click, browsers retry after timeouts, and an `api` process can crash between the Redis hold
and the Postgres insert. Every one of those must end in exactly one order per intent, and a retry after a
crash should heal the half-finished hold rather than leak it.

## Decision

- The `Idempotency-Key` header is required on reserve and checkout (8–64 characters, `[A-Za-z0-9_-]`). The
  storefront creates a uuidv7 key per drop (reserve) and per order (checkout) and keeps it in
  `sessionStorage`, so a reload reuses it.
- `rid = uuidv5(NS, userId:dropId:idempotencyKey)` is both the Redis `rsv` field and `orders.id`. Both layers
  share one identity; the primary key serializes concurrent copies.
- A fingerprint (`sha256` of canonical JSON of the body) is stored at both layers. Same key, different body:
  422 `IDEMPOTENCY_KEY_REUSED`.
- A replay answers 200 with `Idempotency-Replayed: true` and the **current** representation of the order.
  A replay reads the order first and opens no transaction, so a copy never holds a pool connection.
- A same-key retry after a crash finds `EXISTING` in Redis and no row in Postgres, and the insert succeeds:
  the retry heals the orphan. Without a retry, `orphan-scan` tombstones it after expiry plus 30 s; the
  primary key decides any race with a late insert.
- Checkout is one CAS on `status = 'RESERVED'`; a lost CAS compares `checkout_key` and `checkout_hash`.

## Consequences

- No separate idempotency table, no "in progress" state: Lua serializes the Redis side and the primary key
  the Postgres side.
- Proven by `tests/e2e/idempotency.spec.ts`, k6 `idempotency-storm.ts` (50 identical reserves give 1 hold,
  20 identical checkouts give 1 charge, never a 429) and the race matrix (`apps/worker/src/race-matrix.int.test.ts`).
- Cost: keys are scoped to (user, drop). A client that invents a new key per click gets a new order per click,
  up to the per-user limit, which still caps the damage.

## Alternatives rejected

- **A generic idempotency-keys table.** Every idempotent endpoint maps to one aggregate row already; a second
  table would need its own locking and expiry.
