"use strict";

// COORD-718: source-mutation proof that the identity checks, commit binding,
// writer-to-readiness wiring and the QUESTIONS/self-review presentation
// contract are load-bearing. Each mutant rewrites ONE production source line
// at load time (a --require hook; nothing on disk changes) and reruns the
// production-path test that guards it. A mutant must make that test fail; the
// same test must pass unmutated (control), so a kill is never a broken test.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const COORD = path.resolve(__dirname, "..", "..");
const ROOT = path.dirname(COORD);
const at = (relative) => path.join(ROOT, relative);
const UNIT = at("coord/engine/scripts/independent-reviews.test.js");
const CLI = at("coord/engine/scripts/independent-review-command.test.js");
const SURFACES = at("coord/scripts/independent-review-projections.test.js");
const UI = at("frontend/apps/coord-ui/lib/plan-evidence.test.js");

const HOOK = `
const Module = require("node:module");
const fs = require("node:fs");
const mutant = JSON.parse(process.env.C718_MUTANT);
const compile = Module._extensions[".js"];
Module._extensions[".js"] = function (module, filename) {
  if (filename !== mutant.file) return compile(module, filename);
  const source = fs.readFileSync(filename, "utf8");
  const count = source.split(mutant.from).length - 1;
  if (count !== 1) throw new Error("mutant anchor matched " + count + " times in " + filename);
  fs.writeFileSync(mutant.marker, "applied");
  module._compile(source.replace(mutant.from, mutant.to), filename);
};
`;

// ES modules (the cockpit helper) are rewritten by a load hook instead.
const ESM_LOADER = `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const mutant = JSON.parse(process.env.C718_MUTANT);
const target = pathToFileURL(mutant.file).href;
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== target || result.format !== "module") return result;
  const source = String(result.source);
  const count = source.split(mutant.from).length - 1;
  if (count !== 1) throw new Error("mutant anchor matched " + count + " times in " + url);
  fs.writeFileSync(mutant.marker, "applied");
  return { ...result, source: source.replace(mutant.from, mutant.to) };
}
`;

// [name, file, from, to, guarding test file, test-name pattern]
const MUTANTS = [
  ["writer drops the owner check", "coord/engine/scripts/independent-review-command.js",
    "if (owner === agent.handle) {", "if (false) {", CLI, "owner, unbound"],
  ["schema accepts reviews without session or thread evidence", "coord/engine/scripts/independent-reviews.js",
    "if (!reviewer.session_id && !reviewer.thread_id) fail(", "if (false) fail(", UNIT, "reviewer and owner stay distinguishable"],
  ["readiness counts a review by the current owner", "coord/engine/scripts/independent-reviews.js",
    'if (owner && owner === entry.reviewer.handle) return "reviewer_is_owner";', "", UNIT, "only canonical exact-commit"],
  ["writer skips reviewed-commit existence", "coord/engine/scripts/independent-review-command.js",
    "if (!gitCommitExists(root, commit)) {", "if (false) {", CLI, "owner, unbound"],
  ["currency ignores the reviewed commit", "coord/engine/scripts/independent-reviews.js",
    'return entry.commit === scope.commit ? "current" : "stale_head";', 'return "current";', CLI, "moved head"],
  ["currency ignores the reviewed repository", "coord/engine/scripts/independent-reviews.js",
    'if (entry.repository !== scope.repository) return "other_repository";', "", UNIT, "only canonical exact-commit"],
  ["readiness bypasses the writer's ledger", "coord/engine/scripts/governance-readiness.js",
    "independent_reviews: deriveIndependentReviewReadiness(ticketId, row, board, lock, planState),",
    "independent_reviews: projectIndependentReviews({}, {}),", CLI, "bound non-owner reviewer records"],
  ["canonical writer drops the review", "coord/engine/scripts/plan-evidence-supersession.js",
    "if (options.independentReview !== undefined) independentReviews.applyIndependentReviewToRecord(record, options);", "", CLI, "bound non-owner reviewer records"],
  ["conflicting reuse overwrites silently", "coord/engine/scripts/independent-reviews.js",
    "if (isIdenticalIndependentReview(record, review)) return { record, review, changed: false };", "return { record, review, changed: false };", CLI, "identical retry"],
  ["closeout renders an empty review section beside a QUESTIONS claim", "coord/engine/scripts/closeout-summary.js",
    "  if (!trail.counts.total) return;\n", "", SURFACES, "QUESTIONS.md review claim"],
  ["cockpit shows historical reviews as current", "frontend/apps/coord-ui/lib/plan-evidence.js",
    "current: projection.current.map(row),", "current: [...projection.current, ...projection.historical].map(row),", UI, "split into current and historical"],
];

function runGuard(testFile, pattern, mutant) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c718-mutant-"));
  const hook = path.join(dir, "hook.cjs");
  const loader = path.join(dir, "loader.mjs");
  const register = path.join(dir, "register.mjs");
  const marker = path.join(dir, "applied");
  fs.writeFileSync(hook, HOOK);
  fs.writeFileSync(loader, ESM_LOADER);
  fs.writeFileSync(register, `import { register } from "node:module";\nregister(${JSON.stringify(require("node:url").pathToFileURL(loader).href)});\n`);
  const env = { ...process.env };
  for (const key of ["COORD_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "NODE_TEST_CONTEXT"]) delete env[key];
  // A mutant must never reach the suite's coverage: point any V8 coverage the
  // child writes at this throwaway directory instead of the runner's.
  env.NODE_V8_COVERAGE = path.join(dir, "v8-coverage");
  const args = [`--test-name-pattern=${pattern}`, testFile];
  if (mutant) {
    env.C718_MUTANT = JSON.stringify({ ...mutant, file: at(mutant.file), marker });
    args.unshift("--require", hook, "--import", require("node:url").pathToFileURL(register).href);
  }
  try {
    const result = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
    // Node 22 prints the TAP summary ("# pass 1"), Node 24 the spec one ("ℹ pass 1").
    const passed = /^(?:ℹ|#) pass [1-9]/m.test(result.stdout) && /^(?:ℹ|#) fail 0$/m.test(result.stdout);
    return { status: result.status, passed, applied: fs.existsSync(marker), output: `${result.stdout}\n${result.stderr}`.slice(-2000) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("COORD-718: every mutant anchor matches its live production source exactly once", () => {
  for (const [name, file, from] of MUTANTS) {
    const source = fs.readFileSync(at(file), "utf8");
    assert.equal(source.split(from).length - 1, 1, `${name}: anchor must match ${file} exactly once`);
  }
});

test("COORD-718: guarding tests pass unmutated and fail under each mutant", { timeout: 600_000 }, () => {
  const guards = new Map(MUTANTS.map(([, , , , testFile, pattern]) => [`${testFile}\0${pattern}`, [testFile, pattern]]));
  for (const [testFile, pattern] of guards.values()) {
    const control = runGuard(testFile, pattern, null);
    assert.ok(control.status === 0 && control.passed, `control ${path.basename(testFile)} /${pattern}/ must pass unmutated:\n${control.output}`);
  }
  const survivors = [];
  for (const [name, file, from, to, testFile, pattern] of MUTANTS) {
    const result = runGuard(testFile, pattern, { file, from, to });
    assert.ok(result.applied, `${name}: the mutant was never loaded by ${path.basename(testFile)}`);
    if (result.status === 0) survivors.push(name);
  }
  assert.deepEqual(survivors, [], "every mutant must be killed by its production-path guard");
});
