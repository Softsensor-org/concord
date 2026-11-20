"use strict";

// COORD-906: fast test-title registration precheck for targeted test runs,
// `gov commit` and `gov submit`.
//
// The donor workspace keeps release/suite-inventory.json, the reviewed list of
// every test title each edition ships, and release/suite-titles.js, which
// checks changed test files against it in seconds. Without this precheck an
// unregistered title surfaced only at the dual-release hygiene gate. The
// check runs in a child process so the engine never loads release tooling.
// Where release/ is absent (every adopter install and every cut), this is a
// no-op: there is no title inventory to keep in step.
//
// The full release check (suite-inventory.js verify on built cuts) stays the
// authoritative comparison.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join("release", "suite-titles.js");
const MANIFEST = path.join("release", "suite-inventory.json");
const MANIFEST_POSIX = "release/suite-inventory.json";
const SCRUBBED = ["NODE_TEST_CONTEXT", "NODE_V8_COVERAGE"];

function available(root) {
  return Boolean(root) && fs.existsSync(path.join(root, SCRIPT)) && fs.existsSync(path.join(root, MANIFEST));
}

// Run the title check in `root`. `files` are root-relative paths; only
// *.test.js files count. `changedSince` adds every test file changed since
// the merge base with that ref. `manifestFile` overrides the manifest read.
// Returns { ok, skipped?, output }.
function runTitlePrecheck({ root, files = [], changedSince = null, manifestFile = null, spawn = spawnSync } = {}) {
  if (!available(root)) return { ok: true, skipped: "no release suite inventory in this workspace", output: "" };
  const tests = files.filter((file) => file.endsWith(".test.js"));
  if (!tests.length && !changedSince) return { ok: true, skipped: "no test files changed", output: "" };
  const env = { ...process.env };
  for (const key of SCRUBBED) delete env[key];
  const args = [path.join(root, SCRIPT), "check"];
  if (changedSince) args.push("--changed", changedSince);
  if (manifestFile) args.push("--manifest", manifestFile);
  const child = spawn(process.execPath, [...args, "--", ...tests], { cwd: root, env, encoding: "utf8" });
  const output = `${child.stdout || ""}${child.stderr || ""}${child.error ? `${child.error.message}\n` : ""}`;
  return { ok: child.status === 0, output };
}

// The precheck a targeted runner run does: tracked test files only. An
// untracked file is an ad-hoc probe until it is committed, and `gov commit`
// checks it then; the skipped files are named, never silently dropped.
function runnerTitlePrecheck({ root, files, spawn = spawnSync }) {
  const tests = files.filter((file) => file.endsWith(".test.js"));
  if (!available(root) || !tests.length) return runTitlePrecheck({ root, files: tests, spawn });
  const listed = spawn("git", ["ls-files", "-z", "--", ...tests], { cwd: root, encoding: "utf8" });
  if (listed.status !== 0) return runTitlePrecheck({ root, files: tests, spawn });
  const tracked = new Set(String(listed.stdout).split("\0").filter(Boolean));
  const untracked = tests.filter((file) => !tracked.has(file));
  const result = runTitlePrecheck({ root, files: tests.filter((file) => tracked.has(file)), spawn });
  return { ...result, untracked };
}

// The precheck a commit runs: titles are compared with the manifest as it
// will be committed. A manifest edit that is not part of the commit does not
// count, so the index copy is used unless the commit stages the manifest.
function commitTitlePrecheck({ root, stagedFiles, gitTry, tmpDir, spawn = spawnSync }) {
  if (!available(root) || !stagedFiles.some((file) => file.endsWith(".test.js"))) {
    return runTitlePrecheck({ root, files: stagedFiles, spawn });
  }
  if (stagedFiles.includes(MANIFEST_POSIX)) return runTitlePrecheck({ root, files: stagedFiles, spawn });
  const indexed = gitTry(root, ["show", `:${MANIFEST_POSIX}`]);
  if (indexed.status !== 0) return runTitlePrecheck({ root, files: stagedFiles, spawn });
  const dir = fs.mkdtempSync(path.join(tmpDir, "concord-title-manifest-"));
  try {
    const manifestFile = path.join(dir, "suite-inventory.json");
    fs.writeFileSync(manifestFile, indexed.stdout);
    return runTitlePrecheck({ root, files: stagedFiles, manifestFile, spawn });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The precheck a submit runs: every test file the ticket changed since its
// base, resolved by the rule gov start uses (resolveWorktreeBaseCompareRef in
// lifecycle-ticket-admin.js; COORD-898 tracks one shared resolver): prefer
// origin/<base>, fall back to the local <base>. When neither resolves, this
// early warning warns and lets submit continue; the release check stays
// authoritative.
function submitTitlePrecheck({ root, base, spawn = spawnSync }) {
  if (!available(root) || !base) return { ok: true, skipped: "no release suite inventory or ticket base", output: "" };
  const resolves = (ref) => spawn("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, encoding: "utf8" }).status === 0;
  const ref = [`origin/${base}`, base].find(resolves);
  if (!ref) {
    return {
      ok: true, skipped: "ticket base unresolved", output: "",
      warning: `title precheck skipped: neither origin/${base} nor ${base} resolves in ${root}; the release suite inventory check still applies`,
    };
  }
  return runTitlePrecheck({ root, changedSince: ref, spawn });
}

function refusal(subject, result) {
  return `${subject} refused: changed test titles are not registered for both editions.\n${result.output.trimEnd()}\n` +
    "Register them with the fix shown, then retry.";
}

module.exports = { available, commitTitlePrecheck, refusal, runTitlePrecheck, runnerTitlePrecheck, submitTitlePrecheck };
