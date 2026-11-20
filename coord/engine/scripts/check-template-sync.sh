#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORD_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ROOT_DIR="$(cd "$COORD_DIR/.." && pwd)"

REPO_ROOT="$ROOT_DIR"
MANIFEST_PATH="$COORD_DIR/TEMPLATE_SYNC_MANIFEST.json"
STRICT=0
JSON_OUTPUT=0
AUDIT_COVERAGE=0

usage() {
  cat <<'EOF'
Usage: coord/scripts/check-template-sync.sh [options]

Verify reusable template-canonical governance surfaces against
coord/TEMPLATE_SYNC_MANIFEST.json.

Options:
  --repo-root <path>   Project root to validate. Defaults to the current template/project root.
  --manifest <path>    Manifest file to use. Defaults to coord/TEMPLATE_SYNC_MANIFEST.json.
  --strict             Treat advisory drift as a failure.
  --audit-coverage     Also verify that the manifest tracks every engine-managed
                       file discovered by the COORD-607 rule over the roots in
                       coord/engine/docs/GCV4_ENGINE_CONFIG_SEAM.md, minus the reasoned
                       exclusions in coord/engine/scripts/template-sync-discovery.js.
                       An untracked engine-managed file FAILS the check (COORD-606
                       made this report-only; COORD-607 made coverage enforceable
                       because a silent gap is what let engine code drift unseen).
  --json               Emit machine-readable JSON instead of plain text.
  -h, --help           Show this help text.

Exit codes:
  0  All exact-match surfaces passed (advisory drift may still be present unless --strict is used)
  1  Manifest error, a required drift check failed, or (with --audit-coverage) an
     engine-managed file is untracked
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --repo-root" >&2
        exit 2
      fi
      REPO_ROOT="$2"
      shift 2
      ;;
    --manifest)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --manifest" >&2
        exit 2
      fi
      MANIFEST_PATH="$2"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --audit-coverage)
      AUDIT_COVERAGE=1
      shift
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to run coord/scripts/check-template-sync.sh" >&2
  exit 1
fi

ENGINE_SURFACE_MODULE="$SCRIPT_DIR/engine-surface-integrity.js"

export REPO_ROOT MANIFEST_PATH STRICT JSON_OUTPUT AUDIT_COVERAGE ENGINE_SURFACE_MODULE

node <<'NODE'
const path = require("node:path");
// COORD-958: the manifest-vs-files rule lives in engine-surface-integrity.js (shared with the
// merged regenerate-and-verify step and the Repo-X closeout verdict). This script only formats.
const { evaluateTemplateSync, EngineSurfaceRefusal } = require(process.env.ENGINE_SURFACE_MODULE);

const repoRoot = path.resolve(process.env.REPO_ROOT);
const manifestPath = path.resolve(process.env.MANIFEST_PATH);
const strict = process.env.STRICT === "1";
const jsonOutput = process.env.JSON_OUTPUT === "1";
const auditCoverage = process.env.AUDIT_COVERAGE === "1";

try {
  const { summary } = evaluateTemplateSync({ repoRoot, manifestPath, strict, auditCoverage });
  const results = summary.results;

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(summary, null, 2));
    process.stdout.write("\n");
  } else {
    console.log(`Template sync manifest: ${summary.manifest_path}`);
    if (summary.manifest_version) {
      console.log(`Manifest version: ${summary.manifest_version}`);
    }
    console.log(`Repo root: ${summary.repo_root}`);
    for (const entry of results) {
      if (entry.status === "ok") {
        const stamp = entry.version_stamp ? ` (${entry.version_stamp})` : "";
        console.log(`[PASS] ${entry.path}${stamp}`);
        continue;
      }
      const label = strict || entry.policy === "exact" ? "FAIL" : "WARN";
      console.log(`[${label}] ${entry.message}`);
    }
    console.log(
      `Summary: ${summary.counts.passed} passed, ${summary.counts.warnings} warnings, ${summary.counts.failures} failures.`
    );
    if (summary.coverage_audit) {
      const audit = summary.coverage_audit;
      console.log(
        `Coverage audit (rule-based, ${audit.discovery_source}): ${audit.engine_managed_count} engine-managed ` +
          `file(s) under ${audit.roots.join(", ")}; ${audit.untracked_count} untracked; ` +
          `${audit.excluded_count} excluded with a recorded reason.`
      );
      for (const entry of audit.excluded) {
        console.log(`[EXCLUDED] ${entry.path} (${entry.category}) — ${entry.reason}`);
      }
      for (const rel of audit.untracked) {
        console.log(`[UNTRACKED] ${rel}`);
      }
    }
  }

  process.exitCode = summary.ok ? 0 : 1;
} catch (error) {
  const message = error instanceof EngineSurfaceRefusal ? error.message : (error?.stack || error?.message || String(error));
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2));
    process.stdout.write("\n");
  } else {
    console.error(`ERROR: ${message}`);
  }
  process.exitCode = 1;
}
NODE
