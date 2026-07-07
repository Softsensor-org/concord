"use strict";

// COORD-290 / COORD-299: Hard test-harness isolation guard.
//
// Tests that mutate coord/ fixtures MUST run in isolated temp dirs / sandboxes
// via the __testing.paths path-override registry (os.tmpdir() + state.paths) —
// NEVER against the live governed runtime. Writing transient fixtures under the
// SEALED coord/ tree (e.g. coord/prompts/tickets/*.tmp, re-rendered
// coord/rendered/*) trips the COORD-220 out-of-band seal + COORD-222 co-located
// guard for the NEXT governed command during concurrent governed mutations.
//
// This module is an in-flight write interceptor: load it as a `--require`
// preload for the node:test workers (see coord/scripts/check-test-isolation.sh)
// and any fs write that RESOLVES under a guarded live coord/ surface — outside
// the documented allowlist — throws immediately, pinpointing the offending test.
// It catches transient writes too (write-then-restore helpers), which a
// post-suite `git status` check cannot see.
//
// Two guarded classes:
//   1. SEAL surfaces (COORD-290, always fail-closed): the TRACKED, seal-sensitive
//      coordination surfaces — coord/prompts/**, coord/rendered/**.
//   2. LIVE-RUNTIME class (COORD-299, fail-closed by default; stageable): the
//      gitignored shared-worktree runtime — coord/.runtime/**, the directory
//      locks coord/.coord-state.lock + coord/.agent-state.lock, and
//      coord/memory/**. Tests that run governed mutations must sandbox the FULL
//      runtime (RUNTIME_DIR + the two state-lock dirs + memory) via __testing.paths.
//      Controlled by COORD_TEST_ISOLATION_RUNTIME: "enforce" (default) | "detect"
//      (record offenders to COORD_TEST_ISOLATION_REPORT, do not throw) | "off".
//
// The guard instruments the TEST process only (it is preloaded by the test
// runner, never by production `gov`), so real governed journal/lock/memory
// writes are unaffected. See coord/product/TESTING_AND_GATES.md.

const fs = require("node:fs");
const path = require("node:path");

const COORD_DIR = path.resolve(__dirname, "..");

// --- Class 1: tracked seal surfaces (COORD-290). Always fail-closed. ---------
const GUARDED_PREFIXES = [
  path.join(COORD_DIR, "prompts"),
  path.join(COORD_DIR, "rendered"),
];

// --- Class 2: live-runtime surfaces (COORD-299). ----------------------------
// .coord-state.lock / .agent-state.lock are directory locks directly under
// coord/; .runtime and memory are subtrees. All are gitignored runtime state.
const RUNTIME_GUARDED_PREFIXES = [
  path.join(COORD_DIR, ".runtime"),
  path.join(COORD_DIR, ".coord-state.lock"),
  path.join(COORD_DIR, ".agent-state.lock"),
  path.join(COORD_DIR, "memory"),
];

// Documented ALLOWLIST (seal class): legitimate live-path writes.
// `withCanonicalTicketPrompt` (governance-test-utils.js) provisions the REAL
// canonical ticket prompt on disk to exercise canonical path resolution
// (defaultTicketPromptRelPath / ticketPromptRelPathExists, which resolve against
// the real repo root, not the overridable PROMPTS_DIR). It only writes in a
// STRIPPED public checkout where the prompt is missing, and removes only what it
// created. In the donor checkout these prompts already exist, so the helper is a
// no-op. Keep this list tiny and conservative — prefer sandboxing over allowlisting.
const ALLOWLIST = new Set([
  path.join(COORD_DIR, "prompts", "tickets", "COORD-023.md"),
  path.join(COORD_DIR, "prompts", "tickets", "COORD-024.md"),
]);

// Documented path ALLOWLIST (runtime class, COORD-299): genuine end-to-end
// integration tests that MUST exercise a specific real live runtime path and cannot
// be sandboxed without losing the thing under test. Each entry is a repo-relative
// live path. Keep conservative — prefer sandboxing. (Empty: the residual offenders
// are handled by the coarser per-FILE allowlist below, pending the follow-up.)
const RUNTIME_ALLOWLIST = new Set([
  // (none yet — see RUNTIME_ALLOWLIST_FILES + the COORD-300 follow-up)
]);

// Documented per-FILE allowlist (runtime class, COORD-299): test files (or spawned
// worker scripts) whose live-runtime writes are not yet sandboxed. The guard
// FAILS-CLOSED on the live-runtime class for every file OUTSIDE this list, so no NEW
// offender can regress in. Matched by basename against any entry in process.argv
// (covers both the .test.js worker and any child worker script it spawns under the
// guard).
//
// COORD-300: this list is now EMPTY. COORD-299 sandboxed the ~19 incidental
// coarse-lock offenders; COORD-300 drained the last residual content offenders so
// EVERY test file is fully fail-closed under the live-runtime class. How each was
// drained (keep this map — it documents the sandbox seam each relies on):
//   - recall.test.js + memory-eval.test.js: recall.js/memory-eval.js resolve the
//     decisions corpus from the governed, sandboxable state.MEMORY_DIR at call
//     time; both tests redirect it via sandboxProcessRuntimeLocks().
//   - board-rebuild.test.js + agent-commands.test.js + governance.test.js: redirect
//     the FULL runtime surface (RUNTIME_DIR + agent registry/sessions + coarse locks
//     + plan-records) to an os.tmpdir() sandbox via sandboxProcessRuntime(), which
//     seeds the sandbox registry from the live handle list so real-handle lookups
//     still resolve while writes stay in tmp.
//   - journal.test.js: the conformance keypair home now resolves from the governed
//     RUNTIME_DIR (lifecycle.js injects resolveRuntimeDir -> state.RUNTIME_DIR into
//     createConformanceAttestation), so `gov conform` / chain-migration signing write
//     keys into the per-test withJournalSandbox; the light sandboxProcessRuntimeLocks()
//     covers the stray coarse-lock writes.
//   - concurrent-burnin.test.js + concurrent-burnin-worker.js: the burn-in sandbox now
//     binds the two coarse directory locks (COORD/AGENT_STATE_LOCK_DIR) at the SHARED
//     sandbox root, so the N worker forks contend on a sandboxed cross-process mutex
//     instead of the live coord/.coord-state.lock + .agent-state.lock.
//   - gate-proc-registry.test.js + gate-proc-registry.js: the test already sandboxed
//     its gate-procs dir in os.tmpdir() and only spawns a throwaway child, so it
//     never wrote the live runtime — the allowlist entry was precautionary.
const RUNTIME_ALLOWLIST_FILES = new Set([]);

let runtimeAllowlistedProcessCache = null;
// Is the CURRENT process an allowlisted runtime-class test/worker? Memoized;
// matched by basename of any argv entry (the test runner worker or a spawned child).
function isRuntimeAllowlistedProcess() {
  if (runtimeAllowlistedProcessCache !== null) return runtimeAllowlistedProcessCache;
  const argv = Array.isArray(process.argv) ? process.argv : [];
  runtimeAllowlistedProcessCache = argv.some((a) => {
    if (typeof a !== "string") return false;
    return RUNTIME_ALLOWLIST_FILES.has(path.basename(a));
  });
  return runtimeAllowlistedProcessCache;
}

function resolveTarget(p) {
  if (typeof p === "number") return null; // fd-based write; path already opened/checked
  let s;
  if (Buffer.isBuffer(p)) s = p.toString();
  else if (p instanceof URL) s = p.pathname;
  else if (typeof p === "string") s = p;
  else return null;
  if (!s) return null;
  return path.resolve(s);
}

function underAnyPrefix(abs, prefixes) {
  return prefixes.some(
    (prefix) => abs === prefix || abs.startsWith(prefix + path.sep)
  );
}

function isUnderGuarded(abs) {
  return underAnyPrefix(abs, GUARDED_PREFIXES);
}

function isUnderRuntimeGuarded(abs) {
  return underAnyPrefix(abs, RUNTIME_GUARDED_PREFIXES);
}

// Pure classifier (unit-tested): is this absolute path a SEAL-class violation?
function isViolation(abs) {
  if (!abs) return false;
  if (!isUnderGuarded(abs)) return false;
  if (ALLOWLIST.has(abs)) return false;
  return true;
}

// Pure classifier (unit-tested): is this absolute path a RUNTIME-class violation?
function isRuntimeViolation(abs) {
  if (!abs) return false;
  if (!isUnderRuntimeGuarded(abs)) return false;
  if (RUNTIME_ALLOWLIST.has(abs)) return false;
  return true;
}

function flagsAreWrite(flags) {
  if (flags === undefined || flags === null) return true; // openSync default 'r' handled by caller
  const f = String(flags);
  return /[wa+]/.test(f);
}

// COORD-299: runtime-class enforcement mode (the seal class is ALWAYS enforced).
//   enforce (default) | detect | off
function runtimeMode() {
  const v = (process.env.COORD_TEST_ISOLATION_RUNTIME || "enforce").toLowerCase();
  if (v === "detect" || v === "off") return v;
  return "enforce";
}

let installed = false;

function relFromRoot(abs) {
  return path.relative(path.dirname(COORD_DIR), abs);
}

function sealViolationError(op, abs) {
  const rel = relFromRoot(abs);
  const err = new Error(
    `[test-isolation-guard] BLOCKED ${op} under the live coord/ tree: ${rel}\n` +
      `Tests must not write under coord/prompts/** or coord/rendered/**. ` +
      `Use os.tmpdir() + the __testing.paths override (e.g. PROMPTS_DIR / RENDERED_DIR) ` +
      `to sandbox the write. See coord/product/TESTING_AND_GATES.md (COORD-290).`
  );
  err.code = "ETESTISOLATION";
  throw err;
}

function runtimeViolationError(op, abs) {
  const rel = relFromRoot(abs);
  const err = new Error(
    `[test-isolation-guard] BLOCKED ${op} under the live coord/ runtime: ${rel}\n` +
      `Tests must not write under coord/.runtime/**, coord/.coord-state.lock, ` +
      `coord/.agent-state.lock, or coord/memory/**. Sandbox the FULL runtime via the ` +
      `__testing.paths override (RUNTIME_DIR + GOVERNANCE_EVENT_* + COORD_STATE_LOCK_DIR + ` +
      `AGENT_STATE_LOCK_DIR + MEMORY_DIR) at an os.tmpdir() dir, or add a documented ` +
      `RUNTIME_ALLOWLIST entry for a genuine integration test. ` +
      `See coord/product/TESTING_AND_GATES.md (COORD-299).`
  );
  err.code = "ETESTISOLATION";
  throw err;
}

// detect-mode sink: append one JSON line per offending write to the report file,
// so a single serial pass enumerates every offender (test file + path) without
// failing. The report path lives OUTSIDE the guarded tree (an os.tmpdir() file).
function recordDetection(op, abs) {
  const report = process.env.COORD_TEST_ISOLATION_REPORT;
  if (!report) return;
  try {
    const entry = {
      op,
      path: relFromRoot(abs),
      argv: process.argv.slice(1),
      pid: process.pid,
    };
    fs.appendFileSync(report, JSON.stringify(entry) + "\n");
  } catch {
    // never let detection bookkeeping break the test run
  }
}

// Runtime-class check (staged enforcement).
function checkRuntime(op, abs) {
  if (!isRuntimeViolation(abs)) return;
  const mode = runtimeMode();
  if (mode === "off") return;
  if (mode === "detect") {
    // In detect mode we record EVERY offender (including allowlisted ones) so the
    // enumeration is complete; enforcement is what the allowlist exempts.
    recordDetection(op, abs);
    return;
  }
  // enforce: exempt the documented per-file allowlist (tracked by COORD-300).
  if (isRuntimeAllowlistedProcess()) return;
  runtimeViolationError(op, abs);
}

// Central check for a single resolved write target (both classes).
function checkTarget(op, abs) {
  if (!abs) return;
  // Class 1: seal surfaces — always fail-closed (COORD-290 behavior unchanged).
  if (isViolation(abs)) sealViolationError(op, abs);
  // Class 2: live runtime — staged enforcement (COORD-299).
  checkRuntime(op, abs);
}

function install() {
  if (installed) return;
  installed = true;

  // Content-mutating sync ops keyed by argument index of the path.
  const pathFirst = [
    "writeFileSync",
    "appendFileSync",
    "copyFileSync",
    "rmSync",
    "unlinkSync",
    "rmdirSync",
    "createWriteStream",
    "writeFile",
    "appendFile",
  ];
  for (const name of pathFirst) {
    const orig = fs[name];
    if (typeof orig !== "function") continue;
    fs[name] = function guarded(p, ...rest) {
      const abs = resolveTarget(p);
      checkTarget(name, abs);
      return orig.apply(this, [p, ...rest]);
    };
  }

  // mkdirSync: the directory-lock acquisition path (coord-state / agent-state /
  // governance.lock) and runtime-subdir creation. RUNTIME class only — the seal
  // class stays byte-identical to COORD-290 (no mkdir interception there).
  const origMkdirSync = fs.mkdirSync;
  if (typeof origMkdirSync === "function") {
    fs.mkdirSync = function guarded(p, ...rest) {
      const abs = resolveTarget(p);
      if (abs) checkRuntime("mkdirSync", abs);
      return origMkdirSync.apply(this, [p, ...rest]);
    };
  }

  // rename / cp take (src, dest); the DEST is what gets written.
  for (const name of ["renameSync", "cpSync", "rename", "cp"]) {
    const orig = fs[name];
    if (typeof orig !== "function") continue;
    fs[name] = function guarded(src, dest, ...rest) {
      const abs = resolveTarget(dest);
      checkTarget(name, abs);
      return orig.apply(this, [src, dest, ...rest]);
    };
  }

  // openSync only counts when opened for write/append.
  const origOpenSync = fs.openSync;
  if (typeof origOpenSync === "function") {
    fs.openSync = function guarded(p, flags, ...rest) {
      const abs = resolveTarget(p);
      if (abs && flagsAreWrite(flags) && flags !== undefined) {
        checkTarget("openSync", abs);
      }
      return origOpenSync.apply(this, [p, flags, ...rest]);
    };
  }
}

if (require.main !== module && process.env.COORD_TEST_ISOLATION_GUARD !== "0") {
  // Loaded as a preload (`--require`). Self-install.
  install();
}

module.exports = {
  COORD_DIR,
  GUARDED_PREFIXES,
  RUNTIME_GUARDED_PREFIXES,
  ALLOWLIST,
  RUNTIME_ALLOWLIST,
  RUNTIME_ALLOWLIST_FILES,
  resolveTarget,
  isUnderGuarded,
  isUnderRuntimeGuarded,
  isViolation,
  isRuntimeViolation,
  isRuntimeAllowlistedProcess,
  flagsAreWrite,
  runtimeMode,
  install,
};
