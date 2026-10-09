# FlashDrop: measured performance

*Measured on 2026-10-09, between 16:05 and 16:35 UTC, on the dev machine described below. The code was commit `daf4343` plus the uncommitted M9 working tree of that day (the `node` image was rebuilt from it at 16:03 UTC, so `/metrics` and `fd_pg_reserve_txn_seconds` were live). Design §1 lists the targets. This file holds the measured numbers, and only these numbers go on the resume. "§N" refers to [`docs/system-design.md`](system-design.md); "section N" refers to this file.*

**Verdict in one paragraph.** Correctness held in every run: 18 runs (16 k6 runs and 2 sequential baselines), about 356,000 reserve requests and 19,715 orders, gave **0 oversell, 0 double charge, 0 lost events and 0 leaked units**. `verify:invariants` passed INV-1 to INV-9 after every run, both for the run's own drop and for all tracked drops. The real-time path meets its targets with room to spare: on 2,000 WebSockets, stock propagation p95 was **132–144 ms** against a target of < 300 ms, and the busiest socket received **≤ 9 frames/s** against a cap of 11. In reserve-only mode, the reserve path reaches the design's **2,000 req/s** with p95 **23–71 ms** (target < 100 ms), and 1,000 units sell out in **about 2 s**. These targets were **not met**:

- **Reserve p95 in the full laptop profile.** With checkout, payment polling and cancels running alongside the reserves, the two api processes saturate. p95 rose to 654–942 ms, and k6 delivered only about 1,350–1,500 of the 2,000 req/s.
- **Winners' reserve p95.** 0.73–0.92 s against a target of < 250 ms. Every winner's transaction queues on the drop's single inventory row.
- **Submit → PAID p95.** 40 s on the laptop profile and 14–16 s on the nightly profile, against a target of < 2 s. A flash sale is one product, so all of its payments flow through one Kafka partition with 32 charges in flight, and every simulated PSP timeout or 503 pauses that partition.

The sections below give the evidence for each verdict.

---

## 1. Results against the design targets (laptop profile, §1)

Two runs per scenario, written "run 1 / run 2". *Client* means measured by k6 through Caddy. *Server* means the api's own Prometheus histograms, summed over `api-1` and `api-2`.

| Metric (§1) | Target | Measured | Verdict |
|---|---|---|---|
| Reserve burst, laptop profile: 1,000 units, 10,000 users, limit 2, 2,000 req/s for 30 s, **full mode** | sustained | **not sustained:** 40,411 / 44,991 requests in 30 s (≈ 1,350 / 1,500 req/s); k6 dropped 23,440 / 19,332 iterations because all 1,000 VUs were busy | **not met** |
| Same burst, **reserve-only mode** (no checkout, cancel or payment traffic) | sustained | 62,669 / 63,723 requests in 30 s (≈ 2,090 / 2,120 req/s); 3,077 / 2,191 iterations dropped (5 % / 4 %) | **met (≈ 95 % of iterations)** |
| Reserve p95, all requests (client) | < 100 ms | full: **654 / 942 ms**, p99 4.1 / 3.3 s · reserve-only: **71 / 23 ms**, p99 496 / 245 ms | full **not met** · reserve-only **met** |
| Reserve p95, winners only, PG transaction included (client) | < 250 ms | full: **797 / 916 ms** · reserve-only: **733 / 747 ms** | **not met** |
| Reserve p95, all requests (server) | — | full: 60 / 50 ms (p99 219 / 211) · reserve-only: 11 / 4 ms (p99 73 / 89) | — |
| Postgres reserve transaction (`fd_pg_reserve_txn_seconds`, pool checkout included) | — | uncontended (one at a time): **mean 1.5 ms**, p95 ≈ 2.4 ms · laptop burst: p50 50–82 ms, **p95 237–245 ms**, p99 405–443 ms | — |
| Sell-out time (1,000 units, from the first order until Postgres first had 0 available) | — | full: **5.7 / 6.2 s** · reserve-only: **2.2 / 1.8 s** | — |
| Submit → PAID p95 (PSP latency 100–800 ms, 2 % errors, 1 % timeout-after-success) | < 2 s | laptop full: **39.9 / 41.4 s** (p50 27.4 / 25.8 s) | **not met** |
| WebSockets across `api-1` and `api-2` | 2,000 | **2,000 / 2,000** opened, 0 errors, 0 closed early | **met** |
| Stock propagation p95 (Redis mutation time → frame received, 100 ms coalescing included) | < 300 ms | **132 / 144 ms** (p50 98 / 101 ms, p99 147 / 179 ms) | **met** |
| WS frames per socket per second | ≤ 11 | storm average **6.8 / 6.8**; busiest single second **9 / 9**; busiest 2 s window 17 / 17 (gate 23); each busy second carried ≥ 198 / 204 stock changes | **met** |
| Correctness: oversell, double charge, lost events, leaked units | 0 | **0 / 0 / 0 / 0** in all 18 runs (section 4) | **met** |

**The largest full-flow profile this machine sustains** is `nightly`: 300 units and 3,000 users, an opening spike of 300 buyers firing together, then 600 req/s for 30 s. It ran with 0 dropped iterations both times:

| `nightly` profile, full mode | Run 1 | Run 2 |
|---|---|---|
| Reserve p50 / p95 / p99, all (client) | 1.8 / **29.6** / 534 ms | 1.8 / **35.0** / 505 ms |
| Reserve p95 / p99, winners (client) | 1,204 / 1,554 ms | 831 / 1,080 ms |
| Server p95: all / sold-out refusals / winners | 4.7 / 2.2 / 869 ms | 4.7 / 2.2 / 472 ms |
| Postgres reserve transaction p50 / p95 | 188 / 864 ms | 175 / 467 ms |
| Sell-out of 300 units | 2.5 s | 1.6 s |
| Submit → PAID p50 / p95 | 8.5 / **13.7 s** | 8.6 / **15.8 s** |
| `verify:invariants` | PASS | PASS |

The winners' tail here comes from the opening spike: about 400 holds reach the one inventory row within roughly 2 s (section 3.2).

---

## 2. Machine, stack and method

### Hardware and software

| | |
|---|---|
| Machine | **Desktop PC**, not a laptop. The design calls this the "laptop" profile, but it ran on the dev machine: an ASUS board with an **AMD Ryzen 5 5600** (6 cores / 12 threads, up to 4.65 GHz) and **32 GB RAM** |
| Storage | NVMe WD_BLACK SN770 1 TB, partitioned as C: (which holds the Docker Desktop disk image, so Postgres' WAL fsyncs land here) and D: (the repo) |
| OS | Windows 11 Pro 10.0.26100 |
| Docker | Docker Desktop, Engine 29.8.1, Compose v5.5.1, WSL2 backend (kernel 6.18.40.1). The VM gets **12 CPUs and 15.6 GiB**, the default; there is no `.wslconfig` |
| Stack | The full Compose stack of `compose.yaml` (§15): `api-1`, `api-2` (Node 22.23.3, `API_ROLES=http,ws`, Postgres pool of 32 each), `worker`, `listing`, `consumers` ×2, `dashboard-consumers` ×2, `payment-mock` (`PSP_LATENCY_MS=100-800`, `PSP_ERROR_RATE=0.02`, `PSP_TIMEOUT_AFTER_SUCCESS_RATE=0.01`), `web`, `caddy`, `postgres:17.11` (`synchronous_commit=on`, `fsync=on`, data on a named volume), `redis:8.10.2` (AOF `everysec`), `apache/kafka:4.3.1` |
| Load generator | `grafana/k6:2.3.0` as the Compose `k6` service. It runs **inside the same Docker VM** and goes through Caddy like a browser does. It used 1.4–2 cores during the bursts, cores the stack could otherwise have used |
| Load settings | `ENABLE_TEST_ROUTES=true RATE_LIMIT_IP_PER_SEC=100000 RATE_LIMIT_USER_PER_SEC=1000` on both apis, as in `compose.yaml`. 0 requests answered 429 in every run |

**What else was running.** No other tests were running against this stack. Another agent's second Compose project (`flashdrop-shots`, screenshots) sat idle beside it the whole time, using about 0.3 of a core across all its containers (from `docker stats`). Background desktop apps used less than 2 % of the host CPU.

### What each number is and how it was taken

- **Client latencies** are k6 trends, so they include Caddy, the Docker network and k6's own scheduling: `reserve_duration` covers every reserve answer, and `reserve_winner_duration` covers the 201s. Submit → PAID is measured from the checkout submit until the buyer's poll sees `PAID`. The poll runs every 500 ms in the laptop and nightly profiles, so that figure carries up to 0.5 s of polling resolution. `ws_propagation` is receive time minus the `ts` of the newest Redis mutation folded into the frame (§7); k6 and Redis share the host clock.
- **Server latencies** come from `/metrics` on `api-1` and `api-2`. Caddy answers that path with 404, so it was scraped from inside each container (`docker exec flashdrop-api-1-1 node -e "fetch('http://127.0.0.1:4000/metrics')…"`) right before and right after each run. The histogram deltas were summed over both instances, and quantiles were interpolated linearly inside the buckets, as Prometheus' `histogram_quantile` does. The buckets are coarse (… 0.1, 0.25, 0.5 s …), so a server p95 of "240 ms" means "between 100 and 250 ms, near the top".
- **Sell-out time** is replayed from the drop's orders in Postgres. Each order takes its qty at `created_at`, the time of its reserve transaction. It gives the qty back at `closed_at` if it closed unpaid. `REJECTED` tombstones are skipped. The sell-out moment is the first instant at which the running total reaches `total`, measured from the first order.
- **Submit → PAID by stage** comes from the timestamps of PAID orders. The stages are: the outbox `order.placed` row's `created_at` (the submit commit), its `published_at` (the relay), and the order's `paid_at` (the payment CAS).
- **Bottleneck evidence:**
  - `docker stats` was sampled continuously, about one sample every 2 s. "Busy" means the samples in which `api-1` was above 40 % CPU, and a CPU of 100 % equals one core.
  - `pg_stat_activity` was sampled every 200 ms: active backends and their wait events.
  - `pg_stat_database` and `pg_stat_user_tables` were read before and after each run.
  - `INFO commandstats` and `INFO cpu` were read from Redis before and after each run.
- **Correctness.** After every run, `pnpm verify:invariants --drop <the run's drop>` ran first and `pnpm verify:invariants` (all tracked drops) second. Both wait for quiescence, then check INV-1 to INV-9 (§1.1) across Postgres, Redis, the PSP ledger and the three Kafka consumer groups. A last global run after all measurements covered **1,025 tracked drops** and passed. The single dead letter it reports was already in the DLQ before the first measurement; no run added one. No app container restarted during the measurements (`RestartCount` 0 for every app service).
- **Isolation.** Every k6 run creates its own fresh drop and buyers through `POST /api/v1/test/drops` and `/test/sessions`, so runs never share stock or quotas.

### Exact commands

From the repo root in Git Bash. `MSYS_NO_PATHCONV=1` keeps `/scripts/...` from being rewritten into a Windows path; `pnpm load:*` runs the same `docker compose ... run k6` line.

```bash
# The stack under test: the node image from the working tree (web was unchanged), the load settings, a pruned build cache.
docker buildx bake --file docker-bake.hcl --load node
ENABLE_TEST_ROUTES=true RATE_LIMIT_IP_PER_SEC=100000 RATE_LIMIT_USER_PER_SEC=1000 \
  docker compose --profile app up -d --wait --wait-timeout 300
docker buildx prune -af

# Each line ran twice; after each run: verify:invariants for the run's drop, then for all drops.
K6='docker compose --profile load run --rm k6 run'
MSYS_NO_PATHCONV=1 $K6 /scripts/burst.ts -e PROFILE=laptop                      # pnpm load:burst -e PROFILE=laptop
MSYS_NO_PATHCONV=1 $K6 /scripts/burst.ts -e PROFILE=laptop -e MODE=reserve-only
MSYS_NO_PATHCONV=1 $K6 /scripts/burst.ts -e PROFILE=nightly
MSYS_NO_PATHCONV=1 $K6 /scripts/ws-fanout.ts -e PROFILE=laptop                  # pnpm load:ws-fanout -e PROFILE=laptop
MSYS_NO_PATHCONV=1 $K6 /scripts/idempotency-storm.ts                            # pnpm load:idempotency
MSYS_NO_PATHCONV=1 $K6 /scripts/expiry-soak.ts                                  # pnpm load:expiry-soak
MSYS_NO_PATHCONV=1 $K6 /scripts/expiry-soak.ts -e UNITS=1000 -e ROUNDS=3
pnpm verify:invariants --timeout 180 --drop <dropId> --out <run>/inv-drop.json
pnpm verify:invariants --timeout 180 --out <run>/inv-global.json

# Diagnostic only (one run each, section 3.3): the PSP with its injected faults switched off, then restored.
PSP_ERROR_RATE=0 PSP_TIMEOUT_AFTER_SUCCESS_RATE=0 docker compose --profile app up -d --no-deps --wait payment-mock
MSYS_NO_PATHCONV=1 $K6 /scripts/burst.ts -e PROFILE=nightly
MSYS_NO_PATHCONV=1 $K6 /scripts/burst.ts -e PROFILE=laptop
docker compose --profile app up -d --no-deps --wait payment-mock               # back to the compose.yaml defaults
```

The k6 summaries land in `tests/load/results/*.json`, which is git-ignored and overwritten by the next run of the same profile. The per-run copies, the metric scrapes and the sampler outputs of this measurement are kept outside the repo, in `D:/flashdrop-scratch/m9/perf/runs/<run>/`. The uncontended baseline (section 3.2) is a Node script that takes 400 holds on a fresh 400-unit drop one request at a time from the Windows host through Caddy, then sends 400 requests that Lua refuses. It ran twice.

---

## 3. What limits throughput

### 3.1 Reserve requests: the two api event loops

At 2,000 req/s, each api process is one saturated Node event loop. Redis and Postgres both have room left.

| Burst laptop, CPU while busy (100 % = 1 core) | full run 1 | full run 2 | reserve-only run 1 | reserve-only run 2 |
|---|---|---|---|---|
| `api-1` / `api-2` | **94 / 93 %** | **99 / 98 %** | **103 / 97 %** | **104 / 103 %** |
| `caddy` | 89 % | 101 % | 99 % | 96 % |
| k6 (same VM) | 172 % | 151 % | 141 % | 140 % |
| `postgres` | 65 % | 70 % | 18 % | 13 % |
| `redis` | 13 % | 14 % | 35 % | 40 % |
| Whole VM (of 1,200 %) | 645 % | 651 % | 571 % | 538 % |

The evidence:

- **The time goes outside the handler.** In the full laptop runs, the server-side reserve p95 is 50–60 ms, but the client sees 654–942 ms. In reserve-only it is 4–11 ms on the server against 23–71 ms at the client. The difference is time spent waiting for the event loop and in Caddy before the handler runs, and the gap grows with the extra work the api does in full mode.
- **The full profile adds the load that tips it over.** Every checkout buyer polls `GET /orders/:id` every 500 ms until the payment decides. With submit → PAID at about 25 s, that comes to about 30,000–34,000 polls per run, roughly 700/s on average while payments were pending: 71,954 / 79,827 HTTP requests in full mode against 40,411 / 44,991 reserves. Each poll is a Postgres read: 47,029 index scans on `orders` and 109,246 on `products` in full run 2. Without that traffic (reserve-only), the same two processes serve about 2,100 req/s within the target.
- **Redis is far from its limit.** Each reserve costs 3 Function calls: the per-IP and per-user rate-limit hits and `fd_reserve`. These ran at **16–26 µs per call** (`cmdstat_fcall`), about 6,300 calls/s in reserve-only, using about 40 % of Redis' one thread.
- **Postgres never sees the losers.** Sold-out answers made no Postgres call. Reserve-only run 2 answered 63,723 reserves with 4,080 Postgres commits in the whole run, and `orders` saw 5,435 index scans. Server-side sold-out p95 was 2.2 ms in the nightly runs and 2.3–8.8 ms in reserve-only. In full mode, the Postgres commits (about 1,000–1,400/s) are the buyers' order polls, the winners, and the pipeline behind them.

The next step would be more api replicas, and with them a load generator outside the VM. That was not measured here: `compose.yaml` has exactly two api services, and k6 already takes 1.5–2 of the VM's cores.

### 3.2 Winners: the hot inventory row

Every reserve transaction ends with `UPDATE drop_inventory … WHERE total - sold - reserved >= qty` on the drop's single row (§5.2). It holds that row's lock until its commit has been fsynced.

- **Alone, a reserve transaction is quick.** Taking 400 holds one at a time (two runs) gave a mean of 1.5 ms per transaction and a winner round trip of p50 4.4–4.7 ms and p95 6.1–6.3 ms through Caddy. Refusals took p50 2.2–2.3 ms.
- **In a burst, the winners queue.** The transaction time rises to p50 50–82 ms and p95 about 240 ms in the laptop runs. In the nightly runs it reaches 467–864 ms at p95, because the opening spike sends 300 buyers at once.
- **The queue is lock waiting, not work.** `pg_stat_activity` shows 40–63 active backends at the sell-out moment. **46–61 % of active-backend samples** waited on `Lock:transactionid` or `Lock:tuple`, which means waiting for the row; there were 0 deadlocks.
- **The row caps the rate of new holds.** Holds commit at about **450–540/s** in reserve-only (1,000 holds in 1.8–2.2 s). In full mode the same row also takes the cancels, the expiries and the PAID CASes (each moves units between reserved, sold and available), and the api is saturated, so the rate falls to about **200–215/s** (1,213–1,223 holds before the first sell-out at 5.7–6.2 s).

This is the design's deliberate trade-off. The Postgres CHECK on one row is the hard oversell backstop, and only winners pay for it: stock plus churn, about 1,400 reserve transactions in a drop that received 45,000 requests. Spreading the row across N sub-rows would lift the cap, at the price of a more complex backstop (not built).

### 3.3 Submit → PAID: one partition, 32 charges in flight, PSP faults

Splitting submit → PAID by stage (server timestamps, PAID orders, p50 / p95) shows that the relay is not the problem:

| Run | Submit → published (relay) | Published → PAID (payment consumer) | Submit → PAID |
|---|---|---|---|
| laptop full 1 / 2 | 126 / 234 ms · 113 / 218 ms | 26.9 / 38.7 s · 25.3 / 38.9 s | 27.0 / 38.8 s · 25.4 / 39.0 s |
| nightly 1 / 2 | 71 / 244 ms · 73 / 135 ms | 7.8 / 13.3 s · 8.0 / 15.4 s | 8.0 / 13.4 s · 8.1 / 15.4 s |
| nightly, PSP faults off (diagnostic) | 39 / 82 ms | 3.0 / 4.9 s | 3.0 / 4.9 s |
| laptop, PSP faults off (diagnostic) | 112 / 184 ms | 7.6 / 12.3 s | 7.8 / 12.4 s |

- **One product means one partition.** `orders.v1` is keyed by `productId`, and every event of the run's drop went to a single partition. That partition is served by one payment consumer member with **32 charges in flight**, and the batches of a partition run one after another, so each batch waits for its slowest charge (up to 800 ms). The measured drain rate is **35–37 PAID/s with the faults off and about 17 PAID/s with them on**. Meanwhile about 900 checkouts arrive, most of them in the first seconds of the burst, so they queue.
- **Faults stall the whole partition.** Every injected PSP 503 (2 %) and every withheld success (1 %, which hits the 5 s client timeout) pauses the partition for a retry with backoff (§6.4). In nightly run 2, the consumer logged 7 transient failures and 4 partition pauses in under 20 s, which held up every order behind them. Switching the faults off cut the client-side submit → PAID p95 from 13.7–15.8 s to 5.2 s (nightly) and from 39.9–41.4 s to 14.9 s (laptop).
- **The < 2 s target is out of reach at laptop scale under this design.** About 900 checkouts arrive within the first seconds, and one partition drains them at 35–37/s even without faults, so most orders wait in that partition far longer than 2 s. Even fault-free, the drain took about 23 s. Meeting the target would need more concurrency per partition, a product key that spreads one drop across partitions (giving up per-product ordering), or a faster PSP. None of these was built. The correctness side held throughout: every `pm_ok` order became PAID and every `pm_decline` order PAYMENT_FAILED with 0 undecided, and INV-4 found exactly one succeeded charge per PAID order.

### 3.4 WebSocket fan-out: not limiting at 2,000 sockets

- **The gateways had headroom.** During the ws-fanout storm both apis ran at 52–63 % CPU on average.
- **Fan-out volume.** The sockets received 426,165 / 426,456 delta frames during the 30 s storm, about 14,000 frames/s across the two gateways.
- **Coalescing held.** Each socket saw 164–167 stock changes/s in 6.8 frames/s.
- **The storm is smaller than the burst.** `ws-fanout.ts` drives the drop with its own 300 reserves/s storm on 100 units, not the 2,000/s burst. Running both at once on this one VM would starve k6, which would then measure itself; the script's header explains this. So the 2,000-socket figures come from a busy drop, not from a drop under the full burst.

---

## 4. Correctness results (every run)

Every run's own drop and the global check passed **INV-1 to INV-9**, and Postgres reported 0 deadlocks in the 16 k6 runs.

| Run (×2 each unless noted) | What it checks | Result |
|---|---|---|
| burst laptop full | 1,000 units, about 1,300 holds and 920 checkouts per run | k6: PAID ≤ units (845 / 834), 0 wrong payment outcomes, 0 undecided, 0 expired checkouts, 0 replay mismatches, 0 unexpected answers, 0 × 429. Stock settled 26 / 31 s after the first holds expired. INV-1…9 PASS |
| burst laptop reserve-only | exactly 1,000 distinct orders on 1,000 units | 1,000 / 1,000 orders, stock back to 1,000 3.1 s after the holds expired, PASS |
| burst nightly | 300 units under an opening spike | PAID 257 / 251 ≤ 300, PASS |
| burst, PSP faults off (×1 nightly, ×1 laptop, diagnostic) | as above | PASS. The laptop run failed only its latency threshold |
| ws-fanout laptop | 2,000 sockets | 0 bad, out-of-order or unconserved frames; the final level equal to Redis on 2,000 / 2,000 sockets; stock back 100 %; PASS |
| idempotency storm | 50 identical reserves, then 20 identical checkouts | 1 × 201 + 49 × 200 replays; 1 × 202 + 19 replays; exactly 1 PAID order and 1 charge; 0 × 429; PASS |
| expiry soak, 100 units × 3 rounds | never paid | 300 / 300 held, 3 / 3 sold-out probes refused. Stock back 0.55–1.06 s after the holds expired (expire-orders ticks every second); no unit or quota leaked across rounds; PASS |
| expiry soak, 1,000 units × 3 rounds | never paid, at laptop size | 3,000 / 3,000 held, stock back ≤ 1.05 s after expiry in every round, PASS |
| sequential baseline | 400 holds one at a time | the holds expired on their own; PASS in the final global check |

Across the 18 measured drops: **19,715 orders** (3,294 PAID, 360 PAYMENT_FAILED, 6,133 CANCELLED, 9,928 EXPIRED), **3,294 succeeded payments for 3,294 PAID orders**, the outbox drained, all three consumer groups at lag 0, and every dashboard total equal to Postgres.

---

## 5. Which numbers are safe to quote

Quote these only together with the machine: *"on one desktop (Ryzen 5 5600, 32 GB) running the whole Docker Compose stack and k6"*. Each was measured twice, here and in this way:

- **Correctness under load:** "0 oversell, 0 double charges, 0 lost events and 0 leaked units across 18 load runs (about 356k reserve requests, about 20k orders), machine-checked by `verify:invariants` (INV-1 to INV-9) after every run."
- **Reserve throughput:** "~2,000 reserve requests/s with 10,000 buyers competing for 1,000 units, p95 23–71 ms; 1,000 units sold out in about 2 s." This is the **reserve-only** profile and must be called that.
- **Full-flow throughput:** "a 600 req/s flash sale with checkout, payments and cancels running (300 units, 3,000 buyers, an opening spike of 300 simultaneous buyers): reserve p95 30–35 ms."
- **Losers never touch Postgres:** "sold-out answers from one Redis Function call, server p95 ≈ 2 ms; Redis at 16–26 µs per Function call."
- **Real time:** "2,000 concurrent WebSockets across two gateway instances via Redis pub/sub, stock propagation p95 132–144 ms (100 ms coalescing included), ≤ 9 frames/s per socket."
- **Idempotency:** "50 identical concurrent reserves → 1 hold; 20 identical checkouts → 1 order, 1 charge; never a 429."
- **Expiry:** "abandoned holds return to stock within about 1 s of expiry (1,000-unit soak, 3 rounds, nothing leaked)."

**Not safe to quote:**

- **Any design target that section 1 of this file marks not met:** reserve p95 < 100 ms in the full laptop profile, winners' p95 < 250 ms, submit → PAID < 2 s.
- **"2,000 req/s" without saying "reserve-only".**
- **Any number from CI or nightly runners**, which are smoke signals only (§1).
- **The PSP-faults-off figures**, which are diagnostics, not the product's configuration.

---

## 6. Open items

- **Not measured:**
  - more api replicas (the clear next lever, section 3.1);
  - k6 on a separate machine;
  - a payment consumer with more than 32 charges in flight per partition (section 3.3).
- **The sampling harness is not in the repo.** It covers the `/metrics` scrape and diff, the `pg_stat_activity` and Redis sampler, `docker stats`, the sell-out replay and the stage split, and it lives only in scratch. Committing it as `tools/perf/` would make this file reproducible with one command.
- **The k6 results are overwritten.** `tests/load/results/` keeps only the latest JSON of each profile, so the per-run copies quoted here live outside the repo.
