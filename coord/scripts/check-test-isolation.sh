#!/usr/bin/env bash
# COORD-290 / COORD-299 / COORD-480: run the governance suite with the hard
# test-isolation guard active.
#
# COORD-480 collapsed the execution contract into ONE authoritative entrypoint,
# coord/scripts/test-runner.js. This script is now a thin compatibility shim that
# delegates to it, so exactly one place owns:
#   - the test root (resolved from the runner's own location, not the caller cwd)
#   - recursive deterministic suite discovery (nested suites cannot be missed)
#   - serial execution (--test-concurrency=1)
#   - stripping ambient session identity from the child env (COORD_SESSION_ID
#     and friends leak into node --test and spuriously fail ownership tests)
#   - preloading coord/scripts/test-isolation-guard.js, which THROWS the instant
#     any test writes under (a) the live coord/prompts/** or coord/rendered/**
#     seal surfaces, or (b) the live-runtime class coord/.runtime/** +
#     coord/.coord-state.lock + coord/.agent-state.lock + coord/memory/** —
#     outside its sandbox, so a future test cannot silently regress the "never
#     write the live coord/ tree in tests" rule.
#
# The runtime class enforces by default (COORD_TEST_ISOLATION_RUNTIME=enforce);
# set it to "detect" to re-enumerate offenders to COORD_TEST_ISOLATION_REPORT
# without failing, or "off" to disable just the runtime class.
#
# Deterministic + serial; gate-then-mutate, never run concurrently with governed
# mutations. Any arguments are forwarded to the runner (e.g. --module core).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$SCRIPT_DIR/test-runner.js" "$@"
