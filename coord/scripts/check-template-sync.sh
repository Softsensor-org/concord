#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$COORD_DIR/.." && pwd)"

REPO_ROOT="$ROOT_DIR"
MANIFEST_PATH="$COORD_DIR/TEMPLATE_SYNC_MANIFEST.json"
STRICT=0
JSON_OUTPUT=0

usage() {
  cat <<'EOF'
Usage: coord/scripts/check-template-sync.sh [options]

Verify reusable template-canonical governance surfaces against
coord/TEMPLATE_SYNC_MANIFEST.json.

Options:
  --repo-root <path>   Project root to validate. Defaults to the current template/project root.
  --manifest <path>    Manifest file to use. Defaults to coord/TEMPLATE_SYNC_MANIFEST.json.
  --strict             Treat advisory drift as a failure.
  --json               Emit machine-readable JSON instead of plain text.
  -h, --help           Show this help text.

Exit codes:
  0  All exact-match surfaces passed (advisory drift may still be present unless --strict is used)
  1  Manifest error or one or more required drift checks failed
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

export REPO_ROOT MANIFEST_PATH STRICT JSON_OUTPUT

node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(process.env.REPO_ROOT);
const manifestPath = path.resolve(process.env.MANIFEST_PATH);
const strict = process.env.STRICT === "1";
const jsonOutput = process.env.JSON_OUTPUT === "1";

class CheckTemplateSyncError extends Error {}

function fail(message) {
  throw new CheckTemplateSyncError(message);
}

function readJson(absPath, label) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (error) {
    fail(`Could not read ${label} at ${absPath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Could not parse ${label} at ${absPath}: ${error.message}`);
  }
}

function checksumFile(absPath) {
  const bytes = fs.readFileSync(absPath);
  return {
    algo: "sha256",
    hex: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function relativeToRepo(absPath) {
  const relative = path.relative(repoRoot, absPath);
  return relative && !relative.startsWith("..") ? relative : absPath;
}

try {
  const manifest = readJson(manifestPath, "template sync manifest");

  if (manifest.schema_version !== 1) {
    fail(`Unsupported manifest schema_version ${JSON.stringify(manifest.schema_version)}.`);
  }
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    fail("Manifest must contain a non-empty items array.");
  }

  const seenPaths = new Set();
  const results = [];
  const failures = [];
  const warnings = [];

  for (const item of manifest.items) {
    if (!item || typeof item.path !== "string" || item.path.trim() === "") {
      fail("Manifest item is missing a non-empty path.");
    }
    if (seenPaths.has(item.path)) {
      fail(`Manifest contains duplicate path ${item.path}.`);
    }
    seenPaths.add(item.path);

    const policy = item.match_policy === "advisory" ? "advisory" : "exact";
    const absPath = path.join(repoRoot, item.path);
    const expected = item.checksum || null;

    if (!expected || expected.algo !== "sha256" || typeof expected.hex !== "string" || !Number.isInteger(expected.bytes)) {
      fail(`Manifest item ${item.path} is missing a valid sha256 checksum contract.`);
    }

    const entry = {
      path: item.path,
      policy,
      version_stamp: item.version_stamp || null,
      expected,
      actual: null,
      status: "ok",
      message: "",
    };

    if (!fs.existsSync(absPath)) {
      entry.status = "missing";
      entry.message = `Missing file: ${item.path}`;
    } else {
      entry.actual = checksumFile(absPath);
      if (entry.actual.hex !== expected.hex || entry.actual.bytes !== expected.bytes) {
        entry.status = "mismatch";
        entry.message =
          `Checksum drift for ${item.path}: expected sha256=${expected.hex} bytes=${expected.bytes}, ` +
          `got sha256=${entry.actual.hex} bytes=${entry.actual.bytes}`;
      }
    }

    if (entry.status !== "ok") {
      const promote = strict || policy === "exact";
      if (promote) {
        failures.push(entry);
      } else {
        warnings.push(entry);
      }
    }

    results.push(entry);
  }

  const summary = {
    ok: failures.length === 0,
    repo_root: repoRoot,
    manifest_path: relativeToRepo(manifestPath),
    manifest_version: manifest.manifest_version || null,
    strict,
    counts: {
      total: results.length,
      passed: results.length - failures.length - warnings.length,
      warnings: warnings.length,
      failures: failures.length,
    },
    failures,
    warnings,
    results,
  };

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
  }

  process.exitCode = summary.ok ? 0 : 1;
} catch (error) {
  const message = error instanceof CheckTemplateSyncError ? error.message : (error?.stack || error?.message || String(error));
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2));
    process.stdout.write("\n");
  } else {
    console.error(`ERROR: ${message}`);
  }
  process.exitCode = 1;
}
NODE
