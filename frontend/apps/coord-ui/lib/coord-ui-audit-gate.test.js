import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/coord-ui-audit.js", import.meta.url));
const policy = process.env.COORD_AUDIT_POLICY || fileURLToPath(new URL("../../../../coord/engine/scripts/audit-policy.js", import.meta.url));
const gate = readFileSync(new URL("../../../scripts/gate.sh", import.meta.url), "utf8");
const gateBlock = gate.slice(gate.indexOf('  # COORD-573: coord-ui keeps its own lockfile'), gate.indexOf("\n  # COORD-077 (QGATE-003)"));

function fixture({ lock = true, output = "", exit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "coord-ui-audit-"));
  const bin = join(root, "bin");
  const app = join(root, "apps/coord-ui");
  mkdirSync(bin, { recursive: true });
  mkdirSync(app, { recursive: true });
  if (lock) writeFileSync(join(app, "package-lock.json"), "{}\n");
  const npmPath = join(bin, "npm");
  writeFileSync(npmPath, `#!/bin/sh\nprintf '%s' "$AUDIT_FIXTURE_OUTPUT"\nprintf '%s' "$*" > "$AUDIT_FIXTURE_ARGS_FILE"\nexit "$AUDIT_FIXTURE_EXIT"\n`);
  chmodSync(npmPath, 0o755);
  const argsFile = join(root, "npm-args");
  return {
    root,
    argsFile,
    run(offline = false) {
      const result = spawnSync(process.execPath, [script, "--repo-dir", root, "--threshold", "high", "--audit-policy", policy], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          AUDIT_FIXTURE_OUTPUT: output,
          AUDIT_FIXTURE_EXIT: String(exit),
          AUDIT_FIXTURE_ARGS_FILE: argsFile,
          GATE_AUDIT_OFFLINE: offline ? "1" : "0",
        },
      });
      return { ...result, value: JSON.parse(result.stdout) };
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

const cleanCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
const clean = JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: cleanCounts } });
const vulnerable = JSON.stringify({ vulnerabilities: { next: {} }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } });
const moderate = JSON.stringify({ vulnerabilities: { next: {} }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 } } });

for (const scenario of [
  { name: "clean nested lock passes", options: { output: clean, exit: 0 }, status: "pass", exitCode: 0 },
  { name: "vulnerable nested lock fails", options: { output: vulnerable, exit: 1 }, status: "fail", exitCode: 1 },
  { name: "below-threshold advisories remain a warning", options: { output: moderate, exit: 1 }, status: "warn", exitCode: 0 },
  { name: "malformed JSON is unavailable", options: { output: "{bad", exit: 1 }, status: "unavailable", exitCode: 2 },
  { name: "error JSON is unavailable", options: { output: JSON.stringify({ error: { code: "ENOTFOUND" } }), exit: 1 }, status: "unavailable", exitCode: 2 },
  { name: "empty output is unavailable", options: { output: "", exit: 0 }, status: "unavailable", exitCode: 2 },
  { name: "non-advisory npm status is unavailable", options: { output: clean, exit: 2 }, status: "unavailable", exitCode: 2 },
  { name: "npm advisory failure with zero-count JSON is unavailable", options: { output: clean, exit: 1 }, status: "unavailable", exitCode: 2 },
  { name: "missing vulnerability map is unavailable", options: { output: JSON.stringify({ metadata: { vulnerabilities: cleanCounts } }) }, status: "unavailable", exitCode: 2 },
  { name: "array vulnerability map is unavailable", options: { output: JSON.stringify({ vulnerabilities: [], metadata: { vulnerabilities: cleanCounts } }) }, status: "unavailable", exitCode: 2 },
  { name: "incomplete severity counts are unavailable", options: { output: JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }) }, status: "unavailable", exitCode: 2 },
  { name: "negative severity counts are unavailable", options: { output: JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { ...cleanCounts, high: -1, total: -1 } } }) }, status: "unavailable", exitCode: 2 },
  { name: "string severity counts are unavailable", options: { output: JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { ...cleanCounts, high: "0" } } }) }, status: "unavailable", exitCode: 2 },
  { name: "inconsistent total is unavailable", options: { output: JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { ...cleanCounts, high: 1 } } }) }, status: "unavailable", exitCode: 2 },
]) {
  test(scenario.name, () => {
    const f = fixture(scenario.options);
    try {
      const result = f.run();
      assert.equal(result.status, scenario.exitCode);
      assert.equal(result.value.status, scenario.status);
      assert.equal(result.value.command, "npm --prefix apps/coord-ui audit --json");
      assert.match(readFileSync(f.argsFile, "utf8"), /^--prefix apps\/coord-ui audit --json$/);
    } finally { f.cleanup(); }
  });
}

test("offline audit is unavailable even when npm's fixture contains zero findings", () => {
  const f = fixture({ output: clean, exit: 0 });
  try {
    const result = f.run(true);
    assert.equal(result.status, 2);
    assert.equal(result.value.status, "unavailable");
    assert.match(result.value.reason, /offline advisory data is not validated/);
    assert.equal(existsSync(f.argsFile), false);
  } finally { f.cleanup(); }
});

test("missing nested lock is a named, legitimate skip", () => {
  const f = fixture({ lock: false, output: clean });
  try {
    const result = f.run();
    assert.equal(result.status, 0);
    assert.equal(result.value.status, "skipped");
    assert.match(result.value.reason, /missing lockfile/);
    assert.equal(result.value.command, "npm --prefix apps/coord-ui audit --json");
  } finally { f.cleanup(); }
});

test("frontend gate records the nested command and fails when its audit blocks", () => {
  const f = fixture({ output: vulnerable, exit: 1 });
  try {
    const scripts = join(f.root, "scripts");
    mkdirSync(scripts);
    const helperLink = join(scripts, "coord-ui-audit.js");
    symlinkSync(script, helperLink);
    const prelude = [
      "set -euo pipefail",
      "LANE=full",
      `REPO_DIR=${JSON.stringify(f.root)}`,
      `AUDIT_POLICY=${JSON.stringify(policy)}`,
      "AUDIT_SUMMARY='root audit: pass'",
      "AUDIT_SUMMARY_JSON='\"root audit: pass\"'",
      "GATE_AUDIT_THRESHOLD=high",
      "fail=0",
      "step() { echo \"$*\"; }",
      "json_escape() { printf '%s' \"$1\"; }",
    ].join("\n");
    const tail = '\necho "RESULT_FAIL=$fail"\necho "RESULT_AUDIT=$AUDIT_SUMMARY_JSON"';
    const result = spawnSync("bash", ["-c", `${prelude}\n${gateBlock}${tail}`], {
      cwd: f.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(f.root, "bin")}:${process.env.PATH}`,
        AUDIT_FIXTURE_OUTPUT: vulnerable,
        AUDIT_FIXTURE_EXIT: "1",
        AUDIT_FIXTURE_ARGS_FILE: f.argsFile,
        GATE_AUDIT_OFFLINE: "0",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /npm --prefix apps\/coord-ui audit --json/);
    assert.match(result.stdout, /RESULT_FAIL=1/);
    assert.match(result.stdout, /root audit: pass; coord-ui audit fail/);
    assert.match(readFileSync(f.argsFile, "utf8"), /^--prefix apps\/coord-ui audit --json$/);
  } finally { f.cleanup(); }
});
