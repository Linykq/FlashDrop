# ADR 0006: Rebuild Redis from Postgres under a drop lock and a generation fence

- **Status:** Accepted
- **Date:** 2026-10-01 (design, after the verification round); built in M2, drift checks in M9
- **Design:** §4.7, §17, Appendix A "Final verification round"

## Context

Redis can restart and lose up to a second of writes, be wiped (`FLUSHALL`, a fresh volume) or drift through a
bug. Recovery must not race in-flight reserves, two recoveries must not interleave, and an admin status change
must not be overwritten by a rebuild's older snapshot. The first design used a timing-based drain and an
`UNLINK` that removed its own guard; review rejected both.

## Decision

`syncDropFromPostgres(dropId)` is the single path for arming and recovering a drop. Under one per-drop
Postgres advisory lock, which admin actions, the scheduler and the reconciler share:

1. `fd_set_status RECONCILING`: every Function on the drop answers `RETRY` (503 with `Retry-After: 1`).
2. **Fence:** `UPDATE drop_inventory SET redis_gen = redis_gen + 1`. Reserves still carrying the old `gen`
   fail `AND redis_gen = $gen` and retry with the same key.
3. A `REPEATABLE READ` snapshot of the drop, its inventory, quotas and every order.
4. One atomic `fd_rebuild`, which validates the whole snapshot first and returns `STALE` unless its `gen` is
   newer than Redis's, so a zombie can never regress it.

The reconciler triggers it on keyspace loss (`fd:epoch` vs `system_state`, Redis `run_id`, a missing
library), on structural problems, on a Postgres refusal (`NOTIFY fd_sync`), on two consecutive optimistic
**stable samples**, and on three quiescent samples of any mismatch (a leak). The rule: lower Redis promptly on
evidence, raise it only when quiescent.

## Consequences

- A rebuild costs about 1–3 s of 503s on one drop and never a wrong answer. In the chaos run, Redis was down
  5.9 s and 12 drops were rebuilt in 183 ms once the restart was detected; every invariant held.
- **Measured gap:** after a Redis restart the reconciler noticed the new `run_id` 4.7–5.9 s after Redis
  started, not within the 2 s the design first stated (node-redis reconnect backoff plus the 2 s tick).
  No invariant broke, because Postgres refuses any oversell, but INV-7's exemption window is that long.
- The refusal count each rebuild covered lives in the leader's memory, so after a leader change the first
  refusal nudge of a drop with old refusals causes one unneeded rebuild.
- Cost: a drop answers 503 for the whole rebuild. ENDED drops inside retention are rebuilt too, after the
  open ones, so selling resumes first.

## Alternatives rejected

- **Leader-only rebuilds** (admin actions enqueue a request). A per-drop Postgres lock is simpler and also
  serializes status changes from `api`.
- **Timing-based drain before a rebuild.** No timing bound is safe under load; the generation fence is.
