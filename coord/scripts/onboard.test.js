"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildOnboardPlan,
  fileApprovedStarterTickets,
  normalizeContextPack,
  parseArgs,
  renderOnboardPlan,
  run,
  updateOnboardingReceipt,
  writeOnboardArtifacts,
} = require("./onboard.js");

// COORD-624: a WORKSPACE — the control plane plus sibling product repositories.
// Onboarding maps the siblings by relative path; it never touches them.
function tmpRoot({ siblings = ["backend", "frontend"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-onboard-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  for (const name of siblings) {
    fs.mkdirSync(path.join(root, name, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, name, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(root, name, "package.json"), JSON.stringify({ name }));
  }
  return root;
}

test("onboard dry-run builds a deterministic adoption plan", () => {
  const root = tmpRoot();
  const plan = buildOnboardPlan(root);
  const again = buildOnboardPlan(root);
  assert.equal(plan.kind, "concord.onboard_plan");
  assert.equal(plan.plan_digest, again.plan_digest);
  assert.equal(plan.preset.id, "web-app");
  assert.ok(plan.starter_tickets.every((ticket) => ticket.status === "proposed"));
  assert.match(plan.project_config_preview, /coordTicketPrefix/);
  assert.match(renderOnboardPlan(plan), /Concord Onboarding Plan/);
  assert.equal(JSON.stringify(plan).includes(root), false, "preview persists no private absolute path");
  fs.rmSync(root, { recursive: true, force: true });
});

test("onboard apply requires the reviewed digest, writes a receipt, and reruns byte-identically", () => {
  const root = tmpRoot();
  const plan = buildOnboardPlan(root);
  assert.throws(() => writeOnboardArtifacts(plan), /requires explicit approval/);
  const applied = writeOnboardArtifacts(plan, { approve: plan.plan_digest });
  assert.deepEqual(applied.written.sort(), [
    "coord/onboarding.receipt.json",
    "coord/project.config.js",
    "coord/setup.decisions.json",
  ].sort());
  assert.equal(applied.receipt.plan_digest, plan.plan_digest);
  assert.equal(applied.receipt.privacy.private_absolute_paths, false);
  const before = ["project.config.js", "setup.decisions.json", "onboarding.receipt.json"]
    .map((name) => fs.readFileSync(path.join(root, "coord", name)));
  const rerun = writeOnboardArtifacts(buildOnboardPlan(root), { approve: plan.plan_digest });
  assert.deepEqual(rerun.written, []);
  assert.deepEqual(
    ["project.config.js", "setup.decisions.json", "onboarding.receipt.json"]
      .map((name) => fs.readFileSync(path.join(root, "coord", name))),
    before,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-479: installer approval is bound to the exact onboard plan digest", () => {
  const root = tmpRoot();
  try {
    const plan = buildOnboardPlan(root);
    const installPlanDigest = "a".repeat(64);
    assert.throws(
      () => writeOnboardArtifacts(plan, { installPlanDigest }),
      /requires explicit approval/,
      "an install digest alone does not approve an opaque generated configuration",
    );
    assert.throws(
      () => writeOnboardArtifacts(plan, { installPlanDigest, expectedOnboardPlanDigest: "b".repeat(64) }),
      /requires explicit approval/,
      "a stale embedded onboarding preview is refused",
    );
    const applied = writeOnboardArtifacts(plan, {
      installPlanDigest,
      expectedOnboardPlanDigest: plan.plan_digest,
    });
    assert.equal(applied.receipt.approval.kind, "reviewed_install_plan");
    assert.equal(applied.receipt.approval.onboard_plan_digest, plan.plan_digest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("onboard args default to dry-run and accept explicit write/json", () => {
  assert.deepEqual(parseArgs(["/tmp/repo", "--json"]), {
    dryRun: true, write: false, force: false, repo: "/tmp/repo", approve: null,
    approveStarters: false, contextPack: null, json: true,
  });
  assert.equal(parseArgs(["/tmp/repo", "--write"]).dryRun, false);
  assert.equal(parseArgs(["/tmp/repo", "--approve", "abc"]).approve, "abc");
  assert.equal(parseArgs(["/tmp/repo", "--approve-starters"]).approveStarters, true);
});

// ---------------------------------------------------------------------------
// COORD-477: onboarding understands the target's root Git state
// ---------------------------------------------------------------------------

const { execFileSync } = require("node:child_process");
const { detectCoordGitState } = require("./onboard.js");

// COORD-631/ADR-0008: the onboarding diagnostics classify coord/ — the
// independent control-plane repository — not the workspace container, which is
// never a Git repository.

test("COORD-477/COORD-631: onboard plan carries the coord/ git state and stays read-only", () => {
  const root = tmpRoot();
  const plan = buildOnboardPlan(root);
  assert.equal(plan.coord_git.state, "outside");
  assert.equal(plan.coord_git.coord_dir, "coord");
  assert.equal(plan.workspace_container_git.is_git_repository, false);
  assert.match(plan.workspace_container_git.never_initialized, /absence is the control/);
  assert.equal(plan.next_steps.some((s) => /bootstrap-pending/.test(s)), false);
  assert.equal(fs.existsSync(path.join(root, ".git")), false, "onboard planning never creates git state");
  assert.equal(fs.existsSync(path.join(root, "coord", ".git")), false, "onboard planning never creates git state");
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-477/COORD-631: an unborn coord/ gets bootstrap-pending next steps naming coord/ (exact allowlist, never git add .)", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path.join(root, "coord") });
  const plan = buildOnboardPlan(root);
  assert.equal(plan.coord_git.state, "unborn");
  const step = plan.next_steps[0];
  assert.match(step, /bootstrap-pending/);
  assert.match(step, /^coord is bootstrap-pending/, "the guidance names coord without leaking the container path");
  assert.match(step, /--git-stage/);
  assert.match(step, /--git-baseline-commit/);
  assert.match(step, /never `git add \.` \/ `git add -A`/);
  assert.match(step, /gov doctor/);
  assert.equal(plan.workspace_container_git.is_git_repository, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-631: a container-Git workspace is offered REVIEWED MIGRATION, never bootstrap or container initialization", () => {
  const root = tmpRoot();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const plan = buildOnboardPlan(root);
  assert.equal(plan.coord_git.state, "ancestor");
  assert.equal(plan.coord_git.container_is_git_repository, true);
  assert.equal(plan.workspace_container_git.is_git_repository, true);
  const step = plan.next_steps[0];
  assert.equal(/bootstrap-pending/.test(step), false, "never advise committing the container");
  assert.match(step, /not an independent control-plane repository/);
  assert.match(step, /never initialized, relocated or removed automatically/);
  assert.match(step, /explicit, reviewed, backed-up human action/);
  // Read-only: onboarding planning wrote nothing to the container's Git state.
  assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).includes(".git"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("COORD-477/COORD-631: detectCoordGitState classifies outside / ancestor / unborn / established via injected git", () => {
  const coordOfW = path.resolve("/w", "coord");
  // Established: toplevel == coord/, HEAD resolves.
  const established = detectCoordGitState("/w", (args) =>
    args.includes("--show-toplevel") ? { status: 0, stdout: `${coordOfW}\n` } : { status: 0, stdout: "abc\n" });
  assert.equal(established.state, "established");
  assert.equal(established.root, coordOfW);
  // Unborn: toplevel == coord/, HEAD does not resolve.
  const unborn = detectCoordGitState("/w", (args) =>
    args.includes("--show-toplevel") ? { status: 0, stdout: `${coordOfW}\n` } : { status: 128, stdout: "" });
  assert.equal(unborn.state, "unborn");
  // Ancestor: toplevel resolves ABOVE coord/ — the container owns the repo.
  const ancestor = detectCoordGitState("/w", (args) =>
    args.includes("--show-toplevel") ? { status: 0, stdout: "/w\n" } : { status: 0, stdout: "abc\n" });
  assert.equal(ancestor.state, "ancestor");
  assert.equal(ancestor.root, path.resolve("/w"));
  assert.equal(ancestor.container_is_git_repository, true);
  // Outside: toplevel fails.
  assert.equal(detectCoordGitState("/w", () => ({ status: 128, stdout: "" })).state, "outside");
});

// ---------------------------------------------------------------------------
// COORD-624: sibling-workspace topology — repositories are RECORDED by relative
// sibling path, never initialized, onboarded or written to.
// ---------------------------------------------------------------------------

const { discoverSiblingRepos, assignRepoCodes } = require("./onboard.js");

test("COORD-624: project.config.js records sibling product repos by RELATIVE path", () => {
  const root = tmpRoot({ siblings: ["api-service", "web-client", "shared-lib"] });
  try {
    const plan = buildOnboardPlan(root);
    assert.equal(plan.topology, "sibling-workspace");
    assert.deepEqual(plan.sibling_product_repositories, ["api-service", "shared-lib", "web-client"]);
    assert.equal(plan.product_repositories_written, false);
    const config = plan.project_config_preview;
    // Relative sibling paths — never "." and never absolute.
    assert.match(config, /path:\s*"api-service"/);
    assert.match(config, /path:\s*"web-client"/);
    assert.match(config, /path:\s*"shared-lib"/);
    assert.equal(/path:\s*"\."/.test(config), false, "the workspace itself is never a governed repo");
    assert.equal(/path:\s*"\//.test(config), false, "no absolute paths");
    // Codes are distinct and never the reserved cross-repo code X.
    const codes = [...config.matchAll(/^\s{4}([A-Z]):\s*\{/gm)].map((m) => m[1]);
    assert.equal(new Set(codes).size, codes.length, "codes are distinct");
    assert.equal(codes.includes("X"), false, "X stays reserved for coord/cross-repo work");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-624: onboarding a workspace with no sibling repositories fails with the topology", () => {
  const root = tmpRoot({ siblings: [] });
  try {
    assert.throws(() => buildOnboardPlan(root), /no sibling product repositories found[\s\S]*BESIDE coord\//);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-624: sibling discovery is metadata-only and skips the control plane", () => {
  const root = tmpRoot({ siblings: ["svc-a"] });
  try {
    fs.mkdirSync(path.join(root, "coord", ".git"), { recursive: true });   // never a product repo
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });           // not a repo at all
    fs.mkdirSync(path.join(root, "node_modules", ".git"), { recursive: true });
    assert.deepEqual(discoverSiblingRepos(root), ["svc-a"]);
    // Code assignment: first letter when free, X always avoided, no duplicates.
    assert.deepEqual(assignRepoCodes(["api", "billing"]).map((r) => r.code), ["A", "B"]);
    assert.deepEqual(assignRepoCodes(["xylophone", "xenon"]).map((r) => r.code), ["A", "B"], "X is reserved, so both fall through");
    assert.deepEqual(assignRepoCodes(["api", "auth"]).map((r) => r.code), ["A", "B"], "clashes take the next free letter");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// COORD-479: reviewed preview/apply transaction and safe discovery.
// ---------------------------------------------------------------------------

test("COORD-479: a mid-apply failure restores exact prior bytes and modes", () => {
  const root = tmpRoot();
  try {
    const coordDir = path.join(root, "coord");
    fs.mkdirSync(coordDir, { recursive: true });
    const configPath = path.join(coordDir, "project.config.js");
    const decisionsPath = path.join(coordDir, "setup.decisions.json");
    fs.writeFileSync(configPath, "operator config\n", { mode: 0o600 });
    fs.writeFileSync(decisionsPath, "operator decisions\n", { mode: 0o640 });
    const before = [configPath, decisionsPath].map((file) => ({
      bytes: fs.readFileSync(file),
      mode: fs.statSync(file).mode & 0o777,
    }));
    const plan = buildOnboardPlan(root);
    assert.throws(
      () => writeOnboardArtifacts(plan, {
        approve: plan.plan_digest,
        force: true,
        injectFailureAt: "coord/setup.decisions.json",
      }),
      /injected failure/,
    );
    assert.deepEqual([configPath, decisionsPath].map((file) => ({
      bytes: fs.readFileSync(file),
      mode: fs.statSync(file).mode & 0o777,
    })), before);
    assert.equal(fs.existsSync(path.join(coordDir, "onboarding.receipt.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-479: a failed atomic rename leaves no temp file and restores touched outputs", () => {
  const root = tmpRoot();
  try {
    const coordDir = path.join(root, "coord");
    fs.mkdirSync(coordDir, { recursive: true });
    const configPath = path.join(coordDir, "project.config.js");
    const decisionsPath = path.join(coordDir, "setup.decisions.json");
    fs.writeFileSync(configPath, "operator config\n", { mode: 0o600 });
    fs.writeFileSync(decisionsPath, "operator decisions\n", { mode: 0o640 });
    const before = [configPath, decisionsPath].map((file) => ({
      bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777,
    }));
    const plan = buildOnboardPlan(root);
    const failingFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "renameSync") return target[property];
        return (from, to) => {
          if (String(to).endsWith("setup.decisions.json")) throw new Error("simulated rename failure");
          return target.renameSync(from, to);
        };
      },
    });
    assert.throws(
      () => writeOnboardArtifacts(plan, { approve: plan.plan_digest, force: true, fs: failingFs }),
      /simulated rename failure/,
    );
    assert.deepEqual([configPath, decisionsPath].map((file) => ({
      bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777,
    })), before);
    assert.equal(fs.readdirSync(coordDir).some((name) => name.includes(".onboard-tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-479: discovery never opens sensitive paths and persists no canary or raw path", () => {
  const root = tmpRoot();
  const canary = "CANARY_PASSWORD_VALUE_479";
  fs.writeFileSync(path.join(root, ".env.local"), `PASSWORD=${canary}\n`);
  fs.writeFileSync(path.join(root, "backend", "credentials.json"), JSON.stringify({ token: canary }));
  const reads = [];
  const trappedFs = new Proxy(fs, {
    get(target, property) {
      if (property !== "readFileSync") return target[property];
      return (file, ...args) => {
        const name = String(file);
        reads.push(name);
        if (/\.env|credential|private[-_]?key|secret/i.test(name)) {
          throw new Error(`READ TRAP: ${path.basename(name)}`);
        }
        return target.readFileSync(file, ...args);
      };
    },
  });
  try {
    const plan = buildOnboardPlan(root, { fs: trappedFs });
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes(canary), false);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(".env.local"), false);
    assert.equal(serialized.includes("credentials.json"), false);
    assert.ok(reads.every((file) => /package\.json$/.test(file)), `unexpected content read: ${reads.join(", ")}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-479: cited context stays advisory and raw content never reaches plan or receipt", () => {
  const root = tmpRoot();
  const canary = "CANARY_SECRET_CONTEXT_479";
  const contextPath = path.join(root, "continuity.json");
  fs.writeFileSync(contextPath, JSON.stringify({
    source: { ref: "memory/continuity.md" },
    freshness: "2026-08-25",
    sensitivity: "internal",
    citations: [{ id: "architecture", ref: "docs/ARCHITECTURE.md#boundaries" }],
    notes: `must never persist ${canary}`,
  }));
  try {
    const normalized = normalizeContextPack(root, "continuity.json");
    assert.equal(normalized.authority, "advisory");
    assert.equal(normalized.promotion_status, "unpromoted");
    assert.equal(JSON.stringify(normalized).includes(canary), false);
    const plan = buildOnboardPlan(root, { contextPack: "continuity.json" });
    const applied = writeOnboardArtifacts(plan, { approve: plan.plan_digest });
    assert.ok(applied.written.includes("coord/onboarding.context.json"));
    const receipt = fs.readFileSync(path.join(root, "coord", "onboarding.receipt.json"), "utf8");
    assert.equal(receipt.includes(canary), false);
    assert.equal(receipt.includes(root), false);
    assert.match(receipt, /"authority": "advisory"/);
    assert.equal(fs.statSync(path.join(root, "coord", "onboarding.context.json")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-479: context import refuses sensitive paths and credential-bearing references before persistence", () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, ".env.context"), JSON.stringify({ sensitivity: "internal" }));
    assert.throws(
      () => normalizeContextPack(root, ".env.context"),
      /classified as sensitive and was not read/,
    );
    fs.writeFileSync(path.join(root, "unsafe-context.json"), JSON.stringify({
      source: { ref: "https://user:credential@private.example/context" },
      freshness: "2026-08-25",
      sensitivity: "internal",
      citations: ["docs/ARCHITECTURE.md"],
    }));
    assert.throws(
      () => normalizeContextPack(root, "unsafe-context.json"),
      /source is missing or unsafe/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createRealProductRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name, scripts: { test: "node --test", build: "secret-not-read" } }));
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "package.json", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
  fs.writeFileSync(path.join(repo, ".env.local"), "TOKEN=PRODUCT_CANARY_479\n");
  return repo;
}

test("COORD-479: two dirty product repositories stay byte- and HEAD-identical", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord479-products-"));
  const repos = [createRealProductRepo(root, "backend"), createRealProductRepo(root, "frontend")];
  try {
    const before = repos.map((repo) => ({
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }),
      status: execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: repo, encoding: "utf8" }),
      tracked: fs.readFileSync(path.join(repo, "tracked.txt")),
      env: fs.readFileSync(path.join(repo, ".env.local")),
    }));
    const plan = buildOnboardPlan(root);
    assert.ok(plan.discovery.repositories.every((repo) => repo.git.dirty_summary.dirty));
    assert.equal(JSON.stringify(plan).includes(".env.local"), false);
    writeOnboardArtifacts(plan, { approve: plan.plan_digest });
    assert.deepEqual(repos.map((repo) => ({
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }),
      status: execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: repo, encoding: "utf8" }),
      tracked: fs.readFileSync(path.join(repo, "tracked.txt")),
      env: fs.readFileSync(path.join(repo, ".env.local")),
    })), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-479: explicitly approved starter tickets use governed proposed intake and deduplicate", () => {
  const root = tmpRoot();
  try {
    const boardPath = path.join(root, "coord", "board", "tasks.json");
    fs.mkdirSync(path.dirname(boardPath), { recursive: true });
    fs.writeFileSync(boardPath, `${JSON.stringify({ sections: [{ rows: [] }] }, null, 2)}\n`);
    const plan = buildOnboardPlan(root);
    const applied = writeOnboardArtifacts(plan, { approve: plan.plan_digest });
    let calls = 0;
    const fileProposedTicket = (ticket) => {
      calls += 1;
      const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      const id = `COORD-${900 + calls}`;
      board.sections[0].rows.push({
        ID: id,
        Repo: ticket.repo,
        Type: ticket.type,
        Pri: ticket.pri,
        Status: "proposed",
        Description: `[onboarding:${ticket.proposal_key}] ${ticket.title}`,
      });
      fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
      return id;
    };
    const first = fileApprovedStarterTickets(plan, { approveStarters: true, fileProposedTicket });
    updateOnboardingReceipt(plan, applied, first);
    const firstReceipt = fs.readFileSync(path.join(root, "coord", "onboarding.receipt.json"));
    assert.equal(calls, 3);
    assert.ok(first.every((entry) => entry.status === "proposed"));
    const approvedBoard = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.ok(approvedBoard.sections[0].rows.every((row) => row.Status === "proposed"));
    approvedBoard.sections[0].rows[0].Status = "todo";
    fs.writeFileSync(boardPath, `${JSON.stringify(approvedBoard, null, 2)}\n`);
    const rerunPlan = buildOnboardPlan(root);
    const second = fileApprovedStarterTickets(rerunPlan, { approveStarters: true, fileProposedTicket });
    assert.equal(calls, 3, "retry adopts prior proposed rows rather than filing duplicates");
    assert.ok(second.every((entry) => entry.status === "proposed"), "the durable receipt retains the original intake outcome");
    updateOnboardingReceipt(rerunPlan, applied, second);
    assert.deepEqual(
      fs.readFileSync(path.join(root, "coord", "onboarding.receipt.json")),
      firstReceipt,
      "a successful retry is byte-idempotent even after a proposal is promoted",
    );
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    assert.equal(board.sections[0].rows.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-479: the production starter intake names governed proposed status, never todo", () => {
  const root = tmpRoot();
  try {
    const boardPath = path.join(root, "coord", "board", "tasks.json");
    const govPath = path.join(root, "coord", "scripts", "governance.js");
    const capturePath = path.join(root, "captured-intake.json");
    fs.mkdirSync(path.dirname(boardPath), { recursive: true });
    fs.mkdirSync(path.dirname(govPath), { recursive: true });
    fs.writeFileSync(boardPath, `${JSON.stringify({ sections: [{ rows: [] }] }, null, 2)}\n`);
    fs.writeFileSync(govPath, [
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));',
      'process.stdout.write("Filed ticket COORD-991\\n");',
    ].join("\n"));
    const plan = buildOnboardPlan(root);
    fileApprovedStarterTickets(plan, {
      approveStarters: true,
      env: { CAPTURE_PATH: capturePath },
    });
    const argv = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    const at = argv.indexOf("--status");
    assert.ok(at >= 0);
    assert.equal(argv[at + 1], "proposed");
    assert.equal(argv.includes("todo"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-479: a partial proposed-ticket failure is receipted immediately and retryable", () => {
  const root = tmpRoot();
  try {
    const boardPath = path.join(root, "coord", "board", "tasks.json");
    fs.mkdirSync(path.dirname(boardPath), { recursive: true });
    fs.writeFileSync(boardPath, `${JSON.stringify({ sections: [{ rows: [] }] }, null, 2)}\n`);
    const plan = buildOnboardPlan(root);
    let calls = 0;
    const result = run([
      root, "--write", "--approve", plan.plan_digest, "--approve-starters",
    ], {
      log: () => {},
      fileProposedTicket: (ticket) => {
        calls += 1;
        if (calls === 2) throw new Error("simulated governed intake failure");
        const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
        board.sections[0].rows.push({
          ID: "COORD-990",
          Status: "proposed",
          Description: `[onboarding:${ticket.proposal_key}] ${ticket.title}`,
        });
        fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
        return "COORD-990";
      },
    });
    assert.equal(result.code, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, "coord", "onboarding.receipt.json"), "utf8"));
    assert.deepEqual(receipt.proposed_tickets.map((entry) => entry.status), ["proposed", "failed"]);
    assert.equal(receipt.proposed_tickets[0].ticket_id, "COORD-990");
    assert.equal(receipt.proposed_tickets[1].ticket_id, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
