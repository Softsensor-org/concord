"use strict";

// COORD-142: tests for the Phase 2 summary-tier generator.
//
// Coverage: the four tiers generate well-formed records for known tickets/epics/
// subsystems/repos; each record carries source_hashes (present + correct);
// staleness detection flips to invalid when a source changes (simulated by
// altering a fixture board row); rebuild determinism (byte-identical content
// digest); and the cardinal guardrail (summaries marked non-authority + invalid-
// if-source-changed, pointing at the authoritative source, never themselves).

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const summaries = require("./summary-tiers.js");

const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "summary-tiers");
const FIXTURE_BOARD = path.join(FIXTURE_DIR, "board.json");
const FIXTURE_PLANS = path.join(FIXTURE_DIR, "plans");
const FIXTURE_JOURNAL = path.join(FIXTURE_DIR, "governance-events.ndjson");
const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");

const FIXED_NOW = "2026-06-24T00:00:00.000Z";

function generateFromFixture(overrides = {}) {
  return summaries.generateSummaries({
    boardPath: FIXTURE_BOARD,
    plansDir: FIXTURE_PLANS,
    journalPath: FIXTURE_JOURNAL,
    rootDir: ROOT_DIR,
    now: FIXED_NOW,
    ...overrides,
  });
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// --- all four tiers generate well-formed records -----------------------------

test("generates all four tiers (tickets, epics, subsystems, repos)", () => {
  const g = generateFromFixture();
  assert.deepEqual(Object.keys(g).sort(), ["chain_head", "epics", "repos", "subsystems", "tickets"]);

  // 4 ticket rows in the fixture -> 4 ticket summaries.
  assert.equal(g.tickets.length, 4);
  assert.deepEqual(g.tickets.map((r) => r.key).sort(), ["SUM-001", "SUM-002", "SUM-003", "SUM-004"]);

  // epics: "Memory", "Server bootstrap", "(unclassified)".
  assert.deepEqual(g.epics.map((r) => r.key).sort(), ["(unclassified)", "Memory", "Server bootstrap"]);

  // subsystems = board section headings of TABLE sections only.
  assert.deepEqual(g.subsystems.map((r) => r.key).sort(), ["Bootstrap Subsystem", "Memory Subsystem"]);

  // repos: X, B, F.
  assert.deepEqual(g.repos.map((r) => r.key).sort(), ["B", "F", "X"]);
});

test("ticket summary rolls up status + the decision record for a worked ticket", () => {
  const g = generateFromFixture();
  const sum001 = g.tickets.find((r) => r.key === "SUM-001");
  assert.ok(sum001);
  assert.equal(sum001.summary.status, "done");
  assert.equal(sum001.summary.epic, "Memory");
  assert.equal(sum001.summary.subsystem, "Memory Subsystem");
  assert.equal(sum001.summary.has_decision, true);
  assert.equal(sum001.summary.decision_verdict, "complete");
  assert.match(sum001.summary.ticket_ask, /worked decision-bearing record/);

  // An unworked ticket carries no decision.
  const sum002 = g.tickets.find((r) => r.key === "SUM-002");
  assert.equal(sum002.summary.has_decision, false);
  assert.equal(sum002.summary.decision_verdict, null);
});

test("epic rollup groups tickets sharing a bracketed [Epic] prefix", () => {
  const g = generateFromFixture();
  const memory = g.epics.find((r) => r.key === "Memory");
  assert.deepEqual(memory.summary.members, ["SUM-001", "SUM-002"]);
  assert.equal(memory.summary.member_count, 2);
  assert.equal(memory.summary.decided_member_count, 1);
  assert.deepEqual(memory.summary.status_counts, { done: 1, todo: 1 });
});

test("subsystem rollup groups tickets by board section; repo rollup by Repo code", () => {
  const g = generateFromFixture();
  const memSub = g.subsystems.find((r) => r.key === "Memory Subsystem");
  assert.deepEqual(memSub.summary.members, ["SUM-001", "SUM-002"]);

  const repoX = g.repos.find((r) => r.key === "X");
  assert.deepEqual(repoX.summary.members, ["SUM-001", "SUM-002"]);
  const repoB = g.repos.find((r) => r.key === "B");
  assert.deepEqual(repoB.summary.members, ["SUM-003"]);
});

// --- source_hashes present + correct ----------------------------------------

test("every record carries source_hashes matching the canonical hash of its sources", () => {
  const g = generateFromFixture();
  const board = JSON.parse(fs.readFileSync(FIXTURE_BOARD, "utf8"));
  // Recompute the expected board-row hash exactly as the generator does.
  const rows = {};
  for (const section of board.sections) {
    if (section.kind === "table") {
      for (const row of section.rows) {
        rows[row.ID] = sha1(summaries.stableStringify(row));
      }
    }
  }

  const sum001 = g.tickets.find((r) => r.key === "SUM-001");
  assert.ok(Object.keys(sum001.source_hashes).length > 0, "source_hashes present");
  assert.equal(sum001.source_hashes["SUM-001"], rows["SUM-001"]);

  // Epic rollup's source_hashes cover every member row.
  const memory = g.epics.find((r) => r.key === "Memory");
  assert.equal(memory.source_hashes["SUM-001"], rows["SUM-001"]);
  assert.equal(memory.source_hashes["SUM-002"], rows["SUM-002"]);
});

test("each record carries generated_at + chain_head", () => {
  const g = generateFromFixture();
  const lines = fs
    .readFileSync(FIXTURE_JOURNAL, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const expectedChainHead = sha1(lines[lines.length - 1]);

  for (const tier of summaries.TIERS) {
    for (const rec of g[tier]) {
      assert.equal(rec.generated_at, FIXED_NOW);
      assert.equal(rec.chain_head, expectedChainHead);
    }
  }
});

// --- the cardinal guardrail: summaries are NEVER authority -------------------

test("guardrail: every summary is marked non-authority + invalid-if-source-changed and points at the authoritative source", () => {
  const g = generateFromFixture();
  for (const tier of summaries.TIERS) {
    for (const rec of g[tier]) {
      assert.equal(rec.kind, "summary");
      assert.equal(rec.authority, false, "a summary must NOT be citable as authority");
      assert.equal(rec.invalid_if_source_changed, true);
      assert.ok(Array.isArray(rec.sources) && rec.sources.length > 0, "points at authoritative sources");
      for (const s of rec.sources) {
        assert.ok(s.id && s.path, "each source pointer names an authoritative id + path");
      }
    }
  }

  // A worked ticket additionally points at its decision record's hash-linked
  // citation (event_hash + chain_head + verified) — the real authority for the
  // "why" — NEVER the summary itself.
  const sum001 = g.tickets.find((r) => r.key === "SUM-001");
  const decisionPtr = sum001.sources.find((s) => s.type === "decision");
  assert.ok(decisionPtr, "worked ticket points at its decision record");
  assert.equal(decisionPtr.id, "SUM-001");
  assert.equal(typeof decisionPtr.verified, "boolean");
  assert.ok(Object.prototype.hasOwnProperty.call(decisionPtr, "event_hash"));
  assert.ok(Object.prototype.hasOwnProperty.call(decisionPtr, "chain_head"));
});

// --- rebuild determinism -----------------------------------------------------

test("rebuild is deterministic: substantive content digest is byte-stable across wall-clock drift", () => {
  // Two generations with DIFFERENT generated_at values must still produce the
  // same content digest (generated_at is excluded from the digest).
  const a = generateFromFixture({ now: "2020-01-01T00:00:00.000Z" });
  const b = generateFromFixture({ now: "2099-12-31T23:59:59.000Z" });
  for (const tier of summaries.TIERS) {
    assert.equal(
      summaries.contentDigest(a[tier]),
      summaries.contentDigest(b[tier]),
      `${tier} content digest must ignore generated_at`
    );
  }

  // And the full serialization with the SAME now is byte-identical.
  const c = generateFromFixture();
  const d = generateFromFixture();
  for (const tier of summaries.TIERS) {
    assert.equal(summaries.serializeRecords(c[tier]), summaries.serializeRecords(d[tier]));
  }
});

test("rebuild writes derived tier files under summaries/{tier}/{tier}.ndjson", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sum-tiers-"));
  try {
    const { counts } = summaries.rebuild({
      boardPath: FIXTURE_BOARD,
      plansDir: FIXTURE_PLANS,
      journalPath: FIXTURE_JOURNAL,
      rootDir: ROOT_DIR,
      now: FIXED_NOW,
      summariesDir: tmp,
    });
    assert.equal(counts.tickets, 4);
    for (const tier of summaries.TIERS) {
      const p = path.join(tmp, tier, `${tier}.ndjson`);
      assert.ok(fs.existsSync(p), `${tier} file written`);
    }
    const loaded = summaries.loadAllSummaries({ summariesDir: tmp });
    assert.ok(loaded.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- staleness / invalidation ------------------------------------------------

test("staleness detection: all records are valid against unchanged sources", () => {
  const g = generateFromFixture();
  const allRecords = [...g.tickets, ...g.epics, ...g.subsystems, ...g.repos];
  const verdicts = summaries.checkStaleness({ boardPath: FIXTURE_BOARD, records: allRecords });
  assert.ok(verdicts.every((v) => v.valid), "nothing stale against unchanged sources");
});

test("staleness detection FLIPS to invalid when a source row changes", () => {
  // Generate against the original board, then evaluate against a MUTATED board
  // (a status change on SUM-001). Every record whose source_hashes include
  // SUM-001 must flip to stale; records not depending on SUM-001 stay valid.
  const g = generateFromFixture();
  const allRecords = [...g.tickets, ...g.epics, ...g.subsystems, ...g.repos];

  // Write a mutated copy of the board to a temp file.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sum-stale-"));
  const mutatedBoardPath = path.join(tmp, "board.json");
  try {
    const board = JSON.parse(fs.readFileSync(FIXTURE_BOARD, "utf8"));
    for (const section of board.sections) {
      if (section.kind === "table") {
        for (const row of section.rows) {
          if (row.ID === "SUM-001") {
            row.Status = "blocked"; // a real field change -> hash changes
          }
        }
      }
    }
    fs.writeFileSync(mutatedBoardPath, JSON.stringify(board, null, 2));

    const verdicts = summaries.checkStaleness({
      boardPath: mutatedBoardPath,
      records: allRecords,
    });
    const byKey = new Map(verdicts.map((v) => [`${v.tier}:${v.key}`, v]));

    // The SUM-001 ticket summary is stale.
    assert.equal(byKey.get("tickets:SUM-001").stale, true);
    assert.match(byKey.get("tickets:SUM-001").reasons.join(" "), /SUM-001 changed/);

    // The Memory epic + Memory subsystem + repo X rollups include SUM-001 -> stale.
    assert.equal(byKey.get("epics:Memory").stale, true);
    assert.equal(byKey.get("subsystems:Memory Subsystem").stale, true);
    assert.equal(byKey.get("repos:X").stale, true);

    // A record NOT depending on SUM-001 stays valid (the Bootstrap subsystem).
    assert.equal(byKey.get("subsystems:Bootstrap Subsystem").valid, true);
    assert.equal(byKey.get("tickets:SUM-003").valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("staleness detection flips when a source ROW VANISHES", () => {
  const g = generateFromFixture();
  const sum002 = g.tickets.find((r) => r.key === "SUM-002");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sum-gone-"));
  const mutatedBoardPath = path.join(tmp, "board.json");
  try {
    const board = JSON.parse(fs.readFileSync(FIXTURE_BOARD, "utf8"));
    for (const section of board.sections) {
      if (section.kind === "table") {
        section.rows = section.rows.filter((r) => r.ID !== "SUM-002");
      }
    }
    fs.writeFileSync(mutatedBoardPath, JSON.stringify(board, null, 2));

    const verdicts = summaries.checkStaleness({
      boardPath: mutatedBoardPath,
      records: [sum002],
    });
    assert.equal(verdicts[0].stale, true);
    assert.match(verdicts[0].reasons.join(" "), /no longer exists/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- COORD-821: the CLI entrypoint ---------------------------------------------
// The CLI tail is an injectable main(args, io) (the COORD-807 shape). Every
// source and the summaries directory are handed in, so --rebuild writes a temp
// directory and never the live coord/memory tree; the spawned process only ever
// prints usage.
const SUMMARY_USAGE_HEAD = /^coord\/engine\/scripts\/summary-tiers\.js — Phase 2 summary-tier generator \(COORD-142\)\.\n\nUsage:\n/;

function withSummaryCli(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord821-summary-cli-"));
  const options = {
    boardPath: FIXTURE_BOARD,
    plansDir: FIXTURE_PLANS,
    journalPath: FIXTURE_JOURNAL,
    rootDir: ROOT_DIR,
    summariesDir: path.join(tmp, "summaries"),
  };
  const run = (argv, overrides = {}) => {
    const chunks = [];
    const code = summaries.main(argv, {
      stdout: { write: (chunk) => chunks.push(chunk) },
      options: { ...options, ...overrides },
    });
    return { code, out: chunks.join("") };
  };
  try {
    fn({ tmp, options, run });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("COORD-821: summary-tiers main --rebuild writes every tier under the injected summaries dir only", () => {
  withSummaryCli(({ options, run }) => {
    const g = generateFromFixture();
    for (const spelling of ["--rebuild", "rebuild"]) {
      assert.equal(fs.existsSync(options.summariesDir), false);
      const { code, out } = run([spelling]);
      assert.equal(code, undefined);
      assert.equal(
        out,
        `Rebuilt summary tiers under ${path.relative(ROOT_DIR, options.summariesDir)} — ` +
          `${summaries.TIERS.map((t) => `${t}=${g[t].length}`).join(", ")}.\n`
      );
      assert.equal(g.tickets.length, 4);
      for (const tier of summaries.TIERS) {
        const written = summaries.loadTier(options.summariesDir, tier);
        assert.equal(summaries.contentDigest(written), summaries.contentDigest(g[tier]), `${tier} content`);
      }
      fs.rmSync(options.summariesDir, { recursive: true });
    }
  });
});

test("COORD-821: summary-tiers main --check exits 0 on fresh summaries and 1 with STALE lines after a source change", () => {
  withSummaryCli(({ tmp, run }) => {
    run(["--rebuild"]);
    const g = generateFromFixture();
    const total = summaries.TIERS.reduce((n, t) => n + g[t].length, 0);
    for (const spelling of ["--check", "check"]) {
      const fresh = run([spelling]);
      assert.equal(fresh.code, 0);
      assert.equal(fresh.out, `Checked ${total} summary record(s); 0 stale.\n`);
    }

    const board = JSON.parse(fs.readFileSync(FIXTURE_BOARD, "utf8"));
    for (const section of board.sections) {
      for (const row of section.kind === "table" ? section.rows : []) {
        if (row.ID === "SUM-001") row.Status = "blocked";
      }
    }
    const mutatedBoardPath = path.join(tmp, "board.json");
    fs.writeFileSync(mutatedBoardPath, JSON.stringify(board, null, 2));
    const stale = run(["--check"], { boardPath: mutatedBoardPath });
    assert.equal(stale.code, 1);
    const lines = stale.out.trimEnd().split("\n");
    assert.match(lines.at(-1), new RegExp(`^Checked ${total} summary record\\(s\\); ${lines.length - 1} stale\\.$`));
    assert.ok(lines.some((l) => /^STALE \[tickets\] SUM-001: .*SUM-001 changed/.test(l)));
    assert.ok(lines.some((l) => l.startsWith("STALE [epics] Memory: ")));
    assert.ok(!lines.some((l) => l.startsWith("STALE [tickets] SUM-003")), "an unaffected ticket stays fresh");
  });
});

test("COORD-821: summary-tiers main --print writes every tier's records to stdout without writing files", () => {
  withSummaryCli(({ options, run }) => {
    for (const spelling of ["--print", "print"]) {
      const { code, out } = run([spelling]);
      assert.equal(code, undefined);
      const records = out.trimEnd().split("\n").map((line) => JSON.parse(line));
      const g = generateFromFixture();
      const expected = summaries.TIERS.flatMap((t) => g[t]);
      assert.equal(summaries.contentDigest(records), summaries.contentDigest(expected));
    }
    assert.equal(fs.existsSync(options.summariesDir), false);
  });
});

test("COORD-821: summary-tiers main prints usage for a missing or unknown command and touches nothing", () => {
  withSummaryCli(({ tmp, run }) => {
    for (const argv of [[], ["--unknown"]]) {
      const { code, out } = run(argv);
      assert.equal(code, undefined);
      assert.match(out, SUMMARY_USAGE_HEAD);
      assert.match(out, /--check {5}flag summaries whose source_hashes no longer match current sources \(stale\)\n/);
      assert.ok(out.endsWith("generator + fixtures + tests are committed.\n"));
    }
    assert.deepEqual(fs.readdirSync(tmp), []);
  });
});

test("COORD-821: the summary-tiers script run as a process prints usage and exits 0", () => {
  const { spawnSync } = require("child_process");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coord821-summary-spawn-"));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "summary-tiers.js"), "--unknown"], {
      cwd,
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, SUMMARY_USAGE_HEAD);
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("summary ingestion keeps sparse legacy tickets and fingerprints their original row", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-sparse-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const board = path.join(dir, "board.json");
  const row = { ID: "SUM-001" };
  fs.writeFileSync(board, JSON.stringify({ sections: [{ kind: "table", rows: [row] }] }));
  const [ticket] = summaries.readBoardTickets(board);
  const { source_hash, source_path, ...fields } = ticket;
  assert.equal(source_hash, sha1(JSON.stringify(row)));
  assert.equal(path.resolve(ROOT_DIR, source_path), board);
  assert.deepEqual(fields, {
    id: row.ID, repo: null, type: null, priority: null, status: null, owner: null,
    description: "", depends_on: "", subsystem: "(unsectioned)", epic: "(unclassified)",
  });
});
