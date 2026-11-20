"use strict";

// COORD-722: the approved reconcile packet parser and the gitignored-runtime
// filter applied to a missing-baseline adoption.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseReconcilePacket, dropRuntimeLedgerPaths, assertReconcileSnapshotMatchesPacket } = require("./reconcile-packet.js");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const coordDir = path.join(path.sep, "ws", "coord");
const fail = (message) => { throw new Error(message); };
const parse = (text) => parseReconcilePacket(text, { coordDir, fail });

test("COORD-722: markdown packet ignores tables without path and sha256 columns and keeps the approved table", () => {
  const packet = parse([
    "# Approval packet",
    "",
    "| field | value |",
    "| --- | --- |",
    "| approver | human admin |",
    "",
    "| path | sha256 |",
    "| :--- | ---: |",
    `| \`coord/docs/decisions/ADR-001.md\` | ${HASH_A.toUpperCase()} |`,
    "| coord/PLAN.md | absent |",
  ].join("\n"));
  assert.deepEqual([...packet], [["docs/decisions/ADR-001.md", HASH_A], ["PLAN.md", "absent"]]);
});

test("COORD-722: markdown packet row missing its sha256 cell is refused", () => {
  assert.throws(() => parse(["| path | sha256 |", "| --- | --- |", "| coord/PLAN.md |"].join("\n")),
    /table row on line 3 needs a repo-relative path and a sha256 \(or "absent"\): \| coord\/PLAN\.md \|/);
});

test("COORD-722: markdown packet row missing its path cell is refused", () => {
  assert.throws(() => parse(["| sha256 | path |", "| --- | --- |", `| ${HASH_B} |`].join("\n")),
    /table row on line 3 needs a repo-relative path and a sha256/);
});

test("COORD-722: line packet and duplicate or empty packets", () => {
  assert.deepEqual([...parse(`# comment\n\n${HASH_A}  PLAN.md\nabsent docs/x.md\n`)],
    [["PLAN.md", HASH_A], ["docs/x.md", "absent"]]);
  assert.throws(() => parse("not a packet line"), /line 1 is not "<sha256\|absent> <path>"/);
  assert.throws(() => parse(`${HASH_A} PLAN.md\n${HASH_B} PLAN.md`), /lists PLAN\.md more than once/);
  assert.throws(() => parse("# only a comment\n"), /names no paths/);
});

test("COORD-836: packet parser refuses mixed formats and non-normalized, absolute, or traversal paths", () => {
  const markdown = `| path | sha256 |\n| --- | --- |\n| coord/docs/x.md | ${HASH_A} |`;
  assert.throws(() => parse(`${markdown}\n${HASH_B} docs/y.md`), /exactly one packet format; mixed table and line/);
  for (const value of ["./PLAN.md", "../outside.md", "/tmp/outside.md", "C:/outside.md", "docs\\x.md", "docs//x.md"]) {
    assert.throws(() => parse(`${HASH_A} ${value}`), /normalized relative POSIX path/,
      `line path ${JSON.stringify(value)} must be refused`);
  }
});

test("COORD-836: markdown packet paths must be normalized repo-relative coord paths", () => {
  for (const value of ["./coord/PLAN.md", "coord/../outside.md", "/tmp/outside.md", "../coord/PLAN.md", "coord\\PLAN.md", "other/PLAN.md"]) {
    assert.throws(() => parse(`| path | sha256 |\n| --- | --- |\n| ${value} | ${HASH_A} |`),
      /normalized relative POSIX path|repo-relative under coord\//,
      `table path ${JSON.stringify(value)} must be refused`);
  }
});

test("COORD-836: only recoverable sessions and locks are omitted; durable runtime evidence stays governed", () => {
  const relativePaths = ["PLAN.md", "ignored/governed.json", ".runtime/locks/T-1.lock", ".runtime/agent_sessions.json",
    ".runtime/plans/T-1.json", ".runtime/agents.json"];
  assert.deepEqual(dropRuntimeLedgerPaths(relativePaths), ["PLAN.md", "ignored/governed.json", ".runtime/plans/T-1.json"]);
  assert.deepEqual(dropRuntimeLedgerPaths([undefined, ".runtime/locks/T-1.lock"]), [undefined],
    "absent path evidence is not treated as an exempt runtime path");
});

test("COORD-836: a Git ignored governed path remains in the approval set", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-722-packet-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n*.lock\n");
    const paths = ["PLAN.md", "ignored/governed.json", "nested/T-1.lock", ".runtime/locks/T-1.lock"];
    assert.equal(spawnSync("git", ["check-ignore", "ignored/governed.json", "nested/T-1.lock"], { cwd: root }).status, 0);
    assert.deepEqual(dropRuntimeLedgerPaths(paths), ["PLAN.md", "ignored/governed.json", "nested/T-1.lock"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-836: after-snapshot validation binds exact packet paths and bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-836-after-snapshot-"));
  try {
    const approvedBytes = Buffer.from("approved\n");
    fs.writeFileSync(path.join(root, "approved.md"), approvedBytes);
    const hash = crypto.createHash("sha256").update(approvedBytes).digest("hex");
    const sha1 = crypto.createHash("sha1").update(approvedBytes.toString("utf8"), "utf8").digest("hex");
    const absentDigest = crypto.createHash("sha1").update("").digest("hex");
    const before = { files: [{ path: "approved.md", exists: true, digest: sha1 }, { path: "removed.md", exists: false, digest: absentDigest }] };
    const unchanged = { files: [...before.files] };
    const fail = (message) => { throw new Error(message); };
    assert.equal(assertReconcileSnapshotMatchesPacket(new Map([["approved.md", hash]]), before, unchanged, { coordDir: root, fail }), undefined);
    assert.equal(assertReconcileSnapshotMatchesPacket(new Map([["removed.md", "absent"]]), before, unchanged, { coordDir: root, fail }), undefined);
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["approved.md", hash]]), before,
      { files: [{ path: "approved.md", exists: true, digest: sha1 }, { path: "late.md", exists: true, digest: "late" }] }, { coordDir: root, fail }), /changed after packet validation: late\.md/);
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["approved.md", hash]]), before,
      { files: [{ path: "approved.md", exists: false, digest: sha1 }] }, { coordDir: root, fail }), /changed after packet validation: approved\.md/);
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["approved.md", hash]]), before,
      { files: [{ path: "approved.md", exists: true, digest: "changed" }] }, { coordDir: root, fail }), /changed after packet validation: approved\.md/);
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["approved.md", hash]]), null, unchanged,
      { coordDir: root, fail }), /changed after packet validation: approved\.md/,
    "a missing before-snapshot cannot silently validate a later file");
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["approved.md", hash]]), before, null,
      { coordDir: root, fail }), /changed after packet validation: approved\.md/,
    "a missing after-snapshot cannot silently validate an approved file");
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["approved.md", "0".repeat(64)]]), before, unchanged,
      { coordDir: root, fail }), /does not match the approved bytes/);
    assert.equal(assertReconcileSnapshotMatchesPacket(new Map(),
      { files: [{ path: ".runtime/agent_sessions.json", exists: true, digest: "before" }] },
      { files: [{ path: ".runtime/agent_sessions.json", exists: true, digest: "after" }] }, { coordDir: root, fail }), undefined,
    "recoverable session churn remains exempt from mutation-snapshot comparison");
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map(),
      { files: [{ path: ".runtime/plans/T-1.json", exists: true, digest: "before" }] },
      { files: [{ path: ".runtime/plans/T-1.json", exists: true, digest: "after" }] }, { coordDir: root, fail }),
    /changed after packet validation: \.runtime\/plans\/T-1\.json/,
    "durable plan records remain bound even though they live under .runtime");
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["approved.md", "absent"]]), before, unchanged,
      { coordDir: root, fail }), /approved absent/);
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["missing.md", hash]]),
      { files: [{ path: "missing.md", exists: true, digest: sha1 }] },
      { files: [{ path: "missing.md", exists: true, digest: sha1 }] }, { coordDir: root, fail }), /could not be read/);
    assert.throws(() => assertReconcileSnapshotMatchesPacket(new Map([["missing.md", hash]]),
      { files: [] }, { files: [] }, { coordDir: root, fail }), /is absent from the actual after-snapshot/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
