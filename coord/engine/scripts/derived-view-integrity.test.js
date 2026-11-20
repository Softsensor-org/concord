"use strict";

const { invokeFixtureReconcile } = require("./__fixtures__/approval-fixture.js");
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { resolveEngineModule } = require("../../paths.js");
const coord = path.resolve(__dirname, "../..");
const authority = require(resolveEngineModule(coord, "scripts/canonical-derived-authority.js"));

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord678-view-"));
  const paths = { PLAN_PATH: path.join(root, "PLAN.md"), PLAN_RECORDS_DIR: path.join(root, ".runtime/plans"), LEGACY_PLAN_RECORDS_DIR: path.join(root, "board/plans"), RENDERED_DIR: path.join(root, "rendered"), RUNTIME_DIR: path.join(root, ".runtime") };
  fs.mkdirSync(paths.PLAN_RECORDS_DIR, { recursive: true });
  fs.mkdirSync(paths.RENDERED_DIR, { recursive: true });
  fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "| ID | Status |\n| --- | --- |\n| VIEW-1 | doing |\n| VIEW-2 | review |\n");
  const board = { sections: [{ rows: [{ ID: "VIEW-1", Status: "doing" }, { ID: "VIEW-2", Status: "review" }] }], prompt_index: {} };
  for (const id of ["VIEW-1", "VIEW-2"]) fs.writeFileSync(path.join(paths.PLAN_RECORDS_DIR, `${id}.json`), JSON.stringify({ ticket_id: id }));
  const block = (id) => `## ${id} — 2026-10-12\n\n- Change summary:\n  - Preserve this required plan.\n`;
  fs.writeFileSync(paths.PLAN_PATH, block("VIEW-1") + "\n" + block("VIEW-2"));
  try { return fn({ root, paths, board, block, inspect: () => authority.inspectMaterializedViews({ coordDir: root, paths, board }) }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("COORD-678: zero and partial nonempty PLAN loss have distinct missing-block findings", () => {
  fixture(({ paths, block, inspect }) => {
    assert.deepEqual(inspect(), []);
    fs.writeFileSync(paths.PLAN_PATH, block("VIEW-2"));
    let issues = inspect();
    assert.equal(issues[0].code, "derived_view_missing_records");
    assert.deepEqual(issues[0].missing, ["VIEW-1"]);
    fs.writeFileSync(paths.PLAN_PATH, "");
    issues = inspect();
    assert.deepEqual(issues[0].missing, ["VIEW-1", "VIEW-2"]);
    fs.writeFileSync(paths.PLAN_PATH, "## VIEW-1 — header only\n\n" + block("VIEW-2"));
    assert.deepEqual(inspect()[0].missing, ["VIEW-1"]);
  });
});

test("COORD-678: projection scope permits empty completed work, preserves blocked plans and excludes unknown records", () => {
  fixture(({ paths, board, inspect }) => {
    for (const row of board.sections[0].rows) row.Status = "done";
    fs.writeFileSync(paths.PLAN_PATH, "");
    assert.deepEqual(inspect(), []);
    board.sections[0].rows[0].Status = "doing (blocked: waiting)";
    assert.deepEqual(inspect()[0].missing, ["VIEW-1"]);
    board.metadata = { plan_markdown_render_statuses: ["done"] };
    assert.deepEqual(inspect()[0].missing, ["VIEW-2"]);
    fs.writeFileSync(path.join(paths.PLAN_RECORDS_DIR, "VIEW-3.json"), JSON.stringify({ ticket_id: "VIEW-3" }));
    assert.deepEqual(inspect()[0].missing, ["VIEW-2"]);
  });
});

test("COORD-678: inspection does not invent records when source collections are empty or malformed", () => {
  fixture(({ paths, board, inspect }) => {
    board.sections[0].rows = [];
    board.prompt_index = {};
    fs.writeFileSync(paths.PLAN_PATH, "");
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "");
    assert.deepEqual(inspect(), []);
    // Missing required board fields are NOT valid canonical empty state. The
    // board validator must reject them; this inspector only checks projections.
    delete board.sections;
    delete board.prompt_index;
    assert.deepEqual(inspect(), []);
    board.sections = [{}];
    assert.deepEqual(inspect(), [], "a section without rows contributes no required records");
    // Canonical validation owns malformed row status. Integrity inspection must
    // still check the row's board projection without inventing a plan block.
    board.sections = [{ rows: [{ ID: "VIEW-1" }] }];
    assert.deepEqual(inspect().map((issue) => [issue.path, issue.missing]),
      [["coord/rendered/TASKS.md", ["VIEW-1"]]]);
  });
});

test("COORD-678: authority-classified task and prompt views detect missing rows, not prose mentions", () => {
  fixture(({ paths, board, inspect }) => {
    board.prompt_index = { "VIEW-1": "coord/prompts/VIEW-1.md", "VIEW-2": "coord/prompts/VIEW-2.md" };
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "# Board\nVIEW-1 appears only in prose\n| ID | Status |\n| --- | --- |\n| VIEW-2 | review |\n");
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "PROMPT_INDEX.md"), "| Ticket | Prompt File |\n| --- | --- |\n| VIEW-1 | file.md |\n");
    const issues = inspect();
    assert.deepEqual(issues.map((x) => [x.path, x.missing]).sort(), [["coord/rendered/PROMPT_INDEX.md", ["VIEW-2"]], ["coord/rendered/TASKS.md", ["VIEW-1"]]]);
  });
});

test("COORD-678: registered context-pack classes require the scoped ticket identity", () => {
  fixture(({ root, board, inspect }) => {
    for (const sub of ["product/context-packs", ".runtime/context-packs"]) {
      const dir = path.join(root, sub); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "VIEW-1.json"), JSON.stringify({ ticket: "VIEW-2", sections: {} }));
    }
    assert.equal(inspect().filter((x) => x.code === "derived_view_missing_records").length, 2);
    for (const sub of ["product/context-packs", ".runtime/context-packs"]) fs.writeFileSync(path.join(root, sub, "VIEW-1.json"), JSON.stringify({ ticket: "VIEW-1", sections: {} }));
    assert.deepEqual(inspect(), []);
  });
});

let u = require(resolveEngineModule(coord, "scripts/governance-test-utils.js"));
const { createIsolatedGovernanceWorkspace } = require(resolveEngineModule(coord, "engine/scripts/fixtures/isolated-governance-workspace.js"));
u.sandboxProcessRuntime();
for (const key of ["CODEX_THREAD_ID", "COORD_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID"]) delete process.env[key];

test("COORD-678: public doctor distinguishes partial and empty corruption; reconciliation cannot bless it", () => {
  const workspace = createIsolatedGovernanceWorkspace({ prefix: "coord678-derived-view-" });
  const priorUtils = u;
  u = require(resolveEngineModule(workspace.coord, "scripts/governance-test-utils.js"));
  try {
  u.withGovernedSurfaceSandbox(({ boardPath, logPath, renderedDir, planPath, recordsDir, tempDir }) => {
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
    board.sections = [{ kind: "table", level: 2, heading: "Fixture", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"],
      rows: ["VIEW-1", "VIEW-2"].map((ID) => ({ ID, Repo: "X", Type: "bug", Pri: "P1", Status: "review",
        Owner: "unassigned", Description: "Synthetic projection fixture", "Depends On": "" })),
    }];
    fs.writeFileSync(boardPath, JSON.stringify(board));
    fs.writeFileSync(path.join(renderedDir, "TASKS.md"), "| ID | Status |\n| --- | --- |\n| VIEW-1 | review |\n| VIEW-2 | review |\n");
    const block = (id) => `## ${id} — 2026-10-12\n\n- Change summary:\n  - Required fixture block.\n`;
    for (const id of ["VIEW-1", "VIEW-2"]) {
      const record = u.coord006ScaffoldRecord(id, "coord/engine/scripts/canonical-derived-authority.js");
      // Synthetic review fixtures satisfy the board validator so diagnostics
      // reach doctor. These are not reviews or evidence for a real ticket.
      record.self_review_cycles.forEach((cycle) => { cycle.verdict = "pass"; });
      fs.writeFileSync(path.join(recordsDir, `${id}.json`), JSON.stringify(record));
    }
    const plan = planPath;
    const full = block("VIEW-1") + "\n" + block("VIEW-2");
    fs.writeFileSync(plan, full);
    // COORD-835: drift-tolerant verbs no longer anchor a lost-journal genesis over
    // seeded state; the fixture anchors its own baseline explicitly.
    u.__testing.ensureGovernanceJournalBaseline("COORD-678 fixture seed");
    fs.writeFileSync(plan, full + "\n");
    const ordinary = u.executeCommand(["doctor"]);
    assert.match(ordinary.error, /changed without a journaled gov mutation/);
    assert.doesNotMatch(ordinary.error, /derived_view_missing_records/);
    for (const content of ["", block("VIEW-2")]) {
      fs.writeFileSync(plan, content);
      const before = [plan, boardPath, logPath].map((file) => fs.readFileSync(file));
      const result = u.executeCommand(["doctor"]);
      assert.equal(result.ok, false);
      assert.match(result.error, /\[derived_view_missing_records\].*VIEW-1/);
      const reconcile = u.executeCommand(["reconcile", "--reason", "fixture corruption", "--human-admin-override", "isolated fixture only"]);
      assert.equal(reconcile.ok, false);
      assert.match(reconcile.error, /derived_view_missing_records/);
      const dryRun = u.executeCommand(["reconcile", "--dry-run", "--reason", "inspect fixture corruption"]);
      assert.equal(dryRun.ok, true, dryRun.error);
      const proposal = JSON.parse(dryRun.stdout);
      assert.equal(proposal.would_reconcile, 0);
      assert.ok(proposal.derived_view_issues.some((issue) => issue.code === "derived_view_missing_records"));
      assert.deepEqual([plan, boardPath, logPath].map((file) => fs.readFileSync(file)), before);
    }
    fs.writeFileSync(plan, full + "\n");
    const packetPath = path.relative(workspace.coord, plan).split(path.sep).join("/");
    const packet = [`${crypto.createHash("sha256").update(fs.readFileSync(plan)).digest("hex")} ${packetPath}`];
    const inspected = u.executeCommand(["reconcile", "--dry-run", "--reason", "inspect full fixture restoration"]);
    assert.deepEqual(JSON.parse(inspected.stdout).expect_paths_packet, packet);
    const packetFile = path.join(tempDir, "approved-plan.packet");
    fs.writeFileSync(packetFile, `${packet.join("\n")}\n`);
    const restored = invokeFixtureReconcile(workspace.coord, u.executeCommand, ["reconcile", "--reason", "reviewed full fixture restoration", "--human-admin-override", "approve restored fixture blocks only", "--expect-paths-file", packetFile]);
    assert.equal(restored.ok, true, restored.error);
    const repeated = u.executeCommand(["reconcile", "--reason", "already restored fixture"]);
    assert.equal(JSON.parse(repeated.stdout).status, "noop");
    // Exercise the historical trigger, now fixed by the full-source projector.
    // A successful unrelated filing must retain both existing required blocks.
    for (const id of ["VIEW-3", "VIEW-4", "VIEW-5"]) {
      const filed = u.executeCommand(["file-ticket", id, "--repo", "X", "--type", "bug", "--pri", "P2", "--description", "Exercise the real scoped filing projector"]);
      assert.equal(filed.ok, true, filed.error);
      const after = fs.readFileSync(plan, "utf8");
      assert.match(after, /^## VIEW-1 — /m);
      assert.match(after, /^## VIEW-2 — /m);
    }
    assert.doesNotMatch(u.executeCommand(["doctor"]).error || "", /derived_view_missing_records/);
    u.__testing.withGovernanceMutation({ command: "fixture-empty", forceLog: true }, () => {
      const empty = JSON.parse(fs.readFileSync(boardPath, "utf8"));
      empty.sections = [];
      empty.prompt_index = {};
      fs.writeFileSync(boardPath, JSON.stringify(empty));
      for (const name of fs.readdirSync(recordsDir)) fs.unlinkSync(path.join(recordsDir, name));
      fs.writeFileSync(plan, "");
    });
    assert.doesNotMatch(u.executeCommand(["doctor"]).error || "", /derived_view_/,
      "public doctor accepts a legitimately empty projection");
  }, { isolateBoardValidation: true, coordRelativePaths: true });
  } finally {
    u = priorUtils;
    workspace.cleanup();
  }
});

test("COORD-678: examples cannot impersonate required plan blocks or table rows", () => {
  fixture(({ paths, board, block, inspect }) => {
    fs.writeFileSync(paths.PLAN_PATH, '```markdown\n' + block('VIEW-1') + '```\n' + block('VIEW-2'));
    assert.deepEqual(inspect()[0].missing, ["VIEW-1"]);
    fs.writeFileSync(paths.PLAN_PATH, '~~~~\n' + block('VIEW-1') + '~~~\n' + block('VIEW-2') + '~~~~\n');
    assert.deepEqual(inspect()[0].missing, ["VIEW-1", "VIEW-2"]);
    fs.writeFileSync(paths.PLAN_PATH, '<!--\n' + block('VIEW-1') + '-->\n' + block('VIEW-2'));
    assert.deepEqual(inspect()[0].missing, ["VIEW-1"], "hidden comment text is not a rendered block");
    fs.writeFileSync(paths.PLAN_PATH, '<!--\n```\n-->\n' + block('VIEW-1') + block('VIEW-2'));
    assert.deepEqual(inspect(), [], "a fence inside a comment does not hide subsequent real blocks");
    fs.writeFileSync(paths.PLAN_PATH, '```html\n<!--\n```\n' + block('VIEW-1') + block('VIEW-2'));
    assert.deepEqual(inspect(), [], "a comment inside an example does not hide subsequent real blocks");
    fs.writeFileSync(paths.PLAN_PATH, '```\n' + block('VIEW-1') + '```still an example\n' + block('VIEW-2') + '```\n');
    assert.deepEqual(inspect()[0].missing, ["VIEW-1", "VIEW-2"], "a closing fence cannot carry trailing text");
    fs.writeFileSync(paths.PLAN_PATH, block('VIEW-1') + '## VIEW-2 — title\nVisible body<!-- unfinished comment');
    assert.deepEqual(inspect(), [], "visible body text preceding a comment remains content");
    fs.writeFileSync(paths.PLAN_PATH, '```js`bad\n' + block('VIEW-1') + block('VIEW-2'));
    assert.deepEqual(inspect(), [], "a backtick in the info string invalidates a backtick fence opener");
    fs.writeFileSync(paths.PLAN_PATH, block('VIEW-1') + block('VIEW-2'));
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), '```\n| VIEW-1 | review |\n```\n| VIEW-2 | review |\n');
    assert.deepEqual(inspect()[0].missing, ["VIEW-1"]);
    board.sections[0].rows = [];
    board.prompt_index = {};
    fs.writeFileSync(paths.PLAN_PATH, "");
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "TASKS.md"), "");
    fs.writeFileSync(path.join(paths.RENDERED_DIR, "PROMPT_INDEX.md"), "");
    assert.deepEqual(inspect(), [], "empty canonical projections are legitimate even with historical plan files");
  });
});

test("COORD-678: legacy planned work is required, unplanned backlog does not invent a required block", () => {
  fixture(({ paths, board, inspect }) => {
    fs.mkdirSync(paths.LEGACY_PLAN_RECORDS_DIR, { recursive: true });
    fs.renameSync(path.join(paths.PLAN_RECORDS_DIR, "VIEW-1.json"), path.join(paths.LEGACY_PLAN_RECORDS_DIR, "VIEW-1.json"));
    fs.writeFileSync(paths.PLAN_PATH, "");
    board.metadata = { plan_markdown_render_statuses: [] };
    assert.deepEqual(inspect()[0].missing, ["VIEW-1", "VIEW-2"]);
    board.sections[0].rows.push({ ID: "VIEW-3", Status: "todo" });
    assert.deepEqual(inspect()[0].missing, ["VIEW-1", "VIEW-2"]);
    fs.unlinkSync(paths.PLAN_PATH);
    assert.deepEqual(inspect()[0].missing, ["VIEW-1", "VIEW-2"], "missing required view is also missing required blocks");
  });
});

test("COORD-678: context markdown, malformed JSON and unknown formats cannot silently pass", () => {
  fixture(({ root, inspect }) => {
    const dir = path.join(root, "product/context-packs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "VIEW-1.md"), "# Business Context Pack: VIEW-2\n");
    fs.writeFileSync(path.join(dir, "VIEW-2.json"), "{");
    assert.deepEqual(inspect().map((issue) => issue.missing).sort(), [["VIEW-1"], ["VIEW-2"]]);
    fs.writeFileSync(path.join(dir, "VIEW-1.md"), "# Business Context Pack: VIEW-1\n");
    fs.writeFileSync(path.join(dir, "VIEW-2.json"), JSON.stringify({ ticket: "VIEW-2" }));
    fs.writeFileSync(path.join(dir, ".gitkeep"), "");
    fs.writeFileSync(path.join(dir, "new-format.txt"), "nonempty but no registered projection");
    const issues = inspect();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "derived_view_unverifiable");
  });
});


test("COORD-678: removing required table files or their directory is a content failure", () => {
  fixture(({ paths, board, inspect }) => {
    board.prompt_index = { "VIEW-1": "file.md" };
    fs.rmSync(paths.RENDERED_DIR, { recursive: true });
    const issues = inspect();
    assert.deepEqual(issues.map((issue) => [issue.path, issue.missing]), [
      ["coord/rendered/TASKS.md", ["VIEW-1", "VIEW-2"]],
      ["coord/rendered/PROMPT_INDEX.md", ["VIEW-1"]],
    ]);
    board.sections = [];
    board.prompt_index = {};
    assert.deepEqual(inspect(), [], "an unmaterialized empty projection is legitimate");
  });
});


test("COORD-678: malformed configured locations fail closed instead of disabling inspection", () => {
  fixture(({ paths, inspect }) => {
    delete paths.PLAN_PATH;
    assert.throws(inspect, /Missing configured location for coord\/PLAN.md/);
  });
  fixture(({ paths, inspect }) => {
    fs.unlinkSync(paths.PLAN_PATH);
    fs.mkdirSync(paths.PLAN_PATH);
    assert.equal(inspect()[0].code, "derived_view_unverifiable");
  });
});
