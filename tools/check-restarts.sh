#!/bin/sh
# Fails when any container of the Compose stack was restarted by its restart policy (compose.yaml:
# `restart: unless-stopped`). The policy brings a crashed process back, so without this check a crash would
# pass unnoticed. A manual stop or kill (the system tests' failure injection) never counts: Docker does not
# restart a container stopped that way. CI runs it at the end of every job that starts the stack, from the
# repo root with the job's COMPOSE_FILE.
set -eu

ids="$(docker compose --profile app ps --all --quiet)"
if [ -z "$ids" ]; then
  echo "::error::no containers of the stack found"
  exit 1
fi
# $ids unquoted on purpose: one argument per container id.
# shellcheck disable=SC2086
restarted="$(docker inspect --format '{{.Name}} {{.RestartCount}}' $ids | awk '$2 > 0')"
if [ -n "$restarted" ]; then
  echo "::error::containers restarted after their process exited (name, restarts):"
  echo "$restarted"
  exit 1
fi
echo "No container restarted."
