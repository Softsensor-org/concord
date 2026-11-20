"use strict";

// COORD-083: code-quality automation + quality-ticket generator tests.
// Covers the load-bearing behavior: STABLE finding key (cross-run identity),
// finding->proposal mapping + severity->priority, severity floor, DEDUP against
// open tickets (the hardest/most important part), within-run dedup, the per-run
// CAP, the --apply filing path (with a mocked gov runner so NO real board is
// touched), and the dry-run CLI guarantee that nothing is written by default.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const qs = require("./quality-scan.js");
const proposeCron = require("./quality-propose-cron.js");

// --- helpers ---------------------------------------------------------------
function finding(over = {}) {
  return Object.assign(
    {
      check: "size",
      file: "src/big.js",
      value: 2000,
      threshold: 1500,
      severity: "fail",
      message: "file src/big.js is 2000 LOC, over budget 1500",
    },
    over
  );
}

function boardWith(rows) {
  return { sections: [{ kind: "table", rows }] };
}

// --- stable finding key ----------------------------------------------------
test("stableFindingKey: size identity ignores the volatile LOC value", () => {
  const a = qs.stableFindingKey(finding({ value: 2000 }));
  const b = qs.stableFindingKey(finding({ value: 2100 })); // file edited, still big
  assert.strictEqual(a, b, "same file/check must produce same key across runs");
  assert.strictEqual(a, "size:src/big.js:loc");
});

test("stableFindingKey: complexity keyed by function name from message", () => {
  const f = finding({
    check: "complexity",
    file: "a.js",
    value: 30,
    threshold: 15,
    line: 12,
    message: "function doStuff in a.js has cyclomatic complexity ~30, over budget 15",
  });
  assert.strictEqual(qs.stableFindingKey(f), "complexity:a.js:fn:doStuff");
});

test("stableFindingKey: duplication keyed by the region hash", () => {
  const f = finding({
    check: "duplication",
    file: "b.js",
    value: 20,
    threshold: 12,
    line: 5,
    message: "20-line block in b.js duplicates c.js:3 (hash deadbeef)",
  });
  assert.strictEqual(qs.stableFindingKey(f), "duplication:b.js:dup:deadbeef");
});

test("stableFindingKey: normalizes windows-style paths", () => {
  const f = finding({ file: "src\\win\\x.js" });
  assert.strictEqual(qs.stableFindingKey(f), "size:src/win/x.js:loc");
});

test("stableFindingKey: hardcoding keyed by literal value + line (round-trips through dedup)", () => {
  const f = finding({
    check: "hardcoding",
    file: "a.js",
    value: "/etc/coord/x.json",
    threshold: "no-inline-path",
    line: 12,
    message: "hardcoded path literal in a.js",
  });
  assert.strictEqual(qs.stableFindingKey(f), "hardcoding:a.js:hc:/etc/coord/x.json:line12");
});

test("stableFindingKey: deadcode keyed by the unreferenced symbol name", () => {
  const f = finding({
    check: "deadcode",
    file: "a.js",
    value: "orphanFn",
    threshold: "0-refs",
    line: 3,
    message: "'orphanFn' in a.js is defined but never referenced",
  });
  assert.strictEqual(qs.stableFindingKey(f), "deadcode:a.js:dead:orphanFn");
});

test("findingToProposal: new checks get a title + fix framing (quality-scan picks them up)", () => {
  const cases = [
    [{ check: "compositionRoot", line: 3 }, "Move composition-root logic into a module: a.js:3"],
    [{ check: "compositionRoot" }, "Move composition-root logic into a module: a.js"],
    [{ check: "imports", value: "internal" }, "Fix import boundary: a.js imports internal"],
    [{ check: "hardcoding" }, "Extract hardcoded literal in a.js"],
    [{ check: "complexity", line: 7, value: 18, threshold: 12 }, "Reduce complexity: function@7 in a.js (~18 > 12)"],
    [{ check: "plugin-check" }, "Quality finding: plugin-check in a.js"],
  ];
  for (const [fields, title] of cases) {
    assert.equal(qs.findingToProposal({ file: "a.js", ...fields }).title, title);
  }
  const hc = qs.findingToProposal(finding({ check: "hardcoding", value: "/x/y.json", threshold: "no-inline-path", severity: "warn", line: 4 }));
  assert.match(hc.title, /Extract hardcoded literal/);
  assert.match(hc.description, /config-seam/);
  assert.strictEqual(hc.pri, "P3");
  const dc = qs.findingToProposal(finding({ check: "deadcode", value: "orphanFn", threshold: "0-refs", severity: "warn", line: 9 }));
  assert.match(dc.title, /Remove or justify dead code: 'orphanFn'/);
  assert.match(dc.description, /unreferenced/);
  const prodloc = qs.findingToProposal(finding({
    check: "prodloc",
    file: "coord/scripts/new-monolith.js",
    value: 1300,
    threshold: 1200,
    severity: "fail",
  }));
  assert.match(prodloc.title, /Reduce coord production module size/);
  assert.match(prodloc.description, /production module/);
});

// --- proposal mapping ------------------------------------------------------
test("findingToProposal: maps severity->priority and embeds the qkey marker", () => {
  const p = qs.findingToProposal(finding({ severity: "fail" }));
  assert.strictEqual(p.pri, "P2");
  assert.match(p.description, /\[qkey:size:src\/big\.js:loc\]/);
  assert.match(p.description, /Evidence:/);
  assert.match(p.description, /Suggested fix:/);
});

test("findingToProposal: warn->P3 but architectural-risk checks stay P2 even at warn", () => {
  assert.strictEqual(qs.findingToProposal(finding({ severity: "warn" })).pri, "P3");
  assert.strictEqual(
    qs.findingToProposal(finding({ check: "monolith", severity: "warn" })).pri,
    "P2"
  );
  assert.strictEqual(
    qs.findingToProposal(finding({ check: "prodloc", severity: "warn" })).pri,
    "P2"
  );
});

// --- severity floor --------------------------------------------------------
test("planTickets: severity floor excludes lower severities", () => {
  const findings = [finding({ severity: "warn" }), finding({ check: "monolith", file: "m.js", severity: "fail" })];
  const plan = qs.planTickets({ findings, board: boardWith([]), severityFloor: "fail", cap: 10 });
  assert.strictEqual(plan.counts.belowFloor, 1);
  assert.strictEqual(plan.counts.toFile, 1);
  assert.strictEqual(plan.toFile[0].file, "m.js");
});

test("planTickets: warn floor admits both warn and fail", () => {
  const findings = [finding({ severity: "warn", file: "w.js" }), finding({ severity: "fail", file: "f.js" })];
  const plan = qs.planTickets({ findings, board: boardWith([]), severityFloor: "warn", cap: 10 });
  assert.strictEqual(plan.counts.belowFloor, 0);
  assert.strictEqual(plan.counts.toFile, 2);
});

// --- COORD-103: the documented filing POLICY -------------------------------
// arch-checks is warning-first, so the real residual debt is warn-class. The
// ad-hoc `fail` default must file NONE of it (conservative, no surprise); the
// CADENCE `warn` floor must surface it in a bounded batch. This is the policy
// QUALITY_AUTOMATION.md documents (fail = ad-hoc/escalated only; warn = cadence).
test("policy: warn-only debt yields ZERO under the fail (ad-hoc) floor but eligible candidates under the warn (cadence) floor", () => {
  // A warn-only finding set, mirroring the live board (all arch-checks warn).
  const warnDebt = [
    finding({ check: "size", file: "a.js", severity: "warn" }),
    finding({ check: "complexity", file: "b.js", severity: "warn", line: 3, message: "function f in b.js ~30" }),
    finding({ check: "duplication", file: "c.js", severity: "warn", message: "dup hash abc123" }),
  ];

  // Ad-hoc default floor (fail): files nothing — all warn debt is below floor.
  const adhoc = qs.planTickets({ findings: warnDebt, board: boardWith([]), severityFloor: "fail", cap: 3 });
  assert.strictEqual(adhoc.counts.eligible, 0, "fail floor: warn-class debt is below floor");
  assert.strictEqual(adhoc.counts.toFile, 0, "fail floor on a warn-only board files NOTHING (by design)");
  assert.strictEqual(adhoc.counts.belowFloor, warnDebt.length);

  // Cadence floor (warn): surfaces the debt, bounded by the cap.
  const cadence = qs.planTickets({ findings: warnDebt, board: boardWith([]), severityFloor: "warn", cap: 3 });
  assert.ok(cadence.counts.eligible > 0, "warn floor: warn-class debt becomes eligible");
  assert.strictEqual(cadence.counts.eligible, warnDebt.length);
  assert.strictEqual(cadence.counts.toFile, 3, "cadence files a bounded batch (== cap when more eligible)");
});

test("policy: warn-floor cadence cap keeps the batch bounded (overflow resurfaces, not dropped)", () => {
  const findings = [];
  for (let i = 0; i < 8; i += 1) findings.push(finding({ check: "size", file: `f${i}.js`, severity: "warn" }));
  const plan = qs.planTickets({ findings, board: boardWith([]), severityFloor: "warn", cap: 3 });
  assert.strictEqual(plan.counts.toFile, 3, "bounded batch == cap");
  assert.strictEqual(plan.counts.capped, 5, "overflow surfaced as capped, never silently dropped");
  assert.strictEqual(plan.counts.eligible, plan.counts.toFile + plan.counts.capped);
});

// --- dedup (the critical path) ---------------------------------------------
test("planTickets: skips a finding that already has an OPEN ticket", () => {
  const key = qs.stableFindingKey(finding());
  const board = boardWith([
    { ID: "QSCAN-001", Status: "todo", Description: `[auto-quality] ... [qkey:${key}]` },
  ]);
  const plan = qs.planTickets({ findings: [finding()], board, severityFloor: "fail", cap: 10 });
  assert.strictEqual(plan.counts.duplicate, 1);
  assert.strictEqual(plan.counts.skippedOpen, 1, "an open-board match lands in skippedOpen");
  assert.strictEqual(plan.counts.skippedInRun, 0, "open-board match is NOT an in-run dup");
  assert.strictEqual(plan.skippedOpen.length, 1);
  assert.strictEqual(plan.skippedInRun.length, 0);
  assert.strictEqual(plan.counts.toFile, 0);
});

test("planTickets: a DONE/SUPERSEDED ticket does NOT block re-filing", () => {
  const key = qs.stableFindingKey(finding());
  for (const status of ["done", "superseded"]) {
    const board = boardWith([{ ID: "QSCAN-001", Status: status, Description: `[qkey:${key}]` }]);
    const plan = qs.planTickets({ findings: [finding()], board, severityFloor: "fail", cap: 10 });
    assert.strictEqual(plan.counts.duplicate, 0, `${status} must not block`);
    assert.strictEqual(plan.counts.toFile, 1, `${status} must allow re-file`);
  }
});

test("planTickets: within-run dedup collapses two findings of one key", () => {
  const plan = qs.planTickets({
    findings: [finding(), finding({ value: 2222 })], // same file -> same key
    board: boardWith([]),
    severityFloor: "fail",
    cap: 10,
  });
  assert.strictEqual(plan.counts.toFile, 1);
  assert.strictEqual(plan.counts.duplicate, 1);
});

// --- COORD-101: dedup buckets are distinct (in-run vs already-open) --------
test("planTickets: empty board reports in-run dups as skippedInRun, NOT skippedOpen", () => {
  const plan = qs.planTickets({
    findings: [finding(), finding({ value: 2222 })], // same file -> same key, collapses in-run
    board: boardWith([]), // EMPTY board: nothing can be "already open"
    severityFloor: "fail",
    cap: 10,
  });
  // The collapsed duplicate must be attributed to the in-run bucket...
  assert.strictEqual(plan.counts.skippedInRun, 1, "in-run dup belongs to skippedInRun");
  assert.strictEqual(plan.skippedInRun.length, 1);
  // ...and the empty board must report ZERO already-open skips (the bug).
  assert.strictEqual(plan.counts.skippedOpen, 0, "empty board has no already-open skips");
  assert.strictEqual(plan.skippedOpen.length, 0);
  // Combined accessor still reflects the total deduped-away.
  assert.strictEqual(plan.counts.duplicate, 1);
  assert.strictEqual(plan.skippedDuplicate.length, 1);
  assert.strictEqual(plan.counts.toFile, 1);

  // Reporter must label it as a within-scan duplicate, not "already open".
  const out = qs.formatPlan(plan, { apply: false, severityFloor: "fail", cap: 10 }, { findings: [] });
  assert.match(out, /Skipped \(duplicate within scan\): 1/);
  assert.doesNotMatch(out, /Skipped \(already open\): /);
});

test("planTickets: a key already open lands in skippedOpen (not skippedInRun)", () => {
  const key = qs.stableFindingKey(finding());
  const board = boardWith([{ ID: "QSCAN-001", Status: "todo", Description: `[qkey:${key}]` }]);
  const plan = qs.planTickets({ findings: [finding()], board, severityFloor: "fail", cap: 10 });
  assert.strictEqual(plan.counts.skippedOpen, 1);
  assert.strictEqual(plan.counts.skippedInRun, 0);
  const out = qs.formatPlan(plan, { apply: false, severityFloor: "fail", cap: 10 }, { findings: [] });
  assert.match(out, /Skipped \(already open\): 1/);
  assert.doesNotMatch(out, /Skipped \(duplicate within scan\): /);
});

test("openTicketKeys: collects keys only from open tickets", () => {
  const board = boardWith([
    { ID: "A", Status: "todo", Description: "x [qkey:k1]" },
    { ID: "B", Status: "doing", Description: "y [qkey:k2]" },
    { ID: "C", Status: "done", Description: "z [qkey:k3]" },
  ]);
  const keys = qs.openTicketKeys(board);
  assert.ok(keys.has("k1") && keys.has("k2"));
  assert.ok(!keys.has("k3"));
});

// --- cap -------------------------------------------------------------------
test("planTickets: cap limits filed count, surfaces the remainder (no silent drop)", () => {
  const findings = [];
  for (let i = 0; i < 10; i += 1) findings.push(finding({ file: `f${i}.js` }));
  const plan = qs.planTickets({ findings, board: boardWith([]), severityFloor: "fail", cap: 3 });
  assert.strictEqual(plan.counts.toFile, 3);
  assert.strictEqual(plan.counts.capped, 7);
  // Nothing lost: eligible == toFile + capped.
  assert.strictEqual(plan.counts.eligible, plan.counts.toFile + plan.counts.capped);
});

test("planTickets: cap prefers higher priority (P2 before P3)", () => {
  const findings = [
    finding({ file: "warn1.js", severity: "warn" }), // P3
    finding({ file: "fail1.js", severity: "fail" }), // P2
  ];
  const plan = qs.planTickets({ findings, board: boardWith([]), severityFloor: "warn", cap: 1 });
  assert.strictEqual(plan.toFile.length, 1);
  assert.strictEqual(plan.toFile[0].pri, "P2");
});

// --- apply path with a MOCKED gov runner (no real board mutation) ----------
test("applyPlan: shells each proposal through the injected runner", () => {
  const calls = [];
  const fakeRunner = (bin, args) => {
    calls.push({ bin, args });
    const id = `QSCAN-00${calls.length}`;
    return { status: 0, stdout: `Created related follow-up ticket ${id} after COORD-083.\n`, stderr: "" };
  };
  const plan = qs.planTickets({
    findings: [finding({ file: "x.js" }), finding({ file: "y.js" })],
    board: boardWith([]),
    severityFloor: "fail",
    cap: 10,
  });
  const res = qs.applyPlan(plan, qs.DEFAULT_OPTIONS, fakeRunner);
  assert.strictEqual(res.created.length, 2);
  assert.strictEqual(res.failed.length, 0);
  assert.strictEqual(res.created[0].ticket, "QSCAN-001");
  // open-followup invocation shape.
  assert.ok(calls[0].args.includes("open-followup"));
  assert.ok(calls[0].args.includes("--depends-on"));
  assert.ok(calls[0].args.includes("--relation"));
});

test("applyPlan: a non-zero gov exit is captured as a failure, not a crash", () => {
  const fakeRunner = () => ({ status: 1, stdout: "", stderr: "boom" });
  const plan = qs.planTickets({ findings: [finding()], board: boardWith([]), severityFloor: "fail", cap: 10 });
  const res = qs.applyPlan(plan, qs.DEFAULT_OPTIONS, fakeRunner);
  assert.strictEqual(res.created.length, 0);
  assert.strictEqual(res.failed.length, 1);
  assert.match(res.failed[0].error, /boom/);
});

// --- CLI: dry-run is the default and writes nothing -------------------------
test("runCli: default (no --apply) is dry-run and never invokes the runner", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qscan-"));
  try {
    // a target file over the size budget
    fs.writeFileSync(path.join(tmp, "big.js"), Array.from({ length: 1600 }, (_, i) => `const x${i}=${i};`).join("\n"));
    const boardPath = path.join(tmp, "board.json");
    fs.writeFileSync(boardPath, JSON.stringify(boardWith([])));

    let ran = false;
    const runner = () => { ran = true; return { status: 0, stdout: "", stderr: "" }; };
    let outBuf = "";
    const out = { write: (s) => { outBuf += s; } };
    const err = { write: () => {} };

    const code = qs.runCli(
      ["--root", tmp, "--board", boardPath, "--severity-floor", "warn", "--cap", "5"],
      { stdout: out, stderr: err },
      runner
    );
    assert.strictEqual(code, 0);
    assert.strictEqual(ran, false, "dry-run must NOT call the gov runner");
    assert.match(outBuf, /mode=dry-run/);
    assert.match(outBuf, /Would file/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runCli: --apply invokes the runner against the (temp) board", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qscan-"));
  try {
    fs.writeFileSync(path.join(tmp, "big.js"), Array.from({ length: 1600 }, (_, i) => `const x${i}=${i};`).join("\n"));
    const boardPath = path.join(tmp, "board.json");
    fs.writeFileSync(boardPath, JSON.stringify(boardWith([])));

    const calls = [];
    const runner = (bin, args) => {
      calls.push(args);
      return { status: 0, stdout: "Created related follow-up ticket QSCAN-001 after COORD-083.\n", stderr: "" };
    };
    let outBuf = "";
    const out = { write: (s) => { outBuf += s; } };
    const err = { write: () => {} };

    const code = qs.runCli(
      ["--root", tmp, "--board", boardPath, "--apply", "--severity-floor", "warn"],
      { stdout: out, stderr: err },
      runner
    );
    assert.strictEqual(code, 0);
    assert.ok(calls.length >= 1, "apply must call the runner at least once");
    assert.match(outBuf, /FILED QSCAN-001/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- COORD-286: --propose files quarantined `proposed` tickets ------------
// BACKCOMPAT: default DEFAULT_OPTIONS.status is `todo` and the filing path is
// the historical `gov open-followup` (already exercised by the applyPlan test
// above, asserted here explicitly so a regression is named).
test("COORD-286 BACKCOMPAT: default status is todo and files via open-followup", () => {
  assert.strictEqual(qs.DEFAULT_OPTIONS.status, "todo");
  const calls = [];
  const runner = (bin, args) => {
    calls.push(args);
    return { status: 0, stdout: "Created related follow-up ticket QSCAN-001 after COORD-083.\n", stderr: "" };
  };
  const plan = qs.planTickets({ findings: [finding()], board: boardWith([]), severityFloor: "fail", cap: 10 });
  const res = qs.applyPlan(plan, qs.DEFAULT_OPTIONS, runner);
  assert.strictEqual(res.created.length, 1);
  assert.ok(calls[0].includes("open-followup"), "default path stays open-followup");
  assert.ok(!calls[0].includes("--status"), "default path does not stamp a status");
});

// PROPOSE-FILES-PROPOSED: --propose routes through the COORD-285 create path
// `gov file-ticket --status proposed` and parses the new "Filed ticket" output.
test("COORD-286 PROPOSE-FILES-PROPOSED: --propose files via file-ticket --status proposed", () => {
  const calls = [];
  const runner = (bin, args) => {
    calls.push(args);
    const id = `QSCAN-00${calls.length}`;
    return { status: 0, stdout: `Filed ticket ${id} (X/refactor/P3, status=proposed).\n`, stderr: "" };
  };
  const opts = Object.assign({}, qs.DEFAULT_OPTIONS, { status: "proposed" });
  const plan = qs.planTickets({
    findings: [finding({ file: "x.js", severity: "warn" })],
    board: boardWith([]),
    severityFloor: "warn",
    cap: 10,
  });
  const res = qs.applyPlan(plan, opts, runner);
  assert.strictEqual(res.created.length, 1);
  assert.strictEqual(res.created[0].ticket, "QSCAN-001", "id parsed from 'Filed ticket' output");
  const args = calls[0];
  assert.ok(args.includes("file-ticket"), "proposed path uses file-ticket (the create verb)");
  assert.ok(!args.includes("open-followup"), "proposed path does NOT use open-followup");
  const si = args.indexOf("--status");
  assert.ok(si !== -1 && args[si + 1] === "proposed", "stamps --status proposed");
  // The qkey marker still rides in --description so dedup is unchanged.
  const di = args.indexOf("--description");
  assert.match(args[di + 1], /\[qkey:size:x\.js:loc\]/);
});

// DEDUP-INCLUDES-PROPOSED: a same-qkey `proposed` row on the board is a dedup
// hit — the cadence is idempotent and does not double-file a proposal.
test("COORD-286 DEDUP-INCLUDES-PROPOSED: an existing proposed ticket dedups (no double-file)", () => {
  const key = qs.stableFindingKey(finding());
  const board = boardWith([
    { ID: "QSCAN-001", Status: "proposed", Description: `[auto-quality] ... [qkey:${key}]` },
  ]);
  // openTicketKeys must collect the key from the proposed (non-closed) row.
  assert.ok(qs.openTicketKeys(board).has(key), "proposed rows contribute qkeys to dedup");
  const plan = qs.planTickets({ findings: [finding()], board, severityFloor: "fail", cap: 10 });
  assert.strictEqual(plan.counts.skippedOpen, 1, "proposed same-qkey row is an already-open skip");
  assert.strictEqual(plan.counts.toFile, 0, "no double-file: idempotent re-run");
});

test("COORD-286: runCli rejects an invalid --status", () => {
  let errBuf = "";
  const err = { write: (s) => { errBuf += s; } };
  const code = qs.runCli(["--status", "doing"], { stdout: { write() {} }, stderr: err });
  assert.strictEqual(code, 2);
  assert.match(errBuf, /invalid --status/);
});

test("COORD-286: --propose CLI dry-run reports status=proposed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qscan-"));
  try {
    fs.writeFileSync(path.join(tmp, "big.js"), Array.from({ length: 1600 }, (_, i) => `const x${i}=${i};`).join("\n"));
    const boardPath = path.join(tmp, "board.json");
    fs.writeFileSync(boardPath, JSON.stringify(boardWith([])));
    let outBuf = "";
    const out = { write: (s) => { outBuf += s; } };
    const code = qs.runCli(
      ["--root", tmp, "--board", boardPath, "--severity-floor", "warn", "--propose"],
      { stdout: out, stderr: { write() {} } },
      () => ({ status: 0, stdout: "", stderr: "" })
    );
    assert.strictEqual(code, 0);
    assert.match(outBuf, /status=proposed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The single-shot cadence runner: runs scan-and-propose ONCE in the cadence
// shape (warn floor + --apply + --propose) and files through file-ticket.
test("COORD-286: quality-propose-cron single-shot runner files proposals once", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qscan-"));
  try {
    fs.writeFileSync(path.join(tmp, "big.js"), Array.from({ length: 1600 }, (_, i) => `const x${i}=${i};`).join("\n"));
    const boardPath = path.join(tmp, "board.json");
    fs.writeFileSync(boardPath, JSON.stringify(boardWith([])));
    const calls = [];
    const runner = (bin, args) => {
      calls.push(args);
      return { status: 0, stdout: `Filed ticket QSCAN-00${calls.length} (X/refactor/P3, status=proposed).\n`, stderr: "" };
    };
    let outBuf = "";
    const code = proposeCron.runScheduledProposal(
      { root: tmp, board: boardPath, cap: 3 },
      { stdout: { write: (s) => { outBuf += s; } }, stderr: { write() {} } },
      runner
    );
    assert.strictEqual(code, 0);
    assert.ok(calls.length >= 1, "runner files at least one proposal");
    assert.ok(calls[0].includes("file-ticket"), "cadence runner uses the proposed create path");
    const si = calls[0].indexOf("--status");
    assert.strictEqual(calls[0][si + 1], "proposed");
    assert.match(outBuf, /status=proposed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runCli: rejects an invalid severity floor", () => {
  let errBuf = "";
  const err = { write: (s) => { errBuf += s; } };
  const code = qs.runCli(["--severity-floor", "bogus"], { stdout: { write() {} }, stderr: err });
  assert.strictEqual(code, 2);
  assert.match(errBuf, /invalid --severity-floor/);
});

test("runCli: rejects a negative cap", () => {
  let errBuf = "";
  const err = { write: (s) => { errBuf += s; } };
  const code = qs.runCli(["--cap", "-1"], { stdout: { write() {} }, stderr: err });
  assert.strictEqual(code, 2);
  assert.match(errBuf, /invalid --cap/);
});

// COORD-882: the quality-propose-cron main() test now runs a COPY of this
// module from a disposable install, so the real file's apply-failure path
// (FAILED line + exit 1) and the P3-after-P2 branch of the cap ordering are no
// longer reached by it. Drive them here, in a temp root with a scratch board
// and an injected runner standing in for gov: nothing is filed anywhere.
test("COORD-882: runCli --apply with a mixed-priority plan files P2 first, reports a refused filing on stderr, and exits 1", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qscan-882-"));
  try {
    const root = path.join(tmp, "root");
    fs.mkdirSync(root);
    // Three identical over-budget files: three size findings, escalated to fail
    // (-> P2) by the config below, reported before two duplication findings
    // (warn -> P3), so the sort must move P3 proposals behind P2 ones.
    const body = Array.from({ length: 1600 }, (_, i) => `const x${i} = ${i};`).join("\n");
    for (const name of ["a.js", "b.js", "c.js"]) fs.writeFileSync(path.join(root, name), body);
    const configPath = path.join(tmp, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ checks: { size: { severity: "fail" } } }));
    const boardPath = path.join(tmp, "board.json");
    const boardBytes = JSON.stringify(boardWith([]));
    fs.writeFileSync(boardPath, boardBytes);

    const calls = [];
    const runner = (bin, args) => {
      calls.push(args);
      const desc = args[args.indexOf("--description") + 1];
      if (desc.includes("[qkey:size:b.js:loc]")) return { status: 1, stdout: "", stderr: "stub gov refused b.js\n" };
      return { status: 0, stdout: "Filed ticket QSCAN-007 (X/refactor/P2, status=proposed).\n", stderr: "" };
    };
    let outBuf = "";
    let errBuf = "";
    const code = qs.runCli(
      ["--root", root, "--board", boardPath, "--config", configPath, "--apply", "--propose", "--severity-floor", "warn", "--cap", "3"],
      { stdout: { write: (s) => { outBuf += s; } }, stderr: { write: (s) => { errBuf += s; } } },
      runner
    );

    assert.strictEqual(code, 1, "a refused filing makes the run exit 1");
    assert.match(outBuf, /eligible=5 to-file=3 capped=2/);
    // The cap keeps the three P2 size proposals and defers both P3 duplication ones.
    assert.strictEqual(calls.length, 3);
    for (const args of calls) {
      assert.ok(args.includes("file-ticket"));
      assert.strictEqual(args[args.indexOf("--pri") + 1], "P2");
    }
    assert.match(outBuf, /Capped \(not filed this run, will resurface next run\): 2\n {2}- \[P3\] duplication:b\.js:dup:[0-9a-f]+\n {2}- \[P3\] duplication:c\.js:dup:[0-9a-f]+\n/);
    assert.match(outBuf, /FILED QSCAN-007: Reduce file size: a\.js \(1600 LOC > 1500\)\nFILED QSCAN-007: Reduce file size: c\.js \(1600 LOC > 1500\)\n/);
    assert.match(errBuf, /^FAILED to file size:b\.js:loc: stub gov refused b\.js\n$/);
    assert.match(outBuf, /quality-scan: filed=2 failed=1\n$/);
    assert.strictEqual(fs.readFileSync(boardPath, "utf8"), boardBytes, "the scratch board is never written");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// COORD-947: the product-repository map finding that files one refresh ticket. Engine
// selection needs no map (gate-plan uses the COORD-924 selector), so the finding covers
// only configured product maps (testPolicy.repoMaps). Fixtures, never live maps.
const affectedScanner = require("./quality-scan.js");
const NOW = new Date("2026-11-12T00:00:00Z");

function productRoot({ updatedAt = "2026-11-10", files = ["src/a.js"], writeFiles = true, configured = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "product-map-finding-"));
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend", "src"), { recursive: true });
  if (writeFiles) fs.writeFileSync(path.join(root, "backend", "src", "a.js"), "");
  const map = { schema_version: 1, updated_at: updatedAt, full_gate: { commands: ["npm test"] }, targets: [{ id: "unit", command: "npm test", files }] };
  const config = configured
    ? { coordTicketPrefix: "COORD", repos: { B: { path: "backend" } }, testPolicy: { repoMaps: { B: map } } }
    : { coordTicketPrefix: "COORD", repos: { B: { path: "backend" } } };
  fs.writeFileSync(path.join(root, "coord", "project.config.js"), `module.exports = ${JSON.stringify(config, null, 2)};\n`);
  return root;
}
const AFFECTED_QKEY = "affected-map:coord/project.config.js:stale:B";

test("affected-map finding: a fresh product map whose files exist reports nothing", () => {
  assert.deepEqual(affectedScanner.affectedMapFindings({ root: productRoot(), now: NOW }), []);
});

test("affected-map finding: a product map older than 90 days is stale", () => {
  const findings = affectedScanner.affectedMapFindings({ root: productRoot({ updatedAt: "2026-06-28" }), now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, "stale:B");
  assert.match(findings[0].message, /stale \(updated_at 2026-06-28 is \d+ days old, over 90\)/);
});

test("affected-map finding: a product map that refers to a missing file is dangling", () => {
  const findings = affectedScanner.affectedMapFindings({ root: productRoot({ files: ["src/a.js", "src/gone.js"] }), now: NOW });
  const dangling = findings.filter((f) => f.value === "dangling:B");
  assert.equal(dangling.length, 1);
  assert.match(dangling[0].message, /missing file\(s\): src\/gone\.js/);
});

test("affected-map finding: a repository without a configured map reports nothing", () => {
  assert.deepEqual(affectedScanner.affectedMapFindings({ root: productRoot({ configured: false }), now: NOW }), []);
});

test("affected-map finding: a root with no project config reports nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "product-map-none-"));
  assert.deepEqual(affectedScanner.affectedMapFindings({ root, now: NOW }), []);
});

test("affected-map finding files exactly one refresh ticket with its text", () => {
  const findings = affectedScanner.affectedMapFindings({ root: productRoot({ updatedAt: "2026-06-28" }), now: NOW });
  const plan = affectedScanner.planTickets({ findings, board: { sections: [] } });
  assert.equal(plan.toFile.length, 1);
  const [proposal] = plan.toFile;
  assert.equal(proposal.key, AFFECTED_QKEY);
  assert.equal(proposal.pri, "P2");
  assert.match(proposal.title, /^Refresh product dependency map \(stale B\): coord\/project\.config\.js$/);
  assert.match(proposal.description, /testPolicy\.repoMaps in coord\/project\.config\.js/);
  assert.match(proposal.description, /Acceptance: every target file exists/);
  assert.ok(proposal.description.includes(`[qkey:${AFFECTED_QKEY}]`));
});

test("affected-map finding is not re-filed while its ticket is open", () => {
  const findings = affectedScanner.affectedMapFindings({ root: productRoot({ updatedAt: "2026-06-28" }), now: NOW });
  const open = { sections: [{ rows: [{ ID: "COORD-990", Status: "todo", Description: `refresh [qkey:${AFFECTED_QKEY}]` }] }] };
  const plan = affectedScanner.planTickets({ findings, board: open });
  assert.equal(plan.toFile.length, 0);
  assert.equal(plan.skippedOpen.length, 1);
  const closed = { sections: [{ rows: [{ ID: "COORD-990", Status: "done", Description: `refresh [qkey:${AFFECTED_QKEY}]` }] }] };
  assert.equal(affectedScanner.planTickets({ findings, board: closed }).toFile.length, 1);
});

test("affected-map finding is surfaced by doctor as a cheap warning line", () => {
  const warnings = affectedScanner.affectedMapDoctorWarnings({ root: productRoot({ updatedAt: "2026-06-28" }), now: NOW });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[affected-map\] product dependency map B is stale/);
  assert.deepEqual(affectedScanner.affectedMapDoctorWarnings({ root: productRoot(), now: NOW }), []);
});

test("COORD-1052: unreadable product configuration remains actionable scan and doctor evidence", (t) => {
  const root = productRoot();
  const configPath = path.join(root, "coord", "project.config.js");
  t.after(() => { delete require.cache[configPath]; fs.rmSync(root, { recursive: true, force: true }); });
  for (const source of ['throw new Error("fixture config unavailable");', 'throw "fixture config unavailable";']) {
    fs.writeFileSync(configPath, source);
    const findings = qs.affectedMapFindings({ root, now: NOW });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, "affected-map");
    assert.equal(findings[0].severity, "fail");
    assert.equal(findings[0].value, "unreadable");
    assert.match(findings[0].message, /project config could not be loaded: fixture config unavailable/);
    const warnings = qs.affectedMapDoctorWarnings({ root, now: NOW });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /fixture config unavailable.*Refresh the testPolicy\.repoMaps entry/);
    const plan = qs.planTickets({ findings, board: boardWith([]) });
    assert.equal(plan.toFile.length, 1, "a configuration failure must remain visible as actionable debt");
    assert.match(plan.toFile[0].description, /fixture config unavailable/);
  }
  fs.writeFileSync(configPath, "module.exports = null;\n");
  assert.deepEqual(qs.affectedMapFindings({ root, now: NOW }), [], "a config exporting no maps has no product-map debt");
});

test("COORD-1052: undated maps and malformed target lists do not invent missing product files", (t) => {
  const root = productRoot();
  const configPath = path.join(root, "coord", "project.config.js");
  t.after(() => { delete require.cache[configPath]; fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(configPath, `module.exports = ${JSON.stringify({
    repos: { C: { path: "backend" }, D: { path: "backend" } },
    testPolicy: { repoMaps: {
      B: null,
      C: { updated_at: "invalid-date", targets: "not-a-list" },
      D: { updated_at: "2026-11-10", targets: [{ files: null }] },
    } },
  })};\n`);
  const findings = qs.affectedMapFindings({ root, now: NOW });
  assert.deepEqual(findings.map((entry) => entry.value), ["stale:B", "stale:C"]);
  assert.ok(findings.every((entry) => entry.message.includes("undated")));
  assert.ok(findings.every((entry) => !entry.value.startsWith("dangling:")), "absent lists are not invented file paths");
});

test("COORD-1052: dangling map reports normalize, deduplicate and bound missing paths", (t) => {
  const root = productRoot({ files: ["src\\z.js/", "src/f.js", "src/e.js", "src/d.js", "src/c.js", "src/b.js", "src/b.js", "", "src/a.js/"] });
  const configPath = path.join(root, "coord", "project.config.js");
  t.after(() => { delete require.cache[configPath]; fs.rmSync(root, { recursive: true, force: true }); });
  const findings = qs.affectedMapFindings({ root, now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, "dangling:B");
  assert.equal(findings[0].message,
    "product dependency map B is refers to missing file(s): src/b.js, src/c.js, src/d.js, src/e.js, src/f.js (+1 more)");
  assert.ok(!findings[0].message.includes("src/a.js"), "existing normalized paths stay out of missing-file evidence");
});

test("COORD-1052: malformed product target entries become doctor warnings instead of crashing diagnostics", (t) => {
  const root = productRoot();
  const configPath = path.join(root, "coord", "project.config.js");
  t.after(() => { delete require.cache[configPath]; fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(configPath, `module.exports = ${JSON.stringify({ repos: { B: { path: "backend" } },
    testPolicy: { repoMaps: { B: { updated_at: "2026-11-10", targets: [null] } } } })};\n`);
  const warnings = qs.affectedMapDoctorWarnings({ root, now: NOW });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[affected-map\] staleness check did not complete:.*files/);
  fs.writeFileSync(configPath, 'module.exports = { repos: { B: { path: "backend" } }, testPolicy: { repoMaps: { B: { get targets() { throw "invalid target list"; } } } } };');
  assert.deepEqual(qs.affectedMapDoctorWarnings({ root, now: NOW }), [
    "[affected-map] staleness check did not complete: invalid target list",
  ]);
});

test("COORD-1052: scanner replacement invokes only the current registered implementation", (t) => {
  const root = productRoot({ configured: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The public registry has no unregister API. Keep registration confined to a
  // disposable child while importing the actual canonical module, not a copy.
  const script = `
    const qs = require(process.argv[1]);
    let calls = 0;
    qs.registerScanner("fixture-replacement", () => { throw new Error("obsolete scanner ran"); });
    qs.registerScanner("fixture-replacement", ({ root }) => {
      calls += 1;
      if (root !== process.argv[2]) throw new Error("wrong scanner root");
      return [{ check: "fixture-check", file: "fixture.js", severity: "warn", value: 1, threshold: 0, message: "current scanner" }];
    });
    const result = qs.scan({ root: process.argv[2] });
    console.log(JSON.stringify({ calls, findings: result.findings.filter((entry) => entry.check === "fixture-check") }));
  `;
  const result = require("node:child_process").spawnSync(process.execPath,
    ["-e", script, require.resolve("./quality-scan.js"), root], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.calls, 1);
  assert.deepEqual(observed.findings, [{ check: "fixture-check", file: "fixture.js", severity: "warn", value: 1, threshold: 0, message: "current scanner" }]);
});

test("registered scanners use the repository root by default and honor an explicit root", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "quality-default-root-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const script = `
    const qs = require(process.argv[1]);
    const assert = require("node:assert/strict");
    let scannerRoot;
    qs.registerScanner("fixture-root", ({ root }) => {
      scannerRoot = root;
      return [];
    });
    qs.scan();
    assert.equal(scannerRoot, process.argv[2]);
    qs.scan({ root: process.cwd() });
    assert.equal(scannerRoot, process.cwd());
  `;
  const result = require("node:child_process").spawnSync(process.execPath,
    ["-e", script, require.resolve("./quality-scan.js"), path.resolve(__dirname, "..", "..", "..")],
    { cwd, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
