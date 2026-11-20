"use strict";

// Probe evaluation is isolated from the dispatch planner. A prompt or sidecar
// may declare probes, but only a direct, opted-in precheck can run commands.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PRECHECK_PROBE_TIMEOUT_MS = 30 * 1000;
const PRECHECK_GREP_MAX_BYTES = 1024 * 1024;
const PRECHECK_GREP_MAX_PATTERN = 4096;

function probeTimeoutMs(probe) {
  const requested = Number(probe.timeout_ms);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, PRECHECK_PROBE_TIMEOUT_MS)
    : PRECHECK_PROBE_TIMEOUT_MS;
}

function createPrecheckProbes({ rootDir, tokenizeShellWords }) {
  function runPrecheckProbe(probe, options = {}) {
    // Returns { passed: bool, detail, error? }. Never throws. Command probes
    // require an explicit opt-in from the direct CLI; dispatch never opts in.
    const expect = probe && probe.expect ? String(probe.expect) : null;
    try {
      if (!probe || typeof probe !== "object" || !probe.type) {
        return { passed: false, detail: "invalid probe (missing type)", error: "schema" };
      }
      if (probe.type === "file-exists") {
        const target = path.isAbsolute(probe.path || "") ? probe.path : path.join(rootDir, probe.path || "");
        const exists = !!(probe.path && fs.existsSync(target));
        const want = expect === "absent" ? !exists : exists;
        return { passed: want, detail: `file-exists ${probe.path}: ${exists ? "present" : "absent"}` };
      }
      if (probe.type === "grep") {
        if (!probe.pattern || !probe.path) {
          return { passed: false, detail: "grep probe requires pattern and path", error: "schema" };
        }
        if (typeof probe.pattern !== "string" || probe.pattern.length > PRECHECK_GREP_MAX_PATTERN) {
          return { passed: false, detail: "grep pattern must be a short literal string", error: "schema" };
        }
        const target = path.isAbsolute(probe.path) ? probe.path : path.join(rootDir, probe.path);
        if (!fs.existsSync(target)) {
          const want = expect === "absent";
          return { passed: want, detail: `grep ${probe.pattern} @ ${probe.path}: file missing` };
        }
        const stats = fs.statSync(target);
        if (!stats.isFile() || stats.size > PRECHECK_GREP_MAX_BYTES) {
          return { passed: false, detail: `grep ${probe.pattern} @ ${probe.path}: not a bounded regular file`, error: "input_too_large" };
        }
        const content = fs.readFileSync(target, "utf8");
        const found = content.includes(probe.pattern);
        const want = expect === "absent" ? !found : found;
        return { passed: want, detail: `grep ${probe.pattern} @ ${probe.path}: ${found ? "match" : "no-match"}` };
      }
      if (probe.type === "test") {
        if (!probe.command) {
          return { passed: false, detail: "test probe requires command", error: "schema" };
        }
        if (!options.allowCommandProbes) {
          return { passed: false, detail: "test probe requires explicit --allow-command-probes", error: "command_probe_disabled" };
        }
        const argv = tokenizeShellWords(probe.command);
        if (argv.length === 0) {
          return { passed: false, detail: "test probe requires a nonempty command", error: "schema" };
        }
        const result = spawnSync(argv[0], argv.slice(1), {
          cwd: rootDir,
          shell: false,
          encoding: "utf8",
          timeout: probeTimeoutMs(probe),
        });
        if (result.error && result.error.code === "ETIMEDOUT") {
          return { passed: false, detail: `test timed out: ${probe.command}`, error: "timeout" };
        }
        if (result.error) {
          return { passed: false, detail: `test unavailable: ${result.error.message}`, error: "unavailable" };
        }
        const exit = typeof result.status === "number" ? result.status : 1;
        const passed = expect === "fail" ? exit !== 0 : exit === 0;
        return { passed, detail: `test "${probe.command}" exit=${exit}` };
      }
      if (probe.type === "git-contains") {
        if (!probe.repo || !probe.ref || !probe.commit) {
          return { passed: false, detail: "git-contains probe requires repo, ref, and commit", error: "schema" };
        }
        const repo = path.isAbsolute(probe.repo) ? probe.repo : path.join(rootDir, probe.repo);
        const object = spawnSync("git", ["-C", repo, "cat-file", "-e", `${probe.ref}^{commit}`], {
          encoding: "utf8", timeout: probeTimeoutMs(probe),
        });
        const ancestry = object.status === 0
          ? spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", probe.commit, probe.ref], {
            encoding: "utf8", timeout: probeTimeoutMs(probe),
          })
          : object;
        const passed = ancestry.status === 0;
        const unavailable = object.status !== 0 || ancestry.error?.code === "ETIMEDOUT";
        return {
          passed,
          detail: `git-contains ${probe.commit} in ${probe.repo}@${probe.ref}: ${passed ? "yes" : unavailable ? "unavailable" : "confirmed non-ancestor"}`,
          ...(unavailable ? { error: ancestry.error?.code === "ETIMEDOUT" ? "timeout" : "unavailable_ref" } : {}),
        };
      }
      return { passed: false, detail: `unknown probe type "${probe.type}"`, error: "schema" };
    } catch (error) {
      return { passed: false, detail: `probe error: ${error.message}`, error: "exception" };
    }
  }

return { runPrecheckProbe };
}

module.exports = createPrecheckProbes;
