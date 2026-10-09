# Architecture decision records

Each record captures one decision from [`docs/system-design.md`](../system-design.md): the context that forced it,
what was chosen, and what it costs. The design's §14 decision log and §17 rejected alternatives are the
source; these records add the reasoning in a form that fits on one page. Where a record and the design
disagree, the design wins.

| # | Decision | Status |
|---|---|---|
| [0001](0001-modular-monolith.md) | A modular monolith: two images, role flags, one Postgres | Accepted |
| [0002](0002-redis-admits-postgres-decides.md) | Redis admits, Postgres decides | Accepted |
| [0003](0003-redis-functions-library.md) | Stock logic as one Redis Functions library, validate before write | Accepted |
| [0004](0004-deterministic-reservation-id.md) | A deterministic reservation id is the idempotency record | Accepted |
| [0005](0005-postgres-owns-every-deadline.md) | Postgres owns every deadline; sweepers, not key TTLs | Accepted |
| [0006](0006-rebuild-under-drop-lock-and-generation-fence.md) | Rebuild Redis from Postgres under a drop lock and a generation fence | Accepted |
| [0007](0007-reserve-transaction-as-one-plpgsql-call.md) | The reserve transaction is one PL/pgSQL call, hot row last | Accepted (M3, measured) |
| [0008](0008-transactional-outbox-status-polling-relay.md) | Transactional outbox with a status-polling, single-publisher relay | Accepted |
| [0009](0009-one-topic-keyed-by-product.md) | One topic, `orders.v1`, keyed by `productId` | Accepted |
| [0010](0010-idempotent-consumers-at-least-once.md) | At-least-once delivery with idempotent effects, no Kafka transactions | Accepted |
| [0011](0011-async-payment-close-by-reference.md) | Asynchronous payment: charge, then close by reference | Accepted |
| [0012](0012-dashboard-projection-in-postgres.md) | The sales dashboard is a disposable Postgres projection | Accepted |
| [0013](0013-websocket-gateway-in-api.md) | WebSocket gateway inside `api`: Redis pub/sub, coalesced levels | Accepted |
| [0014](0014-llm-listings-create-validate-repair-approve.md) | LLM listings: `messages.create`, two Zod schemas, a repair loop, human approval | Accepted |
| [0015](0015-drizzle-with-hand-written-guarantee-sql.md) | Drizzle for the schema, hand-written SQL for every guarantee | Accepted |
| [0016](0016-one-compose-stack-everywhere.md) | One Compose stack for development, tests and CI | Accepted |

**Format.** Context (the forces), Decision (what was chosen), Consequences (what it buys and what it costs),
and the alternatives that were rejected. "§N" refers to `docs/system-design.md`; "perf §N" refers to
[`docs/perf.md`](../perf.md).
