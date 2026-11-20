"use strict";

// COORD-1026 / ADR 0028: fixture tests for `gov promote`. Every edge runs against local bare
// remotes; no real origin, no real branch, no ruleset is touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { gitFixture, gitFixtureEnv } = require("./test-git-fixture.js");
const promote = require("./promote.js");
const { createApprovalFixture } = require("./__fixtures__/approval-fixture.js");

// promote.js runs git with the host environment, so give the fixture repos a commit identity.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "coord-test",
  GIT_AUTHOR_EMAIL: "coord-test@example.invalid",
  GIT_COMMITTER_NAME: "coord-test",
  GIT_COMMITTER_EMAIL: "coord-test@example.invalid",
});

const POLICY_REL = "coord/engine/test-policy.json";
// The policy names each edge's gates (ADR 0028 section 3); promote reads them from the commit.
const EDGE_GATES = {
  "dev->staging": ["full-suite-sharded-node22"],
  "staging->main": ["full-suite-node22", "full-suite-node24", "coverage-ratchet"],
  "main->concord-public-release": ["community-cut-build", "donor-hygiene-scan", "release-secret-scan", "dual-release-verify", "install-canaries-npm-sea"],
  "main->concord-enterprise-release": ["enterprise-cut-build", "enterprise-qualification", "enterprise-ref-scan"],
};
const POLICY_TEXT = `${JSON.stringify({ policy_version: 2, promotion_edges: Object.fromEntries(Object.entries(EDGE_GATES).map(([edge, gates]) => [edge, { gates }])) }, null, 2)}\n`;
const HOLDER = "claudea808";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitFixtureEnv() }).trim();
}

function commitFile(repo, name, body, message) {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  git(repo, ["add", name]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

// A work repo with a local bare remote named origin. Branches: main and dev are pushed; staging,
// concord-public-release and concord-enterprise-release are only created when a test asks for them (creating a
// remote branch is outside the verb, so tests stand in for the human-admin step).
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-1026-promote-"));
  const bare = path.join(root, "origin.git");
  const repo = path.join(root, "work");
  fs.mkdirSync(repo);
  gitFixture(root, ["init", "-q", "--bare", bare]);
  gitFixture(repo, ["init", "-q", "-b", "dev"]);
  git(repo, ["remote", "add", "origin", bare]);
  const base = commitFile(repo, POLICY_REL, POLICY_TEXT, "base");
  const devTip = commitFile(repo, "src/a.txt", "a\n", "dev work 1");
  git(repo, ["push", "-q", "origin", `${base}:refs/heads/main`, `${devTip}:refs/heads/dev`]);
  git(repo, ["fetch", "-q", "origin"]);
  // COORD-1043: the per-fixture journal holds the producer events promote binds manifests to.
  return { root, bare, repo, base, devTip, journal: [], cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function pushBranch(f, branch, sha) {
  git(f.repo, ["push", "-q", "origin", `${sha}:refs/heads/${branch}`]);
  git(f.repo, ["fetch", "-q", "origin"]);
}

function remoteSha(f, branch) {
  return git(f.bare, ["rev-parse", `refs/heads/${branch}`]);
}

function policyAt(repo, commit) {
  // Raw blob bytes, matching promote.js (the digest covers the exact file).
  return execFileSync("git", ["show", `${commit}:${POLICY_REL}`], { cwd: repo, encoding: "utf8", env: gitFixtureEnv() });
}

// writeManifest stands in for a manifest the producer wrote. COORD-1043: by default it also journals the
// producer event that binds the file's bytes (as produceGateManifest does); { journal: false } writes a
// manifest that no producer ever recorded, which promote must refuse.
function writeManifest(f, { edge, commit, gates, policy = policyAt(f.repo, commit), tree, overrides = {}, journal = true }) {
  const manifest = {
    schema: "promotion-gate-manifest/1",
    edge,
    commit,
    tree: tree || git(f.repo, ["rev-parse", `${commit}^{tree}`]),
    policy_sha256: promote.sha256Hex(Buffer.from(policy)),
    gates,
    ...overrides,
  };
  const file = path.join(f.root, `manifest-${edge.replace(/[^a-z0-9]/gi, "_")}-${commit.slice(0, 8)}-${Math.random().toString(36).slice(2, 7)}.json`);
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (journal) {
    f.journal.push({ command: "promotion-manifest", result: "produced", details: { edge: manifest.edge, commit: manifest.commit, tree: manifest.tree, policy_sha256: manifest.policy_sha256, manifest_sha256: promote.sha256Hex(bytes), gates: manifest.gates } });
  }
  fs.writeFileSync(file, bytes);
  return file;
}

const ALL_PASS = (names) => Object.fromEntries(names.map((n) => [n, "pass"]));
const GATES = {
  "dev->staging": ALL_PASS(["full-suite-sharded-node22"]),
  "staging->main": ALL_PASS(["full-suite-node22", "full-suite-node24", "coverage-ratchet"]),
  "main->concord-public-release": ALL_PASS(["community-cut-build", "donor-hygiene-scan", "release-secret-scan", "dual-release-verify", "install-canaries-npm-sea"]),
  "main->concord-enterprise-release": ALL_PASS(["enterprise-cut-build", "enterprise-qualification", "enterprise-ref-scan"]),
};

function deps(overrides = {}) {
  const events = [];
  return {
    events,
    resolveCaller: () => ({ handle: HOLDER, session_id: "s1" }),
    readRecord: () => ({ holder: { handle: HOLDER } }),
    appendGovernanceEvent: (event) => events.push(event),
    ...overrides,
  };
}

function argsFor(from, to, commit, extra = []) {
  return ["--from", from, "--to", to, "--commit", commit, ...extra];
}

// COORD-1043: promote reads the producer events of this fixture (the journal), not the manifest file.
function run(f, args, d = deps()) {
  return promote.runPromote(args, { readJournal: () => f.journal, ...d, repo: f.repo });
}

function runWithSignedReleaseApproval(f, args, d) {
  const preview = run(f, [...args, "--dry-run"], d);
  const requirement = preview.plan.release.approval.signed_approval;
  const fixtureApproval = createApprovalFixture({ allowedVerbs: [requirement.verb] });
  try {
    fixtureApproval.login({ verb: requirement.verb, ticket: requirement.ticket, subject_sha256: requirement.subject_sha256 });
    d.approvalClient = fixtureApproval.client();
    return run(f, args, d);
  } finally {
    fixtureApproval.cleanup();
  }
}

function assertRefusal(fn, pattern) {
  assert.throws(fn, (error) => error.name === "PromoteRefusal" && pattern.test(error.message), pattern);
}

test("dev -> staging promotes the exact commit fast-forward, journals it, and leaves no merge commit", () => {
  const cli = require("./cli.js");
  const lifecycle = require("./lifecycle.js");
  const { withRegisterPromptHarness } = require("../../scripts/governance-test-utils.js");
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    const manifest = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: GATES["dev->staging"] });
    withRegisterPromptHarness("coord-promotion-journal-", {}, () => {
      const env = {
        ...process.env,
        COORD_PROMOTE_REPO: f.repo,
        COORD_PROVIDER: "anthropic",
        COORD_SESSION_ID: "promotion-thread",
        CLAUDE_CODE_SESSION_ID: "promotion-thread",
        COORD_PROVIDER_SESSION_ID: undefined,
        COORD_INSTANCE_ID: undefined,
        CODEX_THREAD_ID: undefined,
        AGENT_THREAD_ID: undefined,
        CLAUDECODE: undefined,
        GEMINI_AGENT: undefined,
        GROK_AGENT: undefined,
      };
      const execute = (args) => cli.executeCommand(args, { env });
      const claimed = execute(["agent-claim", "claudea11"]);
      assert.equal(claimed.ok, true, claimed.error);
      const authority = execute(["integration", "claim"]);
      assert.equal(authority.ok, true, authority.error);

      const argv = ["promote", ...argsFor("dev", "staging", f.devTip, ["--gate-manifest", manifest])];
      const unrecorded = execute(argv);
      assert.equal(unrecorded.ok, false);
      assert.match(unrecorded.error, /manifest.*journal/i);
      assert.equal(remoteSha(f, "staging"), f.base);

      lifecycle.__testing.appendGovernanceEvent({
        ts: new Date().toISOString(), ticket: null, before_status: null, after_status: null,
        identity: null, changed_paths: [], ...f.journal[0],
      });
      const result = execute(argv);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.value.promoted, true);
      assert.equal(remoteSha(f, "staging"), f.devTip);
      assert.equal(git(f.bare, ["rev-list", "--merges", `${f.base}..${f.devTip}`]), "");
      const promotions = lifecycle.__testing.readGovernanceEventLog().filter((event) => event.command === "promote");
      assert.equal(promotions.length, 1);
      const [event] = promotions;
      assert.equal(event.details.edge, "dev->staging");
      assert.equal(event.details.commit, f.devTip);
      assert.equal(event.details.target_before, f.base);
      assert.equal(event.details.fast_forward_distance, 1);
      assert.equal(event.details.adr_ref, "ADR-0028");
      assert.equal(event.identity.handle, "claudea11");
    });
  } finally {
    f.cleanup();
  }
});

test("staging -> main promotes after the Node 22 and Node 24 gates pass", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.devTip);
    pushBranch(f, "main", f.base);
    const manifest = writeManifest(f, { edge: "staging->main", commit: f.devTip, gates: GATES["staging->main"] });
    const result = run(f, argsFor("staging", "main", f.devTip, ["--gate-manifest", manifest]));
    assert.equal(result.promoted, true);
    assert.equal(remoteSha(f, "main"), f.devTip);
  } finally {
    f.cleanup();
  }
});

test("staging -> main refuses when the Node 24 gate is absent, even if Node 22 passed", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.devTip);
    pushBranch(f, "main", f.base);
    const gates = { "full-suite-node22": "pass", "coverage-ratchet": "pass" };
    const manifest = writeManifest(f, { edge: "staging->main", commit: f.devTip, gates });
    assertRefusal(() => run(f, argsFor("staging", "main", f.devTip, ["--gate-manifest", manifest])), /missing required gates: full-suite-node24/);
    assert.equal(remoteSha(f, "main"), f.base);
  } finally {
    f.cleanup();
  }
});

test("main -> concord-public-release promotes with per-commit human-admin approval and writes an annotated provenance tag", () => {
  const f = fixture();
  try {
    pushBranch(f, "main", f.devTip);
    pushBranch(f, "concord-public-release", f.base);
    const qualification_sha256 = "a".repeat(64);
    const manifest = writeManifest(f, { edge: "main->concord-public-release", commit: f.devTip,
      gates: GATES["main->concord-public-release"], overrides: { qualification_sha256 } });
    const approval = path.join(f.root, "approval-community.json");
    fs.writeFileSync(approval, JSON.stringify({ approver: "human-admin", edition: "community", commit: f.devTip, approved_at: "2026-11-16", approval_ref: "COORD-1026-test" }));
    const d = deps();
    const result = runWithSignedReleaseApproval(f, argsFor("main", "concord-public-release", f.devTip, ["--gate-manifest", manifest, "--approval", approval]), d);
    assert.equal(result.promoted, true);
    assert.equal(remoteSha(f, "concord-public-release"), f.devTip);
    const tag = result.plan.release.tag;
    assert.equal(tag, `cut/community/${f.devTip.slice(0, 12)}`);
    assert.equal(git(f.repo, ["cat-file", "-t", `refs/tags/${tag}`]), "tag", "provenance tag is annotated");
    assert.equal(git(f.repo, ["rev-parse", `refs/tags/${tag}^{commit}`]), f.devTip);
    assert.equal(git(f.bare, ["rev-parse", `refs/tags/${tag}^{commit}`]), f.devTip, "tag is pushed to the remote");
    assert.equal(d.events.filter((event) => event.command === "promote" && event.result === "promoted").length, 1);
    assert.equal(d.events.find((event) => event.event === "approval.verified").ticket, f.devTip);
    const promoteEvent = d.events.find((event) => event.command === "promote" && event.result === "promoted");
    assert.equal(promoteEvent.details.release.edition, "community");
    assert.equal(promoteEvent.details.qualification_sha256, qualification_sha256);
    const annotation = git(f.bare, ["for-each-ref", "--format=%(contents:trailers)", `refs/tags/${tag}`]);
    assert.ok(annotation.includes(`Qualification-SHA256: ${qualification_sha256}`));
    assert.ok(annotation.includes(`Gate-Manifest-SHA256: ${promote.sha256Hex(fs.readFileSync(manifest))}`));
    assert.ok(annotation.includes(`Promotion-Approval-Subject-SHA256: ${promoteEvent.details.release.approval.subject_sha256}`));
    assert.equal(promoteEvent.details.release.approval.approver, "human-admin");
    assert.ok(promoteEvent.details.release.approval.approval_record);
  } finally {
    f.cleanup();
  }
});

test("main -> concord-enterprise-release promotes with its own edition approval", () => {
  const f = fixture();
  try {
    pushBranch(f, "main", f.devTip);
    pushBranch(f, "concord-enterprise-release", f.base);
    const manifest = writeManifest(f, { edge: "main->concord-enterprise-release", commit: f.devTip, gates: GATES["main->concord-enterprise-release"] });
    const approval = path.join(f.root, "approval-enterprise.json");
    fs.writeFileSync(approval, JSON.stringify({ approver: "human-admin", edition: "enterprise", commit: f.devTip }));
    const d = deps();
    const result = runWithSignedReleaseApproval(f, argsFor("main", "concord-enterprise-release", f.devTip, ["--gate-manifest", manifest, "--approval", approval]), d);
    assert.equal(result.promoted, true);
    assert.equal(remoteSha(f, "concord-enterprise-release"), f.devTip);
    assert.match(result.plan.release.tag, /^cut\/enterprise\//);
    assert.ok(d.events.find((event) => event.command === "promote" && event.result === "promoted").details.release.approval.approval_record);
  } finally {
    f.cleanup();
  }
});

test("release edges refuse without approval, with another edition's approval, or for another commit", () => {
  const f = fixture();
  try {
    pushBranch(f, "main", f.devTip);
    pushBranch(f, "concord-public-release", f.base);
    const manifest = writeManifest(f, { edge: "main->concord-public-release", commit: f.devTip, gates: GATES["main->concord-public-release"] });
    assertRefusal(() => run(f, argsFor("main", "concord-public-release", f.devTip, ["--gate-manifest", manifest])), /needs human-admin approval/);
    const wrongEdition = path.join(f.root, "wrong-edition.json");
    fs.writeFileSync(wrongEdition, JSON.stringify({ approver: "human-admin", edition: "enterprise", commit: f.devTip }));
    assertRefusal(() => run(f, argsFor("main", "concord-public-release", f.devTip, ["--gate-manifest", manifest, "--approval", wrongEdition])), /approval is for edition enterprise/);
    const wrongCommit = path.join(f.root, "wrong-commit.json");
    fs.writeFileSync(wrongCommit, JSON.stringify({ approver: "human-admin", edition: "community", commit: f.base }));
    assertRefusal(() => run(f, argsFor("main", "concord-public-release", f.devTip, ["--gate-manifest", manifest, "--approval", wrongCommit])), /per commit and edition/);
    const unsigned = path.join(f.root, "unsigned.json");
    fs.writeFileSync(unsigned, JSON.stringify({ approver: "human-admin", edition: "community", commit: f.devTip }));
    assertRefusal(() => run(f, argsFor("main", "concord-public-release", f.devTip, ["--gate-manifest", manifest, "--approval", unsigned])), /requires a signed human-admin approval/);
    assert.equal(remoteSha(f, "concord-public-release"), f.base);
  } finally {
    f.cleanup();
  }
});

test("edges outside ADR 0028 section 2 are refused before any gate or push", () => {
  const f = fixture();
  try {
    assertRefusal(() => run(f, argsFor("dev", "dev", f.devTip)), /edge dev->dev is not an allowed edge/);
    for (const [from, to] of [["dev", "main"], ["dev", "concord-public-release"], ["dev", "concord-enterprise-release"], ["staging", "concord-public-release"], ["staging", "concord-enterprise-release"], ["main", "dev"], ["main", "staging"]]) {
      assertRefusal(() => run(f, argsFor(from, to, f.devTip)), /is not an allowed edge/);
    }
  } finally {
    f.cleanup();
  }
});

test("fast-forward only: a target that diverged from the commit is refused, never merged or forced", () => {
  const f = fixture();
  try {
    // staging holds a commit that is not an ancestor of dev's next commit.
    git(f.repo, ["checkout", "-q", "-b", "side", f.base]);
    const side = commitFile(f.repo, "src/side.txt", "side\n", "side work");
    pushBranch(f, "staging", side);
    git(f.repo, ["checkout", "-q", "-B", "devwork", f.devTip]);
    const newer = commitFile(f.repo, "src/b.txt", "b\n", "dev work 2");
    git(f.repo, ["push", "-q", "origin", `${newer}:refs/heads/dev`]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const manifest = writeManifest(f, { edge: "dev->staging", commit: newer, gates: GATES["dev->staging"] });
    assertRefusal(() => run(f, argsFor("dev", "staging", newer, ["--gate-manifest", manifest])), /non-fast-forward/);
    assert.equal(remoteSha(f, "staging"), side, "staging is unchanged");
  } finally {
    f.cleanup();
  }
});

test("a commit that is not on the source branch is refused", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    git(f.repo, ["checkout", "-q", "-b", "orphan", f.base]);
    const offBranch = commitFile(f.repo, "src/off.txt", "off\n", "off branch");
    const manifest = writeManifest(f, { edge: "dev->staging", commit: offBranch, gates: GATES["dev->staging"] });
    assertRefusal(() => run(f, argsFor("dev", "staging", offBranch, ["--gate-manifest", manifest])), /is not on dev/);
  } finally {
    f.cleanup();
  }
});

test("gate binding: a missing, wrong-commit, stale-tree or wrong-policy manifest is refused", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip)), /--gate-manifest is required/);
    const other = writeManifest(f, { edge: "dev->staging", commit: f.base, gates: GATES["dev->staging"] });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", other])), /is for commit/);
    const staleTree = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: GATES["dev->staging"], tree: "0".repeat(40) });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", staleTree])), /stale tree/);
    const oldPolicy = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: GATES["dev->staging"], policy: "{\"policy_version\":0}\n" });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", oldPolicy])), /policy digest/);
    const wrongEdge = writeManifest(f, { edge: "staging->main", commit: f.devTip, gates: GATES["dev->staging"] });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", wrongEdge])), /is for edge staging->main/);
    assert.equal(remoteSha(f, "staging"), f.base);
  } finally {
    f.cleanup();
  }
});

test("a red gate refuses promotion; the red-baseline exception for promotions is not applied (ADR 0028 open question 7)", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    const red = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: { "full-suite-sharded-node22": "fail" } });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", red])), /red gate .*open question 7/);
    assert.equal(remoteSha(f, "staging"), f.base);
  } finally {
    f.cleanup();
  }
});

test("only the integration-authority holder may promote; a different holder is refused", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    const manifest = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: GATES["dev->staging"] });
    const other = deps({ resolveCaller: () => ({ handle: "claudea999" }) });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", manifest]), other), /only the integration-authority holder/);
    const none = deps({ readRecord: () => ({ holder: null }) });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", manifest]), none), /no integration-authority holder/);
    assert.equal(remoteSha(f, "staging"), f.base);
  } finally {
    f.cleanup();
  }
});

test("a target branch that does not exist is refused: creating it is a human-admin step", () => {
  const f = fixture();
  try {
    const manifest = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: GATES["dev->staging"] });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", manifest])), /target branch staging does not exist/);
  } finally {
    f.cleanup();
  }
});

test("--dry-run reports the edge, commit, gate evidence and fast-forward distance, and moves nothing", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    const manifest = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: GATES["dev->staging"] });
    const d = deps();
    const before = { staging: remoteSha(f, "staging"), tags: git(f.bare, ["tag", "--list"]) };
    const result = run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", manifest, "--dry-run"]), d);
    assert.equal(result.dry_run, true);
    assert.equal(result.promoted, false);
    assert.equal(result.plan.commit, f.devTip);
    assert.equal(result.plan.fast_forward_distance, 1);
    assert.deepEqual(result.plan.gate.gates, ["full-suite-sharded-node22"]);
    assert.match(result.plan.gate.manifest_sha256, /^[0-9a-f]{64}$/);
    assert.equal(remoteSha(f, "staging"), before.staging, "no ref moved");
    assert.equal(git(f.bare, ["tag", "--list"]), before.tags);
    assert.equal(d.events.length, 0, "no journal event for a preview");
  } finally {
    f.cleanup();
  }
});

test("--dry-run on a release edge previews the provenance tag without creating it", () => {
  const f = fixture();
  try {
    pushBranch(f, "main", f.devTip);
    pushBranch(f, "concord-public-release", f.base);
    const manifest = writeManifest(f, { edge: "main->concord-public-release", commit: f.devTip, gates: GATES["main->concord-public-release"] });
    const approval = path.join(f.root, "approval-dry.json");
    fs.writeFileSync(approval, JSON.stringify({ approver: "human-admin", edition: "community", commit: f.devTip }));
    const d = deps();
    const result = run(f, argsFor("main", "concord-public-release", f.devTip, ["--gate-manifest", manifest, "--approval", approval, "--dry-run"]), d);
    assert.equal(result.plan.release.tag, `cut/community/${f.devTip.slice(0, 12)}`);
    assert.equal(git(f.repo, ["tag", "--list", "cut/*"]), "");
    assert.equal(remoteSha(f, "concord-public-release"), f.base);
    assert.equal(d.events.length, 0);
  } finally {
    f.cleanup();
  }
});

test("the verb refuses a missing --from, --to or --commit before any git call", () => {
  assert.throws(() => promote.parseFlags(["--from", "dev", "--to", "staging"]), /--commit is required/);
  assert.throws(() => promote.parseFlags(["--to", "staging", "--commit", "abc"]), /--from is required/);
});

test("a promotion without a journal appender is refused rather than moving a branch unjournaled", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    const manifest = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: GATES["dev->staging"] });
    const noJournal = { resolveCaller: () => ({ handle: HOLDER }), readRecord: () => ({ holder: { handle: HOLDER } }) };
    assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", manifest]), noJournal), /must be journaled/);
  } finally {
    f.cleanup();
  }
});

test("the gate names come from promotion_edges in the policy at the commit, not from promote.js", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    // A policy that names a different gate for dev -> staging: the old gate name is no longer enough.
    const renamed = `${JSON.stringify({ policy_version: 3, promotion_edges: { "dev->staging": { gates: ["renamed-gate"] } } })}\n`;
    git(f.repo, ["checkout", "-q", "-B", "policy-change", f.devTip]);
    fs.writeFileSync(path.join(f.repo, POLICY_REL), renamed);
    git(f.repo, ["commit", "-q", "-am", "policy names a new gate"]);
    const policyCommit = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "-q", "origin", `${policyCommit}:refs/heads/dev`]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const oldGate = writeManifest(f, { edge: "dev->staging", commit: policyCommit, gates: GATES["dev->staging"] });
    assertRefusal(() => run(f, argsFor("dev", "staging", policyCommit, ["--gate-manifest", oldGate])), /missing required gates: renamed-gate/);
    const newGate = writeManifest(f, { edge: "dev->staging", commit: policyCommit, gates: { "renamed-gate": "pass" } });
    const result = run(f, argsFor("dev", "staging", policyCommit, ["--gate-manifest", newGate]), deps());
    assert.deepEqual(result.plan.gate.gates, ["renamed-gate"]);
    assert.equal(remoteSha(f, "staging"), policyCommit);
  } finally {
    f.cleanup();
  }
});

test("a commit whose policy has no promotion_edges table cannot bind an edge gate and is refused", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    git(f.repo, ["checkout", "-q", "-B", "no-table", f.devTip]);
    fs.writeFileSync(path.join(f.repo, POLICY_REL), "{\"policy_version\":9}\n");
    git(f.repo, ["commit", "-q", "-am", "policy without promotion_edges"]);
    const bare = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "-q", "origin", `${bare}:refs/heads/dev`]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const manifest = writeManifest(f, { edge: "dev->staging", commit: bare, gates: GATES["dev->staging"] });
    assertRefusal(() => run(f, argsFor("dev", "staging", bare, ["--gate-manifest", manifest])), /has no promotion_edges table/);
    assert.equal(remoteSha(f, "staging"), f.base);
  } finally {
    f.cleanup();
  }
});

test("refusals go through the injected governed fail, which is how the CLI reports them", () => {
  const f = fixture();
  try {
    const seen = [];
    const governedFail = (message) => {
      seen.push(message);
      throw new Error(`GOV: ${message}`);
    };
    assert.throws(() => run(f, argsFor("dev", "main", f.devTip), { ...deps(), fail: governedFail }), /^Error: GOV: promote: edge dev->main is not an allowed edge/);
    assert.equal(seen.length, 1);
  } finally {
    f.cleanup();
  }
});

test("the shipped test-policy.json promotion_edges names exactly the four ADR 0028 edges and their gates", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "test-policy.json"), "utf8"));
  assert.deepEqual(Object.keys(policy.promotion_edges).sort(), Object.keys(promote.EDGES).sort());
  for (const [edge, gates] of Object.entries(EDGE_GATES)) {
    assert.deepEqual(policy.promotion_edges[edge].gates, gates, `${edge} gate binding`);
  }
  assert.deepEqual(policy.promotion_edges["staging->main"].gates.filter((g) => /node24/.test(g)), ["full-suite-node24"], "Node 24 runs at staging -> main (ADR 0028 open question 8)");
});

// COORD-1036: the gate-manifest producer. The fixture gate is a tiny script committed with the
// candidate; it reports the result the candidate's gate-result.txt names, so a red candidate is a
// real red gate. No real suite runs.
const FX_NODE24_BIN = "/mnt/disk/shared/node/v24/bin";
const FX_NODE = { node22: path.dirname(process.execPath), node24: FX_NODE24_BIN };
const FX_GATE_RUNS = {
  "fx-node22": { lane: "node22", argv: ["fixture-gate.js"] },
  "fx-node24": { lane: "node24", argv: ["fixture-gate.js"] },
  "fx-ratchet": { derivedFrom: "fx-node22" },
};
const FX_POLICY = `${JSON.stringify({ policy_version: 4, promotion_edges: {
  "dev->staging": { gates: ["fx-node22"] },
  "staging->main": { gates: ["fx-node22", "fx-node24", "fx-ratchet"] },
  "main->concord-public-release": { gates: ["fx-release-build"] },
} }, null, 2)}\n`;
const FX_GATE = `"use strict";
const fs = require("node:fs");
const report = process.argv[process.argv.indexOf("--report") + 1];
const result = fs.readFileSync("gate-result.txt", "utf8").trim();
fs.writeFileSync(report, JSON.stringify({ result, engine_coverage: { ratchet: { result } } }));
process.exit(result === "pass" ? 0 : 1);
`;

// A candidate on dev with the fixture policy and gate. staging and main sit at the base commit.
function producerFixture(gateResult = "pass") {
  const f = fixture();
  git(f.repo, ["checkout", "-q", "-B", "candidate", f.devTip]);
  commitFile(f.repo, POLICY_REL, FX_POLICY, "fixture policy");
  commitFile(f.repo, "fixture-gate.js", FX_GATE, "fixture gate");
  const candidate = commitFile(f.repo, "gate-result.txt", `${gateResult}\n`, "fixture candidate");
  git(f.repo, ["push", "-q", "origin", `${candidate}:refs/heads/dev`]);
  git(f.repo, ["fetch", "-q", "origin"]);
  pushBranch(f, "staging", f.base);
  pushBranch(f, "main", f.base);
  return { ...f, candidate };
}

// The producer journals each manifest into the fixture's journal (COORD-1043).
function produce(f, edge, commit, out = path.join(f.root, `gate-${edge.replace(/[^a-z0-9]/gi, "_")}-${commit.slice(0, 8)}.json`)) {
  return promote.produceGateManifest({ edge, commit, out }, { repo: f.repo, gateRuns: FX_GATE_RUNS, nodeBinDir: FX_NODE, appendGovernanceEvent: (event) => f.journal.push(event) });
}

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeTampered(f, manifest, mutate) {
  const copy = JSON.parse(JSON.stringify(manifest));
  mutate(copy);
  const file = path.join(f.root, `tampered-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify(copy));
  return file;
}

test("producer: a dev -> staging manifest is written in the promote schema and accepted by promote", () => {
  const f = producerFixture();
  try {
    const result = produce(f, "dev->staging", f.candidate);
    assert.equal(result.produced, true);
    assert.deepEqual(result.red, []);
    const manifest = readManifest(result.manifest_file);
    assert.deepEqual(Object.keys(manifest).sort(), ["commit", "edge", "gates", "policy_sha256", "schema", "tree"]);
    assert.equal(manifest.schema, promote.MANIFEST_SCHEMA);
    assert.equal(manifest.commit, f.candidate);
    assert.equal(manifest.tree, git(f.repo, ["rev-parse", `${f.candidate}^{tree}`]));
    assert.deepEqual(manifest.gates, { "fx-node22": "pass" });
    assert.ok(Number.isFinite(result.runs["fx-node22"].duration_ms));
    assert.ok(result.runs["fx-node22"].duration_ms >= 0);
    const promoted = run(f, argsFor("dev", "staging", f.candidate, ["--gate-manifest", result.manifest_file]));
    assert.equal(promoted.promoted, true);
    assert.equal(remoteSha(f, "staging"), f.candidate);
  } finally {
    f.cleanup();
  }
});

test("producer: staging -> main runs the Node 24 lane and the derived ratchet, and promote accepts the manifest", { skip: !fs.existsSync(path.join(FX_NODE24_BIN, "node")) && "shared Node 24 is not installed on this host" }, () => {
  const f = producerFixture();
  try {
    const result = produce(f, "staging->main", f.candidate);
    assert.deepEqual(result.manifest.gates, { "fx-node22": "pass", "fx-node24": "pass", "fx-ratchet": "pass" });
    assert.match(result.runs["fx-node24"].node_version, /^v24\./, "the edge's Node 24 gate ran on Node 24");
    assert.equal(result.runs["fx-node22"].node_version, process.version, "the Node 22 gate ran on the Node 22 lane");
    assert.equal(result.plan.gates.find((g) => g.gate === "fx-node24").lane, "node24");
    for (const gate of ["fx-node22", "fx-node24"]) {
      assert.ok(Number.isFinite(result.runs[gate].duration_ms), `${gate} records its measured gate duration`);
      assert.ok(result.runs[gate].duration_ms >= 0, `${gate} duration is non-negative`);
    }
    // Put the candidate on staging, then promote it to main with the manifest for that edge.
    pushBranch(f, "staging", f.candidate);
    const promoted = run(f, argsFor("staging", "main", f.candidate, ["--gate-manifest", result.manifest_file]));
    assert.equal(promoted.promoted, true);
    assert.equal(remoteSha(f, "main"), f.candidate);
  } finally {
    f.cleanup();
  }
});

test("producer: tampering the commit, tree, policy digest or a gate result is refused by promote", () => {
  const f = producerFixture();
  try {
    const result = produce(f, "dev->staging", f.candidate);
    const good = readManifest(result.manifest_file);
    const cases = [
      [/is for commit/, (m) => { m.commit = f.base; }],
      [/stale tree/, (m) => { m.tree = "0".repeat(40); }],
      [/policy digest/, (m) => { m.policy_sha256 = "0".repeat(64); }],
      [/red gate/, (m) => { m.gates["fx-node22"] = "fail"; }],
      [/missing required gates: fx-node22/, (m) => { m.gates = {}; }],
    ];
    for (const [pattern, mutate] of cases) {
      const file = writeTampered(f, good, mutate);
      assertRefusal(() => run(f, argsFor("dev", "staging", f.candidate, ["--gate-manifest", file])), pattern);
    }
    assert.equal(remoteSha(f, "staging"), f.base, "no tampered manifest moved staging");
  } finally {
    f.cleanup();
  }
});

test("producer: a red gate is recorded as red, the manifest says so, and promote refuses it", () => {
  const f = producerFixture("fail");
  try {
    const result = produce(f, "dev->staging", f.candidate);
    assert.equal(result.produced, true, "the red result is written, not hidden");
    assert.deepEqual(result.red, ["fx-node22"]);
    assert.deepEqual(readManifest(result.manifest_file).gates, { "fx-node22": "fail" });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.candidate, ["--gate-manifest", result.manifest_file])), /red gate .*open question 7/);
    assert.equal(remoteSha(f, "staging"), f.base);
  } finally {
    f.cleanup();
  }
});

test("producer: dry run reports the plan, lanes and digest, and writes nothing and creates no worktree", () => {
  const f = producerFixture();
  try {
    const worktreesBefore = git(f.repo, ["worktree", "list", "--porcelain"]);
    const out = path.join(f.root, "dry-run-manifest.json");
    const result = promote.produceGateManifest({ edge: "staging->main", commit: f.candidate, out, dryRun: true }, { repo: f.repo, gateRuns: FX_GATE_RUNS, nodeBinDir: FX_NODE });
    assert.equal(result.dry_run, true);
    assert.equal(result.produced, false);
    assert.equal(result.plan.commit, f.candidate);
    assert.equal(result.plan.tree, git(f.repo, ["rev-parse", `${f.candidate}^{tree}`]));
    assert.match(result.plan.policy_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.plan.gates, [{ gate: "fx-node22", lane: "node22" }, { gate: "fx-node24", lane: "node24" }, { gate: "fx-ratchet", lane: "node22" }]);
    assert.equal(fs.existsSync(out), false);
    assert.equal(git(f.repo, ["worktree", "list", "--porcelain"]), worktreesBefore);
  } finally {
    f.cleanup();
  }
});

test("producer: refuses an unrunnable gate, a bad edge, a missing commit or output, and writes nothing", () => {
  const f = producerFixture();
  try {
    const out = path.join(f.root, "refused.json");
    const refuse = (opts, pattern) => assert.throws(() => promote.produceGateManifest(opts, { repo: f.repo, gateRuns: FX_GATE_RUNS, nodeBinDir: FX_NODE }), pattern);
    refuse({ edge: "dev->main", commit: f.candidate, out }, /is not an allowed edge/);
    refuse({ edge: "main->concord-public-release", commit: f.candidate, out }, /no runner for gate\(s\) fx-release-build/);
    refuse({ edge: "dev->staging", commit: "deadbeef", out }, /does not resolve/);
    refuse({ edge: "dev->staging", commit: f.candidate }, /--out is required/);
    refuse({ commit: f.candidate, out }, /--edge is required/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    f.cleanup();
  }
});

test("producer: the production gate table covers every gate the shipped policy names, release-edge gates included (COORD-1044)", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "test-policy.json"), "utf8"));
  const named = [...new Set(Object.values(policy.promotion_edges).flatMap((edge) => edge.gates))].sort();
  assert.deepEqual(named.filter((gate) => !promote.GATE_RUNS[gate]), []);
  for (const gate of ["community-cut-build", "enterprise-ref-scan"]) {
    assert.deepEqual(promote.GATE_RUNS[gate].argv, ["coord/engine/scripts/release-gates.js", gate]);
  }
  assert.equal(promote.GATE_RUNS["full-suite-node24"].lane, "node24", "Node 24 is the lane of the staging -> main Node 24 gate");
  assert.equal(promote.GATE_RUNS["full-suite-node22"].lane, "node22");
});

test("COORD-1055: producer subprocesses share only their fresh per-manifest release cache", () => {
  const f = producerFixture();
  const observations = path.join(f.root, "release-cache-observations.jsonl");
  const staleCache = path.join(f.root, "stale-release-cache");
  const oldCache = process.env.COORD_RELEASE_GATE_CACHE;
  const oldObservations = process.env.COORD_TEST_CACHE_OBSERVATIONS;
  try {
    const policy = `${JSON.stringify({ policy_version: 4, promotion_edges: {
      "dev->staging": { gates: ["fx-release-one", "fx-release-two"] },
    } }, null, 2)}\n`;
    commitFile(f.repo, POLICY_REL, policy, "release cache fixture policy");
    const gateScript = `"use strict";
const fs = require("node:fs");
const report = process.argv[process.argv.indexOf("--report") + 1];
fs.appendFileSync(process.env.COORD_TEST_CACHE_OBSERVATIONS, JSON.stringify({ gate: process.argv[2], cache: process.env.COORD_RELEASE_GATE_CACHE }) + "\\n");
fs.writeFileSync(report, JSON.stringify({ result: "pass" }));
`;
    commitFile(f.repo, "coord/engine/scripts/release-gates.js", gateScript, "release cache fixture runner");
    f.candidate = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "-q", "origin", `${f.candidate}:refs/heads/dev`]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const releaseRuns = {
      "fx-release-one": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "one"] },
      "fx-release-two": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "two"] },
    };
    const produce = (name) => promote.produceGateManifest({
      edge: "dev->staging", commit: f.candidate, out: path.join(f.root, `${name}.json`),
    }, { repo: f.repo, gateRuns: releaseRuns, nodeBinDir: FX_NODE, appendGovernanceEvent: (event) => f.journal.push(event) });
    process.env.COORD_RELEASE_GATE_CACHE = staleCache;
    process.env.COORD_TEST_CACHE_OBSERVATIONS = observations;
    const first = produce("first");
    const firstRuns = fs.readFileSync(observations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(first.manifest.gates, { "fx-release-one": "pass", "fx-release-two": "pass" });
    assert.equal(firstRuns.length, 2);
    assert.equal(firstRuns[0].cache, firstRuns[1].cache, "release gates in one manifest share cache");
    assert.notEqual(firstRuns[0].cache, staleCache, "caller-provided stale cache is overridden");
    fs.writeFileSync(observations, "");
    const second = produce("second");
    const secondRuns = fs.readFileSync(observations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(second.manifest.gates, first.manifest.gates);
    assert.equal(secondRuns.length, 2);
    assert.equal(secondRuns[0].cache, secondRuns[1].cache, "second manifest also shares its own cache");
    assert.notEqual(secondRuns[0].cache, firstRuns[0].cache, "separate manifest invocations get fresh caches");
    assert.equal(fs.existsSync(firstRuns[0].cache), false, "first producer removes its temporary cache after consumers finish");
  } finally {
    if (oldCache === undefined) delete process.env.COORD_RELEASE_GATE_CACHE;
    else process.env.COORD_RELEASE_GATE_CACHE = oldCache;
    if (oldObservations === undefined) delete process.env.COORD_TEST_CACHE_OBSERVATIONS;
    else process.env.COORD_TEST_CACHE_OBSERVATIONS = oldObservations;
    f.cleanup();
  }
});

test("Community gate producer retains the exact verified receipt and binds it to the journaled manifest", () => {
  const f = producerFixture();
  try {
    const edge = "main->concord-public-release";
    const gate = "dual-release-verify";
    commitFile(f.repo, POLICY_REL, JSON.stringify({ promotion_edges: { [edge]: { gates: [gate] } } }), "Community fixture policy");
    const runnerPath = "coord/engine/scripts/release-gates.js";
    const runner = `const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
      const report = process.argv[process.argv.indexOf("--report") + 1];
      const cache = process.env.COORD_RELEASE_GATE_CACHE;
      fs.mkdirSync(cache);
      const receipt = path.join(cache, "dual-qualification.json");
      const bytes = JSON.stringify({ receipt: "verified" });
      fs.writeFileSync(receipt, bytes);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      fs.writeFileSync(report, JSON.stringify({ result: "pass", qualification_receipt: { path: receipt, sha256 } }));`;
    const commit = commitFile(f.repo, runnerPath, runner, "Community fixture runner");
    const out = path.join(f.root, "community-promotion.json");
    const deps = {
      repo: f.repo,
      gateRuns: { [gate]: { lane: "node22", argv: [runnerPath, gate] } },
      nodeBinDir: FX_NODE,
      appendGovernanceEvent: (event) => f.journal.push(event),
    };
    const outcome = promote.produceGateManifest({ edge, commit, out }, deps);
    const bytes = fs.readFileSync(outcome.qualification_file);
    const hash = promote.sha256Hex(bytes);
    assert.equal(outcome.manifest.qualification_sha256, hash);
    assert.equal(f.journal.at(-1).details.qualification_sha256, hash);
    assert.equal(f.journal.at(-1).details.manifest_sha256, promote.sha256Hex(fs.readFileSync(out)));
    assert.equal(fs.statSync(outcome.qualification_file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(outcome.runs[gate].qualification_receipt.path), false);
    assert.equal(promote.produceGateManifest({ edge, commit, out }, deps).qualification_file, outcome.qualification_file);
    assert.deepEqual(fs.readFileSync(outcome.qualification_file), bytes);
    fs.writeFileSync(outcome.qualification_file, "different bytes");
    assert.throws(() => promote.produceGateManifest({ edge, commit, out }, deps), { code: "EEXIST" });
    assert.equal(fs.readFileSync(outcome.qualification_file, "utf8"), "different bytes");

    for (const [mode, script, error] of [
      ["missing", runner.replace(", qualification_receipt: { path: receipt, sha256 }", ""), /did not report its qualification receipt/],
      ["outside", runner.replace("path.join(cache,", "path.join(path.dirname(report),"), /must come from this invocation's release gate cache/],
      ["changed", runner + '\nfs.appendFileSync(receipt, "tampered");', /receipt changed after dual verification/],
    ]) {
      const invalid = commitFile(f.repo, runnerPath, script, `report ${mode} receipt`);
      const invalidOut = path.join(f.root, `${mode}.json`);
      const worktrees = git(f.repo, ["worktree", "list", "--porcelain"]);
      assertRefusal(() => promote.produceGateManifest({ edge, commit: invalid, out: invalidOut }, deps), error);
      assert.equal(fs.existsSync(invalidOut), false);
      assert.equal(git(f.repo, ["worktree", "list", "--porcelain"]), worktrees);
      assert.equal(f.journal.length, 2);
    }
  } finally {
    f.cleanup();
  }
});

test("sharded promotion requires the policy runner's verified donor receipt", () => {
  const f = producerFixture();
  try {
    const edge = "dev->staging";
    const gate = "full-suite-sharded-node22";
    commitFile(f.repo, POLICY_REL, JSON.stringify({ policy_version: 4, promotion_edges: { [edge]: { gates: [gate] } } }), "sharded gate policy");
    const runner = `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 5), ["test-policy", "run", "--stage", "promotion", "--head"]);
assert.equal(args[5], require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
assert.deepEqual(args.slice(6, 9), ["--shards", "auto", "--out"]);
const out = args[9];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "test-policy-report.json"), JSON.stringify({ result: "pass", qualification: QUALIFICATION }));
fs.writeFileSync(path.join(out, "runner-report.json"), JSON.stringify({ engine_coverage: { ratchet: { result: "pass" } } }));
`;
    for (const qualification of ["donor receipt verified", "provisional"]) {
      const commit = commitFile(f.repo, "coord/scripts/governance.js", runner.replace("QUALIFICATION", JSON.stringify(qualification)), qualification);
      const result = promote.produceGateManifest({ edge, commit, out: path.join(f.root, `${qualification}.json`) },
        { repo: f.repo, nodeBinDir: FX_NODE, appendGovernanceEvent: (event) => f.journal.push(event) });
      assert.equal(result.manifest.gates[gate], qualification === "donor receipt verified" ? "pass" : "fail");
    }
  } finally {
    f.cleanup();
  }
});

test("COORD-1055: a failed release gate returns its concise diagnostic after producer scratch cleanup", () => {
  const f = producerFixture();
  try {
    const policy = `${JSON.stringify({ policy_version: 4, promotion_edges: {
      "dev->staging": { gates: ["fx-release-fail"] },
    } }, null, 2)}\n`;
    commitFile(f.repo, POLICY_REL, policy, "release failure diagnostic fixture policy");
    const gateScript = `"use strict";
const fs = require("node:fs");
const report = process.argv[process.argv.indexOf("--report") + 1];
fs.writeFileSync(report, JSON.stringify({ result: "fail", detail: "community cut failed integrity validation: attestation donor commit mismatch" }));
`;
    commitFile(f.repo, "coord/engine/scripts/release-gates.js", gateScript, "release failure diagnostic fixture runner");
    f.candidate = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", "-q", "origin", `${f.candidate}:refs/heads/dev`]);
    git(f.repo, ["fetch", "-q", "origin"]);
    const result = promote.produceGateManifest({
      edge: "dev->staging", commit: f.candidate, out: path.join(f.root, "diagnostic.json"),
    }, {
      repo: f.repo,
      gateRuns: { "fx-release-fail": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "community-cut-build"] } },
      nodeBinDir: FX_NODE,
      appendGovernanceEvent: (event) => f.journal.push(event),
    });
    assert.equal(result.manifest.gates["fx-release-fail"], "fail");
    assert.equal(result.runs["fx-release-fail"].diagnostic, "community cut failed integrity validation: attestation donor commit mismatch");
  } finally {
    f.cleanup();
  }
});

// COORD-1043: the producer journals the sha256 of each manifest it writes, and promote accepts a manifest
// only when a journaled producer event for its edge, commit, tree and policy digest carries that sha256.
// The file alone is never trusted. (A signature from COORD-1034's approval key can strengthen this later.)
const NO_PRODUCER_EVENT = /no journaled producer event/;
const FX_SAME_NODE = { node22: path.dirname(process.execPath), node24: path.dirname(process.execPath) };

// staging -> main needs the fixture's three gates (fx-node22, fx-node24, fx-ratchet). Both lanes use this
// host's Node 22 so the test runs without the shared Node 24 install.
function produceMultiGate(f) {
  const out = path.join(f.root, "multi-gate.json");
  promote.produceGateManifest({ edge: "staging->main", commit: f.candidate, out }, { repo: f.repo, gateRuns: FX_GATE_RUNS, nodeBinDir: FX_SAME_NODE, appendGovernanceEvent: (event) => f.journal.push(event) });
  return out;
}

test("COORD-1043: the producer journals the manifest sha256 with edge, commit, tree and policy digest; the genuine manifest is accepted", () => {
  const f = producerFixture();
  try {
    const result = produce(f, "dev->staging", f.candidate);
    const events = f.journal.filter((e) => e.command === "promotion-manifest");
    assert.equal(events.length, 1, "exactly one producer event for the run");
    assert.equal(events[0].result, "produced");
    assert.equal(events[0].details.edge, "dev->staging");
    assert.equal(events[0].details.commit, f.candidate);
    assert.equal(events[0].details.tree, git(f.repo, ["rev-parse", `${f.candidate}^{tree}`]));
    assert.match(events[0].details.policy_sha256, /^[0-9a-f]{64}$/);
    assert.equal(events[0].details.manifest_sha256, promote.sha256Hex(fs.readFileSync(result.manifest_file)), "the event binds the exact bytes written");
    const args = argsFor("dev", "staging", f.candidate, ["--gate-manifest", result.manifest_file]);
    assertRefusal(() => run(f, args, deps({ readJournal: undefined })), NO_PRODUCER_EVENT);
    assert.equal(remoteSha(f, "staging"), f.base);
    const promoted = run(f, args);
    assert.equal(promoted.promoted, true);
    assert.equal(remoteSha(f, "staging"), f.candidate);
  } finally {
    f.cleanup();
  }
});

test("COORD-1043: a fail-to-pass edit of a produced manifest is refused and staging does not move", () => {
  const f = producerFixture("fail");
  try {
    const result = produce(f, "dev->staging", f.candidate);
    const edited = readManifest(result.manifest_file);
    assert.deepEqual(edited.gates, { "fx-node22": "fail" }, "the producer recorded the red gate");
    edited.gates["fx-node22"] = "pass";
    fs.writeFileSync(result.manifest_file, `${JSON.stringify(edited, null, 2)}\n`);
    assertRefusal(() => run(f, argsFor("dev", "staging", f.candidate, ["--gate-manifest", result.manifest_file])), NO_PRODUCER_EVENT);
    assert.equal(remoteSha(f, "staging"), f.base);
  } finally {
    f.cleanup();
  }
});

test("COORD-1043: a reordered gate map or an extra gate on a produced manifest is refused", () => {
  const f = producerFixture();
  try {
    const out = produceMultiGate(f);
    const genuine = readManifest(out);
    assert.deepEqual(Object.keys(genuine.gates), ["fx-node22", "fx-node24", "fx-ratchet"]);
    const reordered = { ...genuine, gates: Object.fromEntries(Object.entries(genuine.gates).reverse()) };
    const reorderedFile = path.join(f.root, "reordered.json");
    fs.writeFileSync(reorderedFile, `${JSON.stringify(reordered, null, 2)}\n`);
    const extra = { ...genuine, gates: { ...genuine.gates, "fx-extra": "pass" } };
    const extraFile = path.join(f.root, "extra.json");
    fs.writeFileSync(extraFile, `${JSON.stringify(extra, null, 2)}\n`);
    pushBranch(f, "staging", f.candidate);
    assertRefusal(() => run(f, argsFor("staging", "main", f.candidate, ["--gate-manifest", reorderedFile])), NO_PRODUCER_EVENT);
    assertRefusal(() => run(f, argsFor("staging", "main", f.candidate, ["--gate-manifest", extraFile])), NO_PRODUCER_EVENT);
    assert.equal(remoteSha(f, "main"), f.base, "main did not move");
    const promoted = run(f, argsFor("staging", "main", f.candidate, ["--gate-manifest", out]));
    assert.equal(promoted.promoted, true, "the genuine multi-gate manifest is accepted");
    assert.equal(remoteSha(f, "main"), f.candidate);
  } finally {
    f.cleanup();
  }
});

test("COORD-1043: a manifest with no producer event is refused, even when every gate it names passed", () => {
  const f = producerFixture();
  try {
    const handWritten = writeManifest(f, { edge: "dev->staging", commit: f.candidate, gates: ALL_PASS(["fx-node22"]), journal: false });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.candidate, ["--gate-manifest", handWritten])), NO_PRODUCER_EVENT);
    assert.equal(remoteSha(f, "staging"), f.base);
    // Without a journal reader promote fails closed: it cannot bind anything, so it refuses.
    assertRefusal(() => promote.runPromote(argsFor("dev", "staging", f.candidate, ["--gate-manifest", handWritten]), { ...deps(), repo: f.repo }), NO_PRODUCER_EVENT);
  } finally {
    f.cleanup();
  }
});

test("COORD-1043: a producer event for another commit does not validate a manifest for this commit", () => {
  const f = producerFixture();
  try {
    const result = produce(f, "dev->staging", f.candidate);
    const genuineEvents = [...f.journal];
    const bytes = fs.readFileSync(result.manifest_file);
    // The same manifest bytes, but journaled as if produced for the base commit.
    f.journal.length = 0;
    f.journal.push({ command: "promotion-manifest", result: "produced", details: { edge: "dev->staging", commit: f.base, tree: git(f.repo, ["rev-parse", `${f.base}^{tree}`]), policy_sha256: result.plan.policy_sha256, manifest_sha256: promote.sha256Hex(bytes), gates: result.manifest.gates } });
    assertRefusal(() => run(f, argsFor("dev", "staging", f.candidate, ["--gate-manifest", result.manifest_file])), NO_PRODUCER_EVENT);
    assert.equal(remoteSha(f, "staging"), f.base);
    // Positive control: the candidate's own producer event validates the same file.
    f.journal.length = 0;
    f.journal.push(...genuineEvents);
    assert.equal(run(f, argsFor("dev", "staging", f.candidate, ["--gate-manifest", result.manifest_file])).promoted, true);
  } finally {
    f.cleanup();
  }
});

test("COORD-1043: the producer refuses to write a manifest it cannot journal", () => {
  const f = producerFixture();
  try {
    const out = path.join(f.root, "unjournaled.json");
    assert.throws(() => promote.produceGateManifest({ edge: "dev->staging", commit: f.candidate, out }, { repo: f.repo, gateRuns: FX_GATE_RUNS, nodeBinDir: FX_NODE }), /no journal appender/);
    assert.equal(fs.existsSync(out), false, "nothing is written without a journal entry");
  } finally {
    f.cleanup();
  }
});

test("COORD-1052: promotion flags reject incomplete or unknown input before Git access", () => {
  for (const args of [[], ["--from", "dev"], ["--from", "dev", "--to", "staging"],
    ["--from"], ["--from", "--to"], ["--force"]]) {
    assertRefusal(() => promote.parseFlags(args), /required|needs a value|unknown flag/);
  }
  assert.deepEqual(promote.parseFlags(argsFor("main", "concord-public-release", "abc", ["--remote", "fixture", "--tag", "fixture-tag", "--dry-run"])),
    { dryRun: true, from: "main", to: "concord-public-release", commit: "abc", remote: "fixture", tag: "fixture-tag" });
});

test("COORD-1052: malformed gate and release approval files never advance a fixture remote", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    const broken = path.join(f.root, "broken.json");
    fs.writeFileSync(broken, "{");
    for (const file of [broken, path.join(f.root, "absent.json")]) {
      assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", file])), /manifest unreadable/);
    }
    for (const overrides of [{ schema: "unknown" }, { gates: null }]) {
      const manifest = writeManifest(f, { edge: "dev->staging", commit: f.devTip, gates: GATES["dev->staging"], overrides });
      assertRefusal(() => run(f, argsFor("dev", "staging", f.devTip, ["--gate-manifest", manifest])), /schema|missing required gates/);
    }
    assert.equal(remoteSha(f, "staging"), f.base);
    pushBranch(f, "main", f.devTip);
    pushBranch(f, "concord-public-release", f.base);
    const manifest = writeManifest(f, { edge: "main->concord-public-release", commit: f.devTip, gates: GATES["main->concord-public-release"] });
    const baseArgs = argsFor("main", "concord-public-release", f.devTip, ["--gate-manifest", manifest]);
    assertRefusal(() => run(f, [...baseArgs, "--approval", broken]), /approval file unreadable/);
    const approvalFile = path.join(f.root, "approval.json");
    for (const approval of [null, {}, { approver: " " }, { approver: 7 }]) {
      fs.writeFileSync(approvalFile, JSON.stringify(approval));
      assertRefusal(() => run(f, [...baseArgs, "--approval", approvalFile]), /must name the human-admin approver/);
    }
    fs.writeFileSync(approvalFile, JSON.stringify({ approver: "fixture-human", edition: "community", commit: f.devTip }));
    const dry = run(f, [...baseArgs, "--approval", approvalFile, "--tag", "fixture-cut", "--dry-run"]);
    const { signed_approval: requirement, ...metadata } = dry.plan.release.approval;
    assert.deepEqual(metadata, { approver: "fixture-human", approved_at: null, approval_ref: null });
    assert.equal(requirement.verb, "promote");
    assert.equal(requirement.ticket, f.devTip);
    assert.match(requirement.subject_sha256, /^[0-9a-f]{64}$/);
    assert.equal(dry.plan.release.tag, "fixture-cut");
    const fixtureApproval = createApprovalFixture({ allowedVerbs: [requirement.verb] });
    try {
      fixtureApproval.login({ verb: requirement.verb, ticket: requirement.ticket, subject_sha256: requirement.subject_sha256 });
      git(f.repo, ["tag", "fixture-cut", f.devTip]);
      const d = deps();
      d.approvalClient = fixtureApproval.client();
      assertRefusal(() => run(f, [...baseArgs, "--approval", approvalFile, "--tag", "fixture-cut"], d), /provenance tag.*already exists/);
    } finally { fixtureApproval.cleanup(); }
    assert.equal(remoteSha(f, "concord-public-release"), f.base);
    assert.equal(git(f.bare, ["tag", "--list"]), "", "refusals and dry-run published no tag");
  } finally { f.cleanup(); }
});

test("COORD-1052: promotion and manifest production reject absent or invalid candidate policy", () => {
  const f = fixture();
  try {
    pushBranch(f, "staging", f.base);
    for (const [body, expected] of [["{", /not valid JSON/], [JSON.stringify({ promotion_edges: {} }), /no gates for this edge/],
      [JSON.stringify({ promotion_edges: { "dev->staging": { gates: [] } } }), /no gates for this edge/]]) {
      const commit = commitFile(f.repo, POLICY_REL, body, "invalid fixture policy");
      pushBranch(f, "dev", commit);
      const manifest = writeManifest(f, { edge: "dev->staging", commit, gates: GATES["dev->staging"] });
      assertRefusal(() => run(f, argsFor("dev", "staging", commit, ["--gate-manifest", manifest])), expected);
      assertRefusal(() => promote.produceGateManifest({ edge: "dev->staging", commit, dryRun: true }, { repo: f.repo }), expected);
    }
    git(f.repo, ["rm", POLICY_REL]);
    git(f.repo, ["commit", "-qm", "remove fixture policy"]);
    const noPolicy = git(f.repo, ["rev-parse", "HEAD"]);
    pushBranch(f, "dev", noPolicy);
    assertRefusal(() => run(f, argsFor("dev", "staging", noPolicy)), /policy.*absent/);
    assertRefusal(() => promote.produceGateManifest({ edge: "dev->staging", commit: noPolicy, dryRun: true }, { repo: f.repo }), /policy.*absent/);
    assert.equal(remoteSha(f, "staging"), f.base);
  } finally { f.cleanup(); }
});

test("COORD-1052: producer refuses invalid requests and unbound derived gates without writing output", () => {
  const f = producerFixture();
  try {
    const out = path.join(f.root, "must-not-exist.json");
    for (const [opts, expected] of [
      [{}, /edge is required/],
      [{ edge: "dev->main" }, /not an allowed edge/],
      [{ edge: "constructor", commit: f.candidate, out }, /not an allowed edge/],
      [{ edge: "toString", commit: f.candidate, out }, /not an allowed edge/],
      [{ edge: "__proto__", commit: f.candidate, out }, /not an allowed edge/],
      [{ edge: "dev->staging" }, /commit is required/],
      [{ edge: "dev->staging", commit: f.candidate }, /out is required/],
      [{ edge: "dev->staging", commit: "no-such-candidate", out }, /does not resolve/],
    ]) assertRefusal(() => promote.produceGateManifest(opts, { repo: f.repo }), expected);
    const runs = { "fx-node22": { derivedFrom: "not-selected" } };
    assertRefusal(() => promote.produceGateManifest({ edge: "dev->staging", commit: f.candidate, out },
      { repo: f.repo, gateRuns: runs }), /measured by not-selected, which the edge does not name/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(f.journal.length, 0);
  } finally { f.cleanup(); }
});

test("COORD-1052: producer records missing runtime and malformed gate reports as failures and cleans its worktree", () => {
  const f = producerFixture();
  try {
    const registered = () => git(f.repo, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).join("\n");
    const before = registered();
    const missingNode = promote.produceGateManifest({ edge: "dev->staging", commit: f.candidate, out: path.join(f.root, "missing-node.json") },
      { repo: f.repo, gateRuns: FX_GATE_RUNS, nodeBinDir: { node22: path.join(f.root, "absent-bin") }, appendGovernanceEvent: (event) => f.journal.push(event) });
    assert.deepEqual(missingNode.red, ["fx-node22"]);
    assert.equal(missingNode.runs["fx-node22"].node_version, null);
    assert.equal(missingNode.runs["fx-node22"].exit_code, null);
    assert.equal(missingNode.runs["fx-node22"].ratchet, null);
    assert.equal(registered(), before);
    const badGate = 'const fs = require("node:fs"); fs.writeFileSync(process.argv[process.argv.indexOf("--report") + 1], "{");\n';
    const commit = commitFile(f.repo, "fixture-gate.js", badGate, "malformed fixture report");
    const malformed = produce(f, "dev->staging", commit);
    assert.deepEqual(malformed.red, ["fx-node22"]);
    assert.equal(malformed.runs["fx-node22"].exit_code, 0, "exit zero alone cannot qualify malformed evidence");
    assert.equal(malformed.runs["fx-node22"].pass, false);
    assert.equal(registered(), before);
  } finally { f.cleanup(); }
});

test("promotion refuses missing authority, an absent source, an unresolved commit and an unchanged target", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const args = argsFor("dev", "staging", f.devTip);
  const d = deps();
  assertRefusal(() => run(f, args, { ...d, readRecord: undefined }), /no integration-authority holder/);
  assertRefusal(() => run(f, args, { ...d, resolveCaller: undefined }), /only the integration-authority holder/);
  pushBranch(f, "staging", f.base);
  git(f.repo, ["push", "-q", "origin", ":refs/heads/dev"]);
  git(f.repo, ["update-ref", "-d", "refs/remotes/origin/dev"]);
  assertRefusal(() => run(f, args, d), /source branch dev does not exist/);
  pushBranch(f, "dev", f.devTip);
  assertRefusal(() => run(f, argsFor("dev", "staging", "does-not-exist"), d), /commit does-not-exist does not resolve/);
  assertRefusal(() => promote.produceGateManifest({ edge: "dev->staging", commit: f.devTip, dryRun: true },
    { repo: path.join(f.root, "missing-repo") }), /commit .* does not resolve/);
  assert.equal(remoteSha(f, "staging"), f.base);
  pushBranch(f, "staging", f.devTip);
  assertRefusal(() => run(f, args, d), /staging is already at/);
  assert.equal(remoteSha(f, "staging"), f.devTip);
  assert.deepEqual(d.events, []);
});

test("release promotion requires an approval journal even with a passing manifest", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const to = "concord-public-release";
  const edge = `main->${to}`;
  pushBranch(f, "main", f.devTip);
  pushBranch(f, to, f.base);
  const manifest = writeManifest(f, { edge, commit: f.devTip, gates: GATES[edge] });
  const approval = path.join(f.root, "approval.json");
  fs.writeFileSync(approval, JSON.stringify({ edition: "community", commit: f.devTip, approver: "admin" }));
  const args = argsFor("main", to, f.devTip, ["--gate-manifest", manifest, "--approval", approval]);
  const d = deps({ appendGovernanceEvent: undefined });
  assert.equal(run(f, [...args, "--dry-run"], d).plan.release.approval.signed_approval.verb, "promote");
  assertRefusal(() => run(f, args, d), /a signed approval must be journaled/);
  assert.equal(remoteSha(f, to), f.base);
  assert.equal(git(f.bare, ["tag", "--list"]), "");
  assert.deepEqual(d.events, []);
});

test("release promotion refuses a signed record already used after the manifest was read", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const signer = createApprovalFixture({ allowedVerbs: ["promote"] });
  t.after(signer.cleanup);
  const to = "concord-public-release";
  const edge = `main->${to}`;
  pushBranch(f, "main", f.devTip);
  pushBranch(f, to, f.base);
  const manifest = writeManifest(f, { edge, commit: f.devTip, gates: GATES[edge] });
  const approval = path.join(f.root, "approval.json");
  fs.writeFileSync(approval, JSON.stringify({ edition: "community", commit: f.devTip, approver: "admin" }));
  const args = argsFor("main", to, f.devTip, ["--gate-manifest", manifest, "--approval", approval]);
  const requirement = run(f, [...args, "--dry-run"]).plan.release.approval.signed_approval;
  signer.login(requirement);
  const client = signer.client();
  const d = deps({
    approvalClient: {
      ...client,
      runSign(request) {
        const signed = client.runSign(request);
        assert.equal(signed.ok, true, signed.detail);
        f.journal.push({ approval_record: JSON.parse(signed.stdout).record_id });
        return signed;
      },
    },
  });
  assertRefusal(() => run(f, args, d), /refused: record-reused/);
  assert.equal(remoteSha(f, to), f.base);
  assert.equal(git(f.bare, ["tag", "--list"]), "");
  assert.deepEqual(d.events.map((event) => [event.event, event.refused]), [["approval.refused", "record-reused"]]);
  assert.equal(d.events[0].subject_sha256, requirement.subject_sha256);
});

test("manifest producer records a signaled gate as failed and removes its detached worktree", (t) => {
  const f = producerFixture();
  t.after(f.cleanup);
  const commit = commitFile(f.repo, "fixture-gate.js", 'process.kill(process.pid, "SIGTERM");\n', "signal fixture gate");
  const worktreesBefore = git(f.repo, ["worktree", "list", "--porcelain"]);
  const result = produce(f, "dev->staging", commit);
  assert.deepEqual(result.red, ["fx-node22"]);
  assert.deepEqual(result.manifest.gates, { "fx-node22": "fail" });
  assert.equal(result.runs["fx-node22"].exit_code, null);
  assert.equal(result.runs["fx-node22"].diagnostic, "gate process terminated by SIGTERM");
  assert.equal(git(f.repo, ["worktree", "list", "--porcelain"]), worktreesBefore);
  assert.equal(remoteSha(f, "staging"), f.base);
});

test("manifest producer refuses a detached checkout whose tree moved before a gate runs", (t) => {
  const f = producerFixture();
  t.after(f.cleanup);
  const out = path.join(f.root, "manifest.json");
  const hook = path.join(f.repo, ".git", "hooks", "post-checkout");
  fs.writeFileSync(hook, `#!/bin/sh\ngit update-ref --no-deref HEAD ${f.base}\n`, { mode: 0o755 });
  const worktrees = git(f.repo, ["worktree", "list", "--porcelain"]);
  assertRefusal(() => produce(f, "dev->staging", f.candidate, out), /checked-out tree does not match/);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(f.journal, []);
  assert.equal(git(f.repo, ["worktree", "list", "--porcelain"]), worktrees);
  assert.equal(remoteSha(f, "staging"), f.base);
});

test("manifest producer survives a gate that has already removed its detached worktree", (t) => {
  const f = producerFixture();
  t.after(f.cleanup);
  const commit = commitFile(f.repo, "fixture-gate.js", [
    'const { execFileSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const report = process.argv[process.argv.indexOf("--report") + 1];',
    `execFileSync("git", ["worktree", "remove", "--force", process.cwd()], { cwd: ${JSON.stringify(f.repo)} });`,
    'fs.writeFileSync(report, JSON.stringify({ result: "pass" }));',
  ].join("\n"), "fixture gate releases its checkout");
  const worktrees = git(f.repo, ["worktree", "list", "--porcelain"]);
  const result = produce(f, "dev->staging", commit);
  assert.deepEqual(result.red, []);
  assert.deepEqual(readManifest(result.manifest_file), result.manifest);
  assert.equal(f.journal.at(-1).details.manifest_sha256, promote.sha256Hex(fs.readFileSync(result.manifest_file)));
  assert.equal(git(f.repo, ["worktree", "list", "--porcelain"]), worktrees);
  assert.equal(remoteSha(f, "staging"), f.base);
});

test("promotion refuses a release edge whose edition conflicts with its target branch", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const to = "concord-public-release";
  pushBranch(f, to, f.base);
  const spec = promote.EDGES[`main->${to}`];
  const edition = spec.edition;
  t.after(() => { spec.edition = edition; });
  spec.edition = "enterprise";
  assertRefusal(() => run(f, argsFor("main", to, f.devTip)), /does not match the release branch/);
  assert.equal(remoteSha(f, to), f.base);
});

test("Community qualification binds promotion to a valid digest and canonical provenance tag", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const to = "concord-public-release";
  const edge = `main->${to}`;
  const canonical = `cut/community/${f.devTip.slice(0, 12)}`;
  pushBranch(f, "main", f.devTip);
  pushBranch(f, to, f.base);
  for (const [qualification_sha256, tag] of [["not-a-digest", canonical], ["a".repeat(64), "other-tag"]]) {
    const manifest = writeManifest(f, { edge, commit: f.devTip, gates: GATES[edge], overrides: { qualification_sha256 } });
    assertRefusal(() => run(f, argsFor("main", to, f.devTip, ["--gate-manifest", manifest, "--tag", tag])),
      /Community qualification requires a valid digest and canonical provenance tag/);
  }
  assert.equal(remoteSha(f, to), f.base);
  assert.equal(git(f.bare, ["tag", "--list"]), "");
});

test("promotion and manifest production work from the current repository without an injected path", (t) => {
  const f = producerFixture();
  t.after(f.cleanup);
  const cwd = process.cwd();
  const pathBefore = process.env.PATH;
  try {
    process.chdir(f.repo);
    delete process.env.PATH;
    const result = promote.produceGateManifest({
      edge: "dev->staging", commit: f.candidate, out: path.join(f.root, "manifest.json"),
    }, { gateRuns: FX_GATE_RUNS, nodeBinDir: FX_NODE, appendGovernanceEvent: (event) => f.journal.push(event) });
    assert.deepEqual(result.red, []);
    const argv = argsFor("dev", "staging", f.candidate, ["--gate-manifest", result.manifest_file, "--dry-run"]);
    const preview = promote.runPromote(argv, deps({ readJournal: () => f.journal }));
    assert.equal(preview.plan.commit, f.candidate);
    assert.equal(preview.promoted, false);
  } finally {
    process.chdir(cwd);
    if (pathBefore !== undefined) process.env.PATH = pathBefore;
  }
  assert.equal(remoteSha(f, "staging"), f.base);
});
