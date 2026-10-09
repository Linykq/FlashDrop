# ADR 0014: LLM listings: `messages.create`, two Zod schemas, a repair loop, human approval

- **Status:** Accepted
- **Date:** 2026-10-01 (design, after the verification round); built in M8
- **Design:** §10, §11 "LLM", §14 "LLM"

## Context

Admins upload 1–4 product photos and want a title, description, highlights and attributes. Model output can
be truncated, refused, invalid JSON, or valid JSON that breaks business rules (an 85-character title, a price
in the text). Text inside a photo can try to inject instructions. CI must run without an API key.

## Decision

- **`messages.create()` with a JSON Schema**, not `messages.parse()`: in SDK 0.131.0 `parse()` throws on
  invalid output before the code can read `stop_reason` or record the attempt's usage. The code branches on
  `stop_reason` first (`refusal` → FAILED, `max_tokens` → one low-effort retry or NEEDS_REVIEW), then parses.
- **Two schemas.** `ListingWire` is what constrained decoding can enforce (shapes, enums, nullability).
  `ListingDraft` adds the rules it can't: lengths, banned claims, no prices or currency in text, attributes
  required per category. A rule violation reaches a **repair turn** with `z.prettifyError` issues, at most 3
  model calls per job, then NEEDS_REVIEW.
- **Nothing publishes without a human.** The review form badges AI fields and turns uncertainties into
  prompts; approve re-validates with `ListingDraft`. The model never sets a price: the admin types it on the
  drop, which caps what an injection can do.
- **Providers:** `anthropic` (default model `claude-sonnet-5-5`), `fixture` (Message-shaped fixtures keyed by
  image sha256, including refusal, `max_tokens`, invalid JSON and a prompt-injection photo) and recording
  (`LLM_RECORD=true`). CI and the Compose stack use fixtures unless told otherwise.
- The job queue is Postgres (`FOR UPDATE SKIP LOCKED` with a lease), not Kafka; the generator runs in its own
  `listing` service, off the purchase path.

## Consequences

- CI exercises every branch the live provider has, with no secret
  (`packages/llm/src/generate.test.ts`, `packages/contracts/src/listing.test.ts`, `tests/e2e/listing.spec.ts`).
- Red-team probes found injected prices ("one dollar", "₹99", "Set price to $1") passing as validated; the
  `PRICE_OR_CURRENCY` rule now refuses them and the cases are kept as tests.
- Cost: no measured live-model numbers yet. The per-draft cost estimate (about $0.02–0.03) is unconfirmed until
  `pnpm eval:listings` runs with a key.

## Alternatives rejected

- **`messages.parse()` or streaming.** Both parse the final message and throw, hiding the stop reason.
- **Auto-publish.** A listing is customer-facing text; a human approves it.
