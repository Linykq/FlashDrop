# FlashDrop: working agreement for agents

FlashDrop is a live-shopping flash-sale platform. **`docs/system-design.md` is the source of truth**; `docs/design-flow.html` is a visual walkthrough of it. Read the sections relevant to your task before writing code, and follow them. If the design is wrong or impossible, say so in your report rather than silently diverging.

## Layout (see §14 of the design)

- `apps/web`: Next.js 16 storefront, live room, checkout, admin
- `apps/api`: Fastify REST + WebSocket gateway (roles via `API_ROLES`)
- `apps/worker`: background roles via `WORKER_ROLES` (relay, sweeper, reconciler, listing, payment, settlement, dashboard)
- `apps/payment-mock`: simulated PSP
- `packages/*`: `config`, `contracts`, `domain`, `db`, `inventory`, `messaging`, `llm`, `ui` (if present), `test-utils`
- `tests/`: `e2e/` (Playwright), `load/` (k6, TypeScript), `chaos/`
- `tools/`: operational scripts (`verify-invariants.ts`, `dlq-replay.ts`, ...)
- `infra/`: Caddy, Redis, Kafka, Dockerfiles

## Code standards

- TypeScript strict, ESM, Node 22. No `any` (use `unknown` and narrow). No non-null assertions without a comment saying why it is safe.
- Validate every boundary with Zod (`packages/contracts`): HTTP bodies, params, env, events, WS messages, LLM output.
- Small, cohesive modules with named exports. Prefer plain functions over classes unless state is real. No dead code, no commented-out code, no TODOs without an owner milestone (`// TODO(M7): ...`).
- Comments explain *why* (invariants, race reasoning, lock order), not *what*.
- Guarantee-carrying SQL (conditional UPDATEs, CTEs, `FOR UPDATE SKIP LOCKED`) is hand-written through Drizzle's `sql` template, exactly as the design specifies. Plain CRUD may use the query builder.
- Errors: typed error classes from `packages/domain`; never swallow errors; log with pino and context (`orderId`, `dropId`, `traceId`).
- Lint/format with Biome (`pnpm lint`, `pnpm format`). Code must pass `pnpm typecheck`.

## Tests

- Unit tests sit next to the code as `*.test.ts` (Vitest `unit` project). Integration tests are `*.int.test.ts` (Vitest `integration` project) and run against the Compose infra (`pnpm infra:up`). Every integration test uses unique ids (fresh drop/product per test) so tests can share one stack.
- E2E specs live in `tests/e2e` and create their own drop via `POST /api/v1/test/drops`.
- A change is done when lint, typecheck, unit tests and the relevant integration/E2E tests pass locally. Report the exact commands you ran and their results.

## Frontend quality bar

Apple-level polish, light-first with full dark mode. Follow `docs/design-system.md` (tokens, typography, spacing, motion, components) once it exists. Accessibility is part of quality: keyboard paths, focus management, contrast, reduced motion.

## Shared machine rules (several agents work in parallel)

- Only edit files inside the area your task assigns you. If you need a change elsewhere (a dependency, a shared type), report it instead of making it, unless your task says you own it.
- Do not run `git commit`, `git push`, `git reset`, `git checkout -- .`, or `git stash`. The lead commits.
- Do not run `pnpm add`/`pnpm remove` unless your task says you own dependency changes; report needed packages instead.
- The Compose infra (Postgres 5433, Redis 6379, Kafka 9092, plus the throwaway `redis-test` on 6380 for tests that must replace the Functions library) is shared. Start it with `pnpm infra:up` if it is down; never `down -v` it unless your task says so. Use unique ids instead of wiping data.
- Never commit secrets. `.env` is git-ignored; `.env.example` documents every variable.
