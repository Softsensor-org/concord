"use strict";

// COORD-936 item 8: automatic selection; human additions and reductions are
// recorded exceptions bound to the reviewed change scope.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");

const tp = require("./test-policy.js");
const tpr = require("./test-policy-run.js");
const ex = require("./test-policy-exceptions.js");
const approvalVerifier = require("./approval-verifier.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");

const POLICY = tp.effectivePolicy();
const GUARD = POLICY.selection.always_required_suites[0];

function git(cwd, ...args) {
  const r = gitFixtureSpawn(cwd, args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A workspace whose product repository B has a dependency map, a submitted
// docs change (plan record review_submission) and an in-memory board.
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord936-exc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  gitFixture(root, ["init", "-q"]);
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  for (const rel of ["backend/lib/u.js", "backend/api/a.js", "backend/docs/x.md"]) write(rel, "1\n");
  const map = { updated_at: new Date().toISOString().slice(0, 10), full_gate: { commands: ["npm run test:all"] }, targets: [
    { id: "lib", files: ["lib/"], command: "npm run test:lib" }, { id: "api", files: ["api/"], command: "npm run test:api", depends_on: ["lib"] },
    { id: "docs", files: ["docs/"], command: "npm run docs:check" }, { id: "links", files: ["docs/"], command: "npm run docs:links" }] };
  write("coord/project.config.js", `module.exports = ${JSON.stringify({ repos: { B: { path: "backend", testCommand: "npm test", ticketPrefixes: ["MSRV"] } }, testPolicy: { repoMaps: { B: map } } })};\n`);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  write("backend/docs/x.md", "2\n");
  git(root, "commit", "-qam", "docs change");
  const submitted = git(root, "rev-parse", "HEAD");
  const plans = path.join(root, "plans");
  write("plans/MSRV-7.json", JSON.stringify({ review_submission: { repository: "backend", commit: submitted } }));
  const board = { metadata: {} };
  const journal = [];
  const logs = [];
  const approvalEvents = [];
  const runtimeDir = path.join(root, "runtime");
  fs.mkdirSync(runtimeDir);
  const command = tpr.createTestPolicyCommands({
    root, env: {}, fail: (m) => { throw new Error(m); }, log: (l) => logs.push(l), planRecordsDir: plans, ledgerDir: path.join(root, "ledger"),
    readBoard: () => JSON.parse(JSON.stringify(board)),
    withBoardTransaction: (meta, fn) => { journal.push(JSON.parse(JSON.stringify(meta))); return fn({ board }); }, writeBoard: () => {},
    resolveHumanAdminOverride: (name, o) => ({ reason: o.humanAdminOverride.trim(), legacyForceAlias: false }), currentHandle: () => "claude-x",
    appendGovernanceEvent: (event) => approvalEvents.push(event), runtimeDir,
  });
  const cmd = (sub, argv) => argv.includes("--human-admin-override")
    ? withAutoSignedApprovals(() => command(sub, argv))
    : command(sub, argv);
  return { root, base, submitted, board, journal, logs, approvalEvents, cmd, write };
}

function withAutoSignedApprovals(run) {
  const allowedVerbs = ["test-policy except (addition)", "test-policy except (reduction)", "test-policy except (withdrawal)"];
  const fixture = createApprovalFixture({ allowedVerbs });
  const original = approvalVerifier.requireSignedOverride;
  approvalVerifier.requireSignedOverride = (request) => {
    const reason = String(request.options.humanAdminOverride || "").trim();
    const subject_sha256 = approvalVerifier.subjectSha256({ verb: request.commandName, ticket: request.ticketId,
      reason, state: approvalVerifier.canonicalJson(request.row) });
    fixture.login({ verb: request.commandName, ticket: request.ticketId, subject_sha256 });
    return original({ ...request, approvalClient: fixture.client() });
  };
  try { return run(); } finally { approvalVerifier.requireSignedOverride = original; fixture.cleanup(); }
}

const resolve = (w, ...extra) => w.cmd("resolve", ["--stage", "pr", "--ticket", "MSRV-7", "--base", w.base, ...extra]);
const commands = (plan) => plan.checks.map((c) => c.command);

test("COORD-936: selection is automatic, with no approval prompt and no exception", (t) => {
  const w = workspace(t);
  const plan = resolve(w);
  assert.deepEqual([plan.execution, plan.exceptions, commands(plan)], ["policy", [], ["npm run docs:check", "npm run docs:links"]]);
  assert.equal(w.journal.length, 0, "nothing is recorded or requested for a normal run");
});

test("COORD-936: an addition and a reduction each require and record human-admin authority, bound to the submission scope", (t) => {
  const w = workspace(t);
  const except = (...argv) => w.cmd("except", ["--ticket", "MSRV-7", "--base", w.base, ...argv]);
  assert.throws(() => except("--add", "perf=npm run perf"), /refusing the addition: a test-policy addition is a human exception and requires --human-admin-override/);
  assert.throws(() => except("--reduce", "B:links"), /refusing the reduction: a test-policy reduction is a human exception and requires --human-admin-override/);
  assert.equal(w.journal.length, 0, "a refusal records nothing");
  assert.throws(() => except("--add", "a=x", "--reduce", "B:links", "--human-admin-override", "r"), /an addition or a reduction, never both/);
  assert.throws(() => except("--reduce", "B:lib", "--human-admin-override", "r"), /B:lib is not in the recommended selection; there is nothing to reduce/);
  assert.throws(() => w.cmd("except", ["--add", "a=x"]), /requires --ticket/);
  assert.throws(() => w.cmd("except", ["--ticket", "MSRV-7", "--add", "a=x", "--human-admin-override", "r"]), /requires --base/);
  w.write("backend/docs/x.md", "3\n");
  const during = w.cmd("except", ["--ticket", "MSRV-8", "--base", w.base, "--add", "a=x", "--human-admin-override", "during implementation"]);
  assert.deepEqual([during.scope.source, during.scope.files, Boolean(during.scope.dirty_digest), /^sha256:/.test(during.scope.digest)], ["working-tree", ["docs/x.md"], true, true],
    "during implementation an exception binds to the working tree, with a digest that includes the uncommitted change");
  git(w.root, "checkout", "-q", "--", ".");
  const added = except("--add", "perf=npm run perf", "--human-admin-override", "release candidate needs perf");
  const reduced = except("--reduce", "B:links", "--human-admin-override", "link checker is down; tracked in OPS-4");
  assert.deepEqual([added.id, added.kind, reduced.id, reduced.kind], ["TPX-MSRV-7-1", "add", "TPX-MSRV-7-2", "reduce"]);
  assert.deepEqual(reduced.authority, { kind: "human-admin-override", approver: "human-admin", recorded_by: "claude-x" });
  assert.deepEqual([reduced.scope.commit, reduced.scope.base, reduced.scope.files, reduced.scope.repository], [w.submitted, w.base, ["docs/x.md"], "backend"]);
  assert.equal(reduced.scope.tree, git(w.root, "rev-parse", `${w.submitted}^{tree}`));
  assert.deepEqual(reduced.scope.recommended, ["B:docs", "B:links"]);
  assert.deepEqual(w.journal.map((j) => [j.command, j.ticket, j.details.exception.id]), [["test-policy-exception", "MSRV-8", "TPX-MSRV-8-1"], ["test-policy-exception", "MSRV-7", "TPX-MSRV-7-1"], ["test-policy-exception", "MSRV-7", "TPX-MSRV-7-2"]]);
  assert.equal(w.approvalEvents.length, 3, "each accepted exception has a separately journaled signed approval");
  assert.ok(w.approvalEvents.every((event) => event.event === "approval.verified" && event.human_admin_session && event.approval_record),
    "approval journal entries retain the verified session and single-use record id");
  assert.deepEqual([reduced.scope.source, reduced.scope.dirty_digest], ["submission", null], "after submit an exception binds to the immutable submission");
  assert.deepEqual(w.board.metadata.test_policy_exceptions["MSRV-7"].map((e) => e.reason), ["release candidate needs perf", "link checker is down; tracked in OPS-4"]);
  assert.match(w.logs.at(-1), /recorded reduce exception TPX-MSRV-7-2 on MSRV-7 \(B:links\), bound to/);
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "board", "tasks.schema.json"), "utf8")).properties.metadata.properties.test_policy_exceptions;
  assert.deepEqual(require("./guard-registry.js").validateSchema(schema, w.board.metadata.test_policy_exceptions), [], "the audit record is a valid governed board record");
});

test("COORD-936: an exception survives replanning within its scope and the plan is labelled with it", (t) => {
  const w = workspace(t);
  const except = (...argv) => w.cmd("except", ["--ticket", "MSRV-7", "--base", w.base, ...argv]);
  except("--add", "perf=npm run perf", "--human-admin-override", "perf");
  except("--reduce", "B:links", "--human-admin-override", "links down");
  for (let i = 0; i < 2; i += 1) {
    const plan = resolve(w);
    assert.deepEqual(commands(plan), ["npm run docs:check", "npm run perf"]);
    assert.deepEqual([plan.execution, plan.exceptions.map((e) => [e.id, e.status])], ["policy + exception: add TPX-MSRV-7-1, reduce TPX-MSRV-7-2", [["TPX-MSRV-7-1", "applied"], ["TPX-MSRV-7-2", "applied"]]]);
  }
  assert.match(w.logs.at(-1), /execution: policy \+ exception: add TPX-MSRV-7-1, reduce TPX-MSRV-7-2\n  exception TPX-MSRV-7-1 \(add perf=npm run perf\): applied; reason: perf; authority: human-admin-override/);
  assert.equal(resolve(w, "--stage", "nightly").execution, "policy", "an exception names its stage");
});

test("COORD-936: a docs change that grows into code lapses the reduction, keeps the addition, and the run says so", (t) => {
  const w = workspace(t);
  const except = (...argv) => w.cmd("except", ["--ticket", "MSRV-7", "--base", w.base, ...argv]);
  except("--add", "perf=npm run perf", "--human-admin-override", "perf");
  except("--reduce", "B:links", "--human-admin-override", "links down");
  w.write("backend/lib/u.js", "2\n");
  git(w.root, "commit", "-qam", "the docs ticket now edits code");
  const plan = resolve(w, "--head", "HEAD");
  const POLICY_SET = ["npm run test:lib", "npm run test:api", "npm run docs:check", "npm run docs:links"];
  assert.deepEqual(commands(plan), [...POLICY_SET, "npm run perf"], "the expanded change runs its consumers under policy (links back), plus the kept addition");
  assert.equal(plan.execution, "policy + exception: add TPX-MSRV-7-1");
  const [kept, lapsed] = plan.exceptions;
  assert.deepEqual([kept.status, lapsed.status], ["kept", "lapsed"]);
  assert.match(lapsed.detail, /the change expanded beyond the bound scope: lib\/u.js; selection reverts to policy until re-authorized/);
  assert.match(kept.detail, /an addition is kept unless withdrawn/);
  assert.equal(w.board.metadata.test_policy_exceptions["MSRV-7"].length, 2, "the lapsed reduction stays on record");
  assert.throws(() => except("--withdraw", "TPX-MSRV-7-1"), /withdrawing a test-policy exception requires --human-admin-override/);
  except("--withdraw", "TPX-MSRV-7-1", "--human-admin-override", "perf no longer needed");
  assert.throws(() => except("--withdraw", "TPX-MSRV-7-1", "--human-admin-override", "again"), /no active test-policy exception TPX-MSRV-7-1/);
  const after = resolve(w, "--head", "HEAD");
  assert.deepEqual([after.execution, after.exceptions.map((e) => e.status), commands(after)], ["policy", ["lapsed"], POLICY_SET]);
  assert.equal(w.board.metadata.test_policy_exceptions["MSRV-7"][0].withdrawn_reason, "perf no longer needed");
  assert.equal(w.journal.at(-1).details.withdraw, "TPX-MSRV-7-1");
  w.write("plans/COORD-5.json", JSON.stringify({ review_submission: { repository: "coord", commit: w.submitted } }));
  const coordScope = tpr.boundScope({ root: w.root, config: {}, ticket: "COORD-5", planRecordsDir: path.join(w.root, "plans"), base: w.base });
  assert.deepEqual([coordScope.repo, coordScope.files], ["X", ["backend/docs/x.md"]], "a coordination ticket is bound in the workspace repository");
  assert.throws(() => tpr.boundScope({ root: w.root, config: {}, ticket: "COORD-5", planRecordsDir: path.join(w.root, "plans"), base: "no-such-ref" }), /git rev-parse no-such-ref/);
});

test("COORD-936: a ticket exception never reduces the policy's mandatory guards; reductions follow newly affected consumers", () => {
  const plan = { base_stage: "pr", checks: [{ id: "selected-suites", suites: ["coord/a.test.js", "coord/b.test.js"] }, { id: "always-required-suites", suites: [GUARD] }],
    selection: { would_suites: [] } };
  const override = { reason: "r" };
  assert.match(ex.exceptionRefusals({ kind: "reduce", items: [GUARD], policy: POLICY, plan, override }).join(), /is a mandatory guard \(always-required\) and can never be reduced/);
  assert.match(ex.exceptionRefusals({ kind: "reduce", items: ["always-required-suites"], policy: POLICY, plan, override }).join(), /can never be reduced/);
  assert.deepEqual(ex.exceptionRefusals({ kind: "reduce", items: [], policy: POLICY, plan, override }), ["an exception names at least one suite or check"]);
  assert.deepEqual(ex.exceptionRefusals({ kind: "swap", items: ["x"], policy: POLICY, plan, override }), ["unknown exception kind swap"]);
  const loosened = { ...POLICY, selection: { ...POLICY.selection, always_required_suites: [] } };
  assert.deepEqual(ex.exceptionRefusals({ kind: "reduce", items: [GUARD], policy: loosened, plan, override }), [], "what is mandatory is policy data: a governed policy change may change it");
  const e = ex.newException({ id: "E1", ticket: "COORD-1", kind: "reduce", stage: "pr", items: ["coord/b.test.js"], reason: "r", recordedBy: null, scope: { commit: "c", tree: "t", base: "b", files: ["coord/x.js"], repo: "X" }, plan, now: "n" });
  const applied = ex.applyExceptions(JSON.parse(JSON.stringify(plan)), [e], { policy: POLICY, filesFor: () => ["coord/x.js"] });
  assert.deepEqual(applied.checks.map((c) => c.suites), [["coord/a.test.js"], [GUARD]]);
  const grown = JSON.parse(JSON.stringify(plan));
  grown.checks[0].suites.push("coord/c.test.js");
  const lapsed = ex.applyExceptions(grown, [e], { policy: POLICY, filesFor: () => ["coord/x.js"] });
  assert.match(lapsed.exceptions[0].detail, /the new head reaches newly affected consumers: coord\/c.test.js/);
  assert.equal(lapsed.execution, "policy");
  const many = Array.from({ length: 7 }, (_, i) => `f${i}.js`);
  assert.match(ex.expansion({ scope: { files: [], recommended: [] } }, { files: many, recommended: [] }), /f4.js, \.\.\.$/);
  assert.match(ex.expansion({ scope: { files: [], recommended: [] } }, { files: [], recommended: many }), /f4.js, \.\.\.$/);
});

test("COORD-936: a reduction of the full suite runs the would-be selection; an addition of suites adds an engine check", () => {
  const plan = { base_stage: "pr", checks: [{ id: "full-suite", kind: "engine-suites" }], selection: { would_suites: ["coord/a.test.js", GUARD] } };
  const reduce = ex.newException({ id: "E2", ticket: "COORD-1", kind: "reduce", stage: "pr", items: ["full-suite"], reason: "r", scope: { files: [], repo: "X" }, plan, now: "n" });
  const add = ex.newException({ id: "E3", ticket: "COORD-1", kind: "add", stage: "pr", items: ["coord/z.test.js"], reason: "r", scope: { files: [], repo: "X" }, plan, now: "n" });
  const out = ex.applyExceptions(JSON.parse(JSON.stringify(plan)), [reduce, add], { policy: POLICY, filesFor: () => [] });
  assert.deepEqual(out.checks.map((c) => [c.id, c.suites]), [["selected-suites", ["coord/a.test.js"]], ["always-required-suites", [GUARD]], ["exception:E3", ["coord/z.test.js"]]]);
  const noSelection = ex.applyExceptions({ ...JSON.parse(JSON.stringify(plan)), selection: null }, [reduce], { policy: POLICY, filesFor: () => [] });
  assert.deepEqual(noSelection.checks.map((c) => c.id), ["full-suite"], "without a would-be selection the full suite is never dropped");
  assert.match(ex.exceptionRefusals({ kind: "reduce", items: ["full-suite"], policy: POLICY, plan: { ...plan, selection: null }, override: { reason: "r" } }).join(), /narrowed only to an eligible would-be selection/);
  assert.deepEqual(ex.exceptionsFor(null, "COORD-1"), []);
  assert.match(ex.exceptionRefusals({ kind: "add", items: ["x"], policy: POLICY, plan, override: { reason: "  " } }).join(), /requires --human-admin-override/);
  assert.match(ex.exceptionRefusals({ kind: "reduce", items: ["full-suite"], policy: POLICY, plan: { ...plan, selection: { would_suites: [] } }, override: { reason: "r" } }).join(), /narrowed only/);
  assert.throws(() => ex.withWithdrawal({ metadata: {} }, { ticket: "T", id: "x" }), /no active test-policy exception x on T/);
  assert.deepEqual(ex.withException({}, { ticket: "T", id: "x" }), { T: [{ ticket: "T", id: "x" }] });
});

test("COORD-945: an eligible T2 change narrows to its counterfactual plus mandatory guards; ineligible T2 and promotion refuse", () => {
  const guard = POLICY.selection.always_required_suites[0];
  const t2Plan = { base_stage: "pr", checks: [{ id: "full-suite", kind: "engine-suites" }],
    selection: { tier: "T2", human_exception_eligible: true, would_suites: ["coord/a.test.js", guard].sort() } };
  assert.deepEqual(ex.exceptionRefusals({ kind: "reduce", items: ["full-suite"], policy: POLICY, plan: t2Plan, override: { reason: "r" } }), [],
    "an eligible T2 counterfactual can be reduced to");
  const reduce = ex.newException({ id: "E4", ticket: "COORD-944", kind: "reduce", stage: "pr", items: ["full-suite"], reason: "focused PR check", scope: { files: [], repo: "X" }, plan: t2Plan, now: "n" });
  const out = ex.applyExceptions(JSON.parse(JSON.stringify(t2Plan)), [reduce], { policy: POLICY, filesFor: () => [] });
  assert.deepEqual(out.checks.map((c) => [c.id, c.suites]), [["selected-suites", ["coord/a.test.js"]], ["always-required-suites", [guard]]],
    "the reduction runs the counterfactual selected suites plus the mandatory guard");
  assert.equal(out.qualifies, false, "a focused PR exception never claims full qualification");
  const ineligible = { ...t2Plan, selection: { tier: "T2", human_exception_eligible: false, would_suites: ["coord/a.test.js"] } };
  assert.match(ex.exceptionRefusals({ kind: "reduce", items: ["full-suite"], policy: POLICY, plan: ineligible, override: { reason: "r" } }).join(), /narrowed only to an eligible would-be selection/,
    "an ineligible T2 selection has no counterfactual to reduce to");
  assert.match(ex.exceptionRefusals({ kind: "reduce", items: ["full-suite"], stage: "promotion", policy: POLICY, plan: t2Plan, override: { reason: "r" } }).join(), /promotion always runs the full suite/,
    "a reduction can never apply at promotion");
});
