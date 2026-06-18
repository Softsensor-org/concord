"use strict";

// COORD-080 (QGATE-006): gate-artifact completeness schema/validator unit tests
// + template gate.sh runner integration. The schema (gate-artifact-schema.js) is
// the single source of truth for the required-field list; these tests assert the
// validator's verdicts and prove the template runners now EMIT a complete
// artifact (real duration, commit, command list, coverage/audit summaries or
// null+skip-reason, artifact paths). Temp fixtures only — no board/runtime
// side effects.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  REQUIRED_FIELDS,
  validateGateArtifact,
  formatCompletenessSummary,
} = require("./gate-artifact-schema.js");

// A complete reference artifact (every required field populated with a usable value).
function completeArtifact(overrides = {}) {
  return {
    schema: "coord.gate-artifact/v1",
    lane: "full",
    commit: "cbfbc738454761b4174600b130deba47e73d9000",
    result: "pass",
    duration_ms: 1234,
    command_list: ["unit tests", "coverage"],
    coverage: "coverage: pass min=80 (lines=96.99 branches=90.91 functions=100.00) lowest=90.91",
    audit: "audit: pass threshold=high total=0 (critical=0 high=0 moderate=0 low=0 info=0) blocking=0",
    artifact_paths: ["coord/artifacts/gates/backend/full.latest.json"],
    ...overrides,
  };
}

// --- Schema constant -------------------------------------------------------

test("REQUIRED_FIELDS lists the documented completeness contract", () => {
  assert.deepEqual(
    [...REQUIRED_FIELDS],
    ["lane", "commit", "result", "duration_ms", "command_list", "coverage", "audit", "artifact_paths"]
  );
});

// --- Validator: complete case ----------------------------------------------

test("validateGateArtifact accepts a fully-populated artifact as complete", () => {
  const v = validateGateArtifact(completeArtifact());
  assert.equal(v.complete, true);
  assert.deepEqual(v.missing, []);
  assert.equal(v.present.length, REQUIRED_FIELDS.length);
});

test("coverage/audit may be null IF the paired skip-reason is present", () => {
  const v = validateGateArtifact(completeArtifact({
    coverage: null,
    coverage_skip_reason: "not run on this lane (default)",
    audit: null,
    audit_skip_reason: "no npm lockfile",
  }));
  assert.equal(v.complete, true, JSON.stringify(v.missing));
});

// --- Validator: missing-field detection ------------------------------------

test("validateGateArtifact flags a missing/unknown duration", () => {
  const v = validateGateArtifact(completeArtifact({ duration_ms: undefined }));
  assert.equal(v.complete, false);
  assert.ok(v.missing.includes("duration_ms"));
});

test('validateGateArtifact rejects a non-numeric "unknown" duration', () => {
  const v = validateGateArtifact(completeArtifact({ duration_ms: "unknown" }));
  assert.equal(v.complete, false);
  assert.ok(v.missing.includes("duration_ms"));
});

test("validateGateArtifact flags an empty command_list", () => {
  const v = validateGateArtifact(completeArtifact({ command_list: [] }));
  assert.equal(v.complete, false);
  assert.ok(v.missing.includes("command_list"));
});

test("validateGateArtifact flags a missing commit and artifact_paths", () => {
  const v = validateGateArtifact(completeArtifact({ commit: "", artifact_paths: [] }));
  assert.equal(v.complete, false);
  assert.ok(v.missing.includes("commit"));
  assert.ok(v.missing.includes("artifact_paths"));
});

test("coverage=null WITHOUT a skip-reason is incomplete (silently dropped signal)", () => {
  const v = validateGateArtifact(completeArtifact({ coverage: null }));
  assert.equal(v.complete, false);
  assert.ok(v.missing.includes("coverage"));
});

test("validateGateArtifact tolerates a non-object input", () => {
  const v = validateGateArtifact(null);
  assert.equal(v.complete, false);
  assert.equal(v.missing.length, REQUIRED_FIELDS.length);
});

// --- Summary formatting ----------------------------------------------------

test("formatCompletenessSummary renders complete vs incomplete one-liners", () => {
  assert.equal(
    formatCompletenessSummary(validateGateArtifact(completeArtifact())),
    "artifact: complete fields=8/8"
  );
  const incomplete = formatCompletenessSummary(
    validateGateArtifact(completeArtifact({ duration_ms: null, command_list: [] }))
  );
  assert.match(incomplete, /^artifact: incomplete fields=6\/8 missing=/);
  assert.match(incomplete, /duration_ms/);
  assert.match(incomplete, /command_list/);
});

// --- Template gate.sh runner integration -----------------------------------
// Build a throwaway sandbox mirroring the template layout (repo dir alongside
// coord/scripts/{audit,coverage}-policy.js) and exercise the real gate.sh
// runner, then validate the artifact it emits against the schema. Proves the
// runner emits a COMPLETE artifact with real duration, commit, command list,
// and coverage/audit summaries. Never touches the live repo/board.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function buildGateSandbox(repo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `coord080-gate-${repo}-`));
  fs.mkdirSync(path.join(root, "coord", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, repo), { recursive: true });
  // The runner shells out to these policy modules on full/ci.
  for (const mod of ["audit-policy.js", "coverage-policy.js"]) {
    fs.copyFileSync(
      path.join(REPO_ROOT, "coord", "scripts", mod),
      path.join(root, "coord", "scripts", mod)
    );
  }
  fs.cpSync(path.join(REPO_ROOT, repo, "scripts"), path.join(root, repo, "scripts"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, repo, "src"), path.join(root, repo, "src"), { recursive: true });
  const repoTests = path.join(REPO_ROOT, repo, "tests");
  fs.mkdirSync(path.join(root, repo, "tests"), { recursive: true });
  if (fs.existsSync(repoTests)) fs.cpSync(repoTests, path.join(root, repo, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, repo, "tests", "coord080-cov.test.js"),
    'const t=require("node:test");const a=require("assert");' +
      'const env=require("../src/config/env.js");' +
      't("env module loads",()=>{a.ok(env);});\n'
  );
  fs.copyFileSync(path.join(REPO_ROOT, repo, "package.json"), path.join(root, repo, "package.json"));
  // The runner reads `git rev-parse HEAD` for the commit; make it a git repo.
  const git = (...args) => spawnSync("git", ["-C", path.join(root, repo), ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { root, repo, gateScript: path.join(root, repo, "scripts", "gate.sh") };
}

function runGate(sandbox, lane, { env } = {}) {
  const childEnv = { ...process.env, ...(env || {}) };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const res = spawnSync("bash", [sandbox.gateScript, lane], { encoding: "utf8", env: childEnv });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}`, root: sandbox.root };
}

function readArtifact(sandbox, lane) {
  const p = path.join(sandbox.root, sandbox.repo, "artifacts", "gates", `${lane}.latest.json`);
  assert.ok(fs.existsSync(p), `gate artifact must exist at ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

for (const repo of ["backend", "frontend"]) {
  test(`gate.sh (${repo}): default lane emits a complete artifact with real commit + command list`, () => {
    const sb = buildGateSandbox(repo);
    try {
      const r = runGate(sb, "default");
      assert.equal(r.status, 0, r.out);
      const art = readArtifact(sb, "default");
      // Commit is real (40-hex sha), not "unknown".
      assert.match(art.commit, /^[0-9a-f]{40}$/, `commit must be a real sha: ${art.commit}`);
      assert.equal(art.lane, "default");
      assert.equal(art.result, "pass");
      // Duration is a real number (>= 0), not the string "unknown".
      assert.equal(typeof art.duration_ms, "number");
      // Command list is the ordered steps the default lane ran.
      assert.ok(Array.isArray(art.command_list) && art.command_list.length >= 3, JSON.stringify(art.command_list));
      // Coverage/audit are off the default lane => null + a skip reason.
      assert.equal(art.coverage, null);
      assert.ok(art.coverage_skip_reason);
      assert.equal(art.audit, null);
      assert.ok(art.audit_skip_reason);
      // Schema validates the emitted artifact as complete.
      const v = validateGateArtifact(art);
      assert.equal(v.complete, true, `default-lane artifact must be complete; missing=${v.missing}`);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test(`gate.sh (${repo}): full lane embeds the coverage summary in a complete artifact`, () => {
    const sb = buildGateSandbox(repo);
    try {
      const r = runGate(sb, "full", { env: { GATE_COVERAGE_MIN: "0" } });
      assert.equal(r.status, 0, r.out);
      const art = readArtifact(sb, "full");
      // The 077 coverage one-liner is embedded verbatim.
      assert.match(String(art.coverage), /^coverage: (pass|warn) min=0/);
      // The full lane's command list includes the coverage + audit steps.
      assert.ok(art.command_list.some((c) => /test coverage/.test(c)), JSON.stringify(art.command_list));
      assert.ok(art.command_list.some((c) => /dependency audit/.test(c)), JSON.stringify(art.command_list));
      const v = validateGateArtifact(art);
      assert.equal(v.complete, true, `full-lane artifact must be complete; missing=${v.missing}`);
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });
}
