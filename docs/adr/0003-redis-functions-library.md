# ADR 0003: Stock logic as one Redis Functions library, validate before write

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M2
- **Design:** §4.1, §4.2, §14 "Redis client + scripts"

## Context

The admission gate must check and decrement stock, enforce the per-user limit and create the idempotency
record atomically, and publish a versioned stock level in mutation order. Several scripts share helpers
(the gate, publishing). Redis does **not** roll back a script that errors after its first write, so a
half-applied script can leave stock taken without a quota, or a hold without an expiry entry.

## Decision

- One Redis Functions library, `flashdrop` (`packages/inventory/lua/flashdrop.lua`): `fd_reserve`,
  `fd_confirm`, `fd_release`, `fd_rebuild`, `fd_set_status`, `fd_rl_hit`. Shared helpers live in the library;
  it is loaded once (`FUNCTION LOAD REPLACE`) and persisted in the AOF.
- All keys of a drop share the hash tag `{d:<dropId>}`, so each call touches one slot (Cluster-ready).
- **Every Function errors before its first write or not at all.** Arguments, every field a write touches,
  key types and the whole rebuild snapshot are validated up front. Integers are parsed exactly as `HINCRBY`
  parses them, because Lua's `tonumber()` accepts `1.0`, ` 1`, `1e0` and `0x1`, which `HINCRBY` later refuses
  after the first writes.
- **Versioned library.** The source declares `-- version N`; a loader never replaces a newer version, skips an
  identical one and keeps a same-version copy with different code. Integration tests use their own Redis
  (`redis-test`, port 6380).
- Every Redis call on a request or loop path has an application deadline (2 s; 10 s for a rebuild).

## Consequences

- `fd_confirm` and `fd_release` are idempotent and mutually exclusive, so stock returns at most once per
  reservation, and a redelivered settlement answers `NOOP`.
- O(n) conservation checks never run inside a Function; they run in tests and the reconciler.
- Tested: 2,000 concurrent reserves from 300 users on 100 units give exactly 100 holds
  (`packages/inventory/src/functions.int.test.ts`); a fast-check model test compares every reply with a pure
  TypeScript model (`model.int.test.ts`); every Function runs against missing and partial keys
  (`partial-keys.int.test.ts`).
- Cost: Lua is a second language in a TypeScript codebase, and Functions are global to a Redis, which is
  why the version rule exists: a working tree edited without a bump once replaced the running stack's copy
  (`library.test.ts` keeps that regression covered).

## Alternatives rejected

- **Separate `EVAL` scripts.** Helpers can't be shared across them.
- **ioredis.** A new major at the time; node-redis 6 is the official client with Functions support. The
  `@fastify/rate-limit` Redis store needs ioredis, so a ~30-line custom store calls `fd_rl_hit` instead.
