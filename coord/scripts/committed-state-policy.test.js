"use strict";

// COORD-862 (COORD-516a): ADR 0020 committed-state policy through the real
// journal seal. A committed prompt edit in the canonical tree is adopted by an
// automatic journal-baseline event; an uncommitted prompt edit and a committed
// board edit still fail closed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { state } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));
const { __testing, withGovernedSurfaceSandbox } = require("./governance-test-utils.js");

const { gitFixture, gitFixtureSpawn } = require("../engine/scripts/test-git-fixture.js");

function git(cwd, ...args) {
  const result = gitFixtureSpawn(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitAll(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

function seedBaseline() {
  __testing.appendGovernanceEvent({
    ts: "2026-10-24T00:00:00.000Z",
    command: "journal-baseline",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    details: { reason: "coord862-test" },
    changed_paths: [],
    snapshot: __testing.buildGovernanceSnapshot(),
  });
}

const governedNoop = () => __testing.withBoardTransaction({ command: "coord862-noop", ticket: "(auto)" }, () => "ok");
const adoptionEvents = () => __testing.readGovernanceEventLog()
  .filter((event) => event.command === "journal-baseline" && event.details?.reason === "committed-state-adoption");

function withCanonicalSandbox(fn) {
  withGovernedSurfaceSandbox(({ tempDir, boardPath }) => {
    const promptPath = path.join(state.PROMPTS_DIR, "tickets", "T-1.md");
    fs.writeFileSync(promptPath, "# T-1\n", "utf8");
    gitFixture(tempDir, ["init", "-q", "-b", "dev"]);
    commitAll(tempDir, "base");
    seedBaseline();
    fn({ tempDir, boardPath, promptPath });
  });
}

test("COORD-862: a committed prompt edit is adopted with a journal-baseline event citing the commit", () => {
  withCanonicalSandbox(({ tempDir, promptPath }) => {
    fs.writeFileSync(promptPath, "# T-1 reviewed and committed\n", "utf8");
    const sha = commitAll(tempDir, "reviewed prompt edit");
    assert.equal(__testing.detectOutOfBandBoardMutation().detected, true, "the edit is unjournaled before adoption");
    assert.equal(governedNoop(), "ok");
    const events = adoptionEvents();
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.details.policy, "ADR-0020");
    assert.equal(event.details.commit, sha);
    assert.equal(event.details.integration_branch, "dev");
    assert.equal(event.details.trigger_command, "coord862-noop");
    assert.equal(event.details.paths.length, 1);
    assert.match(event.details.paths[0], /prompts\/tickets\/T-1\.md$/);
    assert.deepEqual(event.changed_paths, event.details.paths);
    assert.match(event.details.repo_paths[0], /prompts\/tickets\/T-1\.md$/);
    assert.equal(__testing.detectOutOfBandBoardMutation().detected, false);
    // Adoption is idempotent: a second mutation finds nothing to adopt.
    governedNoop();
    assert.equal(adoptionEvents().length, 1);
  });
});

test("COORD-862: an uncommitted prompt edit still fails closed and names why it was declined", () => {
  withCanonicalSandbox(({ promptPath }) => {
    fs.writeFileSync(promptPath, "# T-1 hand edit\n", "utf8");
    assert.throws(governedNoop, (error) => {
      assert.match(error.message, /Refusing to run a governed board mutation on top of an out-of-band coordination-state change/);
      assert.match(error.message, /Scope: engine intact, 1 project path unjournaled \(governed 1\)/);
      assert.match(error.message, /Committed-state adoption \(ADR 0020\) declined: \S*prompts\/tickets\/T-1\.md \(differs_from_head\)/);
      return true;
    });
    assert.equal(adoptionEvents().length, 0);
  });
});

test("COORD-862: a committed board edit stays journal-only and fails closed", () => {
  withCanonicalSandbox(({ tempDir, boardPath }) => {
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.metadata = { ...(board.metadata || {}), hand_edit: true };
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    commitAll(tempDir, "committed board hand edit");
    assert.throws(governedNoop, (error) => {
      assert.match(error.message, /Journal-only under ADR 0020 \(committing them does not reconcile them\): \S*tasks\.json/);
      assert.doesNotMatch(error.message, /declined/);
      return true;
    });
    assert.equal(adoptionEvents().length, 0);
  });
});

test("COORD-862: a mixed committed prompt and board edit adopts only the prompt", () => {
  withCanonicalSandbox(({ tempDir, boardPath, promptPath }) => {
    fs.writeFileSync(promptPath, "# T-1 committed\n", "utf8");
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.metadata = { ...(board.metadata || {}), hand_edit: true };
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    commitAll(tempDir, "mixed");
    assert.throws(governedNoop, /Journal-only under ADR 0020 \(committing them does not reconcile them\): \S*tasks\.json\./);
    // The adoption event survives the refused mutation's rollback, and only
    // the board remains drift.
    const events = adoptionEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].details.paths.length, 1);
    const remaining = __testing.detectOutOfBandBoardMutation();
    assert.equal(remaining.detected, true);
    assert.equal(remaining.paths.length, 1);
    assert.match(remaining.paths[0], /tasks\.json$/);
  });
});

test("COORD-862: a linked worktree never adopts committed authored content", () => {
  withCanonicalSandbox(({ tempDir, promptPath }) => {
    fs.writeFileSync(promptPath, "# T-1 committed\n", "utf8");
    commitAll(tempDir, "committed prompt");
    fs.mkdirSync(path.join(tempDir, "coord", ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "coord", ".runtime", "runtime-role.json"), JSON.stringify({ role: "ephemeral_worktree" }), "utf8");
    assert.throws(governedNoop, /declined: \S*T-1\.md \(non_canonical_tree\); committed-state adoption runs only in the canonical integration tree/);
    assert.equal(adoptionEvents().length, 0);
  });
});


test("COORD-862: the out-of-band detector scopes a precomputed provenance result", () => {
  withGovernedSurfaceSandbox(() => {
    const empty = __testing.detectOutOfBandBoardMutation({ uninitialized: false });
    assert.equal(empty.detected, false);
    assert.equal(empty.latestEvent, null);
    assert.deepEqual(empty.scopes, { engine: [], governed: [], derived: [], runtime: [] });
    assert.equal(empty.committedState, null);
  });
});

test("COORD-862: drift retention adopts only the scoped paths of a scoped reconcile", () => {
  const { planDriftRetention } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-repair.js"));
  const baseline = { files: [{ path: "prompts/a.md", exists: true, digest: "a0" }, { path: "rendered/b.md", exists: true, digest: "b0" }] };
  const after = { files: [{ path: "prompts/a.md", exists: true, digest: "a1" }, { path: "rendered/b.md", exists: true, digest: "b1" }] };
  const provenance = { uninitialized: false, drift: ["prompts/a.md", "rendered/b.md", "locks/x.lock"] };
  const sealed = (metadata, value = provenance) => planDriftRetention(metadata, value, () => baseline).seal(after, after, null, (text) => `d${text.length}`);
  const scoped = sealed({ allowProvenanceDrift: true, adoptProvenanceDrift: true, adoptDriftPaths: ["rendered/b.md"] });
  assert.deepEqual(scoped.details.retained_preexisting_drift, ["prompts/a.md"]);
  assert.deepEqual(scoped.snapshot.files.map((entry) => entry.digest), ["a0", "b1"]);
  assert.equal(sealed({ allowProvenanceDrift: true, adoptProvenanceDrift: true }).snapshot, after, "an unscoped reconcile adopts everything");
  assert.deepEqual(sealed({ allowProvenanceDrift: true }).details.retained_preexisting_drift, ["prompts/a.md", "rendered/b.md"]);
  assert.equal(sealed({}).snapshot, after);
  assert.equal(sealed({ allowProvenanceDrift: true }, { uninitialized: true, drift: ["prompts/a.md"] }).snapshot, after);
  assert.equal(sealed({ allowProvenanceDrift: true }, { snapshotPruned: true, drift: ["prompts/a.md"] }).snapshot, after);
  assert.equal(sealed({ allowProvenanceDrift: true }, { uninitialized: false }).snapshot, after);
});

// --- COORD-862 independent review B1/B2 regressions through the real seal ---

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`COORD-862 review B1: a ${flag} prompt edit hidden from git status still fails closed`, () => {
    withCanonicalSandbox(({ tempDir, promptPath }) => {
      git(tempDir, "update-index", flag, path.relative(tempDir, promptPath).split(path.sep).join("/"));
      fs.writeFileSync(promptPath, `# T-1 hidden edit ${flag}\n`, "utf8");
      assert.equal(git(tempDir, "status", "--porcelain", "--", path.relative(tempDir, promptPath)), "", "the edit is invisible to git status");
      assert.throws(governedNoop, /declined: \S*prompts\/tickets\/T-1\.md \(bytes_differ_from_head\)/);
      assert.equal(adoptionEvents().length, 0);
    });
  });
}

test("COORD-862 review B2: a real linked worktree whose marker claims canonical never adopts", () => {
  const { withScopedGovernanceTestContext } = require("./governance-test-utils.js");
  withCanonicalSandbox(({ tempDir }) => {
    const linked = `${tempDir}-linked`;
    try {
      git(tempDir, "worktree", "add", "-q", "-b", "wt", linked);
      fs.mkdirSync(path.join(linked, "coord", ".runtime"), { recursive: true });
      fs.writeFileSync(path.join(linked, "coord", ".runtime", "runtime-role.json"), JSON.stringify({ role: "canonical_integration_tree" }), "utf8");
      withScopedGovernanceTestContext({ PROMPTS_DIR: path.join(linked, "prompts") }, () => {
        seedBaseline();
        const linkedPrompt = path.join(linked, "prompts", "tickets", "T-1.md");
        fs.writeFileSync(linkedPrompt, "# T-1 committed in the linked worktree\n", "utf8");
        commitAll(linked, "linked worktree prompt edit");
        // Make the linked HEAD reachable from dev, so only the checkout rule can refuse it.
        git(tempDir, "merge", "-q", "--ff-only", "wt");
        assert.throws(governedNoop, /declined: \S*prompts\/tickets\/T-1\.md \(linked_checkout\)/);
        assert.equal(adoptionEvents().length, 0);
      });
    } finally {
      gitFixtureSpawn(tempDir, ["worktree", "remove", "--force", linked]);
      fs.rmSync(linked, { recursive: true, force: true });
    }
  });
});
