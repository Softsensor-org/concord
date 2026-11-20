"use strict";
// COORD-839: a governed landing whose workspace integration changes any file
// under docs/decisions must be bound to an approved packet
// (--expect-paths-file) that lists exactly those files with their post-merge
// sha256. Every fixture here is an isolated temporary Git repository.
const test = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");
const createCloseout = require("./closeout.js");
const createRepoCloseout = require("./lifecycle-repox-closeout.js");
const paths = require("./control-plane-paths.js");
const layoutTesting = paths.__testing;

const ID = "TEST-839";
const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const ACCEPTED = "# ADR-0001\n\nStatus: Accepted\n";
const SUPERSEDED = "# ADR-0001\n\nStatus: Superseded by ADR-0002\n";
const INDEX = "# Decisions\n\n- 0001 Accepted\n";
const INDEX_AFTER = "# Decisions\n\n- 0001 Superseded\n- 0002 Accepted\n";

function fixture(t, donor = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-adr-landing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord"), repo = donor ? root : coord;
  const decisions = path.join(coord, "docs", "decisions");
  fs.mkdirSync(decisions, { recursive: true });
  const effects = [];
  let overrides = {};
  const gitTry = (dir, args, options = {}) => {
    const answer = overrides[args[0]] && overrides[args[0]](args);
    if (answer) return answer;
    if (args[0] === "merge") effects.push("merge");
    return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env, ...options });
  };
  const git = (...args) => { const r = gitTry(repo, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(coord, rel)), { recursive: true }); fs.writeFileSync(path.join(coord, rel), text); };
  const read = (rel) => fs.readFileSync(path.join(coord, rel), "utf8");
  const commit = (message) => { git("add", "--all"); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-b", "main");
  write("docs/decisions/0001-accepted.md", ACCEPTED);
  write("docs/decisions/README.md", INDEX);
  write("docs/note.md", "baseline note\n");
  commit("baseline with an accepted ADR");
  const branch = (name, change) => {
    git("checkout", "-b", `agent/codexa1-test-839-${name}`);
    change();
    commit(`${name} change`);
    git("checkout", "main");
  };
  const layout = paths.resolveControlPlaneLayout({ coordDir: coord, workspaceRoot: root });
  layoutTesting.override(layout); t.after(() => layoutTesting.reset());
  const repoCloseout = createRepoCloseout({ COORD_DIR: coord, REPO_ROOTS: { X: repo }, controlPlaneLayout: layout,
    gitTry, getRepoRoot: () => repo, inferTicketIdFromPath: () => null, listGitWorktrees: () => [],
    readTicketFileSurface: () => [], repoDisplayNameForCode: (code) => code, recordExternalSideEffect: () => {},
    enginePin: { deriveManifestFingerprint: () => ({ manifest: { items: [] } }), verifyManifest: () => ({ ok: true }), verify: () => ({ ok: true }) } });
  const closeout = createCloseout({ assertReviewPlanReady() {}, verifyPrEvidence() {}, findOutstandingCloseoutBlockerFollowups: () => [],
    findLockForTicket: () => null, isRepoBackedCode: () => false,
    ensureRepoXCloseoutReady: repoCloseout.ensureRepoXCloseoutReady, cleanupTicketWorktree: () => effects.push("cleanup") });
  const row = { ID, Repo: "X", Status: "review" }, board = { sections: [{ rows: [row] }], pr_index: { [ID]: ["local-review (no PR)"] } };
  const packetFile = (text) => { const file = path.join(root, `packet-${crypto.randomUUID()}.txt`); fs.writeFileSync(file, text); return fs.readFileSync(file, "utf8"); };
  return { root, repo, coord, layout, git, write, read, commit, branch, effects, board, repoCloseout, packetFile, gitTry,
    override: (map) => { overrides = map; },
    close: (options = {}) => closeout.prepareDoneCloseout(ID, board, { row }, { layout, base: "main", ...options }) };
}

function adrChange(f) {
  f.branch("adr", () => {
    f.write("docs/decisions/0001-accepted.md", SUPERSEDED);
    f.write("docs/decisions/README.md", INDEX_AFTER);
  });
}
const matchingPacket = [
  `${sha256(SUPERSEDED)} docs/decisions/0001-accepted.md`,
  `${sha256(INDEX_AFTER)} docs/decisions/README.md`,
].join("\n");

function assertNothingLanded(f, head, label) {
  assert.deepEqual(f.effects, [], `${label}: no workspace merge and no cleanup ran`);
  assert.equal(f.git("rev-parse", "HEAD"), head, `${label}: the integration HEAD is unchanged`);
  assert.equal(f.board.landing_index, undefined, `${label}: no landing evidence was written`);
  assert.equal(f.read("docs/decisions/0001-accepted.md"), ACCEPTED, `${label}: the accepted ADR bytes are untouched`);
}

test("COORD-839 RED: an ADR-changing landing without a packet is refused before the merge, naming the packet option", (t) => {
  const f = fixture(t);
  adrChange(f);
  const head = f.git("rev-parse", "HEAD");
  assert.throws(() => f.close({ mergeWorkspace: true }), (error) => {
    assert.match(error.message, /--expect-paths-file/);
    assert.match(error.message, /docs\/decisions\/0001-accepted\.md/);
    assert.match(error.message, new RegExp(`${sha256(SUPERSEDED)} docs/decisions/0001-accepted\\.md`), "the refusal prints the packet line to approve");
    assert.match(error.message, new RegExp(`${sha256(INDEX_AFTER)} docs/decisions/README\\.md`));
    assert.match(error.message, /Nothing was merged/);
    return true;
  });
  assertNothingLanded(f, head, "no packet");
});

test("COORD-839: an ADR-changing landing with a matching packet is accepted and lands the approved bytes", (t) => {
  const f = fixture(t);
  adrChange(f);
  f.close({ mergeWorkspace: true, expectPaths: f.packetFile(`# approved by human admin\n${matchingPacket}\n`) });
  assert.deepEqual(f.effects, ["merge", "cleanup"]);
  assert.ok(f.board.landing_index[ID], "landing evidence is recorded");
  assert.equal(f.read("docs/decisions/0001-accepted.md"), SUPERSEDED);
  assert.equal(f.read("docs/decisions/README.md"), INDEX_AFTER);
});

test("COORD-839: the human-approved markdown packet table is accepted verbatim", (t) => {
  const f = fixture(t);
  adrChange(f);
  const table = [
    "# ADR-0001 supersession packet", "", "Approved by the human admin.", "",
    "| path | sha256 |", "| --- | --- |",
    `| \`coord/docs/decisions/0001-accepted.md\` | ${sha256(SUPERSEDED)} |`,
    `| coord/docs/decisions/README.md | ${sha256(INDEX_AFTER)} |`, "",
  ].join("\n");
  f.close({ mergeWorkspace: true, expectPaths: f.packetFile(table) });
  assert.deepEqual(f.effects, ["merge", "cleanup"]);
});

test("COORD-839: regular executable ADR files remain packet-approvable", (t) => {
  const f = fixture(t);
  f.branch("executable-adr", () => {
    const file = path.join(f.coord, "docs/decisions/0001-accepted.md");
    fs.writeFileSync(file, SUPERSEDED);
    fs.chmodSync(file, 0o755);
  });
  const branch = "agent/codexa1-test-839-executable-adr";
  assert.match(f.git("ls-tree", branch, "coord/docs/decisions/0001-accepted.md"), /^100755 blob /);
  f.close({ mergeWorkspace: true, expectPaths: f.packetFile(`${sha256(SUPERSEDED)} docs/decisions/0001-accepted.md\n`) });
  assert.deepEqual(f.effects, ["merge", "cleanup"]);
  assert.equal(f.read("docs/decisions/0001-accepted.md"), SUPERSEDED);
});

test("COORD-839: a symlinked decision path is refused even when its link bytes match the packet", (t) => {
  const f = fixture(t);
  const outsideContent = "# Unapproved decision content outside docs/decisions\n";
  const linkTarget = "../../README.md";
  f.branch("decision-symlink", () => {
    fs.writeFileSync(path.join(f.coord, "README.md"), outsideContent);
    fs.rmSync(path.join(f.coord, "docs/decisions/README.md"));
    fs.symlinkSync(linkTarget, path.join(f.coord, "docs/decisions/README.md"));
  });
  const branch = "agent/codexa1-test-839-decision-symlink";
  assert.match(f.git("ls-tree", branch, "coord/docs/decisions/README.md"), /^120000 blob /);
  assert.equal(f.git("cat-file", "blob", `${branch}:coord/docs/decisions/README.md`), linkTarget);
  const head = f.git("rev-parse", "HEAD");

  assert.throws(() => f.close({
    mergeWorkspace: true,
    expectPaths: f.packetFile(`${sha256(linkTarget)} docs/decisions/README.md\n`),
  }), /docs\/decisions\/README\.md in the integration preview is not a regular file/);
  assertNothingLanded(f, head, "symlinked ADR path");
  assert.equal(f.read("docs/decisions/README.md"), INDEX, "the integration checkout retains its regular index");
});

test("COORD-839: a mismatching packet refuses with no writes for every added, missing or changed path", (t) => {
  const cases = [
    ["missing path", `${sha256(SUPERSEDED)} docs/decisions/0001-accepted.md`, /would change decision paths not in the packet: docs\/decisions\/README\.md/],
    ["added path", `${matchingPacket}\n${sha256("x")} docs/decisions/0099-unrelated.md`, /packet paths the integration does not change: docs\/decisions\/0099-unrelated\.md/],
    ["changed bytes", `${sha256(ACCEPTED)} docs/decisions/0001-accepted.md\n${sha256(INDEX_AFTER)} docs/decisions/README.md`,
      new RegExp(`bytes differ from the packet: docs/decisions/0001-accepted\\.md \\(approved ${sha256(ACCEPTED)}, after merge ${sha256(SUPERSEDED)}\\)`)],
    ["absent instead of bytes", `absent docs/decisions/0001-accepted.md\n${sha256(INDEX_AFTER)} docs/decisions/README.md`, /bytes differ from the packet/],
    ["malformed packet", "not a packet line", /--expect-paths-file line 1 is not/],
    ["empty packet", "# nothing approved\n", /--expect-paths-file names no paths/],
  ];
  for (const [label, packet, pattern] of cases) {
    const f = fixture(t);
    adrChange(f);
    const head = f.git("rev-parse", "HEAD");
    assert.throws(() => f.close({ mergeWorkspace: true, expectPaths: f.packetFile(packet) }), (error) => {
      assert.match(error.message, pattern, `${label}: ${error.message}`);
      assert.match(error.message, /--expect-paths-file/, `${label}: the refusal names the packet option`);
      return true;
    }, label);
    assertNothingLanded(f, head, label);
  }
});

test("COORD-839: a deleted decision file must be approved as absent", (t) => {
  const f = fixture(t);
  f.branch("delete", () => fs.rmSync(path.join(f.coord, "docs/decisions/0001-accepted.md")));
  const head = f.git("rev-parse", "HEAD");
  assert.throws(() => f.close({ mergeWorkspace: true }), /absent docs\/decisions\/0001-accepted\.md/);
  assertNothingLanded(f, head, "deletion without a packet");
  f.close({ mergeWorkspace: true, expectPaths: f.packetFile("absent docs/decisions/0001-accepted.md\n") });
  assert.deepEqual(f.effects, ["merge", "cleanup"]);
  assert.equal(fs.existsSync(path.join(f.coord, "docs/decisions/0001-accepted.md")), false);
});

test("COORD-839: a landing that changes no decision file is unchanged, and a stray packet on it is refused", (t) => {
  const f = fixture(t);
  f.branch("note", () => f.write("docs/note.md", "ticket work\n"));
  const head = f.git("rev-parse", "HEAD");
  assert.throws(() => f.close({ mergeWorkspace: true, expectPaths: f.packetFile(matchingPacket) }),
    /packet paths the integration does not change: docs\/decisions\/0001-accepted\.md, docs\/decisions\/README\.md/);
  assert.deepEqual(f.effects, []);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  f.close({ mergeWorkspace: true });
  assert.deepEqual(f.effects, ["merge", "cleanup"]);
  assert.equal(f.read("docs/note.md"), "ticket work\n");
});

test("COORD-839: a landing with nothing to merge is unaffected", (t) => {
  const f = fixture(t);
  f.close({ mergeWorkspace: true });
  f.close({});
  assert.deepEqual(f.effects, ["cleanup", "cleanup"]);
});

test("COORD-839: several incoming branches are previewed together, so the packet covers the combined integration", (t) => {
  const f = fixture(t);
  f.branch("one", () => f.write("docs/decisions/0001-accepted.md", SUPERSEDED));
  f.branch("two", () => f.write("docs/decisions/0002-new.md", "# ADR-0002\n"));
  const head = f.git("rev-parse", "HEAD");
  assert.throws(() => f.close({ mergeWorkspace: true, expectPaths: f.packetFile(`${sha256(SUPERSEDED)} docs/decisions/0001-accepted.md`) }),
    /would change decision paths not in the packet: docs\/decisions\/0002-new\.md/);
  assertNothingLanded(f, head, "partial multi-branch packet");
  f.close({ mergeWorkspace: true, expectPaths: f.packetFile(`${sha256(SUPERSEDED)} docs/decisions/0001-accepted.md\n${sha256("# ADR-0002\n")} docs/decisions/0002-new.md`) });
  assert.deepEqual(f.effects, ["merge", "merge", "cleanup"]);
});

test("COORD-839: the adopter layout (coord/ is the repository) scopes the check to its own docs/decisions", (t) => {
  const f = fixture(t, false);
  adrChange(f);
  const head = f.git("rev-parse", "HEAD");
  assert.throws(() => f.close({ mergeWorkspace: true }), /--expect-paths-file/);
  assertNothingLanded(f, head, "adopter without a packet");
  f.close({ mergeWorkspace: true, expectPaths: f.packetFile(matchingPacket) });
  assert.deepEqual(f.effects, ["merge", "cleanup"]);
});

test("COORD-839: the exported check is a no-op without --merge-workspace and fails closed on a Git error", (t) => {
  const f = fixture(t);
  adrChange(f);
  assert.deepEqual(f.repoCloseout.assertWorkspaceDecisionPacket(ID, {}), { checked: 0 });
  const result = f.repoCloseout.assertWorkspaceDecisionPacket(ID, { mergeWorkspace: true, expectPaths: matchingPacket });
  assert.equal(result.checked, 2);
  const { checkWorkspaceDecisionPacket } = require("./landing-decision-packet.js");
  const failing = (dir, args) => (args[0] === "diff-tree" ? { status: 128, stdout: "", stderr: "controlled Git failure" } : spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env }));
  assert.throws(() => checkWorkspaceDecisionPacket({
    ticketId: ID, layout: f.layout, gitTry: failing, headSha: f.git("rev-parse", "HEAD"),
    tipShas: [f.git("rev-parse", "agent/codexa1-test-839-adr")], packetText: matchingPacket,
  }), /landing refused before the workspace merge: Git diff-tree could not preview the decision records the integration changes\. controlled Git failure/);
});

// The verb entry runs the check BEFORE move-review / set-pr, which are their
// own journalled mutations: a refusal inside mark-done alone would still
// have moved the ticket to review.
test("COORD-839: finalize and finish refuse before move-review or set-pr when the packet check fails", () => {
  const calls = [];
  let composedOptions;
  const row = { ID, Repo: "X", Status: "doing", Owner: "codexa1" };
  const board = { sections: [{ rows: [row] }], pr_index: { [ID]: ["https://github.com/acme/widget/pull/1"] } };
  const closeout = createCloseout({
    readBoard: () => board, getTicketRef: () => ({ row }), mergeUniqueRefs: (a, b) => [...a, ...b], toArray: (v) => (v == null ? [] : [].concat(v)),
    resolveLifecyclePrRefs: () => ["https://github.com/acme/widget/pull/2"],
    moveReview: () => calls.push("move-review"), markDone: (_ticketId, options) => { composedOptions = options; calls.push("mark-done"); }, setPrRefs: () => calls.push("set-pr"),
    assertWorkspaceDecisionPacket: (ticketId, options) => {
      calls.push(`check:${options.mergeWorkspace === true}`);
      throw new Error(`Ticket ${ticketId} landing refused before the workspace merge: needs --expect-paths-file.`);
    },
  });
  assert.throws(() => closeout.finalizeTicket(ID, { noPr: true, mergeWorkspace: true }), /--expect-paths-file/);
  assert.throws(() => closeout.finishTicket(ID, { mergeWorkspace: true }), /--expect-paths-file/);
  row.Status = "review";
  assert.throws(() => closeout.finishTicket(ID, { mergeWorkspace: true }), /--expect-paths-file/);
  assert.deepEqual(calls, ["check:true", "check:true", "check:true"], "nothing ran after the refused check");
  row.Repo = "B";
  // COORD-855 passes prospective refs into the same mark-done transaction;
  // a separate set-pr mutation would leave refs behind if closeout refused.
  closeout.finishTicket(ID, {});
  assert.deepEqual(calls.slice(3), ["mark-done"], "a product-repo ticket never consults the control-plane check or persists refs separately");
  assert.deepEqual(composedOptions.closeoutPrRefs, ["https://github.com/acme/widget/pull/2"]);
});

// Every refusal arm of the check, against a stubbed Git whose answers are
// otherwise real, so a silent pass on an unreadable integration is caught.
test("COORD-839: the check fails closed on an invalid preview, a non-file decision entry, an unresolvable commit or no repository", (t) => {
  const f = fixture(t);
  adrChange(f);
  const { checkWorkspaceDecisionPacket } = require("./landing-decision-packet.js");
  const { assertWorkspaceDecisionPacketAt } = require("./lifecycle-repox-closeout.js");
  const real = (dir, args, options = {}) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env, ...options });
  const stub = (overrides) => (dir, args, options) => (overrides[args[0]] ? overrides[args[0]](args) : real(dir, args, options));
  const headSha = f.git("rev-parse", "HEAD"), tip = f.git("rev-parse", "agent/codexa1-test-839-adr");
  const check = (gitTry) => checkWorkspaceDecisionPacket({ ticketId: ID, layout: f.layout, gitTry, headSha, tipShas: [tip], packetText: matchingPacket });
  assert.throws(() => check(stub({ "merge-tree": () => ({ status: 0, stdout: "not-a-tree\n", stderr: "" }) })),
    /landing refused before the workspace merge: the integration preview produced an invalid tree\. Nothing was merged or written\./);
  for (const entry of [
    "160000 commit 1111111111111111111111111111111111111111\tcoord/docs/decisions/README.md",
    "100644 tree 1111111111111111111111111111111111111111\tcoord/docs/decisions/README.md",
    "garbage",
  ]) {
    assert.throws(() => check(stub({ "ls-tree": () => ({ status: 0, stdout: `${entry}\0`, stderr: "" }) })),
      /coord\/docs\/decisions\/0001-accepted\.md in the integration preview is not a regular file/, entry);
  }
  assert.throws(() => check(stub({ "diff-tree": () => ({ status: 1, stdout: "", stderr: "" }) })),
    /Git diff-tree could not preview the decision records the integration changes\. Nothing was merged/, "an empty stderr still refuses");
  assert.equal(check(real).checked, 2);

  const at = (gitTry, layout = f.layout) => assertWorkspaceDecisionPacketAt({ ticketId: ID, options: { mergeWorkspace: true }, layout, gitTry });
  assert.throws(() => at(stub({ "rev-parse": () => ({ status: 128, stdout: "", stderr: "fatal: bad HEAD" }) })),
    /landing refused before the workspace merge: could not resolve HEAD: fatal: bad HEAD\./);
  assert.throws(() => at(stub({ "rev-parse": () => ({ status: 128, stdout: "", stderr: "" }) })), /could not resolve HEAD: git rev-parse exited 128\./);
  assert.throws(() => at(real, { ...f.layout, coordRepoRoot: null, topology: "none" }), /Ticket TEST-839 landing refused: Repo X closeout requires a control-plane Git repository/);
  assert.throws(() => at(real), /--expect-paths-file/, "the module-level check sees the same ADR change");
  assert.throws(() => at(stub({ "rev-parse": () => ({ status: 0, stdout: undefined, stderr: "" }) })),
    /Git merge-tree could not preview the decision records the integration changes\. merge-tree: .*not something we can merge/, "a commit that resolves to nothing never passes");
});

test("COORD-839: prodloc keeps refusing an invalid shared merge preview", (t) => {
  const f = fixture(t);
  adrChange(f);
  const { assertProductionLocForCloseout } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/prodloc-closeout.js"));
  const gitTry = (dir, args, options = {}) => (args[0] === "merge-tree"
    ? { status: 0, stdout: "not-a-tree\n", stderr: "" }
    : spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env, ...options }));
  assert.throws(() => assertProductionLocForCloseout(ID, { layout: f.layout, branches: ["agent/codexa1-test-839-adr"], gitTry }),
    /Ticket TEST-839 prodloc closeout refused: invalid merge preview tree\./);
});

test("COORD-839: the default verb-entry preflight honours an explicit control-plane layout", (t) => {
  const f = fixture(t);
  adrChange(f);
  const calls = [];
  const row = { ID, Repo: "X", Status: "review", Owner: "codexa1" };
  const closeout = createCloseout({
    readBoard: () => ({ sections: [{ rows: [row] }], pr_index: { [ID]: ["local-review (no PR)"] } }), getTicketRef: () => ({ row }),
    resolveLifecyclePrRefs: () => ["local-review (no PR)"], markDone: () => calls.push("mark-done"), setPrRefs: () => calls.push("set-pr"),
  });
  const head = f.git("rev-parse", "HEAD");
  assert.throws(() => closeout.finishTicket(ID, { mergeWorkspace: true, layout: f.layout }), /landing refused before the workspace merge: .*--expect-paths-file/);
  assert.deepEqual(calls, []);
  assert.equal(f.git("rev-parse", "HEAD"), head);
});

// Refactoring the closeout moved several inherited Git-failure arms into new
// or changed functions; each is pinned here so a failure with no diagnostic
// text still refuses with the numeric exit instead of an empty reason.
test("COORD-839: workspace integration Git failures with no diagnostic text still refuse with the exit status", (t) => {
  const failure = (stdout = "") => ({ status: 1, stdout, stderr: "" });
  for (const [label, overrides, pattern] of [
    ["branch listing", { "for-each-ref": () => ({ status: 128, stdout: "", stderr: "" }) }, /could not list workspace ticket branches: git for-each-ref exited 128\./],
    ["silent merge", { merge: (args) => (args[1] === "--abort" ? null : failure()) }, /failed and was aborted: git merge exited 1\./],
    ["merge reporting on stdout", { merge: (args) => (args[1] === "--abort" ? null : failure("CONFLICT (content): docs/decisions/README.md")) }, /failed and was aborted: CONFLICT \(content\)/],
  ]) {
    const f = fixture(t);
    adrChange(f);
    const head = f.git("rev-parse", "HEAD");
    f.override(overrides);
    assert.throws(() => f.close({ mergeWorkspace: true, expectPaths: f.packetFile(matchingPacket) }), pattern, label);
    f.override({});
    assert.equal(f.git("rev-parse", "HEAD"), head, `${label}: nothing was merged`);
    assert.equal(f.board.landing_index, undefined, `${label}: no landing evidence`);
  }
  const f = fixture(t);
  adrChange(f);
  let headReads = 0;
  f.override({ "rev-parse": (args) => (args[2] === "HEAD^{commit}" && ++headReads === 2 ? { status: 128, stdout: "", stderr: "" } : null) });
  assert.throws(() => f.close({ mergeWorkspace: true, expectPaths: f.packetFile(matchingPacket) }),
    /could not resolve current integration HEAD before the merge: git rev-parse exited 128\./, "the planner's HEAD read, after the prodloc preview's");
  assert.deepEqual(f.effects, []);
});

test("COORD-839: the shared-preview prodloc check keeps its fail-closed arms", (t) => {
  const f = fixture(t);
  adrChange(f);
  const { assertProductionLocForCloseout } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/prodloc-closeout.js"));
  const check = (gitTry, layout = f.layout) => assertProductionLocForCloseout(ID, { layout, branches: ["agent/codexa1-test-839-adr"], gitTry });
  const stub = (command, answer) => (dir, args, options) => (args[0] === command ? answer : f.gitTry(dir, args, options));
  assert.throws(() => check(f.gitTry, { ...f.layout, coordRepoRoot: null }), /prodloc closeout refused: no control-plane Git repository\./);
  assert.throws(() => check(stub("ls-tree", { status: 1, stdout: "", stderr: "" })), /Git ls-tree could not verify the integration tree\. $/);
  assert.throws(() => check(stub("ls-tree", { status: 0, stdout: "garbage\0", stderr: "" })), /prodloc closeout refused: invalid Git tree entry\./);
  assert.equal(check(f.gitTry).result, "pass");
  const cli = spawnSync(process.execPath, [resolveEngineModule(COORD_ROOT_DIR, "scripts/prodloc-closeout.js"), "unexpected-argument"], { encoding: "utf8", env });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Usage: node coord\/engine\/scripts\/prodloc-closeout\.js/);
});

// COORD-1025: the retired guard's admission rule. A landing whose every decision
// change is an ADR metadata-line edit admits with no packet (the classifier
// verdict is returned as the recorded check); any body line still refuses.
test("COORD-1025: a metadata-only ADR landing admits without a packet and a body change still refuses", (t) => {
  // COORD-1025 ruling: a Status set to Accepted or Superseded needs the packet; Deprecated admits.
  const statusOnly = "# ADR-0001\n\nStatus: Deprecated\n";
  const f = fixture(t);
  f.branch("status-only", () => f.write("docs/decisions/0001-accepted.md", statusOnly));
  const verdict = f.repoCloseout.assertWorkspaceDecisionPacket(ID, { mergeWorkspace: true });
  assert.equal(verdict.checked, 1);
  assert.deepEqual(verdict.metadataOnly, [{ path: "docs/decisions/0001-accepted.md", sha256: sha256(statusOnly) }]);
  f.close({ mergeWorkspace: true });
  assert.deepEqual(f.effects, ["merge", "cleanup"]);
  assert.equal(f.read("docs/decisions/0001-accepted.md"), statusOnly);

  const body = "# ADR-0001\n\nStatus: Accepted\n\n## Decision\n\nA new decision paragraph.\n";
  const g = fixture(t);
  g.branch("body", () => g.write("docs/decisions/0001-accepted.md", body));
  const head = g.git("rev-parse", "HEAD");
  assert.throws(() => g.close({ mergeWorkspace: true }), /--expect-paths-file[\s\S]*docs\/decisions\/0001-accepted\.md/);
  assertNothingLanded(g, head, "body change without a packet");
});

test("COORD-1025 ruling: a Status set to Superseded or Accepted needs the packet even though it is only a status line", (t) => {
  const superseded = "# ADR-0001\n\nStatus: Superseded by ADR-0002\n";
  const f = fixture(t);
  f.branch("superseded", () => f.write("docs/decisions/0001-accepted.md", superseded));
  const head = f.git("rev-parse", "HEAD");
  assert.throws(() => f.close({ mergeWorkspace: true }), /--expect-paths-file[\s\S]*docs\/decisions\/0001-accepted\.md/);
  assertNothingLanded(f, head, "Superseded status without a packet");
  f.close({ mergeWorkspace: true, expectPaths: f.packetFile(`${sha256(superseded)} docs/decisions/0001-accepted.md\n`) });
  assert.deepEqual(f.effects, ["merge", "cleanup"]);
});

test("COORD-1025: a mixed landing, metadata plus body, refuses without a packet and names every decision path", (t) => {
  const body = "# ADR-0001\n\nStatus: Superseded by ADR-0002\n\n## Decision\n\nChanged decision.\n";
  const f = fixture(t);
  f.branch("mixed", () => {
    f.write("docs/decisions/0001-accepted.md", body);
    f.write("docs/decisions/README.md", INDEX_AFTER);
  });
  const head = f.git("rev-parse", "HEAD");
  assert.throws(() => f.close({ mergeWorkspace: true }), (error) => {
    assert.match(error.message, /docs\/decisions\/0001-accepted\.md, docs\/decisions\/README\.md/);
    return true;
  });
  assertNothingLanded(f, head, "mixed without a packet");
});
