#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$COORD_DIR/.." && pwd)"
INVOKED_FROM="$(pwd)"

skip_hygiene=0
skip_contract=0
contract_cmd=""
ticket_id="${COORD_PREFLIGHT_TICKET:-}"

pass_count=0
fail_count=0
skip_count=0

usage() {
  cat <<'EOF'
Usage: coord/scripts/preflight.sh [options]

Thin local preflight wrapper for this coordination scaffold. It reuses canonical coord governance checks
and adds lightweight local repo hygiene scans without duplicating ticket lifecycle logic.

Options:
  --skip-hygiene            Skip configured product-repo cleanliness and conflict-marker checks.
  --skip-contract           Skip the optional contract-check hook.
  --contract-cmd <command>  Run this command as the optional contract check.
  --ticket <ticket-id>      Scope governance doctor to one ticket. Defaults to COORD_PREFLIGHT_TICKET or a ticket id inferred from the invocation path.
  -h, --help                Show this help text.

Contract check resolution order:
  1. --contract-cmd
  2. COORD_PREFLIGHT_CONTRACT_CMD
  3. coord/scripts/check-contracts.sh
  4. coord/scripts/check-contracts.js
EOF
}

note_pass() {
  printf '[PASS] %s\n' "$1"
  pass_count=$((pass_count + 1))
}

note_fail() {
  printf '[FAIL] %s\n' "$1"
  fail_count=$((fail_count + 1))
}

note_skip() {
  printf '[SKIP] %s\n' "$1"
  skip_count=$((skip_count + 1))
}

print_step() {
  printf '\n==> %s\n' "$1"
}

print_command() {
  printf '    $'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

run_required_command() {
  local label="$1"
  shift

  print_step "$label"
  print_command "$@"
  if "$@"; then
    note_pass "$label"
  else
    note_fail "$label"
  fi
}

infer_ticket_from_path() {
  local candidate_path="$1"
  if [[ "$candidate_path" =~ (^|/)([A-Z]+-[0-9]+)(/|$) ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

run_governance_doctor() {
  local effective_ticket="${ticket_id:-}"
  local label="coord governance doctor"

  if [[ -z "$effective_ticket" ]]; then
    effective_ticket="$(infer_ticket_from_path "$INVOKED_FROM" || true)"
  fi

  if [[ -n "$effective_ticket" ]]; then
    run_required_command "$label ($effective_ticket)" bash coord/scripts/gov doctor --ticket "$effective_ticket"
    return
  fi

  print_step "$label"
  note_skip "$label skipped without ticket context"
}

check_repo_clean() {
  local label="$1"
  local repo_path="$2"
  local status_output=""
  local porcelain_output=""

  print_step "Repo hygiene: $label"

  if ! porcelain_output="$(git -C "$repo_path" status --porcelain=v1 --untracked-files=all 2>&1)"; then
    printf '%s\n' "$porcelain_output"
    note_fail "$label git status"
    return
  fi

  if [[ -n "$porcelain_output" ]]; then
    status_output="$(git -C "$repo_path" status --short --branch 2>&1 || true)"
    printf '%s\n' "$status_output"

    if ! git -C "$repo_path" diff --check --no-ext-diff; then
      true
    fi
    if ! git -C "$repo_path" diff --cached --check --no-ext-diff; then
      true
    fi

    note_fail "$label clean worktree"
    return
  fi

  note_pass "$label clean worktree"
}

check_branch_state() {
  local label="$1"
  local repo_path="$2"
  local branch_output=""
  local branch_name=""

  print_step "Repo hygiene: $label branch state"

  if ! branch_output="$(git -C "$repo_path" symbolic-ref --quiet --short HEAD 2>&1)"; then
    local status_output=""
    status_output="$(git -C "$repo_path" status --short --branch 2>&1 || true)"
    if [[ -n "$status_output" ]]; then
      printf '%s\n' "$status_output"
    else
      printf '%s\n' "$branch_output"
    fi
    note_fail "$label detached HEAD"
    return
  fi

  branch_name="$(printf '%s\n' "$branch_output" | tail -1)"
  printf 'Current branch: %s\n' "$branch_name"

  if [[ "$branch_name" == "dev" || "$branch_name" == "main" ]]; then
    note_fail "$label on base branch"
    return
  fi

  note_pass "$label branch state"
}

check_conflict_markers() {
  local label="merge conflict markers"
  local output=""
  local status=0

  print_step "Repo hygiene: $label"

  if command -v rg >/dev/null 2>&1; then
    output="$(
      rg -n \
        --hidden \
        --glob '!**/.git/**' \
        --glob '!**/node_modules/**' \
        --glob '!**/.worktrees/**' \
        --glob '!**/__pycache__/**' \
        '^(<<<<<<< |>>>>>>> )' \
        "$ROOT_DIR" 2>&1
    )"
    status=$?
  else
    output="$(
      grep -RInE \
        --exclude-dir=.git \
        --exclude-dir=node_modules \
        --exclude-dir=__pycache__ \
        --exclude-dir=.worktrees \
        '^(<<<<<<< |>>>>>>> )' \
        "$ROOT_DIR" 2>&1
    )"
    status=$?
  fi

  if [[ $status -eq 0 ]]; then
    printf '%s\n' "$output"
    note_fail "$label"
    return
  fi
  if [[ $status -eq 1 ]]; then
    note_pass "$label"
    return
  fi

  printf '%s\n' "$output"
  note_fail "$label scan"
}

resolve_contract_command() {
  if [[ -n "$contract_cmd" ]]; then
    return 0
  fi

  if [[ -n "${COORD_PREFLIGHT_CONTRACT_CMD:-}" ]]; then
    contract_cmd="$COORD_PREFLIGHT_CONTRACT_CMD"
    return 0
  fi

  if [[ -x "$SCRIPT_DIR/check-contracts.sh" ]]; then
    printf -v contract_cmd 'bash %q' "$SCRIPT_DIR/check-contracts.sh"
    return 0
  fi

  if [[ -f "$SCRIPT_DIR/check-contracts.js" ]]; then
    printf -v contract_cmd 'node %q' "$SCRIPT_DIR/check-contracts.js"
    return 0
  fi

  return 1
}

run_optional_contract_check() {
  local label="optional contract check"

  if [[ $skip_contract -eq 1 ]]; then
    print_step "$label"
    note_skip "$label disabled by flag"
    return
  fi

  if ! resolve_contract_command; then
    print_step "$label"
    note_skip "$label not configured"
    return
  fi

  print_step "$label"
  print_command bash -lc "$contract_cmd"
  if bash -lc "$contract_cmd"; then
    note_pass "$label"
  else
    note_fail "$label"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-hygiene)
      skip_hygiene=1
      shift
      ;;
    --skip-contract)
      skip_contract=1
      shift
      ;;
    --contract-cmd)
      if [[ $# -lt 2 ]]; then
        printf 'Missing value for --contract-cmd.\n' >&2
        exit 2
      fi
      contract_cmd="$2"
      shift 2
      ;;
    --ticket)
      if [[ $# -lt 2 ]]; then
        printf 'Missing value for --ticket.\n' >&2
        exit 2
      fi
      ticket_id="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

check_spec_stubs() {
  local label="spec stub readiness"
  local stubs_found=0
  local stubs_list=""

  print_step "$label"

  for spec_file in \
    "$COORD_DIR/REQUIREMENTS.md" \
    "$COORD_DIR/ARCHITECTURE.md" \
    "$COORD_DIR/TESTING_AND_GATES.md" \
    "$COORD_DIR/LOCAL_AUTOMATION_AND_GATES.md"; do
    if [[ -f "$spec_file" ]] && grep -q "Replace this stub" "$spec_file" 2>/dev/null; then
      stubs_found=$((stubs_found + 1))
      stubs_list="${stubs_list}    - $(basename "$spec_file")"$'\n'
    fi
  done

  if [[ $stubs_found -gt 0 ]]; then
    printf '%s' "$stubs_list"
    note_skip "$label ($stubs_found critical spec stubs still unpopulated)"
    return
  fi

  note_pass "$label"
}

check_orchestrator_recency() {
  local label="orchestrator recency"
  local event_log="$COORD_DIR/.runtime/governance-events.ndjson"

  print_step "$label"

  if [[ ! -f "$event_log" ]]; then
    note_skip "$label (no governance event log yet)"
    return
  fi

  local last_orch_ts=""
  last_orch_ts="$(grep '"command":"orch"' "$event_log" 2>/dev/null | tail -1 | grep -oP '"ts":"[^"]*"' | head -1 | sed 's/"ts":"//;s/"//' || true)"

  if [[ -z "$last_orch_ts" ]]; then
    note_skip "$label (no orchestrator cycle recorded; run coord/scripts/gov orch)"
    return
  fi

  local last_epoch now_epoch age_hours
  last_epoch="$(date -d "$last_orch_ts" +%s 2>/dev/null || echo 0)"
  now_epoch="$(date +%s)"
  age_hours=$(( (now_epoch - last_epoch) / 3600 ))

  if [[ $age_hours -gt 24 ]]; then
    note_fail "$label (last orchestrator cycle was ${age_hours}h ago; run coord/scripts/gov orch)"
    return
  fi

  note_pass "$label (last cycle ${age_hours}h ago)"
}

cd "$ROOT_DIR"

run_required_command "coord board validate" node coord/board/board.js validate
run_governance_doctor
check_spec_stubs
check_orchestrator_recency

if [[ $skip_hygiene -eq 1 ]]; then
  print_step "Repo hygiene"
  note_skip "repo hygiene disabled by flag"
else
  check_repo_clean "frontend" "$ROOT_DIR/frontend"
  check_branch_state "frontend" "$ROOT_DIR/frontend"
  check_repo_clean "backend" "$ROOT_DIR/backend"
  check_branch_state "backend" "$ROOT_DIR/backend"
  check_conflict_markers
fi

run_optional_contract_check

printf '\nPreflight summary: %d passed, %d failed, %d skipped.\n' "$pass_count" "$fail_count" "$skip_count"

if [[ $fail_count -gt 0 ]]; then
  exit 1
fi
