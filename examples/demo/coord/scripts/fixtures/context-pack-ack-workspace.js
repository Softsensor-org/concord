"use strict";

// COORD-723 / COORD-557: disposable governed workspace for the context_pack_ack
// CLI tests. It drives the real public verbs; nothing here overrides a
// validator or reaches into a module.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
// ADR 0031 (COORD-1034): claim --transfer-to needs a fixture-signed record (test-only fixture).
const { createApprovalFixture } = require(path.resolve(__dirname, "..", "..", "engine", "scripts", "__fixtures__", "approval-fixture.js"));
const { fixedLayoutEnv } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/session-lifecycle-test-utils.js"));
const { withApprovedPacket } = require("./approved-reconcile.js");

const VALID_ACK = Object.freeze({
  considered: { active_constraints: ["Isolated runtime"], adrs: ["No architecture change"], business_rules: ["Fixture only"], conflicts: ["No conflict"], stale_warnings: ["No live state"], open_questions: ["No open decision"] },
  authority: { constraints: ["Fixture"], advisory_only: ["No production authority"] },
  closeout_learning: { decision: "scratch-only", rationale: "Temporary fixture" },
});
function fixture() {
  const source = path.resolve(__dirname, "../..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord723-cli-"));
  const coord = path.join(root, "coord"), repo = path.join(root, "backend"), remote = path.join(root, "backend-remote.git");
  fs.mkdirSync(coord); fs.mkdirSync(repo);
  require("./coord-engine-schemas.js").installCanonicalEngine(coord, source);
  for (const name of ["scripts", "engine", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "prompts", "schemas", "docs", "agents.json", "gates", "TEMPLATE_SYNC_MANIFEST.json", "engine-pin.json"]) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(coord, name), { recursive: true });
  }
  const write = (name, data) => { const target = path.join(coord, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data)); };
  const read = (name) => JSON.parse(fs.readFileSync(path.join(coord, name), "utf8"));
  const git = (cwd, ...args) => { const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const initRepo = (dir, branch) => { git(dir, "init", "-b", branch); git(dir, "config", "user.email", "test@example.com"); git(dir, "config", "user.name", "Test"); git(dir, "config", "gc.auto", "0"); };
  write("project.config.js", 'module.exports={repos:{B:{path:"backend",integrationBranch:"dev"}}};\n');
  initRepo(repo, "dev");
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n"); git(repo, "add", "."); git(repo, "commit", "-m", "seed");
  git(root, "init", "--bare", remote); git(repo, "remote", "add", "origin", remote); git(repo, "push", "-u", "origin", "dev");
  const owner = "codexa11", transferee = "codexa12";
  const row = { ID: "SEED-001", Repo: "X", Type: "chore", Pri: "P3", Status: "done", Owner: owner, Description: "Seed", "Depends On": "" };
  write("board/tasks.json", { version: 1, metadata: { title: "Ack", last_updated: new Date().toISOString(), canonical_references: [], plan_markdown_render_statuses: ["doing", "review"], preamble: [], plan_records_required_from_ticket: { B: "TEST-999" }, landing_index_required_from_ticket: { B: "TEST-999" }, pr_index_required_from_ticket: { B: "TEST-999" } }, sections: [{ kind: "table", level: 2, heading: "Ack", separator_before: false, columns: Object.keys(row), rows: [row] }], prompt_index: { "SEED-001": "coord/prompts/seed.md" }, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {} });
  write("prompts/seed.md", "# Seed\n"); write("QUESTIONS.md", "# Questions\n"); write("PLAN.md", "");
  write(".runtime/agents.json", [owner, transferee].map((handle, i) => ({ id: `a1${i + 1}`, handle, provider: "openai", status: "active", aliases: [] })));
  write(".runtime/agent_sessions.json", []);
  require(path.join(coord, "board/board.js")).renderBoardArtifacts();
  // A recording `gh`: PR creation is observable as a line in this log, so "no
  // external side effect" is asserted against the provider boundary itself.
  const ghLog = path.join(root, "gh.log"), bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${ghLog}"\ncase "$1 $2" in "pr list") echo "[]";; "pr create") echo "https://github.com/example/backend/pull/7";; *) echo "{}";; esac\n`, { mode: 0o755 });
  const approval = createApprovalFixture({ allowedVerbs: ["approve", "reject", "claim --transfer-to", "integration handoff", "reconcile", "plan mutation"] });
  const session = (thread) => {
    const env = fixedLayoutEnv(`${thread}-${path.basename(root)}`);
    env.PATH = `${bin}${path.delimiter}${env.PATH}`;
    const cliWith = (extra, ...args) => spawnSync(process.execPath, [path.join(coord, "scripts/governance.js"), ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 });
    const cli = (...args) => cliWith({}, ...args);
    // Only the generated test bootstrap receives the synthetic trust anchor and signer.
    const approvalCli = (...args) => approval.runCli(coord, args, { cwd: root, env, encoding: "utf8", timeout: 60000 });
    const ok = (...given) => {
      const args = given[0] === "reconcile" ? withApprovedPacket(given, (a) => ok(...a)) : given;
      let r = cli(...args);
      // Only positive fixture setup signs the exact refused subject. Raw cli()
      // remains unchanged for tests that assert missing-approval refusals.
      if (args.includes("--human-admin-override") && r.status !== 0) {
        const digest = /Subject digest: ([0-9a-f]{64})/.exec(`${r.stdout}\n${r.stderr}`);
        if (digest) {
          const reconcile = args[0] === "reconcile";
          const ticket = reconcile ? (args[1] && !args[1].startsWith("--") ? args[1] : "control-plane") : args[1];
          approval.login({ verb: reconcile ? "reconcile" : "plan mutation", ticket, subject_sha256: digest[1] });
          r = approvalCli(...args);
        }
      }
      assert.equal(r.status, 0, `${root}: ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
      return r;
    };
    return { cli, ok, approvalCli };
  };
  const ownerSession = session("owner"), transfereeSession = session("transferee");
  write(".gitignore", ".runtime/\n.worktrees/\n");
  // The governed closeout readiness check compares a ticket branch to dev.
  // Seed the control-plane fixture on the same integration branch so positive
  // controls test acknowledgement behavior rather than a missing-base failure.
  initRepo(coord, "dev"); git(coord, "add", "."); git(coord, "commit", "-m", "Seed acknowledgement fixture");
  ownerSession.ok("reconcile", "--reason", "initialize isolated fixture", "--human-admin-override", "fixture owns this isolated baseline");
  ownerSession.ok("agentid", "--owner", owner);
  const { ok } = ownerSession;

  // A ticket taken through the real lane to the point where only the
  // acknowledgement stands between it and review.
  // COORD-813: gov start refuses a scaffold-only prompt, so the description
  // carries ticket-specific acceptance that --with-prompt lifts into the prompt.
  function lane(id, repoCode) {
    ok("file-ticket", id, "--repo", repoCode, "--type", "chore", "--pri", "P2", "--description", "Acknowledgement lane artifact. Acceptance: docs/LANE.md is committed on the lane branch and readable from the committed tree.", "--with-prompt");
    ok("start", id);
    const lock = read(`.runtime/locks/${id}.lock`);
    fs.mkdirSync(path.join(lock.worktree, "docs"), { recursive: true });
    fs.writeFileSync(path.join(lock.worktree, "docs/LANE.md"), "# artifact\n");
    ok("update-plan", id, "--startup", "completed", "--traceability", "exempt", "--files", "docs/LANE.md", "--baseline", "Artifact absent before this lane", "--verify", "node -e require('node:fs').readFileSync('docs/LANE.md')", "--repo-gate", "Artifact bytes verified by fixture", "--security", "yes", "--rollback", "Revert lane artifact", "--invariant", "business-context investigation: not-required");
    ok("commit", id, "--message", "lane artifact", "--all");
    ok("set-review-cycles", id, "--replace", ...[1, 2, 3].flatMap((n) => ["--review-cycle", `lens=lane ${n}; diff=docs/LANE.md; risks=lost bytes, wrong lane; findings=artifact read from committed tree; verification=fixture assertion; verdict=pass`]));
    const args = ["update-plan", id];
    for (const proof of read(`.runtime/plans/${id}.json`).feature_proof) if (proof.startsWith("TODO")) args.push("--drop-feature-proof", proof);
    ok(...args, "--feature-proof", "path:docs/LANE.md");
    ok("update-plan", id, "--context-pack-ack", JSON.stringify(VALID_ACK));
    ok("set-requirement-closure", id, "--supersede", "--ticket-ask", "Create this lane artifact", "--implemented", "Committed the lane artifact", "--not-implemented", "No product change outside sandbox", "--deferred-to", "none", "--closeout-verdict", "complete");
    ok("gate-plan", id, "--write");
    return lock;
  }
  // Models a record admitted by a pre-COORD-571 writer: the bytes are placed
  // directly and the isolated baseline is re-sealed by the admin verb. No
  // production validator is weakened to get the state in.
  function sealLegacyAck(id, ack) {
    const planPath = path.join(coord, `.runtime/plans/${id}.json`);
    const record = JSON.parse(fs.readFileSync(planPath, "utf8"));
    record.context_pack_ack = ack;
    fs.writeFileSync(planPath, `${JSON.stringify(record, null, 2)}\n`);
    ok("reconcile", id, "--reason", "model an acknowledgement sealed by an older writer", "--human-admin-override", "fixture owns this isolated baseline");
  }
  const text = (name) => (fs.existsSync(path.join(coord, name)) ? fs.readFileSync(path.join(coord, name), "utf8") : null);
  // Everything a refused command could have changed: canonical plan, projection,
  // board, journal, the ticket lock, session bindings, the provider call log,
  // and the published branches of the product remote.
  const snapshot = (id) => ({
    plan: text(`.runtime/plans/${id}.json`),
    projection: text("PLAN.md"),
    board: text("board/tasks.json"),
    journal: text(".runtime/governance-events.ndjson"),
    lock: text(`.runtime/locks/${id}.lock`),
    sessions: read(".runtime/agent_sessions.json").map(({ session_id, handle, status, thread_id }) => ({ session_id, handle, status, thread_id })),
    gh: fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8") : null,
    remoteBranches: git(remote, "branch", "--list"),
  });
  const rowOf = (id) => read("board/tasks.json").sections.flatMap((section) => section.rows || []).find((entry) => entry.ID === id);
  return { root, coord, owner, transferee, ownerSession, transfereeSession, approval, lane, sealLegacyAck, snapshot, read, write, rowOf, ghLog, git, remote };
}

module.exports = { VALID_ACK, fixture };
