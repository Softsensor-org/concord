#!/usr/bin/env bash
# Frontend gate runner (FE-001).
# Contract: coord/product/BOOTSTRAP_CONTRACT.md ; Lanes: default | full | ci
# Real zero-dependency runner; returns 0 on clean checkout, non-zero on failure.
#
# COORD-080 (QGATE-006): emits a COMPLETE gate artifact (JSON) at
# artifacts/gates/<lane>.latest.json — lane, commit, result, real duration, the
# ordered command list, coverage/audit summaries (or null + skip-reason), and
# artifact paths — which coord/scripts/gate-runtime.js reads + validates against
# coord/scripts/gate-artifact-schema.js. Minimal repos still emit a VALID
# (coverage/audit-skipped) complete artifact.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
LANE="${1:-}"
case "$LANE" in
  default | full | ci) ;;
  "") echo "ERROR: gate.sh requires a lane argument: default | full | ci" >&2; exit 2 ;;
  *)  echo "ERROR: unknown lane '$LANE'. Expected: default | full | ci" >&2; exit 2 ;;
esac

# COORD-080: artifact instrumentation (start time, command list, coverage/audit summaries, commit).
#
# COORD-093: timing uses a MONOTONIC, sub-second source. Whole-second wall-clock
# `date +%s` math (1) rounds sub-second runs to 0 and (2) can go NEGATIVE on a
# backward clock step (NTP), violating the COORD-080 schema (duration_ms must be
# finite, non-negative). `gate_now_ms` prefers /proc/uptime (monotonic seconds
# since boot, ms precision) and falls back to wall-clock `date +%s%N` where
# /proc/uptime is unavailable (e.g. macOS); the duration is clamped to >= 0
# before emit. NOTE: when run via the governed clean-checkout runner
# (coord/scripts/gate-runtime.js), that runner FINALIZES duration_ms
# authoritatively from its own monotonic Node measurement — this bash value is
# the source of truth only for a direct `bash scripts/gate.sh` run.
gate_now_ms() {
  if [ -r /proc/uptime ]; then
    local up
    up="$(cut -d' ' -f1 < /proc/uptime)"
    local whole="${up%.*}"
    local frac="${up#*.}"
    frac="${frac}00"
    frac="${frac:0:2}"
    printf '%s' "$(( whole * 1000 + 10#$frac * 10 ))"
    return
  fi
  local ns
  ns="$(date +%s%N)"
  printf '%s' "$(( ns / 1000000 ))"
}
GATE_START_MS=$(gate_now_ms)

# COORD-092: gate process-orphan containment. Heavy lanes (full/ci) can spawn
# runtime children (vite dev-server, chromium/playwright workers, node workers).
# Each is launched in its OWN process group (setsid) and recorded in a
# provenance-scoped pidfile registry under
# coord/.runtime/gate-procs/<gate-run-id>.json. A `trap EXIT` tears the tracked
# groups down + removes the registry entry on NORMAL completion, so a clean run
# NEVER leaks; a crash/OOM-kill leaves the entry behind for `gov doctor` to
# detect and `gov reap-gate-procs` to reap (scoped strictly by recorded
# PID + start-time — never a process-name scan). The bare stub spawns nothing
# heavy (no node_modules); the MECHANISM ships so a downstream repo inherits it.
# Use `gate_spawn_tracked "<cmd>" [args...]` to launch a heavy child under it.
GATE_REGISTRY="$REPO_DIR/../coord/scripts/gate-proc-registry.js"
GATE_RUN_ID="gate-$(basename "$REPO_DIR")-$LANE-$$-$(date +%s)"
GATE_TRACKED_PGIDS=()
GATE_TRACKED_PIDS=()
gate_spawn_tracked() {
  if command -v setsid >/dev/null 2>&1; then setsid "$@" & else "$@" & fi
  local pid=$!
  GATE_TRACKED_PIDS+=("$pid"); GATE_TRACKED_PGIDS+=("$pid")
  gate_register_procs
}
gate_register_procs() {
  [ -f "$GATE_REGISTRY" ] || return 0
  [ "${#GATE_TRACKED_PIDS[@]}" -gt 0 ] || return 0
  local pid_csv pgid
  pid_csv="$(IFS=,; echo "${GATE_TRACKED_PIDS[*]}")"
  pgid="${GATE_TRACKED_PGIDS[0]:-}"
  node "$GATE_REGISTRY" register --gate-run-id "$GATE_RUN_ID" --ticket "${COORD_TICKET:-}" \
    --repo "$(basename "$REPO_DIR")" --lane "$LANE" ${pgid:+--pgid "$pgid"} --pids "$pid_csv" >/dev/null 2>&1 || true
}
gate_proc_cleanup() {
  local pid
  for pid in "${GATE_TRACKED_PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  [ -f "$GATE_REGISTRY" ] && node "$GATE_REGISTRY" cleanup --gate-run-id "$GATE_RUN_ID" >/dev/null 2>&1 || true
}
trap gate_proc_cleanup EXIT

COMMAND_LIST=()
COVERAGE_SUMMARY_JSON="null"
COVERAGE_SKIP_REASON="not run on this lane (default)"
AUDIT_SUMMARY_JSON="null"
AUDIT_SKIP_REASON="not run on this lane (default)"
ARCH_SUMMARY_JSON="null"
ARCH_SKIP_REASON="not run on this lane (default)"
LINT_SUMMARY_JSON="null"
LINT_SKIP_REASON="not run on this lane (default)"
CONTRACT_SUMMARY_JSON="null"
CONTRACT_SKIP_REASON="not run on this lane (default)"
MUTATION_SUMMARY_JSON="null"
MUTATION_SKIP_REASON="not enabled (opt-in: set GATE_MUTATION_ENABLED=1)"
SAST_SUMMARY_JSON="null"
SAST_SKIP_REASON="not enabled (opt-in: set GATE_SAST_ENABLED=1)"
SUPPLY_CHAIN_SUMMARY_JSON="null"
SUPPLY_CHAIN_SKIP_REASON="not enabled (opt-in: set GATE_SUPPLY_CHAIN_ENABLED=1)"
A11Y_SUMMARY_JSON="null"
A11Y_SKIP_REASON="not enabled (opt-in: set GATE_A11Y_ENABLED=1)"
PERF_SUMMARY_JSON="null"
PERF_SKIP_REASON="not enabled (opt-in: set GATE_PERF_ENABLED=1)"
GATE_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

fail=0
step() { COMMAND_LIST+=("$*"); echo "[gate:$LANE] $*"; }
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/ }"; s="${s//$'\t'/ }"
  printf '%s' "$s"
}

step "checking app-shell layout"
for required in src/config/env.js src/auth/index.js src/routes/guards.js src/app/shell.js tests; do
  [ -e "$required" ] || { echo "  MISSING: $required" >&2; fail=1; }
done
step "syntax-checking sources"
while IFS= read -r f; do node --check "$f" || fail=1; done < <(find src -name '*.js')
step "running unit tests (node --test)"
node --test || fail=1
if [ "$LANE" = "full" ] || [ "$LANE" = "ci" ]; then
  step "guard smoke (anon -> /dashboard must redirect)"
  APP_ENV=development API_BASE_URL=http://localhost:8080 node -e '
    const {createShell}=require("./src/app/shell.js");
    const s=createShell(process.env,{store:{read:()=>null}});
    const r=s.navigate("/dashboard");
    if(r.status!==302){console.error("guard smoke failed",r);process.exit(1)}
    console.log("guard smoke ok");' || fail=1

  # COORD-081 (QUALITY-001): lint + format-check signal on full/ci only (off
  # `default` for speed — `default` stays fast: layout + syntax + unit tests).
  # ESLint flat config (eslint.config.js) + Prettier config (.prettierrc.json)
  # ship in this skeleton so every GENERATED repo inherits lint/format
  # enforcement. Degrades gracefully: the bare template stub has no node_modules,
  # so eslint/prettier are not installed — the step SKIPS-with-note (never fails)
  # exactly like audit/coverage. Once a derived project installs deps, the same
  # step enforces `npm run lint` + `npm run format:check`.
  step "lint + format-check (eslint, prettier --check)"
  if [ ! -d node_modules ]; then
    LINT_SKIP_REASON="no node_modules (eslint/prettier not installed in bare stub)"
    echo "  SKIP: $LINT_SKIP_REASON — lint/format not applicable"
  elif [ ! -x node_modules/.bin/eslint ] && ! command -v eslint >/dev/null 2>&1; then
    LINT_SKIP_REASON="eslint not installed"
    echo "  SKIP: $LINT_SKIP_REASON — lint signal unavailable"
  else
    LINT_RC=0
    npm run --silent lint || LINT_RC=$?
    npm run --silent format:check || LINT_RC=$?
    if [ "$LINT_RC" -eq 0 ]; then
      LINT_SUMMARY_JSON="\"lint:pass format:pass\""
      LINT_SKIP_REASON=""
      echo "  lint:pass format:pass"
    else
      LINT_SUMMARY_JSON="\"lint/format failed (rc=$LINT_RC)\""
      LINT_SKIP_REASON=""
      echo "  LINT/FORMAT FAILED (rc=$LINT_RC): see eslint/prettier output above" >&2
      fail=1
    fi
  fi

  # COORD-082 (CONTRACT-002): API-contract staleness gate on full/ci only (off
  # `default` for speed). Regenerates the client/types from the backend's
  # OpenAPI artifact — resolved CONFIG-DRIVEN through coord/project.config.js
  # (repos.<F>.contract) + repo-registry path resolution (NOT a hardcoded
  # sibling path) — and FAILS when the committed generated client is stale.
  # Policy single-sourced in coord/scripts/contract-policy.js; shelled via the
  # frontend `contract:check` script. Degrades gracefully (skip-with-note, never
  # fail) when no coord policy is vendored or no OpenAPI source artifact exists,
  # exactly like lint/audit/coverage, so a bare stub stays green.
  step "contract check (regenerate client, diff vs committed; staleness gate)"
  CONTRACT_POLICY="$REPO_DIR/../coord/scripts/contract-policy.js"
  if [ ! -f "$CONTRACT_POLICY" ]; then
    CONTRACT_SKIP_REASON="contract policy ($CONTRACT_POLICY) not found"
    echo "  SKIP: $CONTRACT_SKIP_REASON — contract signal unavailable"
  else
    CONTRACT_RC=0
    CONTRACT_SUMMARY="$(npm run --silent contract:check)" || CONTRACT_RC=$?
    echo "  $CONTRACT_SUMMARY"
    case "$CONTRACT_SUMMARY" in
      "contract: skip"*)
        # graceful skip (no OpenAPI source yet / no coord policy) — never fail.
        CONTRACT_SKIP_REASON="${CONTRACT_SUMMARY#contract: skip }"
        ;;
      *)
        CONTRACT_SUMMARY_JSON="\"$(json_escape "$CONTRACT_SUMMARY")\""
        CONTRACT_SKIP_REASON=""
        if [ "$CONTRACT_RC" -ne 0 ]; then
          echo "  CONTRACT FAILED: generated client is stale vs source contract (run npm run contract:gen)" >&2
          fail=1
        fi
        ;;
    esac
  fi

  # COORD-076 (QGATE-002): dependency/security audit signal on full/ci only
  # (off `default` for speed). Config-driven threshold via GATE_AUDIT_THRESHOLD
  # (default high); pass/warn/fail policy single-sourced in
  # coord/scripts/audit-policy.js. Degrades gracefully (skip-with-note, never
  # fail) when no npm lockfile / npm is present so zero-dependency repos stay green.
  step "dependency audit (npm audit, threshold=${GATE_AUDIT_THRESHOLD:-high})"
  AUDIT_POLICY="$REPO_DIR/../coord/scripts/audit-policy.js"
  if [ ! -e package-lock.json ] && [ ! -e npm-shrinkwrap.json ]; then
    AUDIT_SKIP_REASON="no npm lockfile (package-lock.json/npm-shrinkwrap.json)"
    echo "  SKIP: $AUDIT_SKIP_REASON — audit not applicable"
  elif ! command -v npm >/dev/null 2>&1; then
    AUDIT_SKIP_REASON="npm not available on PATH"
    echo "  SKIP: $AUDIT_SKIP_REASON — audit not applicable"
  elif [ ! -f "$AUDIT_POLICY" ]; then
    AUDIT_SKIP_REASON="audit policy ($AUDIT_POLICY) not found"
    echo "  SKIP: $AUDIT_SKIP_REASON — audit signal unavailable"
  else
    # COORD-122: never let the audit lane make a blocking network call. When
    # GATE_AUDIT_OFFLINE=1 (set by the governance test sandboxes and any
    # network-bounded CI), `npm audit` runs with --offline so it reads the local
    # lockfile/cache instead of reaching the registry — a slow/blocked registry
    # can never hang the release gate. A real CI run that wants live advisory
    # data simply leaves the flag unset.
    AUDIT_NPM_ARGS="audit --json"
    if [ "${GATE_AUDIT_OFFLINE:-0}" = "1" ]; then
      AUDIT_NPM_ARGS="$AUDIT_NPM_ARGS --offline"
    fi
    # shellcheck disable=SC2086
    AUDIT_JSON="$(npm $AUDIT_NPM_ARGS 2>/dev/null || true)"
    if [ -z "$AUDIT_JSON" ]; then
      AUDIT_SKIP_REASON="npm audit produced no output (offline registry?)"
      echo "  SKIP: $AUDIT_SKIP_REASON — audit not applicable"
    else
      AUDIT_RC=0
      AUDIT_SUMMARY="$(printf '%s' "$AUDIT_JSON" | node "$AUDIT_POLICY" classify --threshold "${GATE_AUDIT_THRESHOLD:-high}")" || AUDIT_RC=$?
      echo "  $AUDIT_SUMMARY"
      AUDIT_SUMMARY_JSON="\"$(json_escape "$AUDIT_SUMMARY")\""
      AUDIT_SKIP_REASON=""
      if [ "$AUDIT_RC" -ne 0 ]; then
        echo "  AUDIT FAILED: vulnerabilities at or above threshold ${GATE_AUDIT_THRESHOLD:-high}" >&2
        fail=1
      fi
    fi
  fi

  # COORD-077 (QGATE-003): test-coverage signal + artifact on full/ci only (off
  # `default` for speed). Min threshold config-driven via GATE_COVERAGE_MIN
  # (default 80); pass/warn/fail policy single-sourced in
  # coord/scripts/coverage-policy.js. Degrades gracefully (warn-with-note, never
  # fail) when there are no tests / no coverage tooling / empty output so
  # minimal repos stay green. Textual report stored under
  # coord/artifacts/gates/<repo>/ (canonical gate-artifact dir).
  step "test coverage (node --test, min=${GATE_COVERAGE_MIN:-80})"
  COVERAGE_POLICY="$REPO_DIR/../coord/scripts/coverage-policy.js"
  REPO_NAME="$(basename "$REPO_DIR")"
  ARTIFACT_DIR="$REPO_DIR/../coord/artifacts/gates/$REPO_NAME"
  if [ ! -f "$COVERAGE_POLICY" ]; then
    COVERAGE_SKIP_REASON="coverage policy ($COVERAGE_POLICY) not found"
    echo "  SKIP: $COVERAGE_SKIP_REASON — coverage signal unavailable"
  else
    mkdir -p "$ARTIFACT_DIR"
    COVERAGE_REPORT="$ARTIFACT_DIR/coverage-$LANE.txt"
    node --test --experimental-test-coverage >"$COVERAGE_REPORT" 2>&1 || true
    COV_RC=0
    COVERAGE_SUMMARY="$(node "$COVERAGE_POLICY" classify --min "${GATE_COVERAGE_MIN:-80}" <"$COVERAGE_REPORT")" || COV_RC=$?
    echo "  $COVERAGE_SUMMARY"
    echo "  report: $COVERAGE_REPORT"
    COVERAGE_SUMMARY_JSON="\"$(json_escape "$COVERAGE_SUMMARY")\""
    COVERAGE_SKIP_REASON=""
    if [ "$COV_RC" -ne 0 ]; then
      echo "  COVERAGE FAILED: below minimum ${GATE_COVERAGE_MIN:-80}%" >&2
      fail=1
    fi
  fi

  # COORD-078 (QGATE-004): architecture/complexity guardrails on full/ci only
  # (off `default` for speed). WARNING-FIRST: policy + thresholds single-sourced
  # in coord/scripts/arch-checks.js (every check defaults to warn/non-blocking
  # so the gate stays GREEN on pre-existing module debt). Escalate a check to
  # fail via a JSON config passed through GATE_ARCH_CONFIG. The classify CLI
  # exits non-zero ONLY on a fail classification. Degrades gracefully when the
  # policy is absent.
  step "architecture/complexity guardrails (arch-checks)"
  ARCH_POLICY="$REPO_DIR/../coord/scripts/arch-checks.js"
  if [ ! -f "$ARCH_POLICY" ]; then
    ARCH_SKIP_REASON="arch policy ($ARCH_POLICY) not found"
    echo "  SKIP: $ARCH_SKIP_REASON — arch signal unavailable"
  else
    # COORD-284: default to the checked-in arch-debt PREVENTION ratchet config
    # (monolith/size grandfather existing over-budget files, fail on a NEW file
    # grown past budget vs the baseline — GATE_ARCH_BASELINE | origin/main | main).
    # An explicit GATE_ARCH_CONFIG still wins; if neither resolves the step runs
    # warning-first (absolute). The classify CLI auto-resolves the baseline and
    # falls back to a non-failing absolute pass when no baseline ref is reachable.
    ARCH_CONFIG="${GATE_ARCH_CONFIG:-}"
    if [ -z "$ARCH_CONFIG" ] && [ -f "$REPO_DIR/../coord/config/arch-gate.ratchet.json" ]; then
      ARCH_CONFIG="$REPO_DIR/../coord/config/arch-gate.ratchet.json"
    fi
    ARCH_CONFIG_ARG=()
    if [ -n "$ARCH_CONFIG" ] && [ -f "$ARCH_CONFIG" ]; then
      ARCH_CONFIG_ARG=(--config "$ARCH_CONFIG")
    fi
    ARCH_RC=0
    ARCH_SUMMARY="$(node "$ARCH_POLICY" classify --root "$REPO_DIR" "${ARCH_CONFIG_ARG[@]}")" || ARCH_RC=$?
    echo "  $ARCH_SUMMARY"
    ARCH_SUMMARY_JSON="\"$(json_escape "$ARCH_SUMMARY")\""
    ARCH_SKIP_REASON=""
    if [ "$ARCH_RC" -ne 0 ]; then
      echo "  ARCH FAILED: a check escalated to fail fired (see summary)" >&2
      fail=1
    fi
  fi

  # COORD-131 (Quality dimension #1: Correctness — mutation + property-based
  # testing). OPT-IN, heavy, external-tool ADAPTER. Double-gated: runs only when
  # GATE_MUTATION_ENABLED=1 AND the adapter detects a Stryker config + binary.
  # Absent config/binary => the adapter SKIPS GRACEFULLY (never fails the gate).
  # Policy + verdict + COORD-129 bounded process-group-kill live in
  # coord/scripts/mutation-policy.js. Mode=GATE_MUTATION_MODE (default threshold);
  # min=GATE_MUTATION_MIN (default 60).
  if [ "${GATE_MUTATION_ENABLED:-0}" = "1" ]; then
    step "correctness (mutation testing — stryker, opt-in, mode=${GATE_MUTATION_MODE:-threshold})"
    MUTATION_POLICY="$REPO_DIR/../coord/scripts/mutation-policy.js"
    if [ ! -f "$MUTATION_POLICY" ]; then
      MUTATION_SKIP_REASON="mutation policy ($MUTATION_POLICY) not found"
      echo "  SKIP: $MUTATION_SKIP_REASON — mutation signal unavailable"
    else
      MUT_RC=0
      MUTATION_SUMMARY="$(node "$MUTATION_POLICY" classify \
        --root "$REPO_DIR" \
        --mode "${GATE_MUTATION_MODE:-threshold}" \
        --min "${GATE_MUTATION_MIN:-60}" \
        ${GATE_MUTATION_TIMEOUT_MS:+--timeout-ms "$GATE_MUTATION_TIMEOUT_MS"})" || MUT_RC=$?
      echo "  $MUTATION_SUMMARY"
      MUTATION_SUMMARY_JSON="\"$(json_escape "$MUTATION_SUMMARY")\""
      MUTATION_SKIP_REASON=""
      if [ "$MUT_RC" -ne 0 ]; then
        echo "  MUTATION FAILED: mutation score below min / new survived mutant(s)" >&2
        fail=1
      fi
    fi
  fi

  # COORD-132 (Quality dimension #2: SAST — security-focused static analysis).
  # OPT-IN, heavy, external-tool ADAPTER (Semgrep). Double-gated: runs only when
  # GATE_SAST_ENABLED=1 AND the adapter detects a resolvable semgrep binary.
  # Absent binary => the adapter SKIPS GRACEFULLY (never fails the gate). The SAST
  # parse + RATCHET-DEFAULT verdict + COORD-129 bounded process-group-kill live in
  # coord/scripts/sast-policy.js. Mode=GATE_SAST_MODE (ratchet|threshold, default
  # ratchet so legacy security debt is frictionless); config=GATE_SAST_CONFIG
  # (default Semgrep "auto").
  if [ "${GATE_SAST_ENABLED:-0}" = "1" ]; then
    step "SAST (security static analysis — semgrep, opt-in, mode=${GATE_SAST_MODE:-ratchet})"
    SAST_POLICY="$REPO_DIR/../coord/scripts/sast-policy.js"
    if [ ! -f "$SAST_POLICY" ]; then
      SAST_SKIP_REASON="sast policy ($SAST_POLICY) not found"
      echo "  SKIP: $SAST_SKIP_REASON — SAST signal unavailable"
    else
      SAST_RC=0
      SAST_SUMMARY="$(node "$SAST_POLICY" classify \
        --root "$REPO_DIR" \
        --mode "${GATE_SAST_MODE:-ratchet}" \
        ${GATE_SAST_CONFIG:+--config "$GATE_SAST_CONFIG"} \
        ${GATE_SAST_TIMEOUT_MS:+--timeout-ms "$GATE_SAST_TIMEOUT_MS"})" || SAST_RC=$?
      echo "  $SAST_SUMMARY"
      SAST_SUMMARY_JSON="\"$(json_escape "$SAST_SUMMARY")\""
      SAST_SKIP_REASON=""
      if [ "$SAST_RC" -ne 0 ]; then
        echo "  SAST FAILED: new security finding(s) vs base / at-or-above severity floor" >&2
        fail=1
      fi
    fi
  fi

  # COORD-133 (Quality dimension #3: Supply chain — CycloneDX SBOM + transitive
  # CVE scan). OPT-IN, heavy, external-tool ADAPTER (Trivy/Grype). The engine has
  # ZERO runtime deps and adopters MAY NOT have a CVE scanner installed, so this
  # step is DOUBLE-gated: it only runs when GATE_SUPPLY_CHAIN_ENABLED=1 AND the
  # adapter detects a resolvable trivy/grype binary. Absent scanner => the CVE
  # verdict SKIPS GRACEFULLY (never fails the gate); the dependency-free CycloneDX
  # SBOM emitter still works since it needs no tool. The SBOM emission + CVE parse +
  # THRESHOLD/RATCHET-default verdict + COORD-129 bounded process-group-kill all
  # live in coord/scripts/supply-chain-policy.js (single-sourced, not re-typed in
  # bash). Mode is GATE_SUPPLY_CHAIN_MODE (ratchet|threshold, default ratchet so
  # legacy CVE debt is frictionless); threshold floor is GATE_SUPPLY_CHAIN_THRESHOLD
  # (default high ⇒ HIGH+CRITICAL fail). The generated SBOM is NEVER committed.
  if [ "${GATE_SUPPLY_CHAIN_ENABLED:-0}" = "1" ]; then
    step "supply-chain (SBOM + CVE scan — trivy/grype, opt-in, mode=${GATE_SUPPLY_CHAIN_MODE:-ratchet})"
    SUPPLY_CHAIN_POLICY="$REPO_DIR/../coord/scripts/supply-chain-policy.js"
    if [ ! -f "$SUPPLY_CHAIN_POLICY" ]; then
      SUPPLY_CHAIN_SKIP_REASON="supply-chain policy ($SUPPLY_CHAIN_POLICY) not found"
      echo "  SKIP: $SUPPLY_CHAIN_SKIP_REASON — supply-chain signal unavailable"
    else
      SUPPLY_CHAIN_RC=0
      SUPPLY_CHAIN_SUMMARY="$(node "$SUPPLY_CHAIN_POLICY" classify \
        --root "$REPO_DIR" \
        --mode "${GATE_SUPPLY_CHAIN_MODE:-ratchet}" \
        ${GATE_SUPPLY_CHAIN_THRESHOLD:+--threshold "$GATE_SUPPLY_CHAIN_THRESHOLD"} \
        ${GATE_SUPPLY_CHAIN_TIMEOUT_MS:+--timeout-ms "$GATE_SUPPLY_CHAIN_TIMEOUT_MS"})" || SUPPLY_CHAIN_RC=$?
      echo "  $SUPPLY_CHAIN_SUMMARY"
      SUPPLY_CHAIN_SUMMARY_JSON="\"$(json_escape "$SUPPLY_CHAIN_SUMMARY")\""
      SUPPLY_CHAIN_SKIP_REASON=""
      if [ "$SUPPLY_CHAIN_RC" -ne 0 ]; then
        echo "  SUPPLY-CHAIN FAILED: new CVE advisory(ies) vs base / at-or-above severity floor" >&2
        fail=1
      fi
    fi
  fi

  # COORD-134 (Quality dimension #4: Accessibility — a11y scan + visual
  # regression). FRONTEND-only, OPT-IN, heavy, external-tool ADAPTER (pa11y/axe-
  # core + a snapshot-diff report). The engine has ZERO runtime deps and adopters
  # MAY NOT have an a11y runner installed, so this step is DOUBLE-gated: it only
  # runs when GATE_A11Y_ENABLED=1 AND the adapter detects a resolvable pa11y/axe
  # binary (or, for visual regression alone, a supplied snapshot-diff report).
  # Absent runner => the adapter SKIPS GRACEFULLY (never fails the gate); a
  # frontend with no a11y tooling configured passes unchanged. The a11y/axe parse
  # + visual-regression ingest + RATCHET-DEFAULT verdict (the ticket says ratchet;
  # fail only on NEW violations vs base) + COORD-129 bounded process-group-kill all
  # live in coord/scripts/a11y-policy.js (single-sourced, not re-typed in bash).
  # Mode is GATE_A11Y_MODE (ratchet|threshold, default ratchet so legacy a11y debt
  # is frictionless); target is GATE_A11Y_TARGET (url/dir); the visual-regression
  # snapshot-diff report is GATE_A11Y_VISUAL_REPORT (tool-gated; absent ⇒ the a11y
  # scan stands alone — NO pixel-diff library is bundled). Stable key is
  # rule-id:selector-or-route.
  if [ "${GATE_A11Y_ENABLED:-0}" = "1" ]; then
    step "accessibility (a11y scan + visual regression — pa11y/axe, opt-in, mode=${GATE_A11Y_MODE:-ratchet})"
    A11Y_POLICY="$REPO_DIR/../coord/scripts/a11y-policy.js"
    if [ ! -f "$A11Y_POLICY" ]; then
      A11Y_SKIP_REASON="a11y policy ($A11Y_POLICY) not found"
      echo "  SKIP: $A11Y_SKIP_REASON — accessibility signal unavailable"
    else
      A11Y_RC=0
      A11Y_SUMMARY="$(node "$A11Y_POLICY" classify \
        --root "$REPO_DIR" \
        --mode "${GATE_A11Y_MODE:-ratchet}" \
        ${GATE_A11Y_TARGET:+--target "$GATE_A11Y_TARGET"} \
        ${GATE_A11Y_THRESHOLD:+--threshold "$GATE_A11Y_THRESHOLD"} \
        ${GATE_A11Y_VISUAL_REPORT:+--visual-report "$GATE_A11Y_VISUAL_REPORT"} \
        ${GATE_A11Y_TIMEOUT_MS:+--timeout-ms "$GATE_A11Y_TIMEOUT_MS"})" || A11Y_RC=$?
      echo "  $A11Y_SUMMARY"
      A11Y_SUMMARY_JSON="\"$(json_escape "$A11Y_SUMMARY")\""
      A11Y_SKIP_REASON=""
      if [ "$A11Y_RC" -ne 0 ]; then
        echo "  A11Y FAILED: new accessibility / visual-regression violation(s) vs base / at-or-above severity floor" >&2
        fail=1
      fi
    fi
  fi

  # COORD-135 (Quality dimension #5: Performance budgets — size-limit + Lighthouse
  # CI + k6). OPT-IN, heavy, external-tool ADAPTER. The engine has ZERO runtime
  # deps and adopters MAY NOT have size-limit/lhci/k6 installed, so this step is
  # DOUBLE-gated: it only runs when GATE_PERF_ENABLED=1 AND the adapter detects a
  # resolvable size-limit/lhci/k6 binary. Absent tool => the adapter SKIPS
  # GRACEFULLY (never fails the gate); a frontend with no perf tooling configured
  # passes unchanged. The size-limit/Lighthouse/k6 parse + THRESHOLD-default verdict
  # (budget max; ratchet for regression-vs-base is opt-in) + COORD-129 bounded
  # process-group-kill all live in coord/scripts/perf-budget-policy.js (single-
  # sourced, not re-typed in bash). Mode is GATE_PERF_MODE (threshold|ratchet,
  # default threshold — budgets are naturally an absolute bar); GATE_PERF_TOOL
  # forces a sub-tool; GATE_PERF_TARGET is a url/script; GATE_PERF_BUDGETS is a flat
  # budget-name:target -> max JSON map. Stable key is budget-name:target.
  if [ "${GATE_PERF_ENABLED:-0}" = "1" ]; then
    step "performance budgets (size-limit/Lighthouse/k6, opt-in, mode=${GATE_PERF_MODE:-threshold})"
    PERF_POLICY="$REPO_DIR/../coord/scripts/perf-budget-policy.js"
    if [ ! -f "$PERF_POLICY" ]; then
      PERF_SKIP_REASON="perf policy ($PERF_POLICY) not found"
      echo "  SKIP: $PERF_SKIP_REASON — performance-budget signal unavailable"
    else
      PERF_RC=0
      PERF_SUMMARY="$(node "$PERF_POLICY" classify \
        --root "$REPO_DIR" \
        --mode "${GATE_PERF_MODE:-threshold}" \
        ${GATE_PERF_TOOL:+--tool "$GATE_PERF_TOOL"} \
        ${GATE_PERF_TARGET:+--target "$GATE_PERF_TARGET"} \
        ${GATE_PERF_BUDGETS:+--budgets "$GATE_PERF_BUDGETS"} \
        ${GATE_PERF_TIMEOUT_MS:+--timeout-ms "$GATE_PERF_TIMEOUT_MS"})" || PERF_RC=$?
      echo "  $PERF_SUMMARY"
      PERF_SUMMARY_JSON="\"$(json_escape "$PERF_SUMMARY")\""
      PERF_SKIP_REASON=""
      if [ "$PERF_RC" -ne 0 ]; then
        echo "  PERF FAILED: a budget exceeded its max (threshold) / newly over-budget vs base (ratchet)" >&2
        fail=1
      fi
    fi
  fi
fi

# COORD-080: emit the complete gate artifact (JSON) the clean-checkout runner reads + validates.
GATE_END_MS=$(gate_now_ms)
GATE_DURATION_MS=$(( GATE_END_MS - GATE_START_MS ))
# COORD-093: clamp to >= 0 so a backward clock step (fallback path) can never
# emit a negative duration that would fail the COORD-080 schema.
if [ "$GATE_DURATION_MS" -lt 0 ]; then GATE_DURATION_MS=0; fi
if [ "$fail" -ne 0 ]; then RESULT="fail"; else RESULT="pass"; fi
GATE_ARTIFACT_DIR="$REPO_DIR/artifacts/gates"
mkdir -p "$GATE_ARTIFACT_DIR"
GATE_ARTIFACT_PATH="$GATE_ARTIFACT_DIR/$LANE.latest.json"
CMD_JSON=""
for c in "${COMMAND_LIST[@]}"; do
  esc="\"$(json_escape "$c")\""
  if [ -z "$CMD_JSON" ]; then CMD_JSON="$esc"; else CMD_JSON="$CMD_JSON, $esc"; fi
done
COV_REASON_LINE=""
AUD_REASON_LINE=""
ARCH_REASON_LINE=""
LINT_REASON_LINE=""
CONTRACT_REASON_LINE=""
if [ "$COVERAGE_SUMMARY_JSON" = "null" ]; then
  COV_REASON_LINE="  \"coverage_skip_reason\": \"$(json_escape "$COVERAGE_SKIP_REASON")\","
fi
if [ "$AUDIT_SUMMARY_JSON" = "null" ]; then
  AUD_REASON_LINE="  \"audit_skip_reason\": \"$(json_escape "$AUDIT_SKIP_REASON")\","
fi
if [ "$ARCH_SUMMARY_JSON" = "null" ]; then
  ARCH_REASON_LINE="  \"arch_skip_reason\": \"$(json_escape "$ARCH_SKIP_REASON")\","
fi
if [ "$LINT_SUMMARY_JSON" = "null" ]; then
  LINT_REASON_LINE="  \"lint_skip_reason\": \"$(json_escape "$LINT_SKIP_REASON")\","
fi
if [ "$CONTRACT_SUMMARY_JSON" = "null" ]; then
  CONTRACT_REASON_LINE="  \"contract_skip_reason\": \"$(json_escape "$CONTRACT_SKIP_REASON")\","
fi
MUTATION_REASON_LINE=""
if [ "$MUTATION_SUMMARY_JSON" = "null" ]; then
  MUTATION_REASON_LINE="  \"mutation_skip_reason\": \"$(json_escape "$MUTATION_SKIP_REASON")\","
fi
SAST_REASON_LINE=""
if [ "$SAST_SUMMARY_JSON" = "null" ]; then
  SAST_REASON_LINE="  \"sast_skip_reason\": \"$(json_escape "$SAST_SKIP_REASON")\","
fi
SUPPLY_CHAIN_REASON_LINE=""
if [ "$SUPPLY_CHAIN_SUMMARY_JSON" = "null" ]; then
  SUPPLY_CHAIN_REASON_LINE="  \"supply_chain_skip_reason\": \"$(json_escape "$SUPPLY_CHAIN_SKIP_REASON")\","
fi
A11Y_REASON_LINE=""
if [ "$A11Y_SUMMARY_JSON" = "null" ]; then
  A11Y_REASON_LINE="  \"a11y_skip_reason\": \"$(json_escape "$A11Y_SKIP_REASON")\","
fi
PERF_REASON_LINE=""
if [ "$PERF_SUMMARY_JSON" = "null" ]; then
  PERF_REASON_LINE="  \"perf_skip_reason\": \"$(json_escape "$PERF_SKIP_REASON")\","
fi
ARTIFACT_REL="artifacts/gates/$LANE.latest.json"
{
  echo "{"
  echo "  \"schema\": \"coord.gate-artifact/v1\","
  echo "  \"lane\": \"$LANE\","
  echo "  \"commit\": \"$(json_escape "$GATE_COMMIT")\","
  echo "  \"result\": \"$RESULT\","
  echo "  \"status\": \"$RESULT\","
  echo "  \"duration_ms\": $GATE_DURATION_MS,"
  echo "  \"command_list\": [$CMD_JSON],"
  echo "  \"coverage\": $COVERAGE_SUMMARY_JSON,"
  [ -n "$COV_REASON_LINE" ] && echo "$COV_REASON_LINE"
  echo "  \"audit\": $AUDIT_SUMMARY_JSON,"
  [ -n "$AUD_REASON_LINE" ] && echo "$AUD_REASON_LINE"
  echo "  \"arch\": $ARCH_SUMMARY_JSON,"
  [ -n "$ARCH_REASON_LINE" ] && echo "$ARCH_REASON_LINE"
  echo "  \"lint\": $LINT_SUMMARY_JSON,"
  [ -n "$LINT_REASON_LINE" ] && echo "$LINT_REASON_LINE"
  echo "  \"contract\": $CONTRACT_SUMMARY_JSON,"
  [ -n "$CONTRACT_REASON_LINE" ] && echo "$CONTRACT_REASON_LINE"
  echo "  \"mutation\": $MUTATION_SUMMARY_JSON,"
  [ -n "$MUTATION_REASON_LINE" ] && echo "$MUTATION_REASON_LINE"
  echo "  \"sast\": $SAST_SUMMARY_JSON,"
  [ -n "$SAST_REASON_LINE" ] && echo "$SAST_REASON_LINE"
  echo "  \"supply_chain\": $SUPPLY_CHAIN_SUMMARY_JSON,"
  [ -n "$SUPPLY_CHAIN_REASON_LINE" ] && echo "$SUPPLY_CHAIN_REASON_LINE"
  echo "  \"a11y\": $A11Y_SUMMARY_JSON,"
  [ -n "$A11Y_REASON_LINE" ] && echo "$A11Y_REASON_LINE"
  echo "  \"perf\": $PERF_SUMMARY_JSON,"
  [ -n "$PERF_REASON_LINE" ] && echo "$PERF_REASON_LINE"
  echo "  \"artifact_paths\": [\"$ARTIFACT_REL\"],"
  echo "  \"gate_runner\": \"scripts/gate.sh\""
  echo "}"
} >"$GATE_ARTIFACT_PATH"

if [ "$fail" -ne 0 ]; then echo "[gate:$LANE] FAILED" >&2; exit 1; fi
echo "[gate:$LANE] PASS"
