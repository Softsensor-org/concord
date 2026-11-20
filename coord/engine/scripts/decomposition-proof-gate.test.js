"use strict";
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { collectDecompositionProofIssues } = require("./decomposition-proof-gate.js");
const { evidenceRef, stableSupersessionId } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/plan-evidence-supersession.js"));
const { DEFAULT_CONFIG } = require("./arch-checks.js");
const { countLoc } = require("./arch-checks.js");
const countLocOf = (text) => countLoc(text).loc;
const file = "coord/engine/scripts/lifecycle.js", cap = DEFAULT_CONFIG.checks.prodloc.highWater[file];
const { execFileSync } = require("node:child_process");
// COORD-830: with no live lock the gate measures only a named reviewed source
// commit, so fixtures commit the measured file and hand that commit in.
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
// COORD-854 / COORD-856: the fixture dir may hold spaces or shell
// metacharacters, and a printed step quotes it with the shared git-ops
// shellQuote. Tests split the step with a POSIX shell-word splitter, assert
// the argv it names and run that argv, never through a shell.
const { splitPosixShellWords, shellArgv, hostileTempDir } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/fixtures/posix-shell-words.js"));
const { shellQuote } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/git-ops.js"));
function assertPrintedArgv(step, expected) {
  assert.deepEqual(splitPosixShellWords(step), expected, step);
  assert.deepEqual(shellArgv(step), expected, `/bin/sh agrees: ${step}`);
}
function runPrintedGitStep(step, dir) {
  const argv = splitPosixShellWords(step);
  assert.deepEqual(argv.slice(0, 3), ["git", "-C", dir], step);
  execFileSync("git", argv.slice(1), { stdio: "ignore" });
}
function commitFile(root, rel, lines, message = "fixture") {
  if (!fs.existsSync(path.join(root, ".git"))) { fs.mkdirSync(root, { recursive: true }); git(root, "init", "-q"); }
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), "void 0;\n".repeat(lines));
  git(root, "add", "-A"); git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-proof-bound-"));
  fs.mkdirSync(path.join(root, "coord/scripts"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return (after, options = {}) => {
    const sourceCommit = commitFile(root, file, after);
    const before = options.before ?? after + 3, recordedAfter = options.recordedAfter ?? after, budget = options.budget ?? cap;
    return collectDecompositionProofIssues({ ticketId: options.ticket || "TEST-675", row: { Type: "refactor", Description: "composition root decomposition" },
      planState: { feature_proof: [`decomposition-proof: file=${file}; before=${before}; after=${recordedAfter}; claimed_reduction=${before-after}; target_max=${budget}; budget=${budget}; extracted=helper moved into its owning module`] },
      coordDir: path.join(root, "coord"), sourceCommit, resolveReviewedSource: () => ({ sha: sourceCommit, label: "the verified PR head" }) });
  };
}
test("actual decomposition consumer accepts one line of headroom under the unchanged cap", t => {
  assert.deepEqual(fixture(t)(cap - 1), []);
});
test("exact bound passes and exceeding the real cap refuses even with inflated declared proof budget", t => {
  const check = fixture(t); assert.deepEqual(check(cap), []);
  const issues = check(cap + 1, { budget: cap + 10 });
  assert.ok(issues.some(issue => issue.code === "decomposition_proof_invalid"));
  assert.match(issues[0].message, new RegExp(String(cap)));
});
test("two sequential root reductions pass without recalculating or changing a cap", t => {
  const check = fixture(t), snapshot = JSON.stringify(DEFAULT_CONFIG.checks.prodloc.highWater);
  assert.deepEqual(check(cap - 1, { before: cap, ticket: "TEST-FIRST" }), []);
  assert.deepEqual(check(cap - 2, { before: cap - 1, ticket: "TEST-SECOND" }), []);
  assert.equal(JSON.stringify(DEFAULT_CONFIG.checks.prodloc.highWater), snapshot);
});
test("headroom never excuses a stale recorded measurement or an overstated reduction", t => {
  const check = fixture(t);
  assert.ok(check(cap - 2, { recordedAfter: cap - 1 }).some(issue => /does not match computed/.test(issue.message)));
  assert.ok(check(cap - 2, { before: cap - 3 }).some(issue => /lower than computed after/.test(issue.message)));
});

test("decomposition gate does not consume a superseded proof from repo-gate history", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-proof-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), "void 0;\n".repeat(cap));
  const old = `decomposition-proof: file=${file}; before=${cap + 3}; after=${cap}; claimed_reduction=3; target_max=${cap}; budget=${cap}; extracted=old proof`;
  const successor = "TODO: current decomposition proof not supplied";
  const sourceRef = evidenceRef("repo_gate", 1, old);
  const successorRef = evidenceRef("repo_gate", 2, successor);
  const issues = collectDecompositionProofIssues({ ticketId: "TEST-713", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [old, successor], evidence_supersessions: [{ id: stableSupersessionId(sourceRef, successorRef),
      kind: "repo_gate", source_ref: sourceRef, successor_ref: successorRef, reason: "The prior measurement is stale.",
      actor: "fixture", timestamp: "2026-10-05T00:00:00.000Z" }] }, coordDir: path.join(root, "coord") });
  assert.ok(issues.some((issue) => issue.code === "decomposition_proof_missing"));
});

test("decomposition gate reports missing proof for a legacy plan without a plan object", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-proof-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "void 0;\n".repeat(cap));
  const issues = collectDecompositionProofIssues({ ticketId: "TEST-713-LEGACY", row: { Type: "refactor", Description: "slimming work" }, coordDir: path.join(root, "coord") });
  assert.ok(issues.some((issue) => issue.code === "decomposition_proof_missing"));
});

// COORD-826: a repo-X refactor lives in the ticket worktree until it lands, so the
// gate must measure the locked worktree, not the unchanged canonical file.
const createLifecycleFlags = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/lifecycle-flags.js"));
const { createFeatureProofEntryValidator } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/feature-proof-entry-validation.js"));
function workspaceFixture(t, { gitDir = "", lock } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "concord-proof-workspace-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "canonical"), worktree = path.join(base, "worktree"), locksDir = path.join(base, "locks");
  for (const dir of [path.join(root, "coord"), worktree, locksDir]) fs.mkdirSync(dir, { recursive: true });
  if (gitDir !== null) execFileSync("git", ["init", "-q", path.join(root, gitDir)]);
  const write = (dir, rel, lines) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), "void 0;\n".repeat(lines)); };
  if (lock !== undefined) fs.writeFileSync(path.join(locksDir, "TEST-826.lock"), typeof lock === "string" ? lock : JSON.stringify(lock({ worktree })));
  const check = (target, after, repoRoot = path.join(root, "coord")) => collectDecompositionProofIssues({ ticketId: "TEST-826", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: file=${target}; before=${cap}; after=${after}; claimed_reduction=${cap - after}; target_max=${cap}; extracted=helper moved`] },
    coordDir: path.join(root, "coord"), locksDir, repoRoot });
  return { root, worktree, write, check };
}
test("COORD-826: a locked repo-X ticket is measured in its worktree, not the canonical tree", t => {
  const { root, worktree, write, check } = workspaceFixture(t, { lock: ({ worktree }) => ({ ticket: "TEST-826", worktree }) });
  write(root, file, cap); write(worktree, file, cap - 68);
  assert.deepEqual(check(file, cap - 68), []);
  const stale = check(file, cap);
  assert.ok(stale.some(issue => issue.message.includes(`does not match computed countLoc=${cap - 68}`) && issue.message.includes(worktree)), JSON.stringify(stale));
});
test("COORD-826: a repo-backed ticket is measured in its own repo worktree", t => {
  const { root, worktree, write, check } = workspaceFixture(t, { gitDir: "backend", lock: ({ worktree }) => ({ worktree }) });
  write(root, "backend/src/app.js", cap); write(worktree, "src/app.js", cap - 5);
  assert.deepEqual(check("backend/src/app.js", cap - 5, path.join(root, "backend")), []);
});
test("COORD-830: without a live ticket workspace or source commit the canonical tree is never measured", t => {
  for (const lock of [undefined, "{not json", () => ({ ticket: "TEST-826" }), () => ({ worktree: "/nonexistent/concord-826-worktree" })]) {
    const { root, write, check } = workspaceFixture(t, { gitDir: null, lock });
    write(root, file, cap - 2);
    const issues = check(file, cap - 2);
    assert.deepEqual(issues.map(issue => issue.code), ["decomposition_proof_source_unavailable"], String(lock));
    assert.match(issues[0].message, /no live lock and no reviewed source commit/);
    assert.ok(issues[0].next_steps.some(step => step.includes("finalize TEST-826 --source-commit")), String(lock));
  }
});
test("COORD-826: a ticket repo dir that Git cannot resolve is treated as its own checkout root", t => {
  const { root, worktree, write } = workspaceFixture(t, { gitDir: null, lock: ({ worktree }) => ({ worktree }) });
  write(root, file, cap); write(worktree, "engine/scripts/lifecycle.js", cap - 4);
  const issues = collectDecompositionProofIssues({ ticketId: "TEST-826", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: path=${file}; before=${cap}; after=${cap - 4}; claimed_reduction=4; extracted=helper moved`] },
    coordDir: path.join(root, "coord"), locksDir: path.join(path.dirname(root), "locks") });
  assert.deepEqual(issues, []);
});
test("COORD-826: re-measured proofs still refuse missing targets and overstated claims", t => {
  const { root, worktree, write } = workspaceFixture(t, { lock: ({ worktree }) => ({ worktree }) });
  write(worktree, file, cap - 10);
  const proofs = [
    "decomposition-proof: before=10; after=5; claimed_reduction=5; budget=5; extracted=helper moved",
    `decomposition-proof: target=${file}; before=${cap}; after=${cap - 10}; claimed_reduction=20; target_max=${cap - 11}; budget=${cap - 12}; extracted=helper moved`,
    "decomposition-proof: file=coord/scripts/absent.js; before=10; after=5; claimed_reduction=5; budget=5; extracted=helper moved",
  ];
  const issues = collectDecompositionProofIssues({ ticketId: "TEST-826", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: proofs }, coordDir: path.join(root, "coord"), locksDir: path.join(path.dirname(root), "locks"), repoRoot: path.join(root, "coord") });
  assert.equal(issues.length, 3);
  assert.match(issues[0].message, /file=<repo-relative target> is required/);
  assert.match(issues[0].next_steps[1], /--repo-gate "decomposition-proof: file=<repo-relative target>;/);
  assert.match(issues[1].message, /computed reduction 10 is lower than claimed_reduction=20/);
  assert.match(issues[1].message, new RegExp(`computed countLoc=${cap - 10} exceeds target_max=${cap - 11}`));
  assert.match(issues[1].message, new RegExp(`computed countLoc=${cap - 10} exceeds recorded budget=${cap - 12}`));
  assert.match(issues[2].message, /file=coord\/scripts\/absent\.js does not exist in the ticket worktree /);
});
test("COORD-826: a proof path outside the ticket workspace is refused", t => {
  const { root, write, check } = workspaceFixture(t, { gitDir: "coord", lock: ({ worktree }) => ({ worktree }) });
  write(root, "backend/app.js", cap - 1);
  const issues = check("backend/app.js", cap - 1);
  assert.ok(issues.some(issue => /file=backend\/app\.js escapes the ticket worktree/.test(issue.message)), JSON.stringify(issues));
});
test("COORD-826: every remediation hint is a repo-gate entry the update-plan writer accepts", t => {
  const { root } = workspaceFixture(t, { gitDir: null });
  const sourceCommit = commitFile(root, file, cap);
  const coordDir = path.join(root, "coord"), row = { Type: "refactor", Description: "decomposition refactor" };
  const resolveReviewedSource = () => ({ sha: sourceCommit, label: "the verified PR head" });
  const missing = collectDecompositionProofIssues({ ticketId: "TEST-826", row, planState: {}, coordDir, sourceCommit, resolveReviewedSource });
  const invalid = collectDecompositionProofIssues({ ticketId: "TEST-826", row, planState: { repo_gates: ["decomposition-proof: file=coord/engine/scripts/lifecycle.js"] }, coordDir, sourceCommit, resolveReviewedSource });
  const { parseLifecycleFlags } = createLifecycleFlags({ fail: (message) => { throw new Error(message); }, isLegalStatus: () => true, LEGAL_FINDING_STATUSES: new Set() });
  const { validateFeatureProofEntry } = createFeatureProofEntryValidator({ fail: (message) => { throw new Error(message); } });
  const commands = [...missing, ...invalid].flatMap(issue => issue.next_steps).filter(step => step.includes("update-plan"));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    const argv = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
    assert.deepEqual(argv.slice(0, 3), ["coord/scripts/gov", "update-plan", "TEST-826"]);
    const parsed = parseLifecycleFlags(argv.slice(3));
    assert.equal(parsed.featureProof, undefined, command);
    assert.equal(parsed.repoGate.length, 1, command);
    assert.match(parsed.repoGate[0], /^decomposition-proof: file=/);
    assert.throws(() => validateFeatureProofEntry(parsed.repoGate[0]));
    const fedBack = collectDecompositionProofIssues({ ticketId: "TEST-826", row, planState: { repo_gates: parsed.repoGate }, coordDir, sourceCommit, resolveReviewedSource });
    assert.ok(fedBack.every(issue => issue.code !== "decomposition_proof_missing"));
  }
});

// COORD-830: at closeout move-review has released the lock, and the canonical
// tree may still hold the pre-change file. The proof is qualified against the
// exact reviewed source commit; no worktree is discovered and nothing falls
// back to the canonical tree.
function closeoutFixture(t, makeBase = () => fs.mkdtempSync(path.join(os.tmpdir(), "concord-proof-830-"))) {
  const base = makeBase();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "canonical"), locksDir = path.join(base, "locks");
  fs.mkdirSync(locksDir, { recursive: true });
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  const oldSha = commitFile(root, file, cap, "canonical");
  git(root, "branch", "-q", "-M", "dev");
  git(root, "checkout", "-q", "-b", "TEST-830-refactor");
  const reviewed = commitFile(root, file, cap - 68, "TEST-830 reviewed head");
  git(root, "checkout", "-q", "dev");
  // reviewedHead stands in for durable provenance (the verified PR head).
  const check = (after, { sourceCommit, target = file, repoRoot = path.join(root, "coord"), reviewedHead = reviewed } = {}) => collectDecompositionProofIssues({
    ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: file=${target}; before=${cap}; after=${after}; claimed_reduction=${cap - after}; target_max=${cap}; extracted=helper moved`] },
    coordDir: path.join(root, "coord"), locksDir, repoRoot, sourceCommit,
    resolveReviewedSource: () => ({ sha: reviewedHead, label: "the verified PR head" }) });
  const addWorktree = (name, commitish) => { const dir = path.join(root, "coord", ".worktrees", name); git(root, "worktree", "add", "-q", "--detach", dir, commitish); return dir; };
  return { base, root, locksDir, oldSha, reviewed, check, addWorktree };
}
test("COORD-830 R1: a review ticket with no lock is measured at its reviewed source commit, which the result names", t => {
  const { root, reviewed, check } = closeoutFixture(t);
  assert.equal(countLocOf(fs.readFileSync(path.join(root, file), "utf8")), cap, "canonical keeps the pre-change file");
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), []);
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed.toUpperCase() }), [], "the full reviewed head is accepted in either case");
  const stale = check(cap - 60, { sourceCommit: reviewed });
  assert.ok(stale.some(issue => issue.message.includes(`does not match computed countLoc=${cap - 68}`) && issue.message.includes(`the reviewed source commit ${reviewed}`)), JSON.stringify(stale));
});
test("COORD-830 R2: a unique stale or wrong-branch worktree is never measured", t => {
  const { reviewed, oldSha, check, addWorktree } = closeoutFixture(t);
  const stale = addWorktree("TEST-830", oldSha);
  fs.writeFileSync(path.join(stale, file), "void 0;\n".repeat(cap - 10));
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), [], "the reviewed commit, not the stale worktree, is measured");
  assert.ok(check(cap - 10, { sourceCommit: reviewed }).some(issue => /does not match computed countLoc/.test(issue.message)));
  const refused = check(cap - 10);
  assert.deepEqual(refused.map(issue => issue.code), ["decomposition_proof_source_unavailable"], "a worktree alone is not source evidence");
});
test("COORD-830 R3: multiple candidate worktrees do not change the result", t => {
  const { reviewed, oldSha, check, addWorktree } = closeoutFixture(t);
  const without = check(cap - 68, { sourceCommit: reviewed });
  addWorktree("TEST-830", oldSha); addWorktree("TEST-830-b", reviewed); addWorktree("TEST-830-c", "dev");
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), without);
  assert.deepEqual(without, []);
  assert.deepEqual(check(cap - 68).map(issue => issue.code), ["decomposition_proof_source_unavailable"], "no candidate is guessed");
});
test("COORD-830 R4: missing source evidence refuses with a recovery instruction, never measuring canonical", t => {
  const { reviewed, check } = closeoutFixture(t);
  // The canonical file would satisfy a proof recorded against it; the gate must not accept it.
  const issues = check(cap);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "decomposition_proof_source_unavailable");
  assert.equal(issues[0].severity, "blocker");
  assert.match(issues[0].message, /canonical tree is not the reviewed source/);
  // COORD-830 (third pass), finding 3: the recovery names the reviewed head
  // provenance resolved, never a placeholder no value can satisfy.
  assert.deepEqual(issues[0].next_steps, [
    `coord/scripts/gov finalize TEST-830 --source-commit ${reviewed}`,
    `coord/scripts/gov land TEST-830 --source-commit ${reviewed}`,
  ]);
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), [], "executing the named step is accepted");
});
test("COORD-830 R4c: with no provenance at all, the recovery is the resolver's provenance-creating steps", t => {
  const { reviewed, check } = closeoutFixture(t);
  const steps = ["coord/scripts/gov return-doing TEST-830 ...", "coord/scripts/gov commit TEST-830 ..."];
  const none = () => ({ reason: "nothing names the head", recovery: steps, advice: "create governed provenance first." });
  for (const sourceCommit of [undefined, reviewed]) {
    const issues = collectDecompositionProofIssues({ ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
      planState: { repo_gates: [`decomposition-proof: file=${file}; before=${cap}; after=${cap - 68}; claimed_reduction=68; target_max=${cap}; extracted=helper moved`] },
      coordDir: path.join(os.tmpdir(), "absent-830", "coord"), locksDir: path.join(os.tmpdir(), "absent-830-locks"), sourceCommit, resolveReviewedSource: none });
    assert.deepEqual(issues.map(issue => issue.next_steps), [steps], String(sourceCommit));
    assert.match(issues[0].message, /create governed provenance first\./);
    assert.ok(!issues[0].message.includes("PR head commit"), "no PR-head advice for a ticket with no PR");
  }
  assert.equal(check(cap - 68, { sourceCommit: reviewed }).length, 0);
});
test("COORD-830 R4b: an unresolvable source or a path absent at the source refuses", t => {
  const { root, reviewed, check } = closeoutFixture(t);
  const bogus = check(cap - 68, { sourceCommit: "f".repeat(40), reviewedHead: "f".repeat(40) });
  assert.deepEqual(bogus.map(issue => issue.code), ["decomposition_proof_source_unavailable"]);
  assert.match(bogus[0].message, new RegExp(`source commit "${"f".repeat(40)}" does not resolve`));
  // COORD-873: an untracked file beside the measured module (now under coord/engine/scripts).
  const untracked = path.posix.join(path.posix.dirname(file), "untracked.js");
  fs.writeFileSync(path.join(root, untracked), "void 0;\n");
  const absent = check(1, { sourceCommit: reviewed, target: untracked });
  assert.ok(absent.some(issue => issue.message.includes(`file=${untracked} does not exist in the reviewed source commit ${reviewed}`)), JSON.stringify(absent));
});
test("COORD-830 R5: canonical still holding the old file does not decide the source's verdict", t => {
  const { reviewed, check } = closeoutFixture(t);
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), [], "passes on the source although canonical measures the old count");
  const canonicalCount = check(cap, { sourceCommit: reviewed });
  assert.ok(canonicalCount.some(issue => issue.message.includes(`after=${cap} does not match computed countLoc=${cap - 68}`)), "a proof matching only canonical fails on the source");
});
test("COORD-830: escape is judged relative to the measured source commit's repo", t => {
  const { base } = closeoutFixture(t);
  const workspace = path.join(base, "split");
  const sha = commitFile(path.join(workspace, "coord"), "engine/scripts/lifecycle.js", cap);
  fs.mkdirSync(path.join(workspace, "backend"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "backend", "app.js"), "void 0;\n");
  const issues = collectDecompositionProofIssues({ ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: ["decomposition-proof: file=backend/app.js; before=2; after=1; claimed_reduction=1; target_max=1; extracted=helper moved"] },
    coordDir: path.join(workspace, "coord"), repoRoot: path.join(workspace, "coord"), sourceCommit: sha, resolveReviewedSource: () => ({ sha }) });
  assert.ok(issues.some(issue => issue.message.includes(`file=backend/app.js escapes the reviewed source commit ${sha}`)), JSON.stringify(issues));
  assert.deepEqual(collectDecompositionProofIssues({ ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: file=coord/engine/scripts/lifecycle.js; before=${cap}; after=${cap}; claimed_reduction=0; extracted=helper moved`] },
    coordDir: path.join(workspace, "coord"), repoRoot: path.join(workspace, "coord"), sourceCommit: sha, resolveReviewedSource: () => ({ sha }) }), [], "an own-root repo maps coord/ paths into the commit");
});
test("COORD-830: outside closeout a live lock keeps worktree measurement and must agree with a supplied source commit", t => {
  const { root, locksDir, reviewed, oldSha, addWorktree } = closeoutFixture(t);
  const worktree = addWorktree("TEST-830", reviewed);
  fs.writeFileSync(path.join(locksDir, "TEST-830.lock"), JSON.stringify({ ticket: "TEST-830", worktree }));
  // Doing-state readiness: no reviewed-source resolver is supplied.
  const doing = (after, sourceCommit) => collectDecompositionProofIssues({ ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: file=${file}; before=${cap}; after=${after}; claimed_reduction=${cap - after}; target_max=${cap}; extracted=helper moved`] },
    coordDir: path.join(root, "coord"), locksDir, repoRoot: path.join(root, "coord"), sourceCommit });
  assert.deepEqual(doing(cap - 68), [], "doing ticket: the locked worktree is measured (COORD-826)");
  assert.deepEqual(doing(cap - 68, reviewed), [], "a source commit equal to the worktree HEAD agrees");
  const disagree = doing(cap - 68, oldSha);
  assert.deepEqual(disagree.map(issue => issue.code), ["decomposition_proof_source_unavailable"]);
  assert.match(disagree[0].message, new RegExp(`does not match the live ticket worktree .* HEAD ${reviewed}`));
  assert.deepEqual(doing(cap - 68, "no-such-ref").map(issue => issue.code), ["decomposition_proof_source_unavailable"]);
  const abbreviated = doing(cap - 68, reviewed.slice(0, 12));
  assert.deepEqual(abbreviated.map(issue => issue.code), ["decomposition_proof_source_unavailable"], "even an abbreviation of the worktree HEAD is not a full SHA");
  assert.ok(abbreviated[0].next_steps.includes(`coord/scripts/gov finalize TEST-830 --source-commit ${reviewed}`));
});

// COORD-830 review finding 3 (human-admin ruling 2026-10-14: a worktree is not
// evidence of the reviewed source): in closeout a live lock does not switch the
// gate to worktree measurement. The source is bound to provenance and measured
// at that commit; uncommitted worktree edits are never measured.
test("COORD-830: closeout with a live lock binds to provenance and measures the reviewed commit, not the worktree", t => {
  const { locksDir, reviewed, oldSha, check, addWorktree } = closeoutFixture(t);
  const worktree = addWorktree("TEST-830", reviewed);
  fs.writeFileSync(path.join(locksDir, "TEST-830.lock"), JSON.stringify({ ticket: "TEST-830", worktree }));
  fs.writeFileSync(path.join(worktree, file), "void 0;\n".repeat(cap - 100));
  const noSource = check(cap - 100);
  assert.deepEqual(noSource.map(issue => issue.code), ["decomposition_proof_source_unavailable"], "uncommitted worktree edits are not the reviewed source");
  assert.match(noSource[0].message, /closeout measures the reviewed source, never the live ticket worktree/);
  assert.ok(check(cap - 100, { sourceCommit: reviewed }).some(issue => issue.message.includes(`does not match computed countLoc=${cap - 68}`) && issue.message.includes(`the reviewed source commit ${reviewed}`)),
    "measured at the reviewed commit, not the dirty worktree");
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), []);
  const unbound = check(cap - 68, { sourceCommit: oldSha });
  assert.match(unbound[0].message, new RegExp(`source commit ${oldSha} is not the verified PR head ${reviewed}`), "the worktree HEAD does not stand in for provenance");
  // The worktree HEAD equals the operator's value but not the provenance head.
  const behind = addWorktree("TEST-830-behind", oldSha);
  fs.writeFileSync(path.join(locksDir, "TEST-830.lock"), JSON.stringify({ ticket: "TEST-830", worktree: behind }));
  const disagree = check(cap - 68, { sourceCommit: reviewed });
  assert.deepEqual(disagree.map(issue => issue.code), ["decomposition_proof_source_unavailable"]);
  assert.match(disagree[0].message, new RegExp(`live ticket worktree .* HEAD ${oldSha} is not the verified PR head ${reviewed}`));
});

test("COORD-830: a live lock whose worktree HEAD cannot be read still names the reviewed SHA", t => {
  const { locksDir, reviewed, check } = closeoutFixture(t);
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "concord-proof-830-norepo-"));
  t.after(() => fs.rmSync(notARepo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(locksDir, "TEST-830.lock"), JSON.stringify({ ticket: "TEST-830", worktree: notARepo }));
  const issues = check(cap - 68, { sourceCommit: reviewed });
  assert.match(issues[0].message, new RegExp(`HEAD \\(unresolvable\\) is not the verified PR head ${reviewed}`));
  assertPrintedArgv(issues[0].next_steps[0], ["git", "-C", notARepo, "branch", "TEST-830-beyond-review-HEAD", "HEAD"]);
  assertPrintedArgv(issues[0].next_steps[1], ["git", "-C", notARepo, "checkout", "--detach", reviewed]);
});

// COORD-830 review finding 4: an unfetched reviewed head is a fetch problem,
// and the recovery says so with the exact commands.
test("COORD-830: an unfetched reviewed head tells the operator to fetch it", t => {
  const { root, check } = closeoutFixture(t);
  const missing = "f".repeat(40);
  const issues = collectDecompositionProofIssues({ ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: file=${file}; before=${cap}; after=1; claimed_reduction=1; target_max=${cap}; extracted=helper moved`] },
    coordDir: path.join(root, "coord"), repoRoot: path.join(root, "coord"), sourceCommit: missing,
    resolveReviewedSource: () => ({ sha: missing, label: "the verified PR head", fetchRef: "pull/7/head" }) });
  assert.deepEqual(issues.map(issue => issue.code), ["decomposition_proof_source_unavailable"]);
  assert.match(issues[0].message, /has not been fetched into the ticket repository\..*fetch the reviewed head/s);
  assertPrintedArgv(issues[0].next_steps[0], ["git", "-C", path.join(root, "coord"), "fetch", "origin", missing]);
  assertPrintedArgv(issues[0].next_steps[1], ["git", "-C", path.join(root, "coord"), "fetch", "origin", "pull/7/head"]);
  assert.ok(issues[0].next_steps.includes(`coord/scripts/gov land TEST-830 --source-commit ${missing}`));
  assert.equal(check(1, { sourceCommit: missing, reviewedHead: missing })[0].next_steps.length, 3, "without a fetch ref only the SHA fetch is named");
});

// COORD-830 review finding 2: when provenance is ambiguous the resolver's own
// recovery replaces the --source-commit advice, which could not succeed.
test("COORD-830: an ambiguous-provenance refusal carries the resolver's recovery steps", t => {
  const { root, reviewed } = closeoutFixture(t);
  const issues = collectDecompositionProofIssues({ ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: file=${file}; before=${cap}; after=1; claimed_reduction=1; target_max=${cap}; extracted=helper moved`] },
    coordDir: path.join(root, "coord"), repoRoot: path.join(root, "coord"), sourceCommit: reviewed,
    resolveReviewedSource: () => ({ reason: "ambiguous", recovery: ["coord/scripts/gov set-pr TEST-830 --replace --pr \"x\""] }) });
  assert.match(issues[0].message, /cannot be bound to durable provenance: ambiguous.*resolve the recorded evidence first/);
  assert.deepEqual(issues[0].next_steps, ["coord/scripts/gov set-pr TEST-830 --replace --pr \"x\""]);
});

// COORD-830 review finding 1: a resolvable commitish is not the reviewed source.
// The source must be the full SHA of exactly the head durable provenance names;
// an ancestor where the file happened to be smaller must not qualify the proof.
test("COORD-830: only the exact reviewed head SHA qualifies; symbolic, abbreviated, ancestor and foreign commits are refused", t => {
  const { root, reviewed, oldSha, check } = closeoutFixture(t);
  git(root, "checkout", "-q", "TEST-830-refactor");
  const regrown = commitFile(root, file, cap - 10, "TEST-830 head: regrow");
  git(root, "checkout", "-q", "dev");
  git(root, "merge-base", "--is-ancestor", reviewed, regrown);
  // The proof claims the intermediate ancestor's count, which the real PR head no longer meets.
  const at = (sourceCommit, reviewedHead = regrown) => check(cap - 68, { sourceCommit, reviewedHead });
  const refusal = (issues, pattern, label) => {
    assert.deepEqual(issues.map(issue => issue.code), ["decomposition_proof_source_unavailable"], label);
    assert.match(issues[0].message, pattern, label);
    assert.ok(issues[0].next_steps.includes(`coord/scripts/gov land TEST-830 --source-commit ${regrown}`), `${label}: recovery names the expected head`);
  };
  for (const symbolic of ["dev", "HEAD", "TEST-830-refactor", regrown.slice(0, 12)]) {
    refusal(at(symbolic), /is not a full 40-character commit SHA/, symbolic);
  }
  refusal(at(reviewed), new RegExp(`source commit ${reviewed} is not the verified PR head ${regrown}`), "ancestor of the reviewed head");
  refusal(at(oldSha), new RegExp(`source commit ${oldSha} is not the verified PR head ${regrown}`), "a commit that is not the PR head");
  assert.ok(at(regrown).some(issue => issue.message.includes(`does not match computed countLoc=${cap - 10}`)), "the exact head is measured, so the stale proof fails on the real count");
  assert.deepEqual(check(cap - 10, { sourceCommit: regrown, reviewedHead: regrown }), [], "the exact reviewed head is accepted");
  const unbound = collectDecompositionProofIssues({ ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: file=${file}; before=${cap}; after=${cap - 10}; claimed_reduction=10; target_max=${cap}; extracted=helper moved`] },
    coordDir: path.join(root, "coord"), repoRoot: path.join(root, "coord"), sourceCommit: regrown });
  assert.match(unbound[0].message, /cannot be bound to durable provenance: this caller supplies no durable reviewed-source provenance/);
  const noProvenance = check(cap - 10, { sourceCommit: regrown, reviewedHead: null });
  assert.match(noProvenance[0].message, /cannot be bound to durable provenance: no durable provenance records the reviewed head/);
  assert.ok(noProvenance[0].next_steps.includes("coord/scripts/gov finalize TEST-830 --source-commit <reviewed PR head sha>"));
  assert.match(collectDecompositionProofIssues({ ticketId: "TEST-830", row: { Type: "refactor", Description: "decomposition refactor" },
    planState: { repo_gates: [`decomposition-proof: file=${file}; before=${cap}; after=${cap - 10}; claimed_reduction=10; target_max=${cap}; extracted=helper moved`] },
    coordDir: path.join(root, "coord"), repoRoot: path.join(root, "coord"), sourceCommit: regrown, resolveReviewedSource: () => undefined })[0].message,
  /no durable provenance records the reviewed head/, "a resolver that returns nothing binds nothing");
});

// COORD-830 review finding 2: a directory at the source commit is a tree, and
// measuring its listing must not stand in for measuring a file.
test("COORD-830: a directory proof path is refused at the reviewed source commit", t => {
  const { reviewed, check } = closeoutFixture(t);
  const tree = path.posix.dirname(file); // COORD-873: the measured module's own directory
  const issues = check(1, { sourceCommit: reviewed, target: tree });
  assert.ok(issues.some(issue => issue.message.includes(`file=${tree} is a tree, not a file, in the reviewed source commit ${reviewed}`)), JSON.stringify(issues));
  assert.ok(issues.every(issue => !/computed countLoc/.test(issue.message)), "the tree listing is never measured");
});

// COORD-830 review (third pass), finding 4: a live worktree that is merely on an
// older commit is not fixed by "commit or discard the worktree's changes". The
// refusal names the reviewed SHA to move to, or the stale lock to release, and
// each named step, executed, makes the next closeout accepted.
test("COORD-830: a stale live worktree names the reviewed SHA to move to or the lock to release", t => {
  const { root, locksDir, reviewed, oldSha, check, addWorktree } = closeoutFixture(t);
  const lock = (worktree) => fs.writeFileSync(path.join(locksDir, "TEST-830.lock"), JSON.stringify({ ticket: "TEST-830", worktree }));
  const refused = () => {
    const issues = check(cap - 68, { sourceCommit: reviewed });
    assert.deepEqual(issues.map(issue => issue.code), ["decomposition_proof_source_unavailable"]);
    assert.ok(!issues[0].message.includes("commit or discard"), issues[0].message);
    assert.match(issues[0].message, new RegExp(`HEAD ${oldSha} is not the verified PR head ${reviewed}`));
    return issues[0];
  };
  // Detached worktree on the older commit: check out the reviewed SHA.
  const detached = addWorktree("TEST-830", oldSha);
  lock(detached);
  const first = refused();
  assertPrintedArgv(first.next_steps[0], ["git", "-C", detached, "branch", `TEST-830-beyond-review-${oldSha}`, oldSha]);
  assertPrintedArgv(first.next_steps[1], ["git", "-C", detached, "checkout", "--detach", reviewed]);
  assert.equal(first.next_steps[2], "coord/scripts/gov release-lock TEST-830");
  assert.ok(first.next_steps.includes(`coord/scripts/gov finalize TEST-830 --source-commit ${reviewed}`));
  runPrintedGitStep(first.next_steps[1], detached);
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), [], "after the named checkout the closeout is accepted");
  // Worktree on a ticket branch at the older commit: the branch is moved, kept.
  const onBranch = path.join(root, "coord", ".worktrees", "TEST-830-branch");
  git(root, "worktree", "add", "-q", "-b", "agent/x-test-830-stale", onBranch, oldSha);
  lock(onBranch);
  const second = refused();
  assertPrintedArgv(second.next_steps[1], ["git", "-C", onBranch, "reset", "--keep", reviewed]);
  runPrintedGitStep(second.next_steps[1], onBranch);
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), []);
  assert.equal(git(onBranch, "rev-parse", "--abbrev-ref", "HEAD"), "agent/x-test-830-stale");
  // A stale lock: releasing it (the lock file goes) also resolves the refusal.
  lock(addWorktree("TEST-830-stale", oldSha));
  refused();
  fs.rmSync(path.join(locksDir, "TEST-830.lock"));
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), [], "after release-lock the closeout is accepted");
});

// COORD-830 review (fourth pass), finding 4: a live worktree BEYOND the reviewed
// head is moved back by the recovery; executed in order, the named steps keep
// the commits beyond review reachable instead of silently stranding them.
test("COORD-830: the stale-worktree recovery saves commits beyond the reviewed head before moving back", t => {
  const { root, locksDir, reviewed, check } = closeoutFixture(t);
  const wt = path.join(root, "coord", ".worktrees", "TEST-830-beyond");
  git(root, "worktree", "add", "-q", "-b", "agent/x-test-830-beyond", wt, reviewed);
  const beyond = commitFile(wt, file, cap - 1, "TEST-830 unreviewed commit beyond the reviewed head");
  fs.writeFileSync(path.join(locksDir, "TEST-830.lock"), JSON.stringify({ ticket: "TEST-830", worktree: wt }));
  const [issue] = check(cap - 68, { sourceCommit: reviewed });
  assertPrintedArgv(issue.next_steps[0], ["git", "-C", wt, "branch", `TEST-830-beyond-review-${beyond}`, beyond]);
  assertPrintedArgv(issue.next_steps[1], ["git", "-C", wt, "reset", "--keep", reviewed]);
  assert.ok(issue.message.includes(`save its commits (${issue.next_steps[0]})`), issue.message);
  runPrintedGitStep(issue.next_steps[0], wt);
  runPrintedGitStep(issue.next_steps[1], wt);
  assert.equal(git(root, "rev-parse", `TEST-830-beyond-review-${beyond}`), beyond, "the commit beyond review is kept on a named branch");
  assert.equal(git(wt, "rev-parse", "HEAD"), reviewed);
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), [], "and the next closeout is accepted");
});

// A blob whose header reads (so `git cat-file -t` names it a blob) but whose
// content cannot be read back from the object store is reported missing, never
// measured from partial or empty output.
test("COORD-830: an unreadable blob at the reviewed source commit is reported missing, not measured", t => {
  const { root, reviewed, check } = closeoutFixture(t);
  const oid = git(root, "rev-parse", `${reviewed}:${file}`);
  const loose = path.join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2));
  assert.ok(fs.existsSync(loose), "the reviewed blob is a loose object");
  fs.chmodSync(loose, 0o644);
  const bytes = fs.readFileSync(loose);
  for (let i = bytes.length - 4; i < bytes.length; i++) bytes[i] ^= 0xff; // corrupt the zlib checksum only
  fs.writeFileSync(loose, bytes);
  assert.equal(git(root, "cat-file", "-t", `${reviewed}:${file}`), "blob", "the object header still reads as a blob");
  const issues = check(cap - 68, { sourceCommit: reviewed });
  assert.ok(issues.some(issue => issue.message.includes(`file=${file} does not exist in the reviewed source commit ${reviewed} for countLoc verification`)), JSON.stringify(issues));
  assert.ok(issues.every(issue => !/computed countLoc/.test(issue.message)), "nothing is measured from the unreadable blob");
});

// COORD-856: under a fixture path with a space, parentheses, a dollar sign and
// a single quote, every printed decomposition-proof recovery parses to the argv
// it intends, and executed in order the steps make the next closeout accepted.
test("COORD-856: decomposition-proof recoveries quote a hostile worktree and repository path", t => {
  const { root, locksDir, reviewed, oldSha, check } = closeoutFixture(t, () => fs.realpathSync(hostileTempDir("proof")));
  const missing = "e".repeat(40);
  const unfetched = check(1, { sourceCommit: missing, reviewedHead: missing });
  assertPrintedArgv(unfetched[0].next_steps[0], ["git", "-C", path.join(root, "coord"), "fetch", "origin", missing]);
  assert.ok(unfetched[0].message.includes(`(${unfetched[0].next_steps[0]})`), unfetched[0].message);
  const wt = path.join(root, "coord", ".worktrees", "TEST-830 $(stale) 'x'");
  git(root, "worktree", "add", "-q", "-b", "agent/x-test-856", wt, oldSha);
  fs.writeFileSync(path.join(locksDir, "TEST-830.lock"), JSON.stringify({ ticket: "TEST-830", worktree: wt }));
  const [issue] = check(cap - 68, { sourceCommit: reviewed });
  assertPrintedArgv(issue.next_steps[0], ["git", "-C", wt, "branch", `TEST-830-beyond-review-${oldSha}`, oldSha]);
  assertPrintedArgv(issue.next_steps[1], ["git", "-C", wt, "reset", "--keep", reviewed]);
  assert.ok(issue.message.includes(`(${issue.next_steps[0]})`) && issue.message.includes(`(${issue.next_steps[1]};`), issue.message);
  runPrintedGitStep(issue.next_steps[0], wt);
  runPrintedGitStep(issue.next_steps[1], wt);
  assert.deepEqual(check(cap - 68, { sourceCommit: reviewed }), [], "the printed steps ran against the hostile path");
  git(wt, "checkout", "-q", "--detach", oldSha);
  const [detached] = check(cap - 68, { sourceCommit: reviewed });
  assertPrintedArgv(detached.next_steps[1], ["git", "-C", wt, "checkout", "--detach", reviewed]);
  assert.equal(shellQuote(wt).startsWith("'"), true, "the hostile path is quoted, not printed bare");
});
