// COORD-920: a review ticket's PR workspace (worktree, branch, PR head) must survive
// `claim --transfer-to` and `return-doing`. The fixture is a real CLI run in an
// os.tmpdir() coord + backend repo with a bare origin and a fake `gh` on PATH.
require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-test-utils.js")).sandboxProcessRuntimeLocks();
const test = require("node:test");
const assert = require("node:assert/strict");
// ADR 0031 (COORD-1034): transfers need a fixture-signed record for their exact digest.
const { after } = require("node:test");
const { createApprovalFixture, retryTransferWithLogin } = require("./__fixtures__/approval-fixture.js");
const approval = createApprovalFixture();
after(() => approval.cleanup());
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { GIT_ISOLATION, gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
const { resolvePreservedReviewWorkspace, transferDetailsForPreservedWorkspace, assertReviewWorkspaceTransferable } = require("./review-workspace-evidence.js");
const { state } = require("./governance-context.js");
const { installCanonicalEngine } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/coord-engine-schemas.js"));

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  "pr create") echo "https://github.com/acme/backend/pull/920" ;;
  "pr view") cat "$(dirname "$0")/pr-view.json" ;;
  *) echo "fake gh: unsupported $*" >&2; exit 1 ;;
esac
`;
const PR_URL = "https://github.com/acme/backend/pull/920";

function digest(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(typeof part === "string" ? part : Buffer.from(part));
  return hash.digest("hex");
}

function createReviewTransferFixture({ repo = "B" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord920-review-workspace-"));
  const coord = path.join(root, "coord");
  const backend = path.join(root, "backend");
  const origin = path.join(root, "origin.git");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(coord, { recursive: true });
  fs.mkdirSync(backend, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const sourceCoord = path.resolve(__dirname, "..", "..");
  for (const name of ["scripts", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "prompts", "schemas", "docs", "agents.json"]) {
    const source = path.join(sourceCoord, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(coord, name), {
      recursive: true,
      filter: (entry) => !/\.test\.js$/.test(entry) && !path.relative(source, entry).split(path.sep).some((part) => [".runtime", ".worktrees", "node_modules"].includes(part)),
    });
  }
  installCanonicalEngine(coord, sourceCoord, (entry) => !/\.test\.js$/.test(entry) && !path.relative(path.join(sourceCoord, "engine"), entry).split(path.sep).some((part) => [".runtime", ".worktrees", "node_modules"].includes(part)));
  fs.writeFileSync(path.join(binDir, "gh"), FAKE_GH, { mode: 0o755 });

  const ticket = `${repo}-920`;
  const owner = "claudea801";
  const newOwner = "claudea804";
  const admin = "claudea11";
  const branch = `agent/${owner}-${ticket.toLowerCase()}-review-workspace`;
  const worktree = path.join(backend, ".worktrees", owner, ticket);
  const cliPath = path.join(coord, "scripts", "governance.js");
  const configPath = path.join(coord, "project.config.js");
  const baseEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    COORD_PROJECT_CONFIG: configPath,
    ...GIT_ISOLATION,
  };
  for (const key of ["COORD_SESSION_ID", "COORD_PROVIDER_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID", "AGENT_THREAD_ID", "GOVERNANCE_MCP_THREAD_ID"]) delete baseEnv[key];
  const envFor = (thread) => ({ ...baseEnv, CLAUDE_SESSION_ID: `coord920-${thread}-thread` });
  const ownerEnv = envFor("owner");
  const adminEnv = envFor("admin");
  const run = (cwd, command, args, env = baseEnv) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60000 });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  const git = (cwd, ...args) => gitFixture(cwd, ["-C", cwd, ...args]);
  const cli = (env, ...args) => approval.runCli(coord, args, { cwd: root, env, encoding: "utf8", timeout: 60000 });
  const productionCli = (env, ...args) => run(root, process.execPath, [cliPath, ...args], env);
  const ok = (env, ...args) => {
    const result = cli(env, ...args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const writeFileSyncJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };

  gitFixture(backend, ["init", "-b", "dev"]);
  git(backend, "config", "user.email", "coord920@example.test");
  git(backend, "config", "user.name", "COORD-920 fixture");
  git(backend, "config", "maintenance.autoDetach", "false");
  fs.writeFileSync(path.join(backend, "seed.txt"), "review workspace fixture\n");
  git(backend, "add", "seed.txt");
  git(backend, "commit", "-m", "seed COORD-920 repo");
  assert.equal(gitFixtureSpawn(root, ["init", "--bare", "-b", "dev", origin]).status, 0);
  git(backend, "remote", "add", "origin", origin);
  git(backend, "push", "-u", "origin", "dev");
  git(backend, "worktree", "add", "-b", branch, worktree, "dev");
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src", "submission.txt"), "submitted source\n");
  git(worktree, "add", "src/submission.txt");
  git(worktree, "commit", "-m", "submitted source");
  const submittedHead = git(worktree, "rev-parse", "HEAD");
  writeFileSyncJson(path.join(binDir, "pr-view.json"), { number: 920, url: PR_URL, state: "OPEN", mergedAt: null, title: "COORD-920 fixture", headRefName: branch, headRefOid: submittedHead, baseRefName: "dev", isDraft: false, author: { login: owner }, mergeStateStatus: "CLEAN", mergeCommit: null });

  const row = { ID: ticket, Repo: repo, Type: "bug", Pri: "P1", Status: "doing", Owner: owner, Description: "COORD-920 review workspace fixture", "Depends On": "" };
  writeJson(path.join(coord, "board", "tasks.json"), {
    version: 1,
    metadata: { title: "COORD-920 review workspace fixture", last_updated: new Date().toISOString(), canonical_references: [], plan_markdown_render_statuses: ["doing", "review"], preamble: [], plan_records_required_from_ticket: { [repo]: "MSRV-999" }, landing_index_required_from_ticket: { [repo]: "MSRV-999" }, pr_index_required_from_ticket: { [repo]: "MSRV-999" }, feature_proof_required_from_ticket: { [repo]: "MSRV-999" } },
    sections: [{ kind: "table", level: 2, heading: ticket, separator_before: false, columns: Object.keys(row), rows: [row] }],
    prompt_index: { [ticket]: `coord/prompts/tickets/${ticket}.md` }, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {}, waiver_index: {},
  });
  fs.mkdirSync(path.join(coord, "prompts", "tickets"), { recursive: true });
  fs.writeFileSync(path.join(coord, "prompts", "tickets", `${ticket}.md`), "# B-920\n\n## Acceptance Criteria\n\n- Preserve the PR workspace across transfer and return-doing.\n");
  fs.writeFileSync(path.join(coord, "PLAN.md"), "");
  fs.writeFileSync(path.join(coord, "QUESTIONS.md"), "# Questions\n");
  fs.mkdirSync(path.join(coord, ".runtime", "locks"), { recursive: true });
  fs.mkdirSync(path.join(coord, ".runtime", "plans"), { recursive: true });
  writeJson(path.join(coord, ".runtime", "agents.json"), [owner, newOwner, admin].map((handle, index) => ({ id: `a${920 + index}`, handle, provider: "anthropic", status: "active", aliases: [], lane: "backend", default_repo: "B", created_at: new Date().toISOString() })));
  writeJson(path.join(coord, ".runtime", "agent_sessions.json"), []);
  const now = new Date().toISOString();
  writeJson(path.join(coord, ".runtime", "locks", `${ticket}.lock`), { agent_id: "a920", owner, ticket, status: "doing", repo: "backend", branch, head: submittedHead, worktree, started_at_utc: now, heartbeat_utc: now });

  const evalCode = (code) => {
    const result = run(root, process.execPath, ["-e", code], baseEnv);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result;
  };
  evalCode(`require(${JSON.stringify(cliPath)}).__testing.ensureGovernanceJournalBaseline("COORD-920 isolated fixture");`);
  ok(ownerEnv, "agentid", "--owner", owner);
  ok(ownerEnv, "plan", ticket, "--seed");
  const planPath = path.join(coord, ".runtime", "plans", `${ticket}.json`);
  const lenses = ["contract/state invariants", "auth/security/failure modes", "tests/operability/performance", "requirement closure"];
  const cycleLine = (lens) => `lens=${lens}; diff=review workspace; risks=lost worktree, head drift; findings=none; verification=node --test review-workspace-evidence.test.js; verdict=pass`;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  Object.assign(plan, {
    startup_checklist: ["verified startup"], traceability_gate: ["exempt"], baseline_reproduction: ["not-required"],
    intended_files: ["backend/src/submission.txt"], change_summary: ["Preserve the PR workspace."],
    verification_commands: ["node --test review-workspace-evidence.test.js"],
    critical_invariants: ["The PR workspace survives transfer.", "Return-doing reuses the PR branch and worktree."],
    requirement_closure: ["Ticket ask: preserve PR workspace", "Implemented: transfer and return-doing evidence", "Not implemented: none", "Deferred to: none", "Closeout verdict: complete"],
    feature_proof: [], repo_gates: ["node --test review-workspace-evidence.test.js — passed"], rollback_strategy: ["Restore the governed snapshot."],
    self_review_cycles: lenses.map((lens, index) => ({ cycle: index + 1, total: 4, lens, diff: "review workspace", risks: ["lost worktree", "head drift"], findings: "none", verification: "node --test review-workspace-evidence.test.js", verdict: "pass", raw: cycleLine(lens) })),
  });
  writeJson(planPath, plan);
  evalCode(`const g=require(${JSON.stringify(cliPath)}).__testing;const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},"utf8"));g.writePlanCompatibilityBlockFromRecord(${JSON.stringify(ticket)},p);g.advanceGovernanceProvenanceBaseline("COORD-920 fixture plan ready");`);

  const journalPath = path.join(coord, ".runtime", "governance-events.ndjson");
  const lockPath = path.join(coord, ".runtime", "locks", `${ticket}.lock`);
  const boardPath = path.join(coord, "board", "tasks.json");
  return {
    root, coord, backend, origin, worktree, branch, ticket, owner, newOwner, admin, submittedHead,
    planPath, lockPath, boardPath, journalPath, ownerEnv, adminEnv, ok, cli, productionCli, git, run,
    // Drive the ticket to review through the real pr-create (fake gh + bare origin push) and move-review.
    reachReview() {
      ok(ownerEnv, "pr-create", ticket, "--base", "dev", "--title", "COORD-920 fixture", "--body", "fixture body", "--push");
      ok(ownerEnv, "move-review", ticket, "--pr", PR_URL);
    },
    // COORD-979: the hand-opened flow. The owner pushes the ticket branch with plain git, opens the PR
    // by hand, then records it with move-review --pr (the transition `gov submit --pr` ends in). No
    // pr-create runs, so the journal holds no git_branch_push for the ticket.
    reachHandOpenedReview() {
      git(worktree, "push", "-u", "origin", branch);
      ok(ownerEnv, "move-review", ticket, "--pr", PR_URL);
    },
    transfer() {
      const transferred = retryTransferWithLogin(approval, ticket, () => cli(adminEnv, "claim", ticket, "--transfer-to", newOwner, "--human-admin-override", "COORD-920 review workspace transfer fixture"));
      assert.equal(transferred.status, 0, `${transferred.stdout}\n${transferred.stderr}`);
      return transferred;
    },
    // The transfer binds the target owner to the caller's thread, so the new holder acts from adminEnv.
    returnDoingAsNewOwner() {
      return cli(adminEnv, "return-doing", ticket, "--summary", "addressed review feedback", "--severity", "HIGH", "--qref", "L1");
    },
  };
}

function stateDigest(fx) {
  const worktrees = fx.git(fx.backend, "worktree", "list", "--porcelain");
  const refs = fx.git(fx.backend, "for-each-ref", "--format=%(refname) %(objectname)");
  const lock = fs.existsSync(fx.lockPath) ? fs.readFileSync(fx.lockPath) : Buffer.from("<absent>");
  const head = fs.existsSync(fx.worktree) ? fx.git(fx.worktree, "rev-parse", "HEAD") : "<absent>";
  return {
    board: digest(fs.readFileSync(fx.boardPath)),
    plan: digest(fs.readFileSync(fx.planPath)),
    lock: digest(lock),
    worktrees: digest(worktrees),
    refs: digest(refs),
    head: digest(head),
    journal: digest(fs.existsSync(fx.journalPath) ? fs.readFileSync(fx.journalPath) : "<absent>"),
  };
}

test("COORD-920: return-doing after a review transfer reuses the original worktree and branch and attests the foreign namespace", () => {
  const fx = createReviewTransferFixture();
  try {
    fx.reachReview();
    const transferred = JSON.parse(fx.transfer().stdout);
    assert.equal(transferred.transferred, true);
    const transferBoard = JSON.parse(fs.readFileSync(fx.boardPath, "utf8"));
    assert.equal(transferBoard.sections[0].rows[0].Owner, fx.newOwner);

    const reopened = fx.returnDoingAsNewOwner();
    assert.equal(reopened.status, 0, `return-doing after transfer must succeed\n${reopened.stdout}\n${reopened.stderr}`);
    const lock = JSON.parse(fs.readFileSync(fx.lockPath, "utf8"));
    assert.equal(lock.owner, fx.newOwner, "the lock is rebound to the new owner");
    assert.equal(lock.worktree, fx.worktree, "return-doing must reuse the ORIGINAL worktree behind the PR");
    assert.equal(lock.branch, fx.branch, "return-doing must reuse the ORIGINAL branch behind the PR");
    assert.equal(lock.workspace_owner, fx.owner, "the lock attests the foreign namespace");
    assert.equal(lock.transfer_provenance?.[0]?.from, fx.owner);
    assert.equal(lock.transfer_provenance?.[0]?.to, fx.newOwner);
    const worktrees = fx.git(fx.backend, "worktree", "list", "--porcelain");
    assert.equal(worktrees.includes(`.worktrees/${fx.newOwner}`), false, "no worktree may appear in the new owner's namespace");
    const branches = fx.git(fx.backend, "branch", "--list");
    assert.equal(branches.includes(fx.newOwner), false, "no branch may appear in the new owner's namespace");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("COORD-920: transfer of a review ticket records workspace_owner, transfer_provenance and preserved_workspace from the PR and journal", () => {
  const fx = createReviewTransferFixture();
  try {
    fx.reachReview();
    fx.transfer();
    const events = fs.readFileSync(fx.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const claim = [...events].reverse().find((event) => event.command === "claim-ticket" && event.ticket === fx.ticket && event.result === "succeeded");
    assert.ok(claim, "the transfer must be journaled");
    const details = claim.details || {};
    assert.equal(details.preserved_workspace?.worktree, fx.worktree, "preserved worktree recorded");
    assert.equal(details.preserved_workspace?.branch, fx.branch, "preserved branch recorded");
    assert.equal(details.preserved_workspace?.pr_head, fx.submittedHead, "preserved PR head recorded");
    assert.equal(details.preserved_workspace?.pr_url, PR_URL, "preserved PR recorded from pr_index");
    assert.equal(details.preserved_workspace?.workspace_owner, fx.owner, "workspace_owner recorded");
    assert.equal(details.transfer_provenance?.[0]?.from, fx.owner, "transfer_provenance recorded");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("COORD-920: return-doing refuses with byte-identical state when the original worktree is missing", () => {
  const fx = createReviewTransferFixture();
  try {
    fx.reachReview();
    fx.transfer();
    fx.git(fx.backend, "worktree", "remove", "--force", fx.worktree);
    const before = stateDigest(fx);
    const result = fx.returnDoingAsNewOwner();
    assert.notEqual(result.status, 0, "return-doing must refuse when the original workspace is missing");
    assert.match(`${result.stdout}${result.stderr}`, /repair/i, "the refusal must name the repair path");
    assert.deepEqual(stateDigest(fx), before, "a refused return-doing leaves board, plan, lock, worktrees, refs and head unchanged");
    assert.equal(fs.existsSync(path.join(fx.backend, ".worktrees", fx.newOwner)), false, "no worktree is created in the new owner's namespace");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("COORD-920: return-doing refuses with byte-identical state when the original head differs from the PR head", () => {
  const fx = createReviewTransferFixture();
  try {
    fx.reachReview();
    fx.transfer();
    fs.writeFileSync(path.join(fx.worktree, "src", "drift.txt"), "local drift\n");
    fx.git(fx.worktree, "add", "src/drift.txt");
    fx.git(fx.worktree, "commit", "-m", "local drift after review");
    const before = stateDigest(fx);
    const result = fx.returnDoingAsNewOwner();
    assert.notEqual(result.status, 0, "return-doing must refuse when the workspace head differs from the PR head");
    assert.match(`${result.stdout}${result.stderr}`, /repair/i, "the refusal must name the repair path");
    assert.deepEqual(stateDigest(fx), before, "a refused return-doing leaves board, plan, lock, worktrees, refs and head unchanged");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("COORD-920: transfer refuses with byte-identical board and plan when the original worktree is missing", () => {
  const fx = createReviewTransferFixture();
  try {
    fx.reachReview();
    fx.git(fx.backend, "worktree", "remove", "--force", fx.worktree);
    const before = stateDigest(fx);
    const result = retryTransferWithLogin(approval, fx.ticket, () => fx.cli(fx.adminEnv, "claim", fx.ticket, "--transfer-to", fx.newOwner, "--human-admin-override", "COORD-920 refusal fixture"));
    assert.notEqual(result.status, 0, "claim --transfer-to must refuse when the preserved workspace is missing");
    assert.match(`${result.stdout}${result.stderr}`, /repair/i, "the refusal must name the repair path");
    assert.deepEqual(stateDigest(fx), before, "a refused transfer leaves board, plan, lock, worktrees, refs and head unchanged");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("COORD-1034: ordinary governance CLI ignores forged fixture approval environment", () => {
  const fx = createReviewTransferFixture();
  const forgedApproval = createApprovalFixture();
  const fakeSudoDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord1034-fake-sudo-"));
  try {
    fx.reachReview();
    const fakeSudo = path.join(fakeSudoDir, "sudo");
    fs.writeFileSync(fakeSudo, "#!/bin/sh\nprintf '{\\\"refused\\\":\\\"store-unavailable\\\"}\\n' >&2\nexit 3\n", { mode: 0o755 });
    const reason = "forged environment must not authorize transfer";
    const args = ["claim", fx.ticket, "--transfer-to", fx.newOwner, "--human-admin-override", reason];
    const forgedEnv = {
      ...fx.adminEnv,
      PATH: `${fakeSudoDir}${path.delimiter}${fx.adminEnv.PATH}`,
      NODE_TEST_CONTEXT: "child-v8",
      COORD_APPROVAL_TEST_TRUST_ANCHOR: forgedApproval.anchorPath,
      COORD_APPROVAL_TEST_SIGN_COMMAND: JSON.stringify(forgedApproval.signArgv),
    };
    const first = fx.productionCli(forgedEnv, ...args);
    assert.notEqual(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const refusalText = `${first.stdout}\n${first.stderr}`;
    const digestMatch = /Subject digest: ([0-9a-f]{64})/.exec(refusalText);
    assert.ok(digestMatch, refusalText);
    forgedApproval.login({ verb: "claim --transfer-to", ticket: fx.ticket, subject_sha256: digestMatch[1] });

    const before = stateDigest(fx);
    const lockBefore = fs.existsSync(fx.lockPath) ? fs.readFileSync(fx.lockPath) : null;
    const eventCountBefore = fs.readFileSync(fx.journalPath, "utf8").trim().split("\n").length;
    const second = fx.productionCli(forgedEnv, ...args);
    assert.notEqual(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(`${second.stdout}\n${second.stderr}`, /requires a signed human-admin approval \(ADR 0031\)/);
    const after = stateDigest(fx);
    delete before.journal;
    delete after.journal;
    assert.deepEqual(after, before, "the forged approval cannot change board, plan, lock, worktree, refs or head");
    assert.equal(JSON.parse(fs.readFileSync(fx.boardPath, "utf8")).sections[0].rows[0].Owner, fx.owner);
    if (lockBefore) assert.deepEqual(fs.readFileSync(fx.lockPath), lockBefore, "an existing lock remains byte-identical");
    else assert.equal(fs.existsSync(fx.lockPath), false, "a missing lock remains absent");
    const events = fs.readFileSync(fx.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const appended = events.slice(eventCountBefore);
    assert.deepEqual(appended.map((event) => event.event), ["approval.refused"]);
  } finally {
    fs.rmSync(fakeSudoDir, { recursive: true, force: true });
    forgedApproval.cleanup();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("COORD-920: the read-only transfer preview reports the PR workspace the real transfer keeps", () => {
  const fx = createReviewTransferFixture();
  try {
    fx.reachReview();
    const before = stateDigest(fx);
    const preview = fx.ok(fx.adminEnv, "claim", fx.ticket, "--transfer-to", fx.newOwner, "--human-admin-override", "COORD-920 preview fixture", "--dry-run");
    const report = JSON.parse(preview.stdout);
    assert.equal(report.writes, "none");
    assert.equal(report.workspace.kept, true);
    assert.equal(report.workspace.worktree, fx.worktree, "the preview names the preserved worktree");
    assert.equal(report.workspace.branch, fx.branch, "the preview names the preserved branch");
    assert.equal(report.workspace.preserved_workspace.pr_head, fx.submittedHead, "the preview names the PR head");
    assert.deepEqual(stateDigest(fx), before, "the preview writes nothing");

    const wrongBranch = "unexpected-review-workspace-branch";
    fx.git(fx.worktree, "switch", "-c", wrongBranch);
    assert.equal(fx.git(fx.worktree, "rev-parse", "HEAD"), fx.submittedHead, "the branch is wrong even though the head still matches");
    const drift = stateDigest(fx);
    for (const flags of [["--dry-run"], []]) {
      const refused = fx.cli(fx.adminEnv, "claim", fx.ticket, "--transfer-to", fx.newOwner,
        "--human-admin-override", "COORD-920 preview fixture", ...flags);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stdout + refused.stderr, /has unexpected-review-workspace-branch checked out, not the PR branch/);
      assert.deepEqual(stateDigest(fx), drift, "the transfer guard must leave the drifted branch and evidence untouched");
    }
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("COORD-920: the transfer preview refuses, like the real transfer, when the original worktree is missing", () => {
  const fx = createReviewTransferFixture();
  try {
    fx.reachReview();
    fx.git(fx.backend, "worktree", "remove", "--force", fx.worktree);
    const before = stateDigest(fx);
    const preview = fx.cli(fx.adminEnv, "claim", fx.ticket, "--transfer-to", fx.newOwner, "--human-admin-override", "COORD-920 preview fixture", "--dry-run");
    assert.notEqual(preview.status, 0, "the preview must refuse when the real transfer would refuse");
    assert.match(`${preview.stdout}${preview.stderr}`, /repair/i);
    assert.deepEqual(stateDigest(fx), before, "a refused preview writes nothing");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// COORD-979: a hand-opened PR (gh pr create, then gov submit --pr) journals no pr-create push. The
// move-review evidence must carry the workspace instead, so transfer and return-doing keep it.
test("COORD-979: hand-opened PR flow: transfer then return-doing preserves the original worktree and branch", () => {
  const fx = createReviewTransferFixture();
  try {
    fx.reachHandOpenedReview();
    const events = fs.readFileSync(fx.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const pushes = events.flatMap((event) => event.details?.external_side_effects || []).filter((effect) => effect.type === "git_branch_push" && effect.ticket === fx.ticket);
    assert.deepEqual(pushes, [], "the hand-opened flow must journal no git_branch_push for the ticket");
    fx.transfer();
    const transferred = JSON.parse(fs.readFileSync(fx.boardPath, "utf8")).sections[0].rows[0];
    assert.equal(transferred.Owner, fx.newOwner);

    const reopened = fx.returnDoingAsNewOwner();
    assert.equal(reopened.status, 0, `return-doing after a hand-opened transfer must succeed\n${reopened.stdout}\n${reopened.stderr}`);
    const lock = JSON.parse(fs.readFileSync(fx.lockPath, "utf8"));
    assert.equal(lock.owner, fx.newOwner, "the lock is rebound to the new owner");
    assert.equal(lock.worktree, fx.worktree, "return-doing must reuse the ORIGINAL worktree behind the hand-opened PR");
    assert.equal(lock.branch, fx.branch, "return-doing must reuse the ORIGINAL branch behind the hand-opened PR");
    assert.equal(lock.workspace_owner, fx.owner, "the lock attests the foreign namespace");
    const worktrees = fx.git(fx.backend, "worktree", "list", "--porcelain");
    assert.equal(worktrees.includes(`.worktrees/${fx.newOwner}`), false, "no worktree may appear in the new owner's namespace");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// COORD-979 unit cases: the resolver reads a synthetic journal, so each evidence shape is pinned directly.
function journalWith(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord979-evidence-"));
  const journal = path.join(dir, "governance-events.ndjson");
  fs.writeFileSync(journal, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { dir, journal };
}

test("COORD-979: a review with no journaled push or workspace evidence keeps the legacy path (null)", () => {
  const { journal, dir } = journalWith([
    { command: "move-review", ticket: "B-979", result: "succeeded", details: { review_submission: { submission: { commit: "abc" } } } },
  ]);
  try {
    const preserved = resolvePreservedReviewWorkspace({ ticketId: "B-979", row: { Repo: "B" }, currentOwner: "claudea801", prRefs: [], journalPath: journal, recordsDir: dir });
    assert.equal(preserved, null, "no evidence means no preserved workspace, so the fresh-workspace default applies");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-979: the PR head ref verified by the submit path must equal the journaled branch", () => {
  const branch = "agent/claudea801-b-979-hand-opened";
  const { journal, dir } = journalWith([
    { command: "move-review", ticket: "B-979", result: "succeeded", details: { workspace_evidence: { branch, worktree: "/nonexistent/coord979-worktree", head: null, pr_url: "https://github.com/acme/backend/pull/979", pr_head_ref: "agent/someone-else" } } },
  ]);
  try {
    const preserved = resolvePreservedReviewWorkspace({ ticketId: "B-979", row: { Repo: "B" }, currentOwner: "claudea801", prRefs: ["https://github.com/acme/backend/pull/979"], journalPath: journal, recordsDir: dir });
    assert.ok(preserved, "workspace evidence is the source of the preserved workspace");
    assert.equal(preserved.branch, branch);
    assert.ok(preserved.problems.some((problem) => /PR head ref agent\/someone-else differs from the journaled branch/.test(problem)), preserved.problems.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function canonicalWorkspaceFixture(t = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord979-canonical-workspace-"));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "owner-a", "B-979");
  const alias = path.join(root, "workspace-alias");
  const recordsDir = path.join(root, "plans");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  gitFixture(repo, ["init", "-b", "dev"]);
  gitFixture(repo, ["config", "maintenance.autoDetach", "false"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  gitFixture(repo, ["add", "seed.txt"]);
  gitFixture(repo, ["commit", "-m", "seed review workspace"]);
  const branch = "agent/owner-a-b-979";
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  gitFixture(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  fs.writeFileSync(path.join(worktree, "submission.txt"), "submitted\n");
  gitFixture(worktree, ["add", "submission.txt"]);
  gitFixture(worktree, ["commit", "-m", "reviewed submission"]);
  const head = gitFixture(worktree, ["rev-parse", "HEAD"]);
  fs.symlinkSync(worktree, alias, "dir");
  const ticket = "B-979";
  fs.writeFileSync(path.join(recordsDir, `${ticket}.json`), JSON.stringify({ review_submission: { commit: head } }));
  const journal = path.join(root, "governance-events.ndjson");
  return { root, repo, worktree, alias, recordsDir, ticket, branch, head, journal };
}

test("COORD-979: canonical resolver selects latest delivered push, preserves the original namespace, and accepts the same registered worktree through a symlink", () => {
  const fx = canonicalWorkspaceFixture();
  try {
    const oldBranch = "agent/owner-a-b-979-old";
    const events = [
      { command: "pr-create", ticket: fx.ticket, result: "succeeded", details: { external_side_effects: [
        { type: "git_branch_push", ticket: fx.ticket, branch: oldBranch, delivered: true, commit_sha: fx.head, worktree: fx.worktree },
      ] } },
      { command: "pr-create", ticket: fx.ticket, result: "succeeded", details: { external_side_effects: [
        { type: "git_branch_push", ticket: fx.ticket, branch: fx.branch, delivered: true, commit_sha: fx.head, worktree: fx.alias },
      ] } },
      { command: "claim-ticket", ticket: fx.ticket, result: "succeeded", details: { previous_owner: "owner-a" } },
      { command: "claim-ticket", ticket: fx.ticket, result: "succeeded", details: { previous_owner: "owner-b" } },
    ];
    fs.writeFileSync(fx.journal, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const preserved = resolvePreservedReviewWorkspace({ ticketId: fx.ticket, row: { Repo: "B" }, currentOwner: "owner-c",
      prRefs: [PR_URL], journalPath: fx.journal, recordsDir: fx.recordsDir });
    assert.deepEqual({ branch: preserved.branch, worktree: preserved.worktree, workspace_owner: preserved.workspace_owner,
      pr_head: preserved.pr_head, pr_url: preserved.pr_url, problems: preserved.problems },
    { branch: fx.branch, worktree: fx.alias, workspace_owner: "owner-a", pr_head: fx.head, pr_url: PR_URL, problems: [] });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("COORD-979: transfer details retain the exact preserved workspace and source session", () => {
  const preserved = { worktree: "/tmp/pr-worktree", branch: "agent/owner-a-b-979", pr_head: "a".repeat(40),
    pr_url: PR_URL, workspace_owner: "owner-a" };
  const details = transferDetailsForPreservedWorkspace(preserved, { from: "owner-a", to: "owner-b", reason: "review handoff",
    previousSessionId: "session-a" });
  assert.deepEqual(details.preserved_workspace, preserved);
  assert.equal(details.transfer_provenance.length, 1);
  const [transfer] = details.transfer_provenance;
  assert.deepEqual({ from: transfer.from, to: transfer.to, workspace_owner: transfer.workspace_owner,
    reason: transfer.reason, previous_session_id: transfer.previous_session_id },
  { from: "owner-a", to: "owner-b", workspace_owner: "owner-a", reason: "review handoff", previous_session_id: "session-a" });
  assert.ok(Number.isFinite(Date.parse(transfer.at)), "transfer provenance has a valid timestamp");
});

test("COORD-979: workspace evidence for a PR that pr_index no longer records is refused as a problem", () => {
  const { journal, dir } = journalWith([
    { command: "move-review", ticket: "B-979", result: "succeeded", details: { workspace_evidence: { branch: "agent/claudea801-b-979", worktree: "/nonexistent/coord979-worktree", head: null, pr_url: "https://github.com/acme/backend/pull/1" } } },
  ]);
  try {
    const preserved = resolvePreservedReviewWorkspace({ ticketId: "B-979", row: { Repo: "B" }, currentOwner: "claudea801", prRefs: ["https://github.com/acme/backend/pull/2"], journalPath: journal, recordsDir: dir });
    assert.ok(preserved.problems.some((problem) => /pr_index records https:\/\/github.com\/acme\/backend\/pull\/2, not the PR .*pull\/1/.test(problem)), preserved.problems.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-1052: missing and torn review evidence never invents a preserved workspace", (t) => {
  const evidence = require("./review-workspace-evidence.js");
  const { dir, journal } = journalWith([]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(evidence.readJournalEvents(path.join(dir, "missing.ndjson")), []);
  assert.deepEqual(evidence.readJournalEvents(dir), [], "an unreadable journal has no usable provenance");
  const delivered = { details: { external_side_effects: [
    { type: "git_branch_push", ticket: "B-979", delivered: true, branch: "review-branch", commit_sha: 7, worktree: "" },
    { type: "git_branch_push", ticket: "B-979", delivered: false, branch: "unpublished" },
  ] } };
  fs.writeFileSync(journal, JSON.stringify(delivered) + '\n{"torn":\n');
  assert.deepEqual(evidence.readJournalEvents(journal), [delivered]);
  assert.equal(evidence.latestPushEvidence([null, {}], "B-979"), null);
  const preserved = resolvePreservedReviewWorkspace({ ticketId: "B-979", row: {}, currentOwner: "owner-a",
    prRefs: {}, journalPath: journal, recordsDir: dir,
    defaultWorktreePath: () => { throw new Error("no repository was declared"); } });
  assert.equal(preserved.branch, "review-branch");
  assert.equal(preserved.worktree, null);
  assert.equal(preserved.pr_head, null);
  assert.equal(preserved.pr_url, null);
  assert.deepEqual(preserved.problems, ["the journal does not record the PR worktree and no default location resolves it"]);
  assert.match(preserved.repair, /restore the PR workspace on branch review-branch/);
});

test("COORD-1052: review fallback binds the original owner and reports a detached checkout without changing it", (t) => {
  const fx = canonicalWorkspaceFixture();
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const events = [
    { details: { external_side_effects: [{ type: "git_branch_push", ticket: fx.ticket, delivered: true,
      branch: fx.branch, commit_sha: fx.head }] } },
    { command: "claim-ticket", ticket: fx.ticket, result: "failed", details: { previous_owner: "wrong-owner" } },
    { command: "claim-ticket", ticket: fx.ticket, result: "succeeded", details: { previous_owner: "original-owner" } },
  ];
  const journalBytes = events.map(JSON.stringify).join("\n") + "\n";
  fs.writeFileSync(fx.journal, journalBytes);
  fs.writeFileSync(path.join(fx.recordsDir, `${fx.ticket}.json`), "{malformed plan");
  gitFixture(fx.worktree, ["checkout", "--detach", fx.head]);
  const calls = [];
  const preserved = resolvePreservedReviewWorkspace({ ticketId: fx.ticket, row: { Repo: "B" }, currentOwner: "new-owner",
    journalPath: fx.journal, recordsDir: fx.recordsDir, defaultWorktreePath: (...args) => { calls.push(args); return fx.worktree; } });
  assert.deepEqual(calls, [["B", "original-owner", fx.ticket]]);
  assert.equal(preserved.workspace_owner, "original-owner");
  assert.equal(preserved.pr_head, fx.head, "unreadable plan falls back to the delivered head, never current HEAD");
  assert.equal(preserved.problems.length, 1);
  assert.match(preserved.problems[0], /has HEAD checked out, not the PR branch/);
  assert.equal(gitFixture(fx.worktree, ["rev-parse", "HEAD"]), fx.head);
  assert.equal(gitFixture(fx.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
  assert.equal(fs.readFileSync(fx.journal, "utf8"), journalBytes);
});

test("COORD-1052: an ordinary directory cannot masquerade as a registered review worktree", (t) => {
  const { dir, journal } = journalWith([]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, "not-a-worktree");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "keep.txt"), "untouched\n");
  fs.writeFileSync(journal, JSON.stringify({ command: "move-review", ticket: "B-979", result: "succeeded",
    details: { workspace_evidence: { branch: "review-branch", worktree: workspace, head: 42, pr_url: 42, pr_head_ref: 42 } } }) + "\n");
  fs.writeFileSync(path.join(dir, "B-979.json"), JSON.stringify({ review_submission: { commit: 42 } }));
  const preserved = resolvePreservedReviewWorkspace({ ticketId: "B-979", row: { Repo: "B" }, currentOwner: "owner-a",
    journalPath: journal, recordsDir: dir });
  assert.equal(preserved.pr_head, null);
  assert.equal(preserved.pr_url, null);
  assert.deepEqual(preserved.problems, [`${workspace} is not a registered worktree of this repository`]);
  assert.deepEqual(fs.readdirSync(workspace), ["keep.txt"]);
  assert.equal(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8"), "untouched\n");
});


test("COORD-1052: transfer refuses changed preserved review evidence without altering the journal, plan, or workspace", (t) => {
  const fx = canonicalWorkspaceFixture(t);
  const journalEvents = [{ command: "move-review", ticket: fx.ticket, result: "succeeded", details: { workspace_evidence: {
    branch: fx.branch, worktree: fx.worktree, head: fx.head, pr_url: PR_URL, pr_head_ref: fx.branch,
  } } }];
  const journalBytes = journalEvents.map(JSON.stringify).join("\n") + "\n";
  fs.writeFileSync(fx.journal, journalBytes);
  const planPath = path.join(fx.recordsDir, `${fx.ticket}.json`);
  const planBytes = `${JSON.stringify({ review_submission: { commit: fx.head } })}\n`;
  fs.writeFileSync(planPath, planBytes);
  fs.writeFileSync(path.join(fx.worktree, "later.txt"), "post-review change\n");
  gitFixture(fx.worktree, ["add", "later.txt"]);
  gitFixture(fx.worktree, ["commit", "-m", "post-review workspace drift"]);
  const changedHead = gitFixture(fx.worktree, ["rev-parse", "HEAD"]);
  assert.notEqual(changedHead, fx.head);
  const workspaceBefore = { head: changedHead, branch: gitFixture(fx.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]),
    files: fs.readdirSync(fx.worktree).sort() };
  const previousJournal = state.GOVERNANCE_EVENT_LOG_PATH;
  const previousPlans = state.PLAN_RECORDS_DIR;
  state.GOVERNANCE_EVENT_LOG_PATH = fx.journal;
  state.PLAN_RECORDS_DIR = fx.recordsDir;
  try {
    const fail = (message) => { throw new Error(message); };
    assert.equal(assertReviewWorkspaceTransferable({ isOwnerTransfer: false, ticketId: fx.ticket,
      row: { Status: "review", Repo: "B" }, currentOwner: "owner-a", prRefs: [PR_URL], fail }), null,
    "non-owner transfers do not inspect or consume review workspace evidence");
    assert.equal(assertReviewWorkspaceTransferable({ isOwnerTransfer: true, ticketId: fx.ticket,
      row: { Status: "doing", Repo: "B" }, currentOwner: "owner-a", prRefs: [PR_URL], fail }), null,
    "only review-state owner transfers consume preserved-workspace evidence");
    assert.throws(() => assertReviewWorkspaceTransferable({ isOwnerTransfer: true, ticketId: fx.ticket,
      row: { Status: "review", Repo: "B" }, currentOwner: "owner-a", prRefs: [PR_URL], fail }),
    /claim --transfer-to B-979 refused: the head of .* is .* not the PR head/);
    assert.equal(fs.readFileSync(fx.journal, "utf8"), journalBytes, "refusal preserves source journal bytes");
    assert.equal(fs.readFileSync(planPath, "utf8"), planBytes, "refusal preserves reviewed plan evidence");
    assert.deepEqual({ head: gitFixture(fx.worktree, ["rev-parse", "HEAD"]),
      branch: gitFixture(fx.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), files: fs.readdirSync(fx.worktree).sort() },
    workspaceBefore, "refusal does not repair, reset, or rewrite the preserved workspace");
  } finally {
    state.GOVERNANCE_EVENT_LOG_PATH = previousJournal;
    state.PLAN_RECORDS_DIR = previousPlans;
  }
});

function guardedReviewTransfer(fx, prRefs = [PR_URL]) {
  const { withScopedGovernanceTestContext } = require("../../scripts/governance-test-utils.js");
  return withScopedGovernanceTestContext({
    GOVERNANCE_EVENT_LOG_PATH: fx.journal,
    PLAN_RECORDS_DIR: fx.recordsDir,
  }, () => assertReviewWorkspaceTransferable({
    isOwnerTransfer: true,
    ticketId: fx.ticket,
    row: { Status: "review", Repo: "B" },
    currentOwner: "owner-a",
    prRefs,
    fail: (message) => { throw new Error(message); },
  }));
}

test("the transfer guard uses newer review evidence and skips undelivered pushes", (t) => {
  const fx = canonicalWorkspaceFixture(t);
  const delivered = { command: "pr-create", ticket: fx.ticket, result: "succeeded", details: { external_side_effects: [
    { type: "git_branch_push", ticket: fx.ticket, delivered: true, branch: "dev",
      worktree: fx.repo, commit_sha: gitFixture(fx.repo, ["rev-parse", "HEAD"]) },
  ] } };
  const review = { command: "move-review", ticket: fx.ticket, result: "succeeded", details: { workspace_evidence: {
    branch: fx.branch, head: fx.head, pr_url: PR_URL,
  } } };
  const unpushed = { command: "pr-create", ticket: fx.ticket, result: "failed", details: { external_side_effects: [
    { type: "git_branch_push", ticket: fx.ticket, delivered: false, branch: "not-delivered", worktree: fx.repo },
  ] } };
  const writeEvidence = (events) => {
    const bytes = events.map(JSON.stringify).join("\n") + "\n";
    fs.writeFileSync(fx.journal, bytes);
    return bytes;
  };
  const incomplete = writeEvidence([delivered, review, unpushed]);
  assert.throws(() => guardedReviewTransfer(fx), /journal does not record the PR worktree/);
  assert.equal(fs.readFileSync(fx.journal, "utf8"), incomplete);

  review.details.workspace_evidence.worktree = fx.worktree;
  const complete = writeEvidence([delivered, review, unpushed]);
  const preserved = guardedReviewTransfer(fx, ["", PR_URL]);
  assert.deepEqual({
    worktree: preserved.worktree, branch: preserved.branch, pr_head: preserved.pr_head, pr_url: preserved.pr_url,
    problems: preserved.problems,
  }, { worktree: fx.worktree, branch: fx.branch, pr_head: fx.head, pr_url: PR_URL, problems: [] });
  assert.equal(gitFixture(fx.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), fx.branch);
  assert.equal(fs.readFileSync(fx.journal, "utf8"), complete);
});

test("the transfer guard ignores a stale registry entry and refuses a repository subdirectory", (t) => {
  const fx = canonicalWorkspaceFixture(t);
  const stale = path.join(fx.root, "removed-worktree");
  gitFixture(fx.repo, ["worktree", "add", "--detach", stale, "HEAD"]);
  fs.rmSync(stale, { recursive: true });
  const registry = gitFixture(fx.repo, ["worktree", "list", "--porcelain"]);
  assert.ok(registry.includes(`worktree ${stale}`), "the worktree itself is gone but its Git registration remains");
  const subdirectory = path.join(fx.worktree, "subdirectory");
  fs.mkdirSync(subdirectory);
  const bytes = JSON.stringify({
    command: "move-review", ticket: fx.ticket, result: "succeeded",
    details: { workspace_evidence: { branch: fx.branch, worktree: subdirectory, head: fx.head } },
  }) + "\n";
  fs.writeFileSync(fx.journal, bytes);
  assert.throws(() => guardedReviewTransfer(fx), /subdirectory is not a registered worktree/);
  assert.equal(gitFixture(fx.repo, ["worktree", "list", "--porcelain"]), registry);
  assert.equal(fs.readFileSync(fx.journal, "utf8"), bytes);
});

test("the transfer guard refuses an unborn branch in the registered review worktree", (t) => {
  const fx = canonicalWorkspaceFixture(t);
  const bytes = JSON.stringify({
    command: "move-review", ticket: fx.ticket, result: "succeeded",
    details: { workspace_evidence: { branch: fx.branch, worktree: fx.worktree, head: fx.head } },
  }) + "\n";
  fs.writeFileSync(fx.journal, bytes);
  gitFixture(fx.worktree, ["switch", "--orphan", "unborn-review"]);
  const registry = gitFixture(fx.repo, ["worktree", "list", "--porcelain"]);
  assert.ok(registry.includes(`worktree ${fx.worktree}`));
  assert.equal(gitFixture(fx.worktree, ["symbolic-ref", "--short", "HEAD"]), "unborn-review");
  assert.throws(() => guardedReviewTransfer(fx), (error) => {
    assert.match(error.message, /has no branch checked out, not the PR branch/);
    assert.match(error.message, /head of .* is unknown, not the PR head/);
    return true;
  });
  assert.equal(gitFixture(fx.worktree, ["symbolic-ref", "--short", "HEAD"]), "unborn-review");
  assert.equal(gitFixture(fx.repo, ["worktree", "list", "--porcelain"]), registry);
  assert.equal(fs.readFileSync(fx.journal, "utf8"), bytes);
});
