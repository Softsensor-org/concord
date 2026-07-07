#!/usr/bin/env bash
# COORD-290 / COORD-299: run the coord (X-lane) node:test suite with the hard
# test-isolation guard active. The guard (coord/scripts/test-isolation-guard.js) is
# loaded into every test worker via NODE_OPTIONS and THROWS the instant any test
# writes under (a) the live coord/prompts/** or coord/rendered/** seal surfaces, or
# (b) the live-runtime class coord/.runtime/** + coord/.coord-state.lock +
# coord/.agent-state.lock + coord/memory/** (COORD-299) — outside its sandbox, so a
# future test cannot silently regress the "never write the live coord/ tree in
# tests" rule. The runtime class enforces by default (COORD_TEST_ISOLATION_RUNTIME=
# enforce); set it to "detect" to re-enumerate offenders to COORD_TEST_ISOLATION_REPORT
# without failing, or "off" to disable just the runtime class. Deterministic + serial;
# gate-then-mutate, never run concurrently with governed mutations.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Absolute path: NODE_OPTIONS is inherited by child node processes some tests
# spawn (e.g. gate.sh harnesses) in a DIFFERENT cwd, so a relative --require
# would fail to resolve there.
GUARD="$REPO_ROOT/coord/scripts/test-isolation-guard.js"

# COORD_SESSION_ID leaks into node --test and spuriously fails ownership tests
# (see MEMORY): strip it. --test-concurrency=1 keeps the run deterministic.
exec env -u COORD_SESSION_ID \
  NODE_OPTIONS="--require $GUARD" \
  node --test --test-concurrency=1 \
  coord/scripts/*.test.js coord/board/*.test.js
