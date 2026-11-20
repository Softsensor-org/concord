"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runFixtureApproval } = require("../engine/scripts/__fixtures__/approval-fixture.js");
const { spawnSync } = require("node:child_process");
const { fixedLayoutEnv } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/session-lifecycle-test-utils.js"));

// COORD-820 (second half of COORD-717): reproduce the advertised-versus-executed
// finding-severity contract through the real `coord/scripts/gov` executable, in
// a disposable workspace, on whatever Node runs this suite (CI runs it on the
// Node 22 and Node 24 lanes). Every value `gov` help advertises must be
// accepted by the executable; every refused value must be absent from that set
// and must leave board, PLAN.md, journal, plan records and locks byte-identical.
//
// Bootstrap: a disposable workspace has coordination state but no journal, so
// the governed `reconcile` verb anchors its baseline with an explicit override
// (the same supported path sync-board-publication.test.js uses). Nothing here
// writes the journal or the snapshot by hand.

const REJECTED = ["high", "Med", "MEDIUM", "CRITICAL", "BLOCKING", "HIGH "];
const TICKET = "TEST-820";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord820-gov-exec-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  fs.mkdirSync(coord);
  require("./fixtures/coord-engine-schemas.js").installCanonicalEngine(coord, path.resolve(__dirname, ".."));
  const source = path.resolve(__dirname, "..");
  for (const name of ["scripts", "engine", "board", "paths.js", "GOVERNANCE.md", "AGENTS.md", "product", "schemas", "docs", "agents.json", "gates", "TEMPLATE_SYNC_MANIFEST.json", "engine-pin.json"]) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(coord, name), { recursive: true });
  }
  const write = (name, text) => {
    const file = path.join(coord, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write("project.config.js", 'module.exports={repos:{B:{path:"backend",integrationBranch:"dev"}}};\n');
  fs.mkdirSync(path.join(root, "backend"));
  write("board/tasks.json", JSON.stringify({ version: 1,
    metadata: { title: "Severity fixture", last_updated: new Date().toISOString(), canonical_references: [], preamble: [] },
    sections: [{ kind: "table", level: 2, heading: "Tickets", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"], rows: [] }],
    prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {} }));
  write("QUESTIONS.md", "# Questions\n");
  write("PLAN.md", "");
  write(".gitignore", ".runtime/*\n!.runtime/governance-events.ndjson\n!.runtime/plans/\n.worktrees/\n");
  const git = (...args) => {
    const r = spawnSync("git", ["-C", coord, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("add", ".");
  git("commit", "-m", "Seed disposable severity fixture");
  // The executable resolves `node` from PATH: pin it to the Node running this test.
  const pathWithNode = (env) => ({ ...env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || ""}` });
  const as = (thread) => {
    const env = pathWithNode(fixedLayoutEnv(`c820-${thread}-${path.basename(root)}`));
    return (...args) => {
      const options = { cwd: root, env, encoding: "utf8", timeout: 60000 };
      const runExecutable = () => spawnSync("bash", [path.join(coord, "scripts/gov"), ...args], options);
      if (!args.includes("--human-admin-override")) return runExecutable();
      const ticket = args[0] === "reconcile" ? "control-plane" : args[1];
      return runFixtureApproval(args[0], ticket, runExecutable, (approval) => approval.runCli(coord, args, options));
    };
  };
  const ok = (run, ...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(" ")}\n${r.stdout}\n${r.stderr}\n${r.error || ""}`);
    return r;
  };
  const owner = as("owner");
  const reviewer = as("reviewer");
  // COORD-722: the override binds to the exact packet `reconcile --dry-run`
  // prints, so the fixture approves that packet rather than hand-writing one.
  const reason = "initialize disposable severity fixture";
  const dryRun = JSON.parse(ok(owner, "reconcile", "--dry-run", "--reason", reason).stdout);
  const packetPath = path.join(root, "reconcile-packet.txt");
  fs.writeFileSync(packetPath, `${dryRun.expect_paths_packet.join("\n")}\n`);
  ok(owner, "reconcile", "--reason", reason, "--human-admin-override", "fixture administrator approves isolated baseline", "--expect-paths-file", packetPath);
  ok(owner, "agentid", "--assign");
  ok(owner, "file-ticket", TICKET, "--repo", "X", "--type", "bug", "--pri", "P2", "--description", "Severity contract fixture", "--with-prompt");
  // COORD-813: start refuses the --with-prompt scaffold; author the prompt body
  // through the governed verb, as an operator would.
  const promptBody = path.join(root, `${TICKET}-prompt-body.md`);
  fs.writeFileSync(promptBody, `# ${TICKET}: severity fixture\n\n## Acceptance Criteria\n\n- The ${TICKET} severity fixture reaches its governed start.\n`);
  ok(owner, "register-prompt", TICKET, "--body-file", promptBody);
  // A todo ticket may not carry findings (they read as closeout evidence).
  ok(owner, "start", TICKET);
  ok(reviewer, "agentid", "--assign");
  const board = () => JSON.parse(fs.readFileSync(path.join(coord, "board/tasks.json"), "utf8"));
  const journal = () => fs.readFileSync(path.join(coord, ".runtime/governance-events.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  return { coord, owner, reviewer, ok, board, journal };
}

// Board, PLAN.md, journal, plan records, locks, rendered views and questions:
// everything a refused governed mutation must leave untouched.
function governedState(coord) {
  const out = {};
  const visit = (rel) => {
    const full = path.join(coord, rel);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) {
      for (const entry of fs.readdirSync(full)) visit(path.join(rel, entry));
      return;
    }
    out[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  };
  for (const rel of ["board/tasks.json", "PLAN.md", "QUESTIONS.md", "rendered", ".runtime/governance-events.ndjson", ".runtime/plans", ".runtime/locks"]) {
    visit(rel);
  }
  return out;
}

function advertisedSeverities(help) {
  const tokens = [...new Set(help.match(/--severity <[^>]*>/g) || [])];
  assert.equal(tokens.length, 1, `gov help must advertise exactly one severity set; got ${tokens.join(", ")}`);
  return tokens[0].slice("--severity <".length, -1).split("|");
}

// COORD-829: the title is a release test identity and must not vary by runtime;
// the Node version is reported as a diagnostic instead.
test("COORD-820: the gov executable accepts exactly the severities its help advertises", { timeout: 240000 }, (t) => {
  t.diagnostic(`node ${process.version}`);
  const f = fixture(t);
  const help = f.ok(f.owner, "help", "--all").stdout;
  const advertised = advertisedSeverities(help);
  assert.deepEqual(advertised, ["HIGH", "MED", "LOW"]);

  for (const severity of advertised) {
    f.ok(f.owner, "add-finding", TICKET, "--severity", severity, "--summary", `advertised ${severity}`, "--qref", "L1");
  }
  assert.deepEqual(f.board().review_findings[TICKET].map((finding) => finding.severity), advertised);

  for (const value of REJECTED) {
    const before = governedState(f.coord);
    const r = f.owner("add-finding", TICKET, "--severity", value, "--summary", "refused", "--qref", "L1");
    assert.notEqual(r.status, 0, `--severity ${JSON.stringify(value)} must be refused`);
    assert.ok(!advertised.includes(value), "a refused value must be absent from the advertised set");
    assert.ok(`${r.stdout}${r.stderr}`.includes(`must be one of: ${advertised.join(" | ")} (got ${JSON.stringify(value)})`),
      `the refusal must name the advertised set and the received value; got: ${r.stderr}`);
    assert.deepEqual(governedState(f.coord), before, `a refused --severity ${JSON.stringify(value)} must not write governed state`);
  }
});

// COORD-829: the title is a release test identity and must not vary by runtime;
// the Node version is reported as a diagnostic instead.
test("COORD-820: the gov executable corrects a recorded severity under the approval policy", { timeout: 240000 }, (t) => {
  t.diagnostic(`node ${process.version}`);
  const f = fixture(t);
  f.ok(f.owner, "add-finding", TICKET, "--severity", "LOW", "--summary", "understated", "--qref", "L1");
  const id = `${TICKET}-F1`;
  const correct = (run, severity, ...extra) =>
    run("correct-finding-severity", TICKET, "--id", id, "--severity", severity, "--reason", "re-triaged", ...extra);

  // Human-admin policy: "the owner or a reviewer may raise a severity, lowering
  // requires approval by a different identity, prior values stay in history."
  const unauthorised = governedState(f.coord);
  const refusedRaise = correct(f.reviewer, "HIGH");
  assert.notEqual(refusedRaise.status, 0, "a raise by a session with no recorded finding on the ticket must be refused");
  assert.match(refusedRaise.stderr, /Only the ticket owner \(.+\) or a recorded reviewer of the ticket may raise/);
  assert.deepEqual(governedState(f.coord), unauthorised, "a refused raise must not write governed state");
  assert.equal(correct(f.owner, "HIGH").status, 0, "the ticket owner may raise");
  for (const run of [f.owner, f.reviewer]) {
    const before = governedState(f.coord);
    const refused = correct(run, "MED");
    assert.notEqual(refused.status, 0, "lowering without a second identity must be refused");
    assert.match(refused.stderr, /requires approval by an identity other than the requester/);
    assert.deepEqual(governedState(f.coord), before, "a refused lowering must not write governed state");
  }
  const lowered = correct(f.reviewer, "MED", "--human-admin-override", "admin re-triaged to MED");
  assert.equal(lowered.status, 0, `a second party may approve a lowering: ${lowered.stderr}`);

  const finding = f.board().review_findings[TICKET][0];
  assert.equal(finding.severity, "MED");
  assert.deepEqual(finding.severity_history.map((entry) => [entry.from, entry.to, entry.direction, entry.approval && entry.approval.approver]), [
    ["LOW", "HIGH", "raise", null],
    ["HIGH", "MED", "lower", "human-admin"],
  ]);
  const actors = finding.severity_history.map((entry) => entry.actor);
  assert.notEqual(actors[0], actors[1], "the history attributes each correction to the session that made it");
  const audit = f.journal().find((event) => event.command === "correct-finding-severity" && event.event === "approval.verified");
  assert.ok(audit);
  assert.equal(finding.severity_history[1].approval.record_id, audit.approval_record);
  assert.equal(finding.severity_history[1].approval.session_id, audit.human_admin_session);
  assert.equal(finding.severity_history[1].approval.subject_sha256, audit.subject_sha256);
  const events = f.journal().filter((event) => event.command === "correct-finding-severity" && event.result === "succeeded");
  assert.deepEqual(events.map((event) => [event.result, event.identity.owner]), actors.map((actor) => ["succeeded", actor]));
  assert.equal(finding.original_severity, "LOW", "the original value stays recorded");
  assert.equal(finding.added_by, actors[0], "add-finding records the bound session as the author");

  // Filing a finding makes the reviewer a recorded reviewer, who may then raise.
  f.ok(f.reviewer, "add-finding", TICKET, "--severity", "LOW", "--summary", "reviewer finding", "--qref", "L2");
  f.ok(f.reviewer, "correct-finding-severity", TICKET, "--id", `${TICKET}-F2`, "--severity", "MED", "--reason", "re-triaged");
  const reviewed = f.board().review_findings[TICKET][1];
  assert.deepEqual([reviewed.added_by, reviewed.original_severity, reviewed.severity], [actors[1], "LOW", "MED"]);
  assert.deepEqual(reviewed.severity_history.map((entry) => [entry.actor, entry.direction, entry.approval]), [[actors[1], "raise", null]]);

  // update-finding never changes a severity; it names the governed verb.
  const beforeUpdate = governedState(f.coord);
  const update = f.owner("update-finding", TICKET, "--id", id, "--status", "open", "--severity", "HIGH");
  assert.notEqual(update.status, 0, "update-finding --severity must be refused, not silently ignored");
  assert.match(update.stderr, /does not accept --severity\. Correct a recorded severity with `coord\/scripts\/gov correct-finding-severity/);
  assert.deepEqual(governedState(f.coord), beforeUpdate, "a refused update-finding must not write governed state");
});
