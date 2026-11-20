"use strict";

const { spawnSync } = require("node:child_process");

// COORD-902: merge-tree's modern --write-tree mode and --no-messages option
// first ship together in Git 2.38.0. Closeout previews depend on that exact
// mode; keep this version requirement in one place for every public entrypoint.
const REQUIRED_GIT_VERSION = Object.freeze({ major: 2, minor: 38, patch: 0 });
const REQUIRED_GIT_TEXT = Object.values(REQUIRED_GIT_VERSION).join(".");

function parseGitVersion(output) {
  const match = /^git version (\d+)\.(\d+)\.(\d+)(?:[^\d\r\n][^\r\n]*)?$/.exec(String(output || "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareGitVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

function defaultGitVersionProbe() {
  return spawnSync("git", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
}

function checkGitPrerequisite({ probe = defaultGitVersionProbe } = {}) {
  let result;
  try {
    result = probe();
  } catch (error) {
    result = { status: null, stderr: error && error.message ? error.message : String(error) };
  }
  const output = String(result?.stdout || "").trim();
  const parsed = result?.status === 0 ? parseGitVersion(output) : null;
  const found = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
  const ok = parsed !== null && compareGitVersions(parsed, REQUIRED_GIT_VERSION) >= 0;
  const detail = result?.error?.message || String(result?.stderr || "").trim();
  const diagnostic = ok
    ? null
    : `Git ${REQUIRED_GIT_TEXT} or newer is required for merge-tree --write-tree --no-messages; found ${found || "unavailable"}${detail ? ` (${detail})` : result?.signal ? ` (probe ended with ${result.signal})` : ""}.`;
  return { ok, found, required: REQUIRED_GIT_TEXT, diagnostic };
}

function main({ probe } = {}) {
  const result = checkGitPrerequisite({ probe });
  if (result.ok) {
    process.stdout.write(`Git prerequisite OK: found ${result.found}; required ${result.required}.\n`);
    return 0;
  }
  process.stderr.write(`${result.diagnostic}\n`);
  return 1;
}

module.exports = { REQUIRED_GIT_TEXT, checkGitPrerequisite, compareGitVersions, main, parseGitVersion };

if (require.main === module) process.exitCode = main();
