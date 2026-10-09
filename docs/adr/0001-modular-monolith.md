# ADR 0001: A modular monolith: two images, role flags, one Postgres

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M0–M1
- **Design:** §0, §2, §14 "Architecture style", "Gateway placement"

## Context

FlashDrop needs a storefront, a request tier that absorbs a burst, a WebSocket gateway, singleton background
loops (outbox relay, expiry sweeper, reconciler), three Kafka consumer groups, an LLM job runner and a
simulated payment provider. One developer builds and operates it. Some of these must fail independently:
a slow PSP must not hold HTTP handlers, and a crashing listing job must not stop expiry.

## Decision

- One pnpm + Turborepo monorepo with package-level domain boundaries (`contracts`, `domain`, `db`,
  `inventory`, `messaging`, `llm`, `config`).
- Two images: `web` (Next.js standalone) and `node` (Fastify `api`, `worker`, `payment-mock`, the `migrate`
  job). Processes built from `node` choose their job with role flags: `API_ROLES=http,ws` and `WORKER_ROLES`.
- One Postgres, one Redis, one Kafka broker. No database per service.
- The Compose stack runs the worker image as four services so failures stay apart: `worker`
  (`relay,sweeper,reconciler`), `listing` (`listing`), `consumers` ×2 (`payment,settlement`) and
  `dashboard-consumers` ×2 (`dashboard`). The design first grouped them as two services; splitting the
  listing and dashboard roles out needed no code change, which is the point of role flags.

## Consequences

- One transaction boundary: a status change, its counters and its outbox row commit together (ADR 0008).
- "Kill a consumer mid-burst" is `docker kill flashdrop-consumers-1`, and the chaos suite does exactly that.
- Consumer groups already give independent offsets, failure isolation and horizontal scaling, so the
  isolation story holds without a service mesh.
- Cost: every process shares one Postgres, so a runaway query anywhere can hurt the reserve path. Pools are
  sized and timed out per process (§3) to limit that.
- Cost: role flags make a misconfigured service easy to miss. Each service's healthcheck covers only its own
  roles' loops and groups (§6.4, `apps/worker/src/health.ts`).

## Alternatives rejected

- **A microservice per domain, Kubernetes.** More deployables and network hops for one developer, with no
  correctness benefit at this scale.
- **A separate `realtime` service.** The gateway is a role inside `api` instead (ADR 0013); the flag lets it
  become its own pool later without code changes.
