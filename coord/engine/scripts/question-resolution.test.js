"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { runFixtureReconcile } = require("./__fixtures__/approval-fixture.js");
const createQuestionResolution = require("./question-resolution.js");
const { withApprovedPacket } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/approved-reconcile.js"));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord695-cli-"));
  const coord = path.join(root, "coord");
  fs.mkdirSync(coord);
  require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/coord-engine-schemas.js")).installCanonicalEngine(coord, path.resolve(__dirname, "..", ".."));
  const source = path.resolve(__dirname, "..", "..");
  for (const name of ["scripts", "engine", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "schemas", "docs"]) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(coord, name), { recursive: true });
  }
  const write = (name, value) => {
    const target = path.join(coord, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  };
  const config = process.env.COORD_PROJECT_CONFIG ? require(path.resolve(process.env.COORD_PROJECT_CONFIG)) : require(path.join(source, "project.config.js"));
  write("project.config.js", `module.exports=${JSON.stringify(config)};\n`);
  const ticket = { ID: "TEST-695", Repo: "X", Type: "task", Pri: "P2", Status: "todo", Owner: "unassigned", Description: "Implementation remains open", "Depends On": "" };
  write("board/tasks.json", { version: 1, metadata: { title: "Question resolution fixture", last_updated: new Date().toISOString(), canonical_references: [], preamble: [] }, sections: [{ kind: "table", level: 2, heading: "Work", separator_before: false, columns: Object.keys(ticket), rows: [ticket] }], prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {} });
  write("QUESTIONS.md", "# Questions\n\n| Date | From | To | Question | Answer | Resolved |\n|------|------|----|----------|--------|----------|\n\n## Instructions\n\nRetain evidence.\n");
  write("PLAN.md", "");
  const renderFixtureViews = () => require(path.join(coord, "board/board.js")).renderBoardArtifacts();
  write(".runtime/agents.json", [{ id: "a01", handle: "codexa01", provider: "openai", status: "active", aliases: [] }]);
  write(".runtime/agent_sessions.json", []);
  write(".gitignore", ".runtime/*\n!.runtime/governance-events.ndjson\n!.runtime/plans/\n");
  renderFixtureViews();
  const env = { ...process.env, COORD_PROJECT_CONFIG: path.join(coord, "project.config.js"), CODEX_THREAD_ID: `question-${path.basename(root)}` };
  for (const key of ["NODE_TEST_CONTEXT", "NODE_CHANNEL_FD", "COORD_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "AGENT_THREAD_ID", "COORD_AGENT_ID", "COORD_AGENT_HANDLE", "COORD_OWNER"]) delete env[key];
  const git = (...args) => {
    const r = spawnSync("git", ["-C", coord, ...args], { env, encoding: "utf8" });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Question fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "maintenance.autoDetach", "false");
  git("config", "gc.autoDetach", "false");
  git("add", ".");
  git("commit", "-m", "Seed synthetic question fixture");
  const cli = (...args) => spawnSync(process.execPath, [path.join(coord, "scripts/governance.js"), ...args], { cwd: root, env, encoding: "utf8", timeout: 45000 });
  const ok = (...given) => {
    const applyingReconcile = given[0] === "reconcile" && given.includes("--human-admin-override");
    const args = applyingReconcile ? withApprovedPacket(given, (dryArgs) => ok(...dryArgs)) : given;
    const result = applyingReconcile
      ? runFixtureReconcile(() => cli(...args), (approval) =>
        approval.runCli(coord, args, { cwd: root, env, encoding: "utf8", timeout: 45000 }))
      : cli(...args);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  ok("reconcile", "--reason", "Initialize synthetic question test state", "--human-admin-override", "Fixture administrator approves this isolated synthetic baseline");
  ok("agentid", "--owner", "codexa01");
  const raw = () => fs.readFileSync(path.join(coord, "QUESTIONS.md"), "utf8");
  const journal = () => fs.readFileSync(path.join(coord, ".runtime/governance-events.ndjson"), "utf8");
  const events = () => journal().trim().split("\n").filter(Boolean).map(JSON.parse);
  const digest = line => crypto.createHash("sha256").update(line).digest("hex");
  return { root, coord, env, write, git, cli, ok, raw, journal, events, digest, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("COORD-695: real CLI resolves the selected original row and retains an unrelated unanswered row", () => {
  const f = fixture();
  try {
    f.ok("log-question", "--from", "original-author", "--to", "orchestrator", "--question", "Selected decision", "--answer", "Original evidence for TEST-695 stays", "--resolved", "no");
    f.ok("log-question", "--from", "another-author", "--to", "orchestrator", "--question", "Unrelated decision", "--resolved", "no");
    const original = f.raw().split("\n").find(line => line.includes("| Selected decision |"));
    const unrelated = f.raw().split("\n").find(line => line.includes("| Unrelated decision |"));
    const digest = f.digest(original);
    const board = fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8");
    const before = f.raw(), journal = JSON.stringify(f.events());
    const preview = JSON.parse(f.ok("resolve-question", "--dry-run").stdout);
    assert.ok(preview.questions.some(q => q.row_digest === digest));
    assert.equal(f.raw(), before);
    assert.equal(JSON.stringify(f.events()), journal);
    f.ok("resolve-question", "--expected-row-digest", digest, "--evidence", "Routing decision agreed; implementation remains open.");
    assert.ok(f.raw().split("\n").includes(original.replace(/\| no \|$/, "| yes |")));
    assert.ok(f.raw().split("\n").includes(unrelated));
    assert.equal(f.raw().split("\n").filter(line => /^\|/.test(line) && line.includes("| Selected decision |")).length, 1);
    const resolutions = f.events().filter(event => event.command === "resolve-question" && event.result === "succeeded");
    assert.equal(resolutions.length, 1);
    const record = resolutions[0].details.question_resolution;
    assert.equal(record.original_row, original);
    assert.equal(record.original_digest, digest);
    assert.equal(record.actor, "codexa01");
    assert.equal(resolutions[0].identity.owner, "codexa01");
    assert.equal(record.evidence, "Routing decision agreed; implementation remains open.");
    assert.ok(Number.isFinite(Date.parse(record.resolved_at)));
    assert.ok(f.raw().includes(JSON.stringify(record, null, 2)));
    const remaining = JSON.parse(f.ok("resolve-question", "--dry-run").stdout).questions.filter(q => q.resolved === "no");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].question, "Unrelated decision");
    assert.equal(fs.readFileSync(path.join(f.coord, "board/tasks.json"), "utf8"), board);
  } finally { f.cleanup(); }
});

function addQuestion(f, question = "Selected decision") {
  f.ok("log-question", "--from", "original-author", "--to", "orchestrator", "--question", question, "--resolved", "no");
  const line = f.raw().split("\n").find(row => row.includes(`| ${question} |`));
  return { line, digest: f.digest(line) };
}

function refusesUnchanged(f, args, message) {
  const before = [f.raw(), f.journal()];
  const result = f.cli("resolve-question", ...args);
  if (result.error) throw result.error;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, message);
  assert.deepEqual([f.raw(), f.journal()], before);
}

function directResolver({ raw, events = [], verify = { ok: true }, provenance = { uninitialized: false, drift: [], snapshotPruned: false }, identity = { agent: { handle: "codexa01" } }, beforeMutation } = {}) {
  const original = "| 2026-11-17 | author | orchestrator | Direct canonical test | Evidence pending | no |";
  let text = raw === undefined ? `# Questions\n${original}\n` : raw;
  let writes = 0;
  const rowDigest = value => crypto.createHash("sha256").update(value).digest("hex");
  const splitQuestionCells = line => {
    const cells = [];
    let cursor = 0;
    for (const part of line.split("|")) {
      const start = line.indexOf(part, cursor);
      cells.push({ raw: part, start });
      cursor = start + part.length + 1;
    }
    return cells.slice(1, -1);
  };
  const parseQuestionRow = line => {
    const cells = splitQuestionCells(line).map(cell => cell.raw.trim());
    if (cells.length !== 6 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0])) return null;
    return { date: cells[0], from: cells[1], to: cells[2], question: cells[3], answer: cells[4], resolved: cells[5] };
  };
  const resolver = createQuestionResolution({
    state: { QUESTIONS_PATH: "QUESTIONS.md" },
    fail(message) { throw new Error(message); },
    readCanonicalTextFile() { return text; },
    writeCanonicalTextFile(_file, value, options) {
      if (options?.expectedRaw !== undefined && options.expectedRaw !== text) throw new Error("fixture optimistic write mismatch");
      writes += 1;
      text = value;
    },
    parseQuestionRow,
    splitQuestionCells,
    withGovernanceMutation(metadata, mutate) {
      beforeMutation?.({ metadata, get text() { return text; }, set text(value) { text = value; }, events });
      const result = mutate();
      if (metadata.details?.question_resolution) {
        events.push({ command: "resolve-question", result: "succeeded", details: metadata.details });
      }
      return result;
    },
    readGovernanceEventLog() { return events; },
    verifyGovernanceChain() { return verify; },
    detectGovernanceProvenanceDrift() { return provenance; },
    ensureCurrentAgentIdentity() { return identity; },
  });
  function call(options) {
    const stdoutWrite = process.stdout.write;
    let output = "";
    process.stdout.write = chunk => { output += String(chunk); return true; };
    try { return { result: resolver.resolveQuestion(options), output }; }
    finally { process.stdout.write = stdoutWrite; }
  }
  return {
    original,
    rowDigest: value => rowDigest(value || original),
    resolver,
    call,
    get text() { return text; },
    set text(value) { text = value; },
    events,
    get writes() { return writes; },
  };
}

function resolutionHistory(record) {
  return `\n## Question resolution ${record.original_digest}\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}

test("COORD-695: missing, ambiguous, malformed and stale selectors refuse before writes", () => {
  const f = fixture();
  try {
    const selected = addQuestion(f);
    refusesUnchanged(f, ["--evidence", "A disposition"], /requires --expected-row-digest/);
    refusesUnchanged(f, ["--expected-row-digest", "bad", "--evidence", "A disposition"], /complete lowercase SHA256/);
    refusesUnchanged(f, ["--expected-row-digest", "0".repeat(64), "--evidence", "A disposition"], /missing or stale/);
    refusesUnchanged(f, ["--expected-row-digest", selected.digest, "--evidence", "   "], /nonempty --evidence/);
    refusesUnchanged(f, ["--expected-row-digest", selected.digest, "--evidence", "first", "--evidence", "second"], /exactly one nonempty --evidence/);
    // Authorized synthetic baseline changes isolate selector validation from
    // the independently retained provenance-refusal contract.
    const original = f.raw();
    f.write("QUESTIONS.md", original.replace(selected.line, selected.line + "\n" + selected.line));
    f.ok("reconcile", "--reason", "Seed duplicate-row fixture", "--human-admin-override", "Fixture administrator approves duplicate-row test state");
    refusesUnchanged(f, ["--expected-row-digest", selected.digest, "--evidence", "A disposition"], /ambiguous/);
    f.write("QUESTIONS.md", original.replace("Selected decision", "Edited decision"));
    f.ok("reconcile", "--reason", "Seed changed-row fixture", "--human-admin-override", "Fixture administrator approves changed-row test state");
    refusesUnchanged(f, ["--expected-row-digest", selected.digest, "--evidence", "A disposition"], /missing or stale/);
    const malformed = selected.line + " extra |";
    f.write("QUESTIONS.md", original.replace(selected.line, malformed));
    f.ok("reconcile", "--reason", "Seed malformed-row fixture", "--human-admin-override", "Fixture administrator approves malformed-row test state");
    refusesUnchanged(f, ["--expected-row-digest", f.digest(malformed), "--evidence", "A disposition"], /valid six-column unresolved/);
  } finally { f.cleanup(); }
});

test("COORD-695: identical replay is read-only and conflicting or tampered replay refuses", () => {
  const f = fixture();
  try {
    const selected = addQuestion(f);
    const evidence = "Decision with | and ```\nA second evidence line.";
    const args = ["--expected-row-digest", selected.digest, "--evidence", evidence];
    f.ok("resolve-question", ...args);
    addQuestion(f, "Later unrelated question");
    const before = [f.raw(), f.journal()];
    assert.equal(JSON.parse(f.ok("resolve-question", ...args).stdout).status, "already_resolved");
    assert.deepEqual([f.raw(), f.journal()], before);
    refusesUnchanged(f, ["--expected-row-digest", selected.digest, "--evidence", "A conflicting disposition"], /Conflicting.*replay/);
    const record = f.events().find(event => event.command === "resolve-question").details.question_resolution;
    f.write("QUESTIONS.md", f.raw().replace(JSON.stringify(record, null, 2), JSON.stringify({ ...record, actor: "invented-actor" }, null, 2)));
    refusesUnchanged(f, args, /history does not match/);
  } finally { f.cleanup(); }
});

test("COORD-695: actual post-write failure rolls back row, history and journal", () => {
  const f = fixture();
  try {
    const selected = addQuestion(f);
    const before = [f.raw(), f.journal()];
    const hook = path.join(f.root, "fail-after-question-write.cjs");
    fs.writeFileSync(hook, `const fs=require('node:fs'),path=require('node:path');const native=fs.renameSync,target=${JSON.stringify(path.join(f.coord, "QUESTIONS.md"))};let fired=false;fs.renameSync=function(from,to,...rest){const result=native.call(this,from,to,...rest);if(!fired&&path.resolve(String(to))===target&&fs.readFileSync(target,'utf8').includes('concord.question-resolution/v1')){fired=true;throw Error('COORD695_AFTER_ROW_WRITE');}return result;};\n`);
    const oldOptions = f.env.NODE_OPTIONS;
    f.env.NODE_OPTIONS = `${oldOptions || ""} --require=${hook}`.trim();
    const failed = f.cli("resolve-question", "--expected-row-digest", selected.digest, "--evidence", "Rollback proof");
    if (oldOptions === undefined) delete f.env.NODE_OPTIONS; else f.env.NODE_OPTIONS = oldOptions;
    if (failed.error) throw failed.error;
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /COORD695_AFTER_ROW_WRITE/);
    assert.deepEqual([f.raw(), f.journal()], before);
    f.ok("resolve-question", "--expected-row-digest", selected.digest, "--evidence", "Rollback proof");
    assert.equal(f.events().filter(event => event.command === "resolve-question").length, 1);
  } finally { f.cleanup(); }
});

test("COORD-695: one ordinary CLI sync commits question and journal and the next sync is clean", () => {
  const f = fixture();
  try {
    f.ok("sync", "--commit", "fixture baseline");
    const selected = addQuestion(f);
    f.ok("resolve-question", "--expected-row-digest", selected.digest, "--evidence", "Ready to record");
    const before = f.git("rev-parse", "HEAD");
    f.ok("sync", "--commit", "record question disposition");
    const head = f.git("rev-parse", "HEAD");
    assert.notEqual(head, before);
    const committed = f.git("show", "--format=", "--name-only", "HEAD").split("\n");
    assert.ok(committed.includes("QUESTIONS.md"));
    assert.ok(committed.includes(".runtime/governance-events.ndjson"));
    assert.equal(f.git("status", "--porcelain", "--", "QUESTIONS.md", ".runtime/governance-events.ndjson"), "");
    const journal = f.journal();
    f.ok("sync", "--commit", "must remain clean");
    assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.equal(f.journal(), journal);
    const check = JSON.parse(f.ok("reconcile", "--dry-run", "--reason", "Verify ordinary sync convergence").stdout);
    assert.equal(check.status, "noop");
    assert.deepEqual(check.drift, []);
  } finally { f.cleanup(); }
});

test("COORD-695: no bound actor means no row resolution or journal change", () => {
  const f = fixture();
  try {
    const selected = addQuestion(f);
    delete f.env.CODEX_THREAD_ID;
    refusesUnchanged(f, ["--expected-row-digest", selected.digest, "--evidence", "Must have a real actor"], /No active claimed agent session/);
  } finally { f.cleanup(); }
});

test("COORD-1052: canonical question resolver records the selected row and refuses replay drift", () => {
  const original = "| 2026-11-17 | author | orchestrator | Direct canonical test | Evidence pending | no |";
  const rowDigest = crypto.createHash("sha256").update(original).digest("hex");
  let raw = `# Questions\n${original}\n`;
  const events = [];
  const metadataSeen = [];
  const splitQuestionCells = (line) => {
    const cells = [];
    let cursor = 0;
    for (const part of line.split("|")) {
      const start = line.indexOf(part, cursor);
      cells.push({ raw: part, start });
      cursor = start + part.length + 1;
    }
    return cells.slice(1, -1);
  };
  const parseQuestionRow = (line) => {
    const cells = splitQuestionCells(line).map((cell) => cell.raw.trim());
    if (cells.length !== 6 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0])) return null;
    return { date: cells[0], from: cells[1], to: cells[2], question: cells[3], answer: cells[4], resolved: cells[5] };
  };
  const resolver = createQuestionResolution({
    state: { QUESTIONS_PATH: "QUESTIONS.md" },
    fail(message) { throw new Error(message); },
    readCanonicalTextFile() { return raw; },
    writeCanonicalTextFile(_file, value) { raw = value; },
    parseQuestionRow,
    splitQuestionCells,
    withGovernanceMutation(metadata, mutate) { metadataSeen.push(metadata); return mutate(); },
    readGovernanceEventLog() { return events; },
    verifyGovernanceChain() { return { ok: true }; },
    detectGovernanceProvenanceDrift() { return { uninitialized: false, drift: [], snapshotPruned: false }; },
    ensureCurrentAgentIdentity() { return { agent: { handle: "codexa01" } }; },
  });

  const stdoutWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    const result = resolver.resolveQuestion({ expectedRowDigest: rowDigest, evidence: ["Accepted by fixture"] });
    assert.equal(result.status, "resolved");
    assert.match(raw, /Direct canonical test \| Evidence pending \| yes \|/);
    assert.match(raw, /concord\.question-resolution\/v1/);
    assert.equal(metadataSeen[0].command, "resolve-question");
    assert.equal(metadataSeen[0].identity.agent.handle, "codexa01");
    assert.equal(metadataSeen[0].details.question_resolution.original_row, original);
    assert.match(output, /"status": "resolved"/);
  } finally {
    process.stdout.write = stdoutWrite;
  }

  const tampered = JSON.parse(JSON.stringify(metadataSeen[0].details.question_resolution));
  events.push({ command: "resolve-question", result: "succeeded", details: { question_resolution: { ...tampered, actor: "invented-actor" } } });
  assert.throws(() => resolver.resolveQuestion({ expectedRowDigest: rowDigest, evidence: ["Accepted by fixture"] }), /history does not match/);
});

test("COORD-1052: canonical resolver inventories CRLF rows and refuses invalid selectors and journals without writes", () => {
  const row = "| 2026-11-17 | author | orchestrator | CRLF decision | Evidence pending | no |";
  const digest = crypto.createHash("sha256").update(row).digest("hex");
  const f = directResolver({ raw: `# Questions\r\n${row}\r\n` });
  const before = f.text;
  const inventory = f.call({ dryRun: true, expectedRowDigest: digest }).result;
  assert.equal(inventory.status, "dry_run");
  assert.deepEqual(inventory.questions, [{ row_digest: digest, date: "2026-11-17", from: "author", to: "orchestrator", question: "CRLF decision", answer: "Evidence pending", resolved: "no", valid_cells: true }]);
  assert.equal(f.text, before);
  assert.equal(f.writes, 0);

  assert.throws(() => f.call({ unexpected: true }), /does not accept option unexpected/);
  assert.throws(() => f.call({ expectedRowDigest: "A".repeat(64), evidence: ["proof"] }), /complete lowercase SHA256/);
  assert.throws(() => f.call({ expectedRowDigest: digest, evidence: ["", "second"] }), /exactly one nonempty --evidence/);
  assert.equal(f.text, before);
  assert.equal(f.writes, 0);

  const badJournal = directResolver({ events: [{ command: "resolve-question", result: "succeeded" }], verify: { ok: false } });
  assert.throws(() => badJournal.call({ expectedRowDigest: badJournal.rowDigest(), evidence: ["proof"] }), /invalid governance journal chain/);
  assert.equal(badJournal.writes, 0);

  const stale = directResolver();
  assert.throws(() => stale.call({ expectedRowDigest: "0".repeat(64), evidence: ["proof"] }), /row digest is missing or stale/);
  assert.equal(stale.writes, 0);

  const duplicate = directResolver({ raw: `# Questions\n${directResolver().original}\n${directResolver().original}\n` });
  assert.throws(() => duplicate.call({ expectedRowDigest: duplicate.rowDigest(), evidence: ["proof"] }), /ambiguous/);
  assert.equal(duplicate.writes, 0);

  const resolvedRow = f.original.replace("| no |", "| yes |");
  const alreadyResolved = directResolver({ raw: `# Questions\n${resolvedRow}\n` });
  assert.throws(() => alreadyResolved.call({ expectedRowDigest: alreadyResolved.rowDigest(resolvedRow), evidence: ["proof"] }), /valid six-column unresolved/);
  assert.equal(alreadyResolved.writes, 0);
});

test("COORD-1052: canonical resolver confirms idempotent replay and refuses conflicts, provenance drift, and lost identity", () => {
  const f = directResolver();
  const args = { expectedRowDigest: f.rowDigest(), evidence: ["Accepted by fixture"] };
  f.text = f.text.trimEnd();
  assert.equal(f.call(args).result.status, "resolved");
  assert.equal(f.writes, 1);
  assert.match(f.text, /\| yes \|\n\n## Question resolution/);
  assert.equal(f.call(args).result.status, "already_resolved");
  assert.equal(f.writes, 1);
  assert.throws(() => f.call({ ...args, evidence: ["changed disposition"] }), /Conflicting.*replay/);

  f.events.push(f.events[0]);
  assert.throws(() => f.call(args), /resolution history is ambiguous/);
  assert.equal(f.writes, 1);

  const drift = directResolver({ provenance: { uninitialized: false, drift: ["QUESTIONS.md"], snapshotPruned: false } });
  const driftArgs = { expectedRowDigest: drift.rowDigest(), evidence: ["Accepted by fixture"] };
  drift.call(driftArgs);
  assert.throws(() => drift.call(driftArgs), /provenance is unverified or has drift/);
  assert.equal(drift.writes, 1);

  const checkpoint = { uninitialized: false, drift: [], snapshotPruned: true, snapshotMatchesCurrent: false };
  const pruned = directResolver({ provenance: checkpoint });
  const prunedArgs = { expectedRowDigest: pruned.rowDigest(), evidence: ["Accepted by fixture"] };
  pruned.call(prunedArgs);
  assert.throws(() => pruned.call(prunedArgs), /provenance is unverified or has drift/);
  checkpoint.snapshotMatchesCurrent = true;
  assert.equal(pruned.call(prunedArgs).result.status, "already_resolved");
  assert.equal(pruned.writes, 1);

  const identityMissing = directResolver({ identity: null });
  const identityBefore = identityMissing.text;
  assert.throws(() => identityMissing.call({ expectedRowDigest: identityMissing.rowDigest(), evidence: ["proof"] }), /requires a bound agent identity/);
  assert.equal(identityMissing.text, identityBefore);
  assert.equal(identityMissing.writes, 0);

  const raced = directResolver({ beforeMutation(state) {
    const original = "| 2026-11-17 | author | orchestrator | Direct canonical test | Evidence pending | no |";
    const resolved = original.replace("| no |", "| yes |");
    const record = { schema: "concord.question-resolution/v1", original_digest: crypto.createHash("sha256").update(original).digest("hex"), resolved_digest: crypto.createHash("sha256").update(resolved).digest("hex"), original_row: original, resolved_row: resolved, actor: "other-agent", resolved_at: "2026-11-17T00:00:00.000Z", evidence: "Accepted by fixture" };
    state.text = state.text.replace(original, resolved) + resolutionHistory(record);
    state.events.push({ command: "resolve-question", result: "succeeded", details: { question_resolution: record } });
  } });
  const raceResult = raced.call({ expectedRowDigest: raced.rowDigest(), evidence: ["Accepted by fixture"] }).result;
  assert.equal(raceResult.status, "already_resolved");
  assert.equal(raced.writes, 0, "a competing resolution observed under the mutation lock is not written twice");
  assert.equal(raced.events.length, 1);
});
