# FlashDrop

FlashDrop is a live-shopping flash-sale platform. A host goes live, a limited drop opens, and thousands of
buyers race for a few hundred units. The system is built to stay correct under that burst: no oversell, no
double charge, no lost order events, no stock leaked by abandoned checkouts, and no buyer over the
purchase limit. Each guarantee is written down as an invariant and checked by machine across Postgres,
Redis, the payment ledger and Kafka.

It is a modular monolith in a pnpm and Turborepo monorepo: a Next.js storefront, a Fastify API that also
hosts the WebSocket gateway, background workers and a mock payment provider, on PostgreSQL 17, Redis 8 and
Kafka 4. One Docker Compose setup runs everything, locally and in CI.

## The core rule

**Redis admits, Postgres decides, Kafka carries the news, timers clean up.**

- **Redis admits.** An atomic Redis Function checks the drop window, the per-user limit and the stock, and
  takes a hold. Losers get an O(1) answer and never touch Postgres.
- **Postgres decides.** Every winner becomes an order row in one transaction, under `CHECK` constraints that
  make oversell impossible. Postgres owns every deadline, and Redis gives stock back only after Postgres
  has committed the outcome, so Redis can be more conservative than Postgres but never more optimistic.
- **Kafka carries the news.** Checkout ends at an outbox row. A relay publishes it to `orders.v1`, keyed by
  product, and idempotent consumers run payment, inventory settlement and the live sales dashboard.
- **Timers clean up.** Postgres-driven sweepers expire holds and return stock even if Kafka is down, and a
  reconciler rebuilds Redis from Postgres after a restart or a wipe.

![FlashDrop architecture](docs/diagrams/architecture.svg)

## Design

- [`docs/system-design.md`](docs/system-design.md) is the source of truth: data model, Redis Functions,
  checkout and the order lifecycle, Kafka, real-time, the LLM listing generator, invariants, testing and
  the milestone plan.
- [`docs/design-flow.html`](docs/design-flow.html) is a visual walkthrough of the same design. Open it in
  a browser.

## Status

Each milestone ends in a demo, and its tests join CI as they are written.

| Milestone | Scope | Status |
|---|---|---|
| M0 | Monorepo, tooling, `packages/config`, Compose infra, CI | In progress |
| M1 | Schema and migrations, seed, dev login, SSR catalog pages, Docker images, Caddy | Planned |
| M2 | Redis Functions, rebuild and fencing, reservations, idempotency, rate limits, sweeper | Planned |
| M3 | Checkout, transactional outbox and relay, consumer runner, settlement | Planned |
| M4 | Mock payment provider, payment consumer, race-matrix tests | Planned |
| M5 | WebSocket gateway on two instances, live stock, live room with HLS | Planned |
| M6 | Accessible checkout: keyboard-only purchase, announcements, axe in CI | Planned |
| M7 | Live sales dashboard | Planned |
| M8 | LLM listing generator with human review | Planned |
| M9 | Redis drift checks, chaos runs, nightly load tests | Planned |
| M10 | Measured performance report, ADRs | Planned |

## Quickstart

Prerequisites: Node.js 22.12 or later (see `.nvmrc`), pnpm 10.32 (`corepack enable` picks the pinned
version), and Docker with Compose v2.

```sh
pnpm install
pnpm infra:up       # Postgres on 127.0.0.1:5433, Redis on :6379, Kafka on :9092, then creates the topics
pnpm test           # unit tests
pnpm test:int       # integration tests against the Compose infra
```

The infra and the tests need no `.env`: every connection setting defaults to the local stack on
`127.0.0.1`. `cp .env.example .env` adds development values for the secrets the apps read, and documents
every variable.

| Command | What it does |
|---|---|
| `pnpm lint` / `pnpm format` | Check, or fix, formatting and lint rules with Biome |
| `pnpm typecheck` | Type-check every package with TypeScript |
| `pnpm check:native` | Prove the native Kafka and image bindings load |
| `pnpm infra:logs` / `pnpm infra:down` | Follow the infra logs, or stop it (data is kept in volumes) |
| `docker compose --profile tools up -d kafka-ui` | Kafka UI on http://127.0.0.1:8081 |
| `pnpm docs:diagrams` | Re-render `docs/diagrams/*.svg` from their Mermaid sources |

## Repository layout

```
apps/        web (Next.js), api (Fastify + WebSocket gateway), worker, payment-mock (from M1)
packages/    config, contracts, domain, db, inventory, messaging, llm, test-utils
infra/       Redis and Kafka configuration (Dockerfiles and Caddy join in M1)
tools/       repository scripts: native-binding check, diagram rendering
docs/        system design, diagrams
```

## License

[MIT](LICENSE)
