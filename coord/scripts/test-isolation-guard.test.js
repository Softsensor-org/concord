"use strict";

// COORD-290: unit coverage for the test-isolation guard's path classifier and
// (in a controlled, last-running test) its in-flight fs interceptor.

// Do NOT auto-install the fs hooks on require — we drive install() explicitly.
process.env.COORD_TEST_ISOLATION_GUARD = "0";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const guard = require("./test-isolation-guard.js");
const COORD_DIR = guard.COORD_DIR;

test("isViolation flags writes under live coord/prompts and coord/rendered", () => {
  assert.equal(guard.isViolation(path.join(COORD_DIR, "prompts", "tickets", "Z-999.tmp")), true);
  assert.equal(guard.isViolation(path.join(COORD_DIR, "prompts", "tickets", "FOO-1.md")), true);
  assert.equal(guard.isViolation(path.join(COORD_DIR, "rendered", "TASKS.md")), true);
});

test("isViolation (seal class) ignores sandbox + the runtime/board surfaces it does not own", () => {
  assert.equal(guard.isViolation(path.join(os.tmpdir(), "sbx", "prompts", "tickets", "X.md")), false);
  // The seal classifier owns ONLY prompts/rendered; the live runtime is the
  // runtime classifier's job (isRuntimeViolation), the board is neither.
  assert.equal(guard.isViolation(path.join(COORD_DIR, ".runtime", "governance-events.ndjson")), false);
  assert.equal(guard.isViolation(path.join(COORD_DIR, "board", "tasks.json")), false);
  assert.equal(guard.isViolation(path.join(COORD_DIR, "QUESTIONS.md")), false);
});

// COORD-299: live-runtime classifier — .runtime/**, the two coarse directory locks,
// and the memory corpus.
test("isRuntimeViolation flags writes under live .runtime, the coarse locks, and memory", () => {
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, ".runtime", "governance-events.ndjson")), true);
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, ".runtime", "agents.json")), true);
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, ".coord-state.lock")), true);
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, ".coord-state.lock", "lock-owner.json")), true);
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, ".agent-state.lock")), true);
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, "memory", "decisions.ndjson")), true);
});

test("isRuntimeViolation ignores sandbox + the seal surfaces it does not own", () => {
  assert.equal(guard.isRuntimeViolation(path.join(os.tmpdir(), "sbx", ".runtime", "governance-events.ndjson")), false);
  assert.equal(guard.isRuntimeViolation(path.join(os.tmpdir(), "sbx", ".agent-state.lock")), false);
  // prompts/rendered are the seal classifier's domain, not the runtime one's.
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, "prompts", "tickets", "X.md")), false);
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, "board", "tasks.json")), false);
});

test("the runtime per-file allowlist is fully drained (empty) and is process-scoped not path-scoped", () => {
  // COORD-300: the per-FILE allowlist is now EMPTY — every test file is fully
  // fail-closed under the live-runtime class. No file may be exempted by basename.
  assert.equal(guard.RUNTIME_ALLOWLIST_FILES.size, 0, "the per-file runtime allowlist must be empty (all drained)");
  // The formerly-allowlisted offenders are now all drained.
  for (const f of [
    "recall.test.js",
    "memory-eval.test.js",
    "board-rebuild.test.js",
    "agent-commands.test.js",
    "governance.test.js",
    "journal.test.js",
    "concurrent-burnin.test.js",
    "concurrent-burnin-worker.js",
    "gate-proc-registry.test.js",
    "gate-proc-registry.js",
  ]) {
    assert.equal(guard.RUNTIME_ALLOWLIST_FILES.has(f), false, `${f} must be drained from the file allowlist`);
  }
  // A non-allowlisted file (this guard's own test) is NOT exempt.
  assert.equal(guard.RUNTIME_ALLOWLIST_FILES.has("test-isolation-guard.test.js"), false);
  // The exemption is by process identity, not by path: the classifier still flags
  // an allowlisted file's live path (enforcement, not classification, is exempted).
  assert.equal(guard.isRuntimeViolation(path.join(COORD_DIR, ".runtime", "agents.json")), true);
});

test("ALLOWLIST exempts the canonical live-path prompt fixtures", () => {
  for (const allowed of guard.ALLOWLIST) {
    assert.equal(guard.isViolation(allowed), false, `${allowed} must be allowlisted`);
  }
  assert.ok(guard.ALLOWLIST.has(path.join(COORD_DIR, "prompts", "tickets", "COORD-023.md")));
});

test("flagsAreWrite recognizes write/append/plus flags", () => {
  assert.equal(guard.flagsAreWrite("w"), true);
  assert.equal(guard.flagsAreWrite("a"), true);
  assert.equal(guard.flagsAreWrite("r+"), true);
  assert.equal(guard.flagsAreWrite("r"), false);
});

test("resolveTarget normalizes strings, Buffers and file URLs", () => {
  const p = path.join(COORD_DIR, "rendered", "TASKS.md");
  assert.equal(guard.resolveTarget(p), p);
  assert.equal(guard.resolveTarget(Buffer.from(p)), p);
  assert.equal(guard.resolveTarget(123), null);
});

// Last: install the in-flight interceptor (process-global, no uninstall) and
// prove it throws on a live-tree write while permitting sandbox + allowlisted
// writes. Kept last so the global hook does not affect earlier assertions.
test("install() throws on live coord/prompts writes, passes for sandbox + allowlist", () => {
  guard.install();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "isolation-guard-"));
  // Sandbox write is fine.
  assert.doesNotThrow(() => fs.writeFileSync(path.join(sandbox, "ok.md"), "ok"));
  // Live prompts write is blocked.
  assert.throws(
    () => fs.writeFileSync(path.join(COORD_DIR, "prompts", "tickets", "GUARD-PROOF.tmp"), "x"),
    (e) => e.code === "ETESTISOLATION"
  );
  // Allowlisted canonical prompt path is permitted by the guard (the write
  // itself is routed to a throwaway temp copy to avoid mutating the donor file).
  const allow = [...guard.ALLOWLIST][0];
  assert.equal(guard.isViolation(allow), false);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// COORD-299: fail-closed proof for the live-runtime class. The interceptor is
// already installed (previous test). This test process (test-isolation-guard.test.js)
// is NOT in the per-file allowlist, so a write resolving under the live coord/.runtime
// tree must throw in enforce mode — proving a future test that writes the live runtime
// is caught. A sandbox write is unaffected.
test("install() fails-closed on a live coord/.runtime write (enforce), passes in a sandbox", () => {
  guard.install();
  const prior = process.env.COORD_TEST_ISOLATION_RUNTIME;
  process.env.COORD_TEST_ISOLATION_RUNTIME = "enforce";
  try {
    // Deliberate offender: writing under the live runtime is blocked BEFORE the
    // underlying fs op runs (so nothing is actually created under coord/.runtime).
    assert.throws(
      () => fs.writeFileSync(path.join(COORD_DIR, ".runtime", "GUARD-PROOF-COORD299.tmp"), "x"),
      (e) => e.code === "ETESTISOLATION"
    );
    // Acquiring the live coarse lock dir (mkdir) is blocked too.
    assert.throws(
      () => fs.mkdirSync(path.join(COORD_DIR, ".agent-state.lock")),
      (e) => e.code === "ETESTISOLATION"
    );
    // A sandbox runtime write is fine.
    const sbx = fs.mkdtempSync(path.join(os.tmpdir(), "isolation-runtime-"));
    assert.doesNotThrow(() => fs.writeFileSync(path.join(sbx, "governance-events.ndjson"), "ok"));
    fs.rmSync(sbx, { recursive: true, force: true });
  } finally {
    if (prior === undefined) delete process.env.COORD_TEST_ISOLATION_RUNTIME;
    else process.env.COORD_TEST_ISOLATION_RUNTIME = prior;
  }
});
