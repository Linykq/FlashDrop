# ADR 0016: One Compose stack for development, tests and CI

- **Status:** Accepted
- **Date:** 2026-10-01 (design); built in M0, isolated project added for the system and chaos tests
- **Design:** §13, §14 "Integration infra", "Images", §15

## Context

The tests that matter (Functions under concurrency, the relay, the race matrix, rebuilds, chaos) need real
Postgres, Redis and Kafka. The machine is Windows with Docker Desktop, several agents share it, and CI must run
the same broker and images as development.

## Decision

- **One `compose.yaml`** with profiles: infra (Postgres 17, Redis 8, Kafka 4 in KRaft, the one-shot
  `kafka-init`), `app` (the images built by `docker buildx bake`), `load` (k6), `tools` (kafka-ui, Prometheus,
  Grafana). Images are pinned by tag and digest; ports bind to `127.0.0.1` only.
- The same pinned `apache/kafka` JVM image runs locally and in CI, with the full single-node settings
  (`kafka-native` lacks the CLI tools `kafka-init` and the healthcheck need).
- Integration tests use unique ids per test and their own Redis (`redis-test`, 6380), so they can share one
  stack. `compose.ci.yaml` adds CI's overrides; `compose.isolated.yaml` is a second project (`flashdrop-sys`,
  other host ports) for the system and chaos tests, which stop, kill and pause services.
- `docker compose up --wait` doesn't wait for one-shot jobs, so app services depend on `kafka-init` and
  `migrate` with `service_completed_successfully`.

## Consequences

- One way to start infra everywhere; CI's `integration`, `e2e`, `load-smoke`, `system` and the nightly chaos
  run all use it.
- Every app service has a healthcheck that means "can do its job" (consumers are healthy only with a partition
  assignment), and CI fails a job in which any container restarted.
- Cost: a GitHub runner shares 4 vCPU between about 14 containers and k6, so CI and nightly latencies are smoke
  signals, never results. Only the dev-machine numbers in `docs/perf.md` are quoted.

## Alternatives rejected

- **Testcontainers 12.** Needs Node ≥ 22.22 (the machine had 22.14), and Compose already provides the infra.
- **Bitnami images, `apache/kafka-native` in CI.** Official images only, and CI runs the broker development runs.
