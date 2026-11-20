"use strict";

// COORD-882 (also used by the COORD-879 legacy-path test): a disposable
// install that quality-propose-cron can run against without touching the tree
// under test. It copies the shipped shim registry, resolver, legacy shim and
// engine modules into a temp root, adds a stub POSIX `gov` that logs each call
// and prints a filed-ticket line (or fails with $FAKE_GOV_STATUS), one source
// file large enough to produce a warn finding, and an empty scratch board.
// quality-scan resolves its repo root, board and gov from its own location, so
// everything the copied modules read or spawn stays inside the temp root.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SHIM_REGISTRY_RELATIVE_PATH } = require("../../../paths.js");

const SOURCE_COORD = path.resolve(__dirname, "..", "..", "..");

const QUALITY_CRON_FILES = Object.freeze([
  "paths.js", SHIM_REGISTRY_RELATIVE_PATH, "scripts/quality-propose-cron.js", "engine/scripts/governance-constants.js",
  "engine/scripts/quality-propose-cron.js", "engine/scripts/quality-scan.js", "engine/scripts/arch-checks.js",
  "engine/scripts/prodloc-attribution.js", "engine/scripts/comment-lexer.js",
  "engine/scripts/prodloc-budget.js",
  "engine/scripts/composition-root-wiring.js", "engine/vendor/babel-parser/index.js",
]);

// The session and runtime identity variables a parent agent session exports;
// a child process of the fixture must not inherit them.
const SCRUBBED_ENV_VARS = Object.freeze(["COORD_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDECODE"]);

function buildQualityCronInstall(t, { label = "quality-cron" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `coord-${label}-`));
  if (t && typeof t.after === "function") t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  for (const rel of QUALITY_CRON_FILES) {
    fs.mkdirSync(path.dirname(path.join(coord, rel)), { recursive: true });
    fs.copyFileSync(path.join(SOURCE_COORD, rel), path.join(coord, rel));
  }
  const callsPath = path.join(root, "gov-calls.log");
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(coord, "scripts", "gov"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${callsPath}'`,
    'if [ "${FAKE_GOV_STATUS:-0}" != 0 ]; then echo "stub gov refused" >&2; exit "$FAKE_GOV_STATUS"; fi',
    'echo "Filed ticket QSCAN-001 (X/refactor/P3, status=proposed)."',
    "",
  ].join("\n"), { mode: 0o755 });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "big.js"), Array.from({ length: 1600 }, (_, i) => `const x${i} = ${i};`).join("\n"));
  const boardPath = path.join(coord, "board", "tasks.json");
  fs.mkdirSync(path.dirname(boardPath), { recursive: true });
  fs.writeFileSync(boardPath, JSON.stringify({ sections: [{ kind: "table", rows: [] }] }));

  const env = { ...process.env };
  for (const name of SCRUBBED_ENV_VARS) delete env[name];
  const readCalls = () => (fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean) : []);
  const resetCalls = () => fs.rmSync(callsPath, { force: true });
  return { root, coord, callsPath, boardPath, env, readCalls, resetCalls };
}

module.exports = { QUALITY_CRON_FILES, SCRUBBED_ENV_VARS, buildQualityCronInstall };
