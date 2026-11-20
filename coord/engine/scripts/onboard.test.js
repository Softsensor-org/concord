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

function configuredWorkspace(root) {
  const config = '// Preserve operator comments and unrelated settings.\nmodule.exports = ' + JSON.stringify({
    coordTicketPrefix: "TEAM",
    repos: {
      S: { path: "backend", integrationBranch: "release/service", testCommand: "npm run test:service", ticketPrefixes: ["SERV"] },
      W: { path: "frontend", integrationBranch: "release/web", testCommand: "npm run test:web", ticketPrefixes: ["WEB"] },
    },
    privateNotes: "UNPROJECTED_CONFIG_CANARY_527",
  }) + ';\n';
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord/project.config.js"), config, { mode: 0o600 });
  return config;
}

test("COORD-527 cwd-based serialized approval preserves existing config", () => {
  const root = tmpRoot(); const beforeCwd = process.cwd();
  try {
    const config = configuredWorkspace(root);
    process.chdir(root);
    const plan = JSON.parse(JSON.stringify(buildOnboardPlan()));
    writeOnboardArtifacts(plan, { approve: plan.plan_digest });
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), config);
    assert.equal(fs.existsSync(path.join(root, "coord/setup.decisions.json")), true);
  } finally { process.chdir(beforeCwd); fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 public help and human preview describe config preservation", () => {
  const root = tmpRoot(); const logged = []; const originalLog = console.log;
  try {
    configuredWorkspace(root);
    console.log = line => logged.push(line);
    assert.equal(run().code, 1);
    assert.equal(run([root, "--help"]).code, 0);
    assert.ok(logged.every(line => line.includes("Existing project.config.js is preserved")));
    const preview = run([root], { log: line => logged.push(line) });
    assert.equal(preview.code, 0);
    assert.match(logged.at(-1), /Plan digest:/);
    assert.match(renderOnboardPlan({ ...preview.report, shape: { ...preview.report.shape, signals: [] } }), /## Signals\n- none/);
    assert.equal(fs.existsSync(path.join(root, "coord/setup.decisions.json")), false);
  } finally { console.log = originalLog; fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 incomplete starter command output is refused and receipted", () => {
  const root = tmpRoot();
  try {
    configuredWorkspace(root);
    const gov = path.join(root, "coord/scripts/governance.js");
    fs.mkdirSync(path.dirname(gov), { recursive: true });
    fs.writeFileSync(gov, 'process.stdout.write("No ticket was created\\n");');
    const plan = buildOnboardPlan(root);
    assert.throws(() => fileApprovedStarterTickets(plan, { approveStarters: true }), /returned no ticket id/);
    fs.writeFileSync(gov, 'process.exitCode = 1;');
    assert.throws(() => fileApprovedStarterTickets(plan, { approveStarters: true }), /governed proposed-ticket intake failed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 receipt publication failure is surfaced without changing operator config", () => {
  const root = tmpRoot();
  try {
    const config = configuredWorkspace(root); const logs = []; let receipts = 0;
    const plan = buildOnboardPlan(root);
    const io = new Proxy(fs, { get(target, key) {
      if (key === "renameSync") return (from, to) => {
        if (to === path.join(root, "coord/onboarding.receipt.json") && ++receipts === 2) {
          throw Object.assign(new Error("receipt publication failed"), { code: "EIO" });
        }
        return fs.renameSync(from, to);
      };
      return target[key];
    } });
    const result = run([root, "--write", "--approve", plan.plan_digest, "--approve-starters"], {
      fs: io, log: line => logs.push(line), fileProposedTicket: () => "FIX-123",
    });
    assert.equal(result.code, 1);
    assert.match(logs.at(-1), /receipt publication failed/);
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), config);
    assert.equal(receipts, 2, "failure recovery keeps the unchanged original receipt without another rename");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "coord/onboarding.receipt.json"), "utf8")).proposed_tickets, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 configured onboarding preserves bytes and settings while creating missing decisions", () => {
  const root = tmpRoot();
  try {
    const config = configuredWorkspace(root);
    const plan = buildOnboardPlan(root);
    assert.equal(plan.schema_version, 3);
    assert.equal(plan.project_config_preview, null, "version 3 binds preserved bytes by digest, without disclosing raw source");
    assert.deepEqual(plan.decisions.repos.map((repo) => repo.code), ["S", "W"]);
    assert.equal(plan.setup_decisions.decisions.coord_ticket_prefix, "TEAM");
    assert.equal(plan.decisions.repos[0].integrationBranch, "release/service");
    assert.equal(plan.decisions.repos[0].testCommand, "npm run test:service");
    assert.deepEqual(plan.decisions.repos[0].ticketPrefixes, ["SERV"]);
    assert.equal(JSON.stringify(plan).includes("UNPROJECTED_CONFIG_CANARY_527"), false);
    const applied = writeOnboardArtifacts(plan, { approve: plan.plan_digest });
    assert.deepEqual(applied.written.sort(), ["coord/onboarding.receipt.json", "coord/setup.decisions.json"]);
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), config);
    assert.equal(fs.statSync(path.join(root, "coord/project.config.js")).mode & 0o777, 0o600);
    assert.equal(applied.receipt.files.find((file) => file.path === "coord/project.config.js").digest,
      require("node:crypto").createHash("sha256").update(config).digest("hex"));
    assert.equal(JSON.stringify(applied.receipt).includes("UNPROJECTED_CONFIG_CANARY_527"), false);
    assert.deepEqual(writeOnboardArtifacts(buildOnboardPlan(root), { approve: plan.plan_digest, force: true }).written, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 stale configuration approval refuses even force before any artifact changes", () => {
  const root = tmpRoot();
  try {
    const original = configuredWorkspace(root);
    const plan = buildOnboardPlan(root);
    const changed = original.replace("release/service", "release/reviewed-later");
    fs.writeFileSync(path.join(root, "coord/project.config.js"), changed);
    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest, force: true }), /config.*changed|config.*digest/i);
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), changed);
    assert.equal(fs.existsSync(path.join(root, "coord/setup.decisions.json")), false);
    assert.equal(fs.existsSync(path.join(root, "coord/onboarding.receipt.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 missing preserved config and mismatched generated preview refuse without writes", () => {
  const root = tmpRoot();
  try {
    configuredWorkspace(root);
    const plan = buildOnboardPlan(root);
    fs.unlinkSync(path.join(root, "coord/project.config.js"));
    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest, force: true }), /config is missing/);
    const fresh = buildOnboardPlan(root);
    fresh.project_config_preview += "// not in the approved digest\n";
    assert.throws(() => writeOnboardArtifacts(fresh, { approve: fresh.plan_digest }), /preview differs/);
    assert.deepEqual(fs.readdirSync(path.join(root, "coord")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 a concurrent config edit stops apply and rolls back setup without clobbering the edit", () => {
  const root = tmpRoot();
  try {
    const original = configuredWorkspace(root);
    const changed = original.replace("release/service", "release/new-owner-edit");
    const plan = buildOnboardPlan(root);
    const changingFs = new Proxy(fs, { get(target, name) {
      if (name !== "renameSync") return target[name];
      return (from, to) => {
        target.renameSync(from, to);
        if (String(to).endsWith("setup.decisions.json")) target.writeFileSync(path.join(root, "coord/project.config.js"), changed);
      };
    } });
    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest, fs: changingFs }), /config changed during apply/);
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), changed);
    assert.deepEqual(fs.readdirSync(path.join(root, "coord")), ["project.config.js"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 public onboard dispatch preserves config and fresh-generation rollback remains atomic", () => {
  const root = tmpRoot();
  try {
    const fresh = buildOnboardPlan(root);
    assert.throws(() => writeOnboardArtifacts(fresh, { approve: fresh.plan_digest,
      injectFailureAt: "coord/setup.decisions.json" }), /injected failure/);
    assert.deepEqual(fs.readdirSync(path.join(root, "coord")), []);
    const source = configuredWorkspace(root);
    const messages = [];
    const deps = { log: (message) => messages.push(message), env: {} };
    const preview = run([root, "--json"], deps);
    assert.equal(preview.code, 0);
    const applied = run([root, "--json", "--write", "--approve", preview.report.plan_digest, "--force"], deps);
    assert.equal(applied.code, 0, messages.at(-1));
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), source);
    assert.equal(messages.join("\n").includes("UNPROJECTED_CONFIG_CANARY_527"), false);
    assert.deepEqual(applied.report.receipt.decisions.repos.map((repo) => repo.code), ["S", "W"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 serialized approval binds config and existing decision collisions remain atomic", () => {
  const root = tmpRoot();
  try {
    const config = configuredWorkspace(root);
    const plan = JSON.parse(JSON.stringify(buildOnboardPlan(root)));
    const decisions = path.join(root, "coord/setup.decisions.json");
    fs.writeFileSync(decisions, "operator decisions\n");
    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest, targetRoot: root }), /refusing to overwrite coord\/setup.decisions/);
    assert.equal(fs.readFileSync(decisions, "utf8"), "operator decisions\n");
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), config);
    fs.writeFileSync(path.join(root, "coord/project.config.js"), "module.exports = getConfig();");
    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest, targetRoot: root, force: true }), /without executing/);
    assert.equal(fs.existsSync(path.join(root, "coord/onboarding.receipt.json")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-527 concurrent decision edits and failed rollback are reported without touching config", () => {
  const root = tmpRoot();
  try {
    const config = configuredWorkspace(root);
    const plan = buildOnboardPlan(root);
    const decisions = path.join(root, "coord/setup.decisions.json");
    fs.writeFileSync(decisions, "operator decisions\n");
    let reads = 0;
    const racingFs = new Proxy(fs, { get(target, name) {
      if (name !== "readFileSync") return target[name];
      return (file, ...args) => {
        if (file === decisions && ++reads === 2) target.writeFileSync(decisions, "concurrent decisions\n");
        return target.readFileSync(file, ...args);
      };
    } });
    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest, force: true, fs: racingFs }), /changed after the reviewed preflight/);
    assert.equal(fs.readFileSync(decisions, "utf8"), "concurrent decisions\n");
    let renames = 0;
    const failedRollbackFs = new Proxy(fs, { get(target, name) {
      if (name !== "renameSync") return target[name];
      return (from, to) => {
        if (to === decisions && ++renames === 2) throw new Error("rollback destination unavailable");
        return target.renameSync(from, to);
      };
    } });
    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest, force: true,
      fs: failedRollbackFs, injectFailureAt: "coord/onboarding.receipt.json" }), /rollback anomalies:.*rollback destination unavailable/);
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), config);
    assert.equal(fs.readdirSync(path.join(root, "coord")).some((name) => name.includes(".onboard-tmp-")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

test("COORD-902: onboard refuses a workspace plan when Git is below the shared minimum", () => {
  const logs = [];
  const result = run(["/tmp/coord-902-onboard"], {
    log: (line) => logs.push(String(line)),
    checkGitPrerequisite: () => ({ ok: false, diagnostic: "Git 2.38.0 or newer is required for merge-tree; found 2.34.1." }),
  });
  assert.equal(result.code, 1);
  assert.deepEqual(logs, ["Git 2.38.0 or newer is required for merge-tree; found 2.34.1."]);
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
  for (const stdout of [undefined, "", "relative/repo"]) {
    assert.throws(() => detectCoordGitState("/w", () => ({ status: 0, stdout })), /no absolute repository root/);
  }
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

// COORD-891: the workspace installer ships coord/project.config.workspace.js as
// coord/project.config.js with `repos: {}`, then runs `onboard . --write --force`.
// Onboarding refused that unmapped starter ("requires a nonempty repository
// map"), so `create-concord --from-existing` wrote an empty map and rejected it.
test("COORD-891: the installer's unmapped starter config is mapped, not refused, under the dry-run's digest", () => {
  const root = tmpRoot({ siblings: ["fleet-users-msrv", "fleet-web"] });
  try {
    // create-concord --from-existing --dry-run reviews the plan BEFORE the payload exists.
    const reviewed = buildOnboardPlan(root);
    fs.mkdirSync(path.join(root, "coord"), { recursive: true });
    const starter = fs.readFileSync(path.join(__dirname, "..", "..", "project.config.workspace.js"), "utf8");
    assert.match(starter, /^\s*repos: \{\},$/m, "fixture is the shipped empty-map starter");
    fs.writeFileSync(path.join(root, "coord/project.config.js"), starter);

    const plan = buildOnboardPlan(root);
    assert.equal(plan.plan_digest, reviewed.plan_digest, "the starter does not change the reviewed onboard plan");
    assert.deepEqual(plan.sibling_product_repositories, ["fleet-users-msrv", "fleet-web"]);
    assert.equal(typeof plan.project_config_preview, "string");

    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest }), /refusing to overwrite coord\/project\.config\.js; pass --force/);
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), starter, "refusal leaves the starter untouched");

    const applied = writeOnboardArtifacts(plan, { installPlanDigest: "a".repeat(64), expectedOnboardPlanDigest: reviewed.plan_digest, force: true });
    assert.ok(applied.written.includes("coord/project.config.js"));
    const written = fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8");
    assert.equal(written, plan.project_config_preview);
    assert.match(written, /path:\s*"fleet-users-msrv"/);
    assert.match(written, /path:\s*"fleet-web"/);

    // The written map is accepted (and preserved) by the next onboarding run.
    const rerun = buildOnboardPlan(root);
    assert.equal(rerun.project_config_preview, null);
    assert.deepEqual(rerun.sibling_product_repositories, ["fleet-users-msrv", "fleet-web"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-891: an unmapped config is never replaced by a plan that preserves a mapped one", () => {
  const root = tmpRoot();
  try {
    configuredWorkspace(root);
    const plan = buildOnboardPlan(root);
    assert.equal(plan.project_config_preview, null);
    const emptied = "module.exports = { coordTicketPrefix: \"TEAM\", repos: {} };\n";
    fs.writeFileSync(path.join(root, "coord/project.config.js"), emptied);
    assert.throws(() => writeOnboardArtifacts(plan, { approve: plan.plan_digest, force: true }), /config.*changed|config.*digest/i);
    assert.equal(fs.readFileSync(path.join(root, "coord/project.config.js"), "utf8"), emptied);
    // A fresh plan maps the siblings and keeps the declared non-repo settings.
    const fresh = buildOnboardPlan(root);
    assert.match(fresh.project_config_preview, /coordTicketPrefix: "TEAM"/);
    assert.match(fresh.project_config_preview, /path:\s*"backend"/);
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
    const plan = buildOnboardPlan(root);
    assert.equal(plan.shape.shape, "single-repo");
    assert.equal(plan.decisions.governance_tier, "lite");
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
    configuredWorkspace(root);
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
        injectFailureAt: "coord/onboarding.receipt.json",
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
    configuredWorkspace(root);
    fs.writeFileSync(decisionsPath, "operator decisions\n", { mode: 0o640 });
    const before = [configPath, decisionsPath].map((file) => ({
      bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777,
    }));
    const plan = buildOnboardPlan(root);
    const failingFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "renameSync") return target[property];
        return (from, to) => {
          if (String(to).endsWith("onboarding.receipt.json")) throw new Error("simulated rename failure");
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

// COORD-894: onboarding runs the board push preflight before any ticket work.
test("COORD-894: onboarding probes the configured board branch's rules and renders the finding beside the plan", () => {
  const { onboardBoardPushPreflight } = require("./onboard.js");
  const root = tmpRoot();
  try {
    configuredWorkspace(root);
    const configPath = path.join(root, "coord/project.config.js");
    fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace('"coordTicketPrefix"', '"boardBranch":"governance","coordTicketPrefix"'));
    execFileSync("git", ["init", "-q", "--initial-branch=main", path.join(root, "coord")]);
    execFileSync("git", ["-C", path.join(root, "coord"), "remote", "add", "origin", "git@github.com:acme/acme-coord.git"]);
    const calls = [];
    const gh = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "auth") return { status: 0, stdout: "", stderr: "" };
      if (args[1] === "repos/acme/acme-coord/rules/branches/governance") return { status: 0, stdout: JSON.stringify([{ type: "pull_request" }]), stderr: "" };
      return { status: 1, stdout: "", stderr: "Branch not protected (HTTP 404)" };
    };
    const result = onboardBoardPushPreflight(root, { gh });
    assert.equal(result.status, "blocked");
    assert.equal(result.branch, "governance", "the configured boardBranch is the probed branch");
    assert.equal(result.board_landing, "push");
    assert.ok(calls.every((call) => !call.includes("rules/branches/main")));
    const logged = [];
    const preview = run([root], { gh, log: (line) => logged.push(line) });
    assert.equal(preview.code, 0);
    assert.equal(preview.report.board_push_preflight.status, "blocked");
    assert.match(logged.at(-1), /## Board Push\n\[board-push\] direct push to acme\/acme-coord branch "governance": BLOCKED/);
    assert.match(logged.at(-1), /boardLanding: "pr"/);
    // boardLanding "pr" is read from the declaration too.
    fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8").replace('"boardBranch"', '"boardLanding":"pr","boardBranch"'));
    assert.equal(onboardBoardPushPreflight(root, { gh }).board_landing, "pr");
    // An unreadable config falls back to defaults (the plan reports the config problem).
    fs.rmSync(configPath);
    fs.mkdirSync(configPath);
    const fallback = onboardBoardPushPreflight(root, { gh });
    assert.equal(fallback.board_landing, "push");
    assert.equal(fallback.status, "unknown", "the unconfigured board branch does not exist on the fake remote, so its probe is unanswered");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-894: onboarding omits the preflight when there is no board remote and honours an injected probe", () => {
  const { onboardBoardPushPreflight } = require("./onboard.js");
  const root = tmpRoot();
  try {
    configuredWorkspace(root);
    assert.equal(onboardBoardPushPreflight(root).status, "not_applicable");
    const quiet = run([root, "--json"], { log: () => {} });
    assert.equal("board_push_preflight" in quiet.report, false);
    const injected = run([root, "--json"], { log: () => {}, boardPushPreflight: (target) => ({ status: "unknown", reason: "offline", branch: "main", repo: path.basename(target) }) });
    assert.equal(injected.report.board_push_preflight.reason, "offline");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// COORD-1015: git reports the canonical toplevel. coord/ that IS its own repository,
// reached through a symlinked workspace root, is established, not an ancestor.
test("COORD-1015 detectCoordGitState: coord/ reached through a symlinked workspace is its own repository", () => {
  const { spawnSync } = require("node:child_process");
  const { gitFixture } = require("./test-git-fixture.js");
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "onboard-1015-")));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-1015-link-"));
  try {
    const coord = path.join(real, "coord");
    fs.mkdirSync(coord);
    gitFixture(coord, ["init", "-q"]);
    gitFixture(coord, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const workspaceViaLink = path.join(linkParent, "ws");
    fs.symlinkSync(real, workspaceViaLink, "dir");
    const run = (args) => spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    const state = detectCoordGitState(workspaceViaLink, run);
    assert.equal(state.state, "established", JSON.stringify(state));
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("COORD-1052: onboarding renders integration branch findings with actionable remedies", () => {
  const root = tmpRoot();
  try {
    const plan = buildOnboardPlan(root);
    plan.repositories = [{ path: "backend", git: { integration_ref_findings: [{ code: "missing", message: "ref is missing", remedy: "fetch origin" }] } }, { path: "frontend", git: {} }];
    const output = renderOnboardPlan(plan);
    assert.match(output, /## Integration Branch Refs\n- backend: \[missing\] ref is missing\. Remedy: fetch origin/);
    plan.repositories = [];
    assert.doesNotMatch(renderOnboardPlan(plan), /## Integration Branch Refs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("COORD-1052: onboarding classifies absent Git probe results as outside", () => {
  const root = tmpRoot();
  try {
    const state = detectCoordGitState(root, () => null);
    assert.equal(state.container_is_git_repository, false);
    assert.equal(state.state, "outside");
    assert.equal(state.root, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
