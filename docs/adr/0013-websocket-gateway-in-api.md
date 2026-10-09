# ADR 0013: WebSocket gateway inside `api`: Redis pub/sub, coalesced levels

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M5
- **Design:** §7, §8.2, §14 "API + gateway", "Gateway placement", §17

## Context

Thousands of viewers watch stock tick down during a burst, across two `api` instances. The Redis Functions
publish on every mutation, which can be thousands of messages per second. Next.js route handlers can't hold
WebSocket upgrades, and pub/sub is at-most-once.

## Decision

- A Fastify plugin (`@fastify/websocket` on `ws`) inside each `api` instance, enabled by `API_ROLES` containing
  `ws`. Cookie auth on upgrade plus an `Origin` allowlist; `user` topics are owner-only and `dash:*` admin-only.
- **One subscriber connection per gateway**, reference-counted per channel. Gateways hold no state that
  matters, so Caddy round-robins sockets without sticky sessions.
- **Stock is a level, not a log.** Every frame carries `(gen, seq)`; gateways and clients keep only strictly
  newer ones. The gateway keeps the latest level per topic and flushes dirty topics every 100 ms, serializing
  each once, so a socket gets at most 10 stock frames per second.
- **Snapshot + delta.** On subscribe the gateway subscribes first, then reads an atomic `HMGET` snapshot;
  after its own subscriber reconnects it re-snapshots every topic. Clients reconnect with jittered backoff and
  poll the stock endpoint after 5 s offline. SSR embeds `{avail, held, gen, seq}`.
- Backpressure: skip sends while `bufferedAmount > 256 KB`; close with 1013 after 10 s above 1 MB.

## Consequences

- Measured on 2,000 sockets across both gateways: propagation p95 132–144 ms (100 ms coalescing included),
  at most 9 frames/s on the busiest socket, gateways at 52–63% CPU (perf §1, §3.4).
- `/ws/1` and `/ws/2` in Caddy pin a socket to one instance, so Playwright proves cross-instance fan-out
  deterministically (`tests/e2e/live-stock.spec.ts`, `live-room.spec.ts`).
- Cost: Redis pub/sub cost grows with instances × channels. The stock channel already carries the drop hash
  tag, so moving to sharded `SPUBLISH` is a one-line change (not built).

## Alternatives rejected

- **Socket.IO.** Hides the pub/sub and coalescing mechanics the project exists to show.
- **uWebSockets.js.** Native-build friction. **SSE.** One-way, and the claim is WebSockets.
- **Single-use WS tickets.** The socket is same-origin, so the cookie plus an Origin check suffice.
