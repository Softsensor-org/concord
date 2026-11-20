"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
const landing = require("./control-plane-landing.js");
const { resolveControlPlaneLayout } = require("./control-plane-paths.js");
const createCloseout = require("./closeout.js");
const { parseFlags } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/cli.js")).__testing;
const boardTesting = require("../../board/board.js").__testing;
const schema = require("../../board/tasks.schema.json");
const ID = "TEST-763", TARGET = "TEST-701";
test("COORD-809: absent or invalid board cannot trigger landing evaluation or publication", () => {
  const options = {
    get prEvidence() { throw new Error("evidence must not be inspected without a board"); },
    get pushBeforeCloseout() { throw new Error("publication must not be inspected without a board"); },
  };
  for (const board of [undefined, null, false, 42, "not a board"]) {
    assert.equal(landing.ensureControlPlaneLandingRecord(ID, board, { Repo: "X" }, options), null);
  }
});
const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");

function git(dir, ...args) {
  const r = gitFixtureSpawn(dir, args, { env });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function fixture(t, donor = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-fulfillment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord"), repo = donor ? root : coord, remote = path.join(root, "remote.git");
  fs.mkdirSync(coord); gitFixture(repo, ["init", "-b", "main"]);
  const commit = text => {
    fs.writeFileSync(path.join(coord, "implementation.txt"), text);
    git(repo, "add", path.join(coord, "implementation.txt")); git(repo, "commit", "-m", text);
    return git(repo, "rev-parse", "HEAD");
  };
  const source = commit("reviewed source"), sha = commit("landed implementation");
  gitFixture(root, ["init", "--bare", "-b", "main", remote]); git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "main"); git(repo, "fetch", "origin", "main");
  const row = { ID, Repo: "X", Status: "review", Owner: "codexa1" };
  const board = { version: 1, metadata: { title: "Fulfillment", last_updated: "2026-09-22", canonical_references: [], plan_markdown_render_statuses: ["doing", "review"] },
    sections: [{ kind: "table", level: 2, heading: "Tickets", separator_before: false, columns: ["ID", "Repo", "Status", "Owner"],
      rows: [row, { ID: TARGET, Repo: "X", Status: "done", Owner: "unassigned" }] }],
    prompt_index: {}, pr_index: { [ID]: ["local-review (no PR)"] }, review_findings: {}, waiver_index: {}, followup_exceptions: {},
    landing_index: { [TARGET]: { recorded_at: "2026-09-22T00:00:00Z", method: "no_pr", commit_sha: sha, base_ref: "main", evidence: ["Existing implementation"] } } };
  const options = { layout: resolveControlPlaneLayout({ coordDir: coord, workspaceRoot: root }), base: "main", configuredBranch: "main", sourceCommit: source };
  // The composition root's final integrity check uses the canonical layout;
  // bind that existing test seam to this real fixture repository as well.
  require("./control-plane-paths.js").__testing.override(options.layout);
  t.after(() => require("./control-plane-paths.js").__testing.reset());
  return { root, repo, remote, row, board, sha, source, commit, options,
    write: extra => landing.ensureControlPlaneLandingRecord(ID, board, row, { ...options, ...extra }),
    remoteHead: () => git(remote, "for-each-ref", "--format=%(objectname)", "refs/heads/main") };
}

for (const donor of [false, true]) for (const selector of ["commit", "ticket"]) test(`real ${donor ? "donor" : "independent"} Git fulfillment by ${selector} persists and validates`, t => {
  const f = fixture(t, donor), previous = structuredClone(f.board.landing_index[TARGET]);
  const record = f.write(selector === "commit" ? { fulfilledByCommit: f.sha } : { fulfilledByTicket: TARGET });
  assert.equal(record.method, "manual"); assert.equal(record.provenance_status, "fulfilled_by");
  assert.equal(record.commit_sha, f.sha); assert.equal(record.fulfilled_by_commit_sha, f.sha);
  assert.equal(record.source_commit_sha, f.source); assert.notEqual(f.source, f.sha);
  assert.equal(record.control_plane_verification, "remote_ancestry");
  if (selector === "ticket") assert.equal(record.fulfilled_by_ticket, TARGET);
  assert.deepEqual(f.board.landing_index[TARGET], previous, "existing landing remains unchanged");
  const file = path.join(f.root, "persisted-board.json"); fs.writeFileSync(file, JSON.stringify(f.board));
  const reloaded = JSON.parse(fs.readFileSync(file)), errors = [];
  boardTesting.validateSchema(schema, reloaded, "tasks.json", errors); assert.deepEqual(errors, []);
  assert.deepEqual(reloaded.landing_index[ID], record);
  const audit = landing.classifyControlPlaneLandingRecord(ID, f.row, record, f.options);
  assert.equal(audit.fulfilled_by_commit_sha, f.sha);
});

const invalid = {
  missing_commit: f => ({ fulfilledByCommit: "missing-ref" }),
  missing_index: f => { delete f.board.landing_index; return { fulfilledByCommit: "missing-ref" }; },
  missing_remote_branch: f => { git(f.remote, "update-ref", "-d", "refs/heads/main"); git(f.repo, "update-ref", "-d", "refs/remotes/origin/main"); return { fulfilledByCommit: f.sha }; },
  stale_remote_ancestry: f => { git(f.remote, "update-ref", "refs/heads/main", f.source); return { fulfilledByCommit: f.sha }; },
  unavailable_remote: f => { git(f.repo, "remote", "set-url", "origin", path.join(f.root, "missing.git")); return { fulfilledByCommit: f.sha }; },
  unrelated_source: f => { git(f.repo, "checkout", "-b", "other", f.source); return { sourceCommit: f.commit("unrelated source"), fulfilledByCommit: f.sha }; },
  missing_ticket: f => ({ fulfilledByTicket: "TEST-MISSING" }),
  self_reference: f => ({ fulfilledByTicket: ID }),
  wrong_repository: f => { f.board.sections[0].rows[1].Repo = "B"; return { fulfilledByTicket: TARGET }; },
  missing_landing: f => { delete f.board.landing_index[TARGET]; return { fulfilledByTicket: TARGET }; },
  source_is_not_landing: f => { f.board.landing_index[TARGET] = { source_commit_sha: f.sha, evidence: [`source ${f.sha}`] }; return { fulfilledByTicket: TARGET }; },
  ambiguous_selectors: f => ({ fulfilledByCommit: f.sha, fulfilledByTicket: TARGET }),
  not_published: f => ({ fulfilledByCommit: f.commit("not published"), pushBeforeCloseout: true }),
  absent_local_ancestry: f => { git(f.repo, "checkout", "-b", "unlanded"); const sha = f.commit("remote only"); git(f.repo, "push", "origin", "HEAD:main"); return { fulfilledByCommit: sha }; },
};
for (const [name, alter] of Object.entries(invalid)) test(`fulfilled-by ${name} refuses before publishing a record or pushing`, t => {
  const f = fixture(t), extra = alter(f), before = structuredClone(f.board), remote = f.remoteHead();
  assert.throws(() => f.write(extra), /fulfill|commit|ancestor|landing|selector/i);
  assert.deepEqual(f.board, before); assert.equal(f.remoteHead(), remote);
});

test("a valid local-only fulfillment remains explicitly local when no remote is configured", t => {
  const f = fixture(t); git(f.repo, "remote", "remove", "origin");
  const record = f.write({ fulfilledByCommit: f.sha });
  assert.equal(record.method, "manual"); assert.equal(record.commit_sha, f.sha);
  assert.equal(record.control_plane_verification, "local_only");
  assert.equal(record.control_plane_verification_reason, "no_control_plane_remote");
});

function closeout(f, effects) {
  return createCloseout({ assertReviewPlanReady() {}, verifyPrEvidence() {}, findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null, isRepoBackedCode: code => code !== "X",
    ensureRepoXCloseoutReady: () => { effects.push("merge"); return null; }, cleanupTicketWorktree: () => effects.push("cleanup") });
}
test("real parsed fulfillment flags reach the closeout consumer and structured writer", t => {
  const f = fixture(t), effects = [];
  const options = { ...f.options, ...parseFlags(["--fulfilled-by-commit", f.sha, "--source-commit", f.source]) };
  closeout(f, effects).prepareDoneCloseout(ID, f.board, { row: f.row }, options);
  assert.equal(f.board.landing_index[ID].fulfilled_by_commit_sha, f.sha);
  assert.equal(f.board.landing_index[ID].control_plane_verification, "remote_ancestry");
  assert.deepEqual(effects, ["merge", "cleanup"]);
});
test("invalid fulfillment is preflighted before the real closeout consumer invokes irreversible effects", t => {
  const f = fixture(t), effects = [], before = structuredClone(f.board);
  assert.throws(() => closeout(f, effects).prepareDoneCloseout(ID, f.board, { row: f.row },
    { ...f.options, ...parseFlags(["--fulfilled-by-commit", "missing-ref"]), mergeWorkspace: true, pushBeforeCloseout: true }), /fulfill|commit/i);
  assert.deepEqual(effects, []); assert.deepEqual(f.board, before);
});

test("ordinary structured merge provenance and historical records keep their existing semantics", t => {
  const f = fixture(t);
  const record = f.write({ commitSha: f.sha, landed: "Actual governed merge" });
  assert.equal(record.method, "no_pr"); assert.equal(record.commit_sha, f.sha);
  assert.equal(record.control_plane_verification, "remote_ancestry");
  assert.equal(record.fulfilled_by_commit_sha, undefined);
  const historical = { method: "no_pr", evidence: ["Historical local record"] };
  f.board.landing_index[ID] = historical;
  assert.equal(f.write({ fulfilledByCommit: f.sha }), historical);
  assert.deepEqual(historical, { method: "no_pr", evidence: ["Historical local record"] });
});

test("a caller-shaped PR tuple cannot bypass verified evidence at the landing writer", t => {
  const f = fixture(t), before = structuredClone(f.board), remote = f.remoteHead();
  assert.throws(() => f.write({
    commitSha: f.sha,
    sourceCommit: f.source,
    prEvidence: {
      requested_url: "https://github.com/example/coord/pull/1",
      url: "https://github.com/example/coord/pull/1",
      repository: "example/coord",
      number: 1,
      base_ref: "main",
      state: "MERGED",
      merged_at: "2026-10-06T00:00:00Z",
      head_ref: "agent/test-763-change",
      head_sha: f.source,
      merge_sha: f.sha,
      ticket_id: ID,
      source_commit_sha: f.source,
    },
  }), /verified in-process PR evidence/);
  assert.deepEqual(f.board, before);
  assert.equal(f.remoteHead(), remote);
});

test("a verified but unrelated GitHub merge is refused before the landing writer can publish", t => {
  const f = fixture(t);
  const evidence = require("./control-plane-pr-evidence.js");
  git(f.repo, "checkout", "-b", "agent/owner-test-763-pr-head", f.source);
  const head = f.commit("PR head after reviewed source");
  const sourceTree = git(f.repo, "rev-parse", `${f.source}^{tree}`);
  const unrelatedMerge = git(f.repo, "commit-tree", sourceTree, "-p", f.source, "-m", "unrelated valid merge object");
  git(f.repo, "checkout", "main");
  const integration = f.commit("unpublished governed integration");
  f.board.pr_index[ID] = ["https://github.com/example/coord/pull/763"];
  const prEvidence = evidence.verifyControlPlanePrEvidence({
    ticketId: ID,
    refs: f.board.pr_index[ID],
    verifiedPrs: [{
      ref: f.board.pr_index[ID][0],
      payload: {
        number: 763,
        url: "https://github.com/example/coord/pull/763",
        state: "MERGED",
        mergedAt: "2026-09-22T00:00:00Z",
        headRefName: "agent/owner-test-763-pr-head",
        headRefOid: head,
        baseRefName: "main",
        mergeCommit: { oid: unrelatedMerge },
      },
    }],
    expectedRepository: "example/coord",
    selectedBaseRef: "main",
    sourceCommitSha: f.source,
    repoRoot: f.repo,
  });
  const beforeBoard = structuredClone(f.board);
  const beforeRemote = f.remoteHead();
  assert.throws(() => f.write({
    commitSha: integration,
    sourceCommit: f.source,
    prEvidence,
    pushBeforeCloseout: true,
  }), /not an ancestor of governed integration/);
  assert.deepEqual(f.board, beforeBoard, "invalid merge ancestry cannot write a landing record");
  assert.equal(f.remoteHead(), beforeRemote, "invalid merge ancestry must refuse before the opt-in push");
});

test("a verified PR proof for a different ticket cannot be replayed into this ticket's landing", t => {
  const f = fixture(t);
  const evidence = require("./control-plane-pr-evidence.js");
  git(f.repo, "checkout", "-b", "agent/owner-test-764-pr-head", f.source);
  const head = f.commit("other ticket PR head");
  const prUrl = "https://github.com/example/coord/pull/764";
  const prEvidence = evidence.verifyControlPlanePrEvidence({
    ticketId: "TEST-764",
    refs: [prUrl],
    verifiedPrs: [{
      ref: prUrl,
      payload: {
        number: 764,
        url: prUrl,
        state: "MERGED",
        mergedAt: "2026-09-22T00:00:00Z",
        headRefName: "agent/owner-test-764-pr-head",
        headRefOid: head,
        baseRefName: "main",
        mergeCommit: { oid: f.sha },
      },
    }],
    expectedRepository: "example/coord",
    selectedBaseRef: "main",
    sourceCommitSha: f.source,
    repoRoot: f.repo,
  });
  const before = structuredClone(f.board);
  assert.throws(() => f.write({ commitSha: f.sha, sourceCommit: f.source, prEvidence }), /different ticket/);
  assert.deepEqual(f.board, before);
});

test("PR provenance cannot be combined with parent-ticket fulfillment", t => {
  const f = fixture(t);
  const evidence = require("./control-plane-pr-evidence.js");
  const prUrl = "https://github.com/example/coord/pull/763";
  const proof = evidence.verifyControlPlanePrEvidence({
    ticketId: ID,
    refs: [prUrl],
    verifiedPrs: [{ ref: prUrl, payload: {
      number: 763,
      url: prUrl,
      state: "MERGED",
      mergedAt: "2026-09-22T00:00:00Z",
      headRefName: "agent/owner-test-763-change",
      headRefOid: f.source,
      baseRefName: "main",
      mergeCommit: { oid: f.source },
    } }],
    expectedRepository: "example/coord",
    selectedBaseRef: "main",
    sourceCommitSha: f.source,
    repoRoot: f.repo,
  });
  const before = structuredClone(f.board), remote = f.remoteHead();
  assert.throws(() => f.write({ commitSha: f.sha, sourceCommit: f.source, prEvidence: proof, fulfilledByCommit: f.sha }), /cannot combine PR landing evidence with parent-ticket fulfillment/);
  assert.deepEqual(f.board, before);
  assert.equal(f.remoteHead(), remote);
});

test("landing writer initializes a missing landing index only after valid evidence is ready", t => {
  const f = fixture(t);
  delete f.board.landing_index;
  const record = f.write({ commitSha: f.sha, sourceCommit: f.source, landed: "Verified governed merge" });
  assert.equal(record.method, "no_pr");
  assert.deepEqual(f.board.landing_index[ID], record);
});

// COORD-803: the public base flag must survive the preflight/landing boundary.
for (const donor of [false, true]) for (const selector of ["dev", "origin/dev", "refs/heads/dev"]) test(`COORD-803: explicit ${selector} base preserves main in ${donor ? "donor" : "independent"} topology`, t => {
  const f = fixture(t, donor), effects = [], main = f.remoteHead();
  git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(f.repo, "checkout", "-b", "dev");
  const sha = f.commit("dev-only implementation");
  git(f.repo, "push", "origin", "dev");
  const options = { layout: f.options.layout, ...parseFlags(["--base", selector, "--source-commit", sha, "--fulfilled-by-commit", sha]) };
  closeout(f, effects).prepareDoneCloseout(ID, f.board, { row: f.row }, options);
  const record = f.board.landing_index[ID];
  assert.equal(record.base_ref, "dev");
  assert.equal(record.source_commit_sha, sha);
  assert.equal(record.commit_sha, sha);
  assert.equal(record.control_plane_verification, "remote_ancestry");
  assert.equal(f.remoteHead(), main, "main must not move to satisfy dev landing");
  assert.deepEqual(effects, ["merge", "cleanup"]);
  assert.equal(landing.evaluateControlPlaneLanding(ID, { commit_sha: main }, { layout: f.options.layout }).base_ref, "main",
    "omitting an explicit base retains the remote-default contract");
});

for (const [label, extra, pattern] of [
  ["conflicting", { base: "dev", configuredBranch: "main" }, /Conflicting control-plane base/],
  ["invalid", { base: "bad..branch" }, /Invalid control-plane base/],
  ["missing", { base: "missing-branch" }, /missing control-plane base/],
]) test(`COORD-803: ${label} explicit base refuses before closeout effects without a source flag`, t => {
  const f = fixture(t), effects = [], before = structuredClone(f.board), main = f.remoteHead();
  assert.throws(() => closeout(f, effects).prepareDoneCloseout(ID, f.board, { row: f.row },
    { layout: f.options.layout, ...extra }), pattern);
  assert.deepEqual(effects, []);
  assert.deepEqual(f.board, before);
  assert.equal(f.remoteHead(), main);
});


test("COORD-803: pre-closeout push publishes only the explicitly selected dev branch", t => {
  const f = fixture(t), main = f.remoteHead();
  git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(f.repo, "checkout", "-b", "dev");
  git(f.repo, "push", "origin", "dev");
  const source = f.commit("unpublished dev fixture implementation");
  const record = landing.ensureControlPlaneLandingRecord(ID, f.board, f.row, {
    layout: f.options.layout, base: "dev", commitSha: source, sourceCommit: source,
    pushBeforeCloseout: true, landed: "Fixture closeout push",
  });
  assert.equal(record.base_ref, "dev");
  assert.equal(record.commit_sha, source);
  assert.equal(record.control_plane_verification, "remote_ancestry");
  assert.equal(git(f.remote, "rev-parse", "refs/heads/dev"), source);
  assert.equal(f.remoteHead(), main);
  assert.equal(git(f.repo, "rev-parse", "refs/heads/main"), main);
});

test("COORD-803: existing wrong base refuses fulfillment before workspace effects", t => {
  const f = fixture(t), effects = [], main = f.remoteHead();
  git(f.repo, "checkout", "-b", "dev");
  const source = f.commit("dev-only source on wrong-base probe");
  git(f.repo, "push", "origin", "dev");
  assert.throws(() => closeout(f, effects).prepareDoneCloseout(ID, f.board, { row: f.row }, {
    layout: f.options.layout, base: "main", sourceCommit: source,
    fulfilledByCommit: source, pushBeforeCloseout: true,
  }), /not an ancestor of local main/);
  assert.deepEqual(effects, []);
  assert.equal(f.remoteHead(), main);
  assert.equal(f.board.landing_index[ID], undefined);
});

// Explicit resolver guard contracts and a real Git ref deletion between the
// two remote observations; no synthetic successful landing assessment.
test("COORD-803: fulfillment refuses wrong repo and unavailable control-plane topology", t => {
  const f = fixture(t);
  const before = structuredClone(f.board);
  assert.throws(() => landing.resolveControlPlaneFulfillment(ID, f.board, { ...f.row, Repo: "B" }, { ...f.options, fulfilledByCommit: f.sha }), /requires a control-plane/);
  assert.throws(() => landing.resolveControlPlaneFulfillment(ID, f.board, f.row, { ...f.options, fulfilledByCommit: f.sha, layout: { coordRepoRoot: null } }), /no control-plane repository/);
  assert.equal(landing.resolveSourceCommitOrRefuse(ID, { layout: { coordRepoRoot: null }, sourceCommit: f.sha }), null);
  assert.deepEqual(f.board, before);
});

test("COORD-803: disappearance of the remote branch during verification never becomes local-only fulfillment", t => {
  const f = fixture(t), before = structuredClone(f.board);
  const { resolveFulfillment } = require("./control-plane-fulfillment.js");
  assert.throws(() => resolveFulfillment(ID, f.board, f.row, { ...f.options, fulfilledByCommit: f.sha }, (sha, options) => {
    git(f.remote, "update-ref", "-d", "refs/heads/main");
    git(f.repo, "update-ref", "-d", "refs/remotes/origin/main");
    return landing.evaluateControlPlaneLanding(ID, { commit_sha: sha }, options);
  }), /no verifiable main branch/);
  assert.deepEqual(f.board, before);
});

test("COORD-803: implicit resolver uses actual Git branch then fallback for detached repositories", t => {
  const f = fixture(t);
  const { resolveControlPlaneIntegrationBranch } = require("./control-plane-paths.js");
  git(f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  assert.equal(resolveControlPlaneIntegrationBranch(f.options.layout), "main");
  git(f.repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  assert.equal(resolveControlPlaneIntegrationBranch(f.options.layout), "main");
  git(f.repo, "checkout", "--detach", f.sha);
  assert.equal(resolveControlPlaneIntegrationBranch(f.options.layout), "main");
  assert.equal(resolveControlPlaneIntegrationBranch(f.options.layout, { fallback: "integration" }), "integration");
});

test("COORD-803: empty responses from an injected ref adapter cannot invent a default branch", () => {
  const { resolveControlPlaneIntegrationBranch } = require("./control-plane-paths.js");
  assert.equal(resolveControlPlaneIntegrationBranch({ coordRepoRoot: "/unused-by-adapter" }, {
    fallback: "integration",
    gitTry: () => ({ status: 0, stdout: "", stderr: "" }),
  }), "integration");
});
