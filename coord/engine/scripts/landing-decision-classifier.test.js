"use strict";
// COORD-1025: the docs/decisions classifier. Human-admin ruling 2026-11-16 ("Keep
// packet for acceptance"): a Status line or README index row set to Accepted or
// Superseded, and any Approval State change, need the approved packet; other
// metadata edits (Date, Supersedes, links, Status to other values) admit. The
// real-diff cases read ADR files from fixed commits of this repository's history
// (COORD-1024 acceptance 0b57a9f2, COORD-966 0049c3d7).
const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { classifyDecisionChange, adrLineKinds, lineDiff } = require("./landing-decision-classifier.js");

const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DECISIONS = "coord/docs/decisions";
const ACCEPTANCE = "0b57a9f2";
const ADR_0025_CREATED = "0049c3d7";
// COORD-1049: the real diffs are checked in as full-context patches, so the tests need no git history.
const FIXTURE_DIR = path.join(__dirname, "__fixtures__", "landing-decision");
const ACCEPTANCE_PATCHES = {
  "0023-attempt-aware-coordination-parallel-attempts-are-allowed-and-integration.md": "coord-1024-0b57a9f2-adr-0023.patch",
  "0024-cross-domain-collaboration-runs-as-a-separate-service-that-never-mutates.md": "coord-1024-0b57a9f2-adr-0024.patch",
  "0026-duplicate-ticket-check-before-filing.md": "coord-1024-0b57a9f2-adr-0026.patch",
  "README.md": "coord-1024-0b57a9f2-readme.patch",
  "0025-full-suite-triggers-and-sharding-for-per-pr-impact-radius-gates.md": "coord-1024-0b57a9f2-adr-0025.patch",
};
const CREATED_PATCH = "coord-966-0049c3d7-adr-0025.patch";

// Reads one checked-in fixture patch (a single full-context hunk) and returns the old and new
// file text it encodes. A "/dev/null" side returns null (an added or deleted file).
function readPatch(name) {
  const lines = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8").split("\n");
  const minus = lines.findIndex((line) => line.startsWith("--- "));
  assert.ok(minus >= 0 && lines[minus + 1]?.startsWith("+++ "), `${name}: a unified diff header is required`);
  const hunkAt = lines.findIndex((line, i) => i > minus && line.startsWith("@@ "));
  const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[hunkAt] ?? "");
  assert.ok(header, `${name}: one hunk header is required`);
  const oldCount = header[1] === undefined ? 1 : Number(header[1]);
  const newCount = header[2] === undefined ? 1 : Number(header[2]);
  const oldSide = [], newSide = [];
  let oldSeen = 0, newSeen = 0, last = null;
  for (let i = hunkAt + 1; oldSeen < oldCount || newSeen < newCount; i += 1) {
    const line = lines[i];
    assert.ok(line !== undefined, `${name}: the hunk ends before its counts`);
    if (line.startsWith("\\")) {
      for (const side of last ?? []) side[side.length - 1].eol = false;
      continue;
    }
    const mark = line[0], text = line.slice(1);
    if (mark === " ") { oldSide.push({ text, eol: true }); newSide.push({ text, eol: true }); oldSeen += 1; newSeen += 1; last = [oldSide, newSide]; }
    else if (mark === "-") { oldSide.push({ text, eol: true }); oldSeen += 1; last = [oldSide]; }
    else if (mark === "+") { newSide.push({ text, eol: true }); newSeen += 1; last = [newSide]; }
    else assert.fail(`${name}: unexpected hunk line ${i + 1}`);
  }
  const join = (side) => side.map((entry) => entry.text + (entry.eol ? "\n" : "")).join("");
  return {
    oldText: lines[minus].slice(4) === "/dev/null" ? null : join(oldSide),
    newText: lines[minus + 1].slice(4) === "/dev/null" ? null : join(newSide),
  };
}
function showAt(rev, file) {
  const result = spawnSync("git", ["-C", REPO_ROOT, "show", `${rev}:${file}`], { encoding: "utf8" });
  assert.equal(result.status, 0, `git show ${rev}:${file} must resolve in history: ${result.stderr}`);
  return result.stdout;
}
function acceptanceDiff(file) {
  const sides = readPatch(ACCEPTANCE_PATCHES[file]);
  return classifyDecisionChange({ path: file, oldText: sides.oldText, newText: sides.newText });
}

test("COORD-1025 real diff: the COORD-1024 acceptance of ADRs 0023, 0024 and 0026 requires the packet (Status Accepted and Approval State)", () => {
  for (const file of [
    "0023-attempt-aware-coordination-parallel-attempts-are-allowed-and-integration.md",
    "0024-cross-domain-collaboration-runs-as-a-separate-service-that-never-mutates.md",
    "0026-duplicate-ticket-check-before-filing.md",
  ]) {
    const verdict = acceptanceDiff(file);
    assert.equal(verdict.kind, "body", file);
    assert.ok(verdict.bodyLines.includes("+- **Status:** Accepted"), `${file}: the Status line set to Accepted is named`);
    assert.ok(verdict.reason.includes("Status set to Accepted or Superseded"), `${file}: reason is ${verdict.reason}`);
    assert.ok(verdict.reason.includes("Approval State changed"), `${file}: the Approval State edit is named too`);
  }
});

test("COORD-1025 real diff: the COORD-1024 acceptance index rows in README.md require the packet", () => {
  const verdict = acceptanceDiff("README.md");
  assert.equal(verdict.kind, "body", JSON.stringify(verdict.bodyLines));
  assert.equal(verdict.bodyLines.filter((line) => line.startsWith("+")).length, 4, "the four Accepted rows are the added body lines");
  assert.ok(verdict.reason.includes("README index row set to Accepted or Superseded"));
});

test("COORD-1025 real diff: ADR 0025 in the same acceptance is body, because of its Decision-section paragraph and its Approval State", () => {
  const verdict = acceptanceDiff("0025-full-suite-triggers-and-sharding-for-per-pr-impact-radius-gates.md");
  assert.equal(verdict.kind, "body");
  assert.ok(
    verdict.bodyLines.some((line) => line === "+**Radius threshold (human-admin choice, 2026-11-15).** The human admin chose the 70% of suites option from Options Evaluated, item 2. The radius trigger in decision 2(b) therefore fires when the affected set exceeds 70% of suites."),
    "the added Decision-section paragraph is named as a body change",
  );
});

test("COORD-1025 real diff: the creation of ADR 0025 (a new file) is body", () => {
  const file = "0025-full-suite-triggers-and-sharding-for-per-pr-impact-radius-gates.md";
  const verdict = classifyDecisionChange({ path: file, oldText: null, newText: readPatch(CREATED_PATCH).newText });
  assert.equal(verdict.kind, "body");
  assert.equal(verdict.reason, "added or replaced file");
});

test("COORD-1025: Date, Supersedes and link edits admit, and so does a Status set to Deprecated", () => {
  const before = "# ADR 9001: Title\n\n- **Status:** Deprecated\n- **Date:** 2026-11\n- **Supersedes:** ADR 0001\n- **Linked scope:** `coord/a.js`\n\n## Decision\n\nKeep it.\n";
  const after = "# ADR 9001: Title\n\n- **Status:** Deprecated\n- **Date:** 2026-11-16\n- **Supersedes:** ADR 0002\n- **Linked scope:** `coord/b.js`\n\n## Decision\n\nKeep it.\n";
  const verdict = classifyDecisionChange({ path: `${DECISIONS}/9001-x.md`, oldText: before, newText: after });
  assert.equal(verdict.kind, "metadata", JSON.stringify(verdict.bodyLines));
  assert.equal(verdict.metadataLines, 6);
  const proposedToDeprecated = classifyDecisionChange({ path: `${DECISIONS}/9001-x.md`,
    oldText: "# ADR 9001\n\n- **Status:** Proposed\n\n## Decision\n\nK.\n", newText: "# ADR 9001\n\n- **Status:** Deprecated\n\n## Decision\n\nK.\n" });
  assert.equal(proposedToDeprecated.kind, "metadata", "a Status change to a value other than Accepted or Superseded admits");
});

test("COORD-1025: a Status set to Accepted or Superseded requires the packet, from any prior value", () => {
  for (const [from, to] of [["Proposed", "Accepted"], ["Accepted", "Superseded by ADR-0002"], ["Proposed", "Superseded"], ["Deprecated", "Accepted"]]) {
    const before = `# ADR 9002\n\n- **Status:** ${from}\n\n## Decision\n\nK.\n`;
    const after = `# ADR 9002\n\n- **Status:** ${to}\n\n## Decision\n\nK.\n`;
    const verdict = classifyDecisionChange({ path: `${DECISIONS}/9002-t.md`, oldText: before, newText: after });
    assert.equal(verdict.kind, "body", `${from} to ${to}`);
    assert.ok(verdict.reason.includes("Status set to Accepted or Superseded"), `${from} to ${to}`);
  }
});

test("COORD-1025: any change to the Approval State section requires the packet, even alongside a Date edit", () => {
  const before = "# ADR 9003\n\n- **Date:** 2026-11\n\n## Decision\n\nK.\n\n## Approval State\n\nProposed only.\n";
  const after = "# ADR 9003\n\n- **Date:** 2026-11-16\n\n## Decision\n\nK.\n\n## Approval State\n\nDeprecated.\n";
  const verdict = classifyDecisionChange({ path: `${DECISIONS}/9003-t.md`, oldText: before, newText: after });
  assert.equal(verdict.kind, "body");
  assert.ok(verdict.reason.includes("Approval State changed"));
  assert.equal(verdict.metadataLines, 2, "the Date edit itself is metadata");
});

test("COORD-1025: a Decision-section edit is body even when it looks like a status line", () => {
  const before = "# ADR 9004: T\n\n- **Status:** Deprecated\n\n## Decision\n\nUse the queue.\n";
  const after = "# ADR 9004: T\n\n- **Status:** Deprecated\n\n## Decision\n\nUse the queue.\n- **Status:** Accepted for all\n";
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/9004-t.md`, oldText: before, newText: after }).kind, "body");
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/9004-t.md`, oldText: before, newText: before.replace("queue", "stack") }).kind, "body");
});

test("COORD-1025: a title, a heading, a context section, a moved status line or a plain-text field outside the leading block is body", () => {
  const base = "# ADR 9005: Title\n\n- **Status:** Deprecated\n\n## Context\n\nA.\n\n## Decision\n\nB.\n";
  for (const [label, text] of [
    ["title", base.replace("Title", "Renamed")],
    ["heading", base.replace("## Context", "## Background")],
    ["context prose", base.replace("A.", "A changed.")],
    ["status moved into a body section", base.replace("- **Status:** Deprecated\n", "").replace("## Decision\n\nB.\n", "## Decision\n\nB.\n- **Status:** Deprecated\n")],
    ["plain-text field outside the leading block", base.replace("A.", "Status: Deprecated")],
    ["status line removed with no replacement", base.replace("- **Status:** Deprecated\n", "")],
  ]) {
    const verdict = classifyDecisionChange({ path: `${DECISIONS}/9005-t.md`, oldText: base, newText: text });
    assert.equal(verdict.kind, "body", label);
  }
});

test("COORD-1025: a mixed change, metadata plus body, is body", () => {
  const before = "# ADR 9006: T\n\n- **Date:** 2026-11\n\n## Decision\n\nX.\n";
  const after = "# ADR 9006: T\n\n- **Date:** 2026-11-16\n\n## Decision\n\nY.\n";
  const verdict = classifyDecisionChange({ path: `${DECISIONS}/9006-t.md`, oldText: before, newText: after });
  assert.equal(verdict.kind, "body");
  assert.equal(verdict.bodyLines.length, 2);
});

test("COORD-1025: a deleted file, a mode-only change and an oversized diff are body", () => {
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/9007.md`, oldText: "x\n", newText: null }).reason, "deleted file");
  const same = "# ADR 9007\n\n- **Status:** Deprecated\n";
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/9007.md`, oldText: same, newText: same }).reason, "mode or type change without a text change");
  const old = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
  const changed = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/9007.md`, oldText: old, newText: changed }).reason, "diff too large to classify line by line");
});

test("COORD-1025: README index rows admit only for a non-Accepted, non-Superseded Status cell", () => {
  const before = "| Num | Title | Status |\n| --- | --- | --- |\n| [0030](./0030-x.md) | Some title | Proposed |\n";
  const deprecated = before.replace("| Proposed |", "| Deprecated |");
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/README.md`, oldText: before, newText: deprecated }).kind, "metadata");
  const accepted = before.replace("| Proposed |", "| Accepted |");
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/README.md`, oldText: before, newText: accepted }).kind, "body");
  const titleChanged = before.replace("Some title", "Other title");
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/README.md`, oldText: before, newText: titleChanged }).kind, "body");
  const newRow = `${before}| [0031](./0031-y.md) | New | Deprecated |\n`;
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/README.md`, oldText: before, newText: newRow }).kind, "body", "a new index row is body");
  const prose = before.replace("| Num |", "| Index |");
  assert.equal(classifyDecisionChange({ path: `${DECISIONS}/README.md`, oldText: before, newText: prose }).kind, "body", "a non-row header change is body");
});

test("COORD-1025: the line diff and per-line kinds are exact on small inputs", () => {
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c"]), { removed: [1], added: [1] });
  assert.deepEqual(lineDiff(["a"], ["a", "b"]), { removed: [], added: [1] });
  assert.deepEqual(adrLineKinds("# T\n- **Date:** x\n\n## Approval State\nok\n## Decision\nbody"),
    ["body", "metadata", "metadata", "body", "body", "body", "body"]);
  assert.deepEqual(adrLineKinds("# T\n- **Status:** Accepted\n"), ["body", "body", "metadata"], "a new Accepted Status line is body");
  assert.deepEqual(adrLineKinds("# T\n- **Status:** Accepted\n", "old"), ["body", "metadata", "metadata"], "the old side does not decide");
});

// COORD-1049: re-derives the checked-in fixtures from git history and asserts they match. It needs
// the two source commits; a release cut or a no-history copy has none, so the test skips with the reason.
function historySkipReason() {
  const missing = [ACCEPTANCE, ADR_0025_CREATED].filter((rev) =>
    spawnSync("git", ["-C", REPO_ROOT, "cat-file", "-e", `${rev}^{commit}`], { encoding: "utf8" }).status !== 0);
  return missing.length === 0 ? false : `git history for ${missing.join(", ")} is absent from this tree (release cut or no-history copy); the checked-in fixtures are the test input`;
}
test("COORD-1049 fixtures: the checked-in patches equal the real history of commits 0b57a9f2 and 0049c3d7", { skip: historySkipReason() }, () => {
  for (const [file, patch] of Object.entries(ACCEPTANCE_PATCHES)) {
    const sides = readPatch(patch);
    const filePath = `${DECISIONS}/${file}`;
    assert.equal(sides.oldText, showAt(`${ACCEPTANCE}^`, filePath), `${patch}: old side`);
    assert.equal(sides.newText, showAt(ACCEPTANCE, filePath), `${patch}: new side`);
  }
  const created = `${DECISIONS}/0025-full-suite-triggers-and-sharding-for-per-pr-impact-radius-gates.md`;
  assert.equal(readPatch(CREATED_PATCH).oldText, null, "the created file has no old side");
  assert.equal(readPatch(CREATED_PATCH).newText, showAt(ADR_0025_CREATED, created), `${CREATED_PATCH}: new side`);
});
