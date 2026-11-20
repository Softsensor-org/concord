"use strict";

// COORD-862 (COORD-516a): journal-side scope classification and committed-state
// adoption, with injected journal collaborators.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const createJournalDriftScope = require("./journal-drift-scope.js");

const COORD = "/repo/coord";
const state = {
  AGENTS_PATH: `${COORD}/agents.json`,
  AGENT_SESSIONS_PATH: `${COORD}/.runtime/agent_sessions.json`,
  LOCKS_DIR: `${COORD}/.runtime/locks`,
  LEGACY_LOCKS_DIR: `${COORD}/locks`,
  BOARD_PATH: `${COORD}/board/tasks.json`,
  QUESTIONS_PATH: `${COORD}/QUESTIONS.md`,
  PLAN_RECORDS_DIR: `${COORD}/.runtime/plans`,
  PLAN_PATH: `${COORD}/PLAN.md`,
  RENDERED_DIR: `${COORD}/rendered`,
  PROMPTS_DIR: `${COORD}/prompts`,
  DECISIONS_DIR: `${COORD}/docs/decisions`,
  RUNTIME_ROLE_MARKER_PATH: `${COORD}/.runtime/runtime-role.json`,
};

function harness(overrides = {}) {
  const events = [];
  const roles = [];
  const scope = createJournalDriftScope({
    state,
    relativeCoordPath: (file) => path.posix.relative(COORD, file),
    collectGovernedSnapshotFilePaths: () => [`${COORD}/prompts/tickets/T-1.md`],
    readLatestGovernanceSnapshotSource: () => ({ snapshot: overrides.baseline === undefined
      ? { files: [{ path: "board/tasks.json", exists: true, digest: "b0" }, { path: "prompts/tickets/T-1.md", exists: true, digest: "p0" }] }
      : overrides.baseline }),
    appendGovernanceEvent: (event) => events.push(event),
    detectGovernanceProvenanceDrift: () => ({ drift: ["board/tasks.json"], redetected: true }),
    sha1: (value) => `sha1:${value.length}`,
    rootDir: "/repo",
    detectCheckoutRuntimeRole: (options) => { roles.push(options); return { role: "canonical_integration_tree" }; },
    integrationBranch: "dev",
    gitRun: overrides.gitRun,
  });
  return { scope, events, roles };
}

const provenance = (drift) => ({
  uninitialized: false,
  drift,
  currentSnapshot: { files: [{ path: "board/tasks.json", exists: true, digest: "b1" }, { path: "prompts/tickets/T-1.md", exists: true, digest: "p1" }] },
});

test("COORD-862: journal paths classify against the live configured surfaces", () => {
  const { scope } = harness();
  const cases = {
    "agents.json": "runtime", ".runtime/agent_sessions.json": "runtime", ".runtime/locks/T-1.lock": "runtime",
    "elsewhere/T-1.lock": "runtime", "PLAN.md": "derived", "rendered/TASKS.md": "derived",
    "board/tasks.json": "governed", "prompts/tickets/T-1.md": "governed", ".runtime/session-threads/x.json": "runtime",
    "QUESTIONS.md": "governed", ".runtime/plans/T-1.json": "governed", "locks/T-1.lock": "runtime", "prompts/tickets/notes.lock": "governed", "docs/GOVERNANCE.md": "governed",
  };
  for (const [file, expected] of Object.entries(cases)) assert.equal(scope.journalDriftScope(file), expected, file);
  assert.equal(scope.journalDriftScope(undefined), "governed");
  assert.deepEqual(scope.partitionJournalDrift(["rendered/TASKS.md", "board/tasks.json"]).derived, ["rendered/TASKS.md"]);
  assert.equal(scope.isAuthoredDriftPath("docs/decisions/0020-x.md"), true);
  assert.equal(scope.isAuthoredDriftPath("board/tasks.json"), false);
  assert.equal(scope.isAuthoredDriftPath(null), false);
});

test("COORD-862: adoption is skipped without authored drift or a usable baseline", () => {
  const { scope, events } = harness();
  for (const value of [null, { uninitialized: true, drift: [] }, { snapshotPruned: true, drift: [] }, provenance(["board/tasks.json"]), { drift: undefined }]) {
    assert.equal(scope.planCommittedAuthoredAdoption(value), null);
  }
  const plain = provenance(["board/tasks.json"]);
  assert.equal(scope.adoptCommittedAuthoredDrift(plain), plain);
  assert.equal(scope.explainCommittedState(plain, ["board/tasks.json"]), null);
  const refusing = harness({ gitRun: () => ({ status: 128, stdout: "" }) });
  const authored = provenance(["prompts/tickets/T-1.md", "prompts/tickets/gone.md"]);
  const plan = refusing.scope.planCommittedAuthoredAdoption(authored);
  assert.equal(plan.adopted.length, 0);
  assert.equal(refusing.scope.adoptCommittedAuthoredDrift(authored, { ticket: "T-1" }), authored);
  assert.equal(events.length + refusing.events.length, 0);
});

const PROMPT_BYTES = Buffer.from("# T-1 committed\n");
const PROMPT_BLOB = require("node:crypto").createHash("sha1").update(`blob ${PROMPT_BYTES.length}\0`).update(PROMPT_BYTES).digest("hex");

// The adoption module reads the filesystem through `fs`; route only the
// fixture paths and leave every other call alone.
function mockFixtureFs(t, existing) {
  const fs = require("node:fs");
  const { existsSync, lstatSync, readFileSync } = fs;
  const fake = (file) => String(file) === "/repo/.git" || String(file) === "/other/.git" || existing(String(file));
  t.mock.method(fs, "existsSync", (file) => (String(file).startsWith("/repo") || String(file).startsWith("/other") ? fake(file) : existsSync(file)));
  t.mock.method(fs, "realpathSync", (file) => file);
  t.mock.method(fs, "lstatSync", (file, ...rest) => (fake(file)
    ? { isDirectory: () => String(file).endsWith("/.git"), isFile: () => !String(file).endsWith("/.git") }
    : lstatSync(file, ...rest)));
  t.mock.method(fs, "readFileSync", (file, ...rest) => (fake(file) ? PROMPT_BYTES : readFileSync(file, ...rest)));
}

function adoptingGit(cwd, args) {
  if (args.includes("--show-toplevel")) return { status: 0, stdout: "/repo\n" };
  if (args[0] === "rev-parse" && args[2] === "HEAD^{commit}") return { status: 0, stdout: "abc123\n" };
  if (args[0] === "rev-parse") return { status: args[3] === "refs/heads/dev^{commit}" ? 0 : 1, stdout: args[3] === "refs/heads/dev^{commit}" ? "abc123\n" : "" };
  if (args[0] === "merge-base") return { status: 0, stdout: "" };
  if (args.includes("ls-tree")) return { status: 0, stdout: `100644 blob ${PROMPT_BLOB}\tcoord/prompts/tickets/T-1.md\0` };
  if (args.includes("status")) return { status: 0, stdout: "" };
  return { status: 1, stdout: "" };
}

test("COORD-862: qualifying authored drift is adopted by one journal-baseline event", (t) => {
  mockFixtureFs(t, (file) => file === `${COORD}/prompts/tickets/T-1.md`);
  const { scope, events, roles } = harness({ gitRun: adoptingGit });
  const result = scope.adoptCommittedAuthoredDrift(provenance(["board/tasks.json", "prompts/tickets/T-1.md"]));
  assert.equal(result.redetected, true);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.command, "journal-baseline");
  assert.equal(event.ticket, null);
  assert.equal(event.details.trigger_command, null);
  assert.equal(event.details.commit, "abc123");
  assert.deepEqual(event.details.paths, ["prompts/tickets/T-1.md"]);
  assert.deepEqual(event.snapshot.files.map((entry) => `${entry.path}:${entry.digest}`), ["board/tasks.json:b0", `prompts/tickets/T-1.md:sha1:${PROMPT_BYTES.toString("utf8").length}`],
    "the adopted entry digests the bytes verified against HEAD");
  assert.equal(roles[0].markerPath, state.RUNTIME_ROLE_MARKER_PATH, "the live checkout uses its configured marker");
  const missingBaseline = harness({ gitRun: adoptingGit, baseline: null });
  const unchanged = provenance(["prompts/tickets/T-1.md"]);
  assert.equal(missingBaseline.scope.adoptCommittedAuthoredDrift(unchanged, { ticket: "T-1", command: "start" }), unchanged);
  assert.equal(missingBaseline.events.length, 0);
});

test("COORD-862: another checkout's role marker is its own", (t) => {
  mockFixtureFs(t, () => true);
  const elsewhere = (cwd, args) => (args.includes("--show-toplevel") ? { status: 0, stdout: "/other\n" } : adoptingGit(cwd, args));
  const { scope, roles } = harness({ gitRun: elsewhere });
  scope.planCommittedAuthoredAdoption(provenance(["prompts/tickets/T-1.md"]));
  assert.equal(roles[0].markerPath, path.join("/other", "coord", ".runtime", "runtime-role.json"));
});

test("COORD-862: the out-of-band refusal text names scopes, journal-only paths and declines", () => {
  const { scope } = harness();
  assert.equal(scope.formatOutOfBandScopeText({}), "");
  const text = scope.formatOutOfBandScopeText({
    paths: ["board/tasks.json", "prompts/tickets/T-1.md"],
    committedState: { rejected: [{ path: "prompts/tickets/T-1.md", reason: "differs_from_head" }], refusal: null },
  });
  assert.match(text, /^Scope: engine intact, 2 project paths unjournaled \(governed 2\)\. Remedy by scope: governed: /);
  assert.match(text, /Journal-only under ADR 0020 \(committing them does not reconcile them\): board\/tasks\.json\./);
  assert.match(text, /declined: prompts\/tickets\/T-1\.md \(differs_from_head\)\. Authored content/);
  const refused = scope.formatOutOfBandScopeText({
    paths: ["prompts/tickets/T-1.md"],
    scopes: { engine: [], governed: ["prompts/tickets/T-1.md"], derived: [], runtime: [] },
    committedState: { rejected: [{ path: "prompts/tickets/T-1.md", reason: "non_canonical_tree" }], refusal: { message: "not canonical" } },
  });
  assert.doesNotMatch(refused, /Journal-only/);
  assert.match(refused, /\(non_canonical_tree\); not canonical\./);
  assert.doesNotMatch(scope.formatOutOfBandScopeText({ paths: ["prompts/tickets/T-1.md"], committedState: { rejected: [] } }), /declined/);
});

test("COORD-862: the default Git runner reports spawn failures as a null status", () => {
  const ok = createJournalDriftScope.defaultGitRun(__dirname, ["--version"]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /git version/);
  const failed = createJournalDriftScope.defaultGitRun(path.join(__dirname, "coord862-missing-dir"), ["--version"]);
  assert.equal(failed.status, null);
  assert.equal(failed.stdout, "");
});
