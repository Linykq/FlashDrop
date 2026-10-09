# FlashDrop: interview notes

*For the owner, before an interview. Each resume bullet gets a 30-second answer, a 2-minute answer, the
hardest bug behind it (how it was found and fixed), the trade-offs and what changes at 100× scale, and the
questions an interviewer is likely to ask. Every number here comes from [`docs/perf.md`](perf.md); section 7
lists which ones are safe to quote and how. "§N" refers to [`system-design.md`](system-design.md).*

**The one sentence.** FlashDrop sells a limited drop to a burst of buyers without overselling, double-charging
or losing an event: **Redis admits, Postgres decides, Kafka carries the news, timers clean up**, and a script
checks nine invariants across every store after every load and chaos run.

**The machine sentence** (say it with any number): *"measured on one desktop, a Ryzen 5 5600 with 32 GB,
running the whole Docker Compose stack and the k6 load generator together."*

---

## 1. Storefront, live room, SSR, real-time stock over WebSockets via Redis pub/sub, accessible checkout

*§18 rows 1a–1f. Code: `apps/web`, `apps/api/src/ws`, `packages/inventory/lua/flashdrop.lua` (`publish`).*

### 30 seconds

A Next.js 16 storefront whose product pages are server-rendered: the raw HTML already has the title and the
current stock. Stock changes go out over WebSockets from a gateway inside the Fastify API, fanned out through
Redis pub/sub so two API instances serve the same drop. Stock is a versioned level, not a stream of events,
so I coalesce updates to at most 10 frames per second per socket. On 2,000 sockets, an update reached clients
in 132–144 ms at p95. The checkout works with the keyboard alone and is checked by axe in every state.

### 2 minutes

- **SSR.** `/p/[slug]` is a cached product shell plus a streamed `<Suspense>` hole for live stock, so the
  response contains the stock number (`ssr.spec` checks the raw HTML, not a JS-disabled render). The page also
  embeds `{avail, held, gen, seq}`, so hydration never shows an older number than the server did.
- **Publishing.** Every Redis Function that changes stock publishes `gen:seq:avail:held:sold:status:ts` inside
  the same atomic call, so messages are ordered exactly like the mutations.
- **Fan-out.** Each gateway holds one Redis subscriber connection, reference-counted per channel. Gateways hold
  nothing that matters, so Caddy round-robins sockets with no sticky sessions.
- **Coalescing.** During a burst Redis publishes thousands of messages per second. The gateway keeps only the
  latest level per topic and flushes dirty topics every 100 ms, serializing each once for all sockets. Cost is
  per topic, not per socket. Slow sockets are skipped while their buffer is over 256 KB, since the next flush
  carries the latest level anyway.
- **Recovery.** Pub/sub is at-most-once, so correctness never depends on delivery: `(gen, seq)` versions, a
  snapshot on every subscribe, a re-snapshot when the gateway's subscriber reconnects, and a 3 s polling
  fallback after 5 s offline.
- **Accessible checkout.** Native form semantics, focus moved deliberately (heading on load, error summary on
  failure, confirmation on success), a countdown that is hidden from screen readers but announces at 2:00,
  1:00, 0:30 and 0:10, a one-time +60 s extension for WCAG 2.2.1, and a native `<dialog>` to leave.
  Playwright drives the whole purchase with Tab, Space, Enter and arrows, and uses `page.clock` to
  fast-forward the countdown.

### Hardest bug: a frozen Redis hung the storefront

- **Found by:** the M2 review, which froze Redis (a paused container: the socket stays open, nothing answers)
  instead of killing it.
- **Cause.** Only the Functions had an application deadline. The plain stock read behind every product page
  had none, and node-redis stops applying a command's own timeout once the command is written to the socket, so
  a frozen Redis held calls until TCP keepalive gave up. The catalog, every loop tick and the worker's shutdown
  hung with it.
- **Fix.** Every Redis call on a request or loop path carries a deadline (2 s; 10 s for a rebuild) that
  rejects as a transient error; the catalog then falls back to Postgres stock instead of failing the page. A
  call that completes after its deadline is harmless because every Function is idempotent
  (`apps/api/src/services/stock.test.ts`, `packages/inventory/src/calls.test.ts`, `frozen.int.test.ts`).
- **A subtle accessibility point the design review caught:** an error summary given `role="alert"` and focused
  at the same moment is announced twice, once by the live region and once by the focus. The checkout's summary
  and the expiry card are regions named by their heading, with no alert role, so focus reads them once
  (§8.3, design-system §13.3).

### Trade-offs, and 100× scale

- **Chosen:** gateway inside `api` behind `API_ROLES` (one fewer deployable); latest-wins levels instead of a
  log; Redis pub/sub instead of a broker per socket.
- **Given up:** a separate realtime tier; delivery guarantees for intermediate stock values (nobody needs them).
- **At 100×:** run the gateway as its own pool (the role flag already allows it); switch to sharded pub/sub
  (`SPUBLISH`; the channel already carries the drop's hash tag, so it is a one-line change); put the SSR shell
  behind a CDN and give Next a shared cache handler; consider a second fan-out tier (gateways subscribing to
  regional relays) when instances × channels gets large.

### Likely questions

- **Why not Socket.IO?** It hides exactly the mechanics I wanted to own: pub/sub, coalescing, backpressure,
  resync. Plain `ws` behind Fastify.
- **What if a pub/sub message is lost?** Nothing breaks. The next message carries the full level; a client
  ignores anything not newer than its `(gen, seq)`; resubscribes and reconnects start from a snapshot.
- **How do you measure propagation?** Each publish carries the Redis `TIME` of the mutation; the gateway
  forwards the newest one per frame; k6 records receive time minus that. All containers share one host clock.
- **How do two instances stay consistent?** They don't need to: both subscribe to the same Redis channel and
  hold only the latest level. Caddy's `/ws/1` and `/ws/2` pin sockets so a test can prove both instances
  delivered (`live-stock.spec`, `live-room.spec` assert the instance ids differ).
- **Why does the client poll at all?** Pub/sub fails silently. After 5 s disconnected the UI says "Live updates
  paused" and polls every 3 s.
- **How do you test accessibility?** Biome a11y lint, axe with 0 serious or critical violations in every
  checkout state and with reduced motion, and a keyboard-only purchase asserted focus by focus.

---

## 2. Prevented overselling under burst traffic: atomic Redis Lua reservations, per-user limits, idempotent checkout keys, automatic expiry

*§18 rows 2a–2e. Code: `packages/inventory/lua/flashdrop.lua`, `packages/db/drizzle/0006_reserve_function.sql`,
`apps/api/src/services`, `apps/worker/src/sweeper`, `apps/worker/src/reconciler`.*

### 30 seconds

A Redis Function written in Lua atomically checks the drop window, the buyer's limit and the stock and takes
a hold, so the 10–100× losers get an O(1) answer and never touch Postgres. Each winner becomes an order row in
Postgres under CHECK constraints, so Postgres is the real arbiter even if Redis is wrong. Redis only ever gives
stock back after Postgres has committed, so it can be too low but never too high. A deterministic id from the
idempotency key makes retries collapse onto one order, and Postgres-driven timers expire unpaid holds and
return their stock.

### 2 minutes

- **Admission.** `fd_reserve` checks qty, the window, `uq[user] + q <= limit` and `avail >= q`, then takes the
  hold, records the idempotency entry, schedules the expiry candidate and publishes, all in one atomic call.
  Redis doesn't roll back a script that fails halfway, so every Function validates everything before its first
  write.
- **Decision.** One PL/pgSQL call per winner, in a fixed lock order: insert the order, claim the quota,
  write the outbox row, and update the drop's inventory row **last**, guarded by
  `total - sold - reserved >= q`, the drop window and a generation number. Commit happens in the same round
  trip, so no winner holds the hot row while waiting on Node.
- **Disagreement.** If Postgres refuses what Redis admitted, the API writes a REJECTED tombstone and its event
  in one statement, answers 409 and nudges the reconciler to rebuild that drop. Under-sell, never oversell.
- **Idempotency.** `rid = uuidv5(userId:dropId:Idempotency-Key)` is both the Redis entry and the order's
  primary key. Double click: same rid, replay 200. Same key, different body: 422. API crash between Redis and
  Postgres: the same-key retry inserts the missing row and heals the orphan; without a retry, a scan tombstones
  it after expiry plus 30 s.
- **Expiry.** A leader-elected loop moves due orders to EXPIRED by Postgres time, then the settlement consumer
  (or a safety net if the event is lost) releases the Redis hold. Redis key TTLs are never used: an expired key
  can't give its stock back.
- **Recovery.** After a Redis restart or wipe, each drop is rebuilt from Postgres under a per-drop advisory
  lock, with a generation fence so an in-flight reserve can't be counted twice.

### Hardest bug: a hot drop could not be paused or ended

- **Found by:** the M2 red team, measuring under a burst. The drop scheduler timed out every second, and an
  admin Pause answered 503 after 10 s on a hot drop.
- **Cause.** The scheduler and the admin status changes locked the `drops` row `FOR UPDATE`. Every in-flight
  reserve holds `FOR KEY SHARE` on that row through its foreign keys until commit. `FOR UPDATE` conflicts with
  it, and new `KEY SHARE` lockers don't queue behind a waiting `FOR UPDATE`, so under a steady burst the status
  change starves.
- **Fix.** A status change is not a key change, so status CASes lock with `FOR NO KEY UPDATE`, which
  `KEY SHARE` doesn't block. The scheduler also became level-triggered: it reads everything without a lock and
  takes the drop lock only for a drop with work. The rule is now in §3: never `FOR UPDATE` a `drops`, `users`
  or `products` row. Regression tests: `packages/db/src/drops.int.test.ts`,
  `apps/worker/src/sweeper/sweeper.int.test.ts`.
- **Runner-up: Lua's `tonumber` vs Redis's `HINCRBY`.** `tonumber()` accepts `1.0`, ` 1`, `1e0` and `0x1`;
  `HINCRBY` refuses them, after the script's first writes. With `seq = '1.0'`, `fd_set_status RECONCILING`
  wrote the status and then failed, so every rebuild failed at step one and the drop stayed in 503 until a
  manual fix. Integers are now parsed exactly as `HINCRBY` parses them, and a test runs every Function against
  missing and malformed keys (`packages/inventory/src/partial-keys.int.test.ts`).
- **Runner-up: the hot row held across Node's event loop.** In M2 the API sent `COMMIT` itself, so each winner
  held the inventory row through a busy event loop. Moving the transaction into one PL/pgSQL call raised the
  `ci` burst's hot-row commits from 91–112/s to 452–457/s (ADR 0007).

### Trade-offs, and 100× scale

- **Chosen:** two stores with an ordering rule and a reconciler, over the simplicity of one.
- **Measured cost:** every winner updates one inventory row. On the dev machine it caps new holds at about
  450–540/s, and winners' p95 was 0.73–0.92 s against a 250 ms target (perf §3.2). Losers are unaffected.
- **Measured gap:** after a Redis restart, the reconciler noticed the new `run_id` 4.7–5.9 s later, not the
  2 s first documented (reconnect backoff plus the 2 s tick). Postgres refused any oversell meanwhile, but the
  window where Redis may be optimistic is that long.
- **At 100×:** more API replicas first (the API event loops are the measured limit at 2,000 req/s, perf §3.1);
  shard the inventory row into N sub-rows; Redis Cluster (keys already share a hash tag per drop, but
  `FUNCTION LOAD` must reach every primary); a waiting room or token queue in front of very large drops; real
  bot and sybil defense.

### Likely questions

- **Why Redis at all, if Postgres has the CHECK?** With Postgres-only stock, every loser queues on one row
  lock. Redis turns 10–100× over-demand into microsecond read-only refusals. In the reserve-only run, 63,723
  reserves caused 4,080 Postgres commits in total.
- **What if Redis says yes and Postgres says no?** Tombstone plus event in one statement, 409, a nudge, a
  rebuild of that drop. Tested by injecting `avail + 10` and bursting (`apps/worker/src/reconciler/drift.int.test.ts`).
- **What if Redis loses its last second of writes?** Detected through its `run_id`; every tracked drop goes
  RECONCILING (503s), the generation is bumped, and the drop is rebuilt from a Postgres snapshot. The chaos
  `redis-lost-tail` scenario restores Redis from an AOF copy taken seconds earlier; all invariants held.
- **How is the per-user limit enforced across tabs and keys?** `uq[user]` in Lua is the fast gate; the
  `user_drop_quota` row with `CHECK (claimed BETWEEN 0 AND limit_qty)` is the backstop.
- **Two concurrent requests with the same key?** Lua serializes them; the second sees `EXISTING`, and in
  Postgres it waits on the primary key until the first commits, then replays. No "in progress" state.
- **Clock skew?** One host clock. Postgres `now()` decides every expiry and re-checks the window; Redis
  `TIME` is only the fast gate and picks sweep candidates.
- **Why not `synchronous_commit = off` for speed?** It can lose acknowledged reservations and their events.
- **How do you know you never oversold?** The CHECK makes it impossible to commit, and `verify:invariants`
  checked INV-1 to INV-9 after each of 18 load runs and 6 chaos scenarios: 0 oversell.

---

## 3. Decoupled checkout from fulfillment: transactional outbox, Kafka partitioned by product, idempotent consumers for payment, inventory settlement and a live sales dashboard

*§18 rows 3a–3g. Code: `packages/db/src/relay.ts`, `packages/messaging`, `apps/worker/src/consumers`,
`apps/payment-mock`.*

### 30 seconds

Checkout is one compare-and-set to PENDING_PAYMENT plus an outbox row in the same transaction, and the request
ends there with 202. A relay publishes the outbox to Kafka, keyed by product, and three idempotent consumer
groups do the rest: payment against a mock PSP, settling the Redis hold, and a live dashboard. Kafka can be
down and checkout still works. Every effect is idempotent, so at-least-once delivery is enough: a chaos run
that delivered every event twice produced no double charge and the same dashboard totals.

### 2 minutes

- **Outbox.** Each status change writes its event in the same transaction, so there is no dual write. The relay
  polls `published_at IS NULL` in id order (not an id cursor, which would skip a row that commits late), sends
  a batch, waits for broker acks, then marks it. One publisher at a time, fenced by an advisory lock taken on
  the batch's own connection.
- **Kafka.** One topic, `orders.v1`, 6 partitions, key `productId` with Java's murmur2 partitioner. All events
  of an order land on one partition, so per-order order holds, and each product's dashboard row has one writer.
- **Payment.** The consumer charges with `Idempotency-Key: charge:<orderId>` and CASes the order to PAID.
  The order row is the single linearization point: if the order expired or was cancelled first, the CAS loses
  and the consumer closes the PSP reference, which refunds the charge and rejects later ones. Unknown outcomes
  (timeouts) retry forever with the same key; they never go to the DLQ.
- **Settlement.** Re-reads Postgres, then calls `fd_confirm` or `fd_release`, which are idempotent state
  transitions in Lua, then stamps `redis_settled_at`. A Postgres-driven safety net settles anything whose
  event was lost.
- **Dashboard.** One transaction per batch: insert event ids into `processed_events`, fold only the new ones by
  event-time minute, bump a version. Publishing totals with a version makes duplicates and reordering harmless.
  `pnpm dash:rebuild` wipes it and replays to identical numbers.
- **Runner rules.** Manual offsets (only the contiguous finished prefix), start at earliest, pause and seek on
  transient errors, DLQ only for poison, and a replay tool that runs the handler directly.

### Hardest bug: the relay published an order's events out of order

- **Found by:** the M4 review of the relay, checked against the per-order ordering argument of §5.4.
- **Cause.** The batch query used `FOR UPDATE SKIP LOCKED`. If any other session happened to lock an outbox row
  (a probe, an operator's `psql`), the relay skipped it and published the same order's *later* event first:
  `order.expired` before `order.placed`. Per-order ordering only holds if the relay never passes over a row.
- **Fix.** `FOR UPDATE` without `SKIP LOCKED`. The advisory lock already admits one publisher, so skipping bought
  nothing; a locked row now delays the batch instead. The regression test locks a row from a second session and
  asserts the order of publication (`packages/db/src/relay.int.test.ts`, "waits for a row another session
  locked").
- **Runner-up: offsets that silently skipped a message.** The Kafka client stores only the highest resolved
  offset, and its automatic seek-back after a failure starts after it. With concurrent processing, a failed
  message behind finished ones would never be redelivered. The runner resolves only the contiguous finished
  prefix and seeks explicitly to the first unfinished offset (M0 spike, `packages/messaging/src/runner.ts`).
- **Runner-up: payments ran 10 at a time, not 32.** With the client's default batch of 32 messages, about a
  third of them `order.placed`, only about 10 charges were ever in flight: 9 s from submit to PAID at p50 in CI.
  The payment group now reads batches of up to 256, and a failure ends only its own order's work instead of the
  whole batch (§6.4).

### Trade-offs, and 100× scale

- **Chosen:** keying by product for per-order ordering and a single writer per aggregate.
- **Measured cost:** a flash sale is one product, so all its payments share one partition: 32 charges in flight,
  35–37 PAID/s without PSP faults, about 17/s with them, and every injected PSP 503 pauses the whole partition.
  Submit → PAID p95 was about 40 s on the laptop profile and 14–16 s on the nightly one, against a 2 s target
  (perf §3.3). That is the honest weak spot.
- **At 100×:** raise in-partition concurrency (it is safe: correctness rests on the CAS and PSP keys, not on
  processing order); key by `productId:bucket` to spread one drop over partitions and merge the dashboard per
  bucket; isolate PSP retries per order instead of pausing the partition (a retry topic or a per-order delay
  queue); Kafka with RF 3 and `min.insync.replicas=2`; replace the relay with CDC once operating Debezium is
  worth it (the outbox table stays the same).

### Likely questions

- **Why not just publish to Kafka after the commit?** A crash between them loses the event; publishing before
  the commit can announce an order that never existed. The outbox makes the event part of the transaction.
- **Exactly once?** Effectively-once effects on at-least-once delivery. Kafka transactions only cover
  Kafka → Kafka; my effects land in Postgres, Redis and the PSP.
- **What if Kafka is down?** Checkout keeps working; the relay's transaction rolls back within about 10 s so it
  doesn't block vacuum; the outbox grows and alerts; stock returns through the safety net; payments wait. The
  5-minute payment window is the outage budget (`tools/system/checkout-decoupled.sys.test.ts`).
- **What if the relay crashes after sending, before marking?** The batch goes out again and consumers dedupe.
  The chaos run SIGKILLed it with a 500-row batch in flight: 9 events twice, none lost.
- **Payment succeeds just as the order expires?** The order row lock decides. If expiry won, the payment CAS
  loses and the charge is refunded by closing the reference; net capture 0. Both orders are forced in the race
  matrix (`apps/worker/src/race-matrix.int.test.ts`).
- **The PSP times out after charging?** Retry with the same key: the PSP returns the same charge. Tested with
  timeout-after-success on every charge (`tools/system/payments.sys.test.ts`).
- **What goes to the DLQ?** Only poison: a schema failure, an unknown type, an invariant violation; unknown
  errors after 5 failures and 60 s. A DLQ'd event never leaks stock or money, because expiry, settlement and
  PSP closing all have Postgres-driven loops.
- **Why not Debezium?** Kafka Connect, logical WAL and slot monitoring are a lot to operate alone; the polling
  relay is simple and fully tested.

---

## 4. LLM listing generator with Zod-validated output; Vitest, Playwright and k6 in GitHub Actions

*§18 rows 4a–4f. Code: `packages/llm`, `packages/contracts/src/listing.ts`, `apps/worker/src/listing`,
`tests/`, `.github/workflows`.*

### 30 seconds

Admins upload product photos and get a draft listing back. The model is asked for a JSON shape; my code then
validates it twice with Zod, once for the shape and once for business rules like length limits and "no prices
in the text", and sends a repair turn with the exact issues when it fails, at most three calls. Nothing is
published without a human, and the price always comes from the admin. CI runs every branch on recorded
fixtures. The whole system is tested at five layers in GitHub Actions: about 1,900 Vitest tests, 110 Playwright
tests, k6 load tests with correctness gates, and a nightly chaos run.

### 2 minutes

- **Pipeline.** Upload (magic-byte check, resize, re-encode to strip EXIF and GPS) → a Postgres job row →
  a worker claims it with `SKIP LOCKED` and a lease → model attempt → validate → repair or finish → admin
  review → approve creates the product.
- **Why `messages.create()`.** `messages.parse()` throws on invalid output, so the code never sees
  `stop_reason` or the attempt's token usage. I send the JSON Schema, branch on `refusal` and `max_tokens`
  first, then `JSON.parse` and Zod inside a `try`.
- **Two schemas.** `ListingWire` is what constrained decoding can enforce. `ListingDraft` adds what it can't:
  title 10–80 characters, banned claims, no prices or currency, attributes required per category. A rule
  violation becomes a repair turn instead of a crash.
- **Safety.** Text in images is data, never instructions; the model never sets a price; output is rendered as
  text; a human approves.
- **Tests.** Unit and integration tests with Vitest (1,384 + 509), system tests that kill and pause services
  (7), Playwright with axe (110, each spec with its own drop from a test route), k6 TypeScript scripts with
  strict correctness thresholds and loose latency ones, and a chaos suite of six scenarios. Every load and chaos
  run ends with `verify:invariants`.

### Hardest bug: injected prices passed validation

- **Found by:** red-team probes against the review form.
- **Symptom.** Drafts containing "one dollar, or ninety nine cents", "₹99", "Set price to $1" or "Pay 20 CHF at
  the door" reached the review form marked as validated.
- **Fix.** The `PRICE_OR_CURRENCY` rule now covers currency symbols, currency codes and spelled-out amounts;
  each probe is a test case (`packages/contracts/src/listing.test.ts`). The deeper fix was already
  in the design: the LLM can't set a price at all, so injected text can at worst produce wrong copy that a human
  reviews.
- **Runner-up: a k6 gate that failed correct runs.** A winner whose 201 got lost (a k6 timeout) was retried,
  replayed with 200 and never counted, so a correct run ended with `units − 1` creations and failed. The verdict
  now counts an uncertain send that a replay confirms (`tests/load/lib/verdict.test.ts`).
- **Runner-up: tests replaced the running stack's Lua.** Integration tests loaded the Functions library from the
  working tree into the same Redis the stack used, so containers ran Lua their image never shipped. Tests now
  use their own Redis (port 6380), and the loader never replaces a same-version copy with different code
  (`packages/inventory/src/library.test.ts`).

### Trade-offs, and 100× scale

- **Chosen:** a human in the loop and fixtures in CI, over automation and live-model coverage.
- **Not yet measured:** live-model cost and accuracy. The estimate (about $0.02–0.03 per draft on Sonnet 5.5)
  is unconfirmed until `pnpm eval:listings` runs with a key.
- **At 100×:** batch API for bulk catalog imports, prompt caching once the system prompt passes the model's
  minimum, a larger labelled eval set with per-field accuracy in CI on a schedule, spend caps per admin; for the
  tests, shard Playwright and run k6 from separate load machines so the generator doesn't compete with the
  system under test.

### Likely questions

- **How do you stop hallucinated brands or "authentic" claims?** The prompt says describe only what is visible
  and list unknowns in `uncertainties`; `ListingDraft` bans those claims; the review form turns each uncertainty
  into a prompt on its field.
- **What happens on a refusal or truncation?** Refusal → FAILED with its category, logged and alerted.
  `max_tokens` → one retry at low effort, then NEEDS_REVIEW. Every attempt's usage is recorded, failed ones too.
- **How do you test LLM code without a key?** Fixtures shaped like real `Message` objects (content,
  `stop_reason`, usage), keyed by image hash, for an over-long title, a refusal, `max_tokens`, invalid JSON and
  an injection photo. CI runs exactly the branches the live provider runs.
- **How do you keep E2E tests from being flaky?** Each spec creates its own product and drop through a test
  route, so no spec shares stock; `retries: 0` so a race can't hide; pinned `/ws/1` and `/ws/2` for
  cross-instance checks; `page.clock` instead of sleeping through a 120 s hold.
- **What does k6 actually gate?** Correctness strictly: never more PAID orders than units, every `pm_ok` order
  PAID, every replay answering with its own order, no 429, stock fully back. Latency loosely in CI, because a
  4-vCPU runner shares its CPU with about 14 containers.
- **What runs nightly?** The nightly k6 profile and WebSocket fan-out, all six chaos scenarios and the
  invariants on an isolated Compose project, with a Markdown summary and uploaded reports.

---

## 5. Cross-cutting questions

- **What would you do differently?** Build the performance harness into the repo from the start (the sampling
  scripts behind `perf.md` still live outside it). Size the payment path for one-product sales earlier: the
  partition key was right for correctness, but I underestimated how much one hot partition plus PSP retries
  would cost. Make Redis restart detection event-driven (on reconnect) instead of tick-driven.
- **What is the weakest part?** Submit → PAID latency under a sale (one partition per product, and PSP retries
  pause it). Second, the single inventory row caps winners' throughput. Both are documented with numbers.
- **What isn't real?** Payments (a mock PSP with tokens), identity (a dev login), video (a committed sample
  stream), and high availability (one node each of Postgres, Redis and Kafka). With Kafka at replication
  factor 1, losing its volume would lose events already marked published; the design says so (§17).
- **How did you work?** Three independent designs, two critics, a synthesis, then verifiers (Appendix A of the
  design), then milestones that each ended in a demo and a review. Review findings are kept as regression tests
  with a comment saying what broke.
- **How big is it?** Four apps, eight packages, 11 SQL migrations, one Lua library of six Functions, about 1,900
  automated tests across five layers plus k6 and chaos.

## 6. Demo script (5 minutes)

1. `pnpm stack:up` was run before. Open `/` and `/live/studio`: SSR stock, the stream, the viewer count.
2. Sign in as Ada, buy one unit, show the hold countdown and finish the checkout with the keyboard alone.
3. Sign in as Mira in another window: `/admin/dashboard/<dropId>` updates as the order is paid.
4. `MSYS_NO_PATHCONV=1 pnpm demo:burst`: 2,000 reserves at 100 units, exactly 100 holds, invariants green.
   Keep the product page open beside it.
5. `docker kill flashdrop-consumers-1` during a burst; then `pnpm verify:invariants`.
6. `pnpm dash:rebuild --compose --wait`: the dashboard is wiped and replayed to identical totals.
7. Show `tests/chaos/results/<run>/summary.json` from a `pnpm chaos:all` run, and `docs/perf.md`.

## 7. Numbers safe to quote

Always with the machine sentence above. Each was measured twice (perf §5).

| Claim | Exact wording |
|---|---|
| Correctness under load | "0 oversell, 0 double charges, 0 lost events and 0 leaked units across 18 load runs (about 356k reserve requests, about 20k orders), machine-checked by `verify:invariants` after every run" |
| Reserve throughput | "~2,000 reserve requests/s with 10,000 buyers competing for 1,000 units, p95 23–71 ms; 1,000 units sold out in about 2 s" **(reserve-only profile; say so)** |
| Full-flow sale | "a 600 req/s flash sale with checkout, payments and cancels running (300 units, 3,000 buyers, an opening spike of 300 simultaneous buyers): reserve p95 30–35 ms" |
| Losers never touch Postgres | "sold-out answers from one Redis Function call, server p95 ≈ 2 ms; Redis at 16–26 µs per Function call" |
| Real time | "2,000 concurrent WebSockets across two gateway instances via Redis pub/sub, stock propagation p95 132–144 ms (100 ms coalescing included), ≤ 9 frames/s per socket" |
| Idempotency | "50 identical concurrent reserves → 1 hold; 20 identical checkouts → 1 order, 1 charge; never a 429" |
| Expiry | "abandoned holds return to stock within about 1 s of expiry (1,000-unit soak, 3 rounds, nothing leaked)" |
| Chaos | "six chaos scenarios (Redis killed mid-burst, Redis restored from a truncated AOF, relay and consumer SIGKILLed mid-batch, a 60 s PSP outage, every event delivered twice): all nine invariants held in each" |
| Tests | "about 1,900 Vitest tests (1,384 unit, 509 integration), 110 Playwright tests with axe, k6 and a nightly chaos run in GitHub Actions" (counts of 2026-10-09) |

**Never quote:** reserve p95 < 100 ms for the full profile (measured 654–942 ms); winners' p95 < 250 ms
(0.73–0.92 s); submit → PAID < 2 s (about 40 s laptop, 14–16 s nightly); "2,000 req/s" without "reserve-only";
any CI or nightly runner latency; the PSP-faults-off diagnostics; any live-LLM cost or accuracy figure (none was
measured).
