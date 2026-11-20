"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Only exact deterministic projections may be adopted. Call under the journal
// transaction lock, before any drift adoption or writes. No path-only exemption.
function proveDerivedSync({ baseline, current, outputs, resolvePath, digest, expectedDigest = baseline?.digest }) {
  if (!baseline || !current || !Array.isArray(baseline.files)) return null;
  if (baseline.digest !== expectedDigest || baseline.digest !== digest(JSON.stringify(baseline.files))) return null;
  const before = new Map(baseline.files.map((e) => [e.path, e]));
  const after = new Map(current.files.map((e) => [e.path, e]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => {
    const a = before.get(p), b = after.get(p);
    return !a || !b || a.exists !== b.exists || a.digest !== b.digest;
  });
  if (!changed.length) return null;
  const rendered = new Map(outputs.map((o) => [path.resolve(o.path), o.content]));
  // Check ALL snapshot differences, including ones ordinarily ignored as runtime
  // noise. A concurrent identity refresh can retry; it cannot widen this proof.
  if (changed.some((p) => !rendered.has(path.resolve(resolvePath(p))))) return null;
  for (const entry of current.files) {
    if (!entry.exists) continue;
    const file = path.resolve(resolvePath(entry.path));
    let cursor = file;
    while (true) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!fs.lstatSync(file).isFile()) return null;
    if (digest(fs.readFileSync(file, "utf8")) !== entry.digest) return null;
  }
  for (const p of changed) {
    const file = path.resolve(resolvePath(p));
    const previous = before.get(p);
    if (!previous || !previous.exists || !after.get(p)?.exists) return null;
    const stat = fs.lstatSync(file);
    if (stat.mode & 0o111) return null;
    if (!fs.readFileSync(file).equals(Buffer.from(rendered.get(file), "utf8"))) return null;
  }
  return changed.map((p) => ({ path: p, before_digest: before.get(p).digest, after_digest: after.get(p).digest }));
}
// Rendering policy inputs are sealed in every snapshot (COORD-935). Legacy
// snapshots that predate them cannot prove recovery and are refused.
function policyInputPaths(coordDir) {
  return ["GOVERNANCE.md", "project.config.js", "board/tasks.schema.json", "board/plan.schema.json"].map((p) => path.join(coordDir, p));
}

// Proof inputs: the exact baseline and current snapshots, plus the board
// renderer's read-only bytes for every generated view (no writes).
function syncProofInputs({ provenance, baseline, resolvePath, digest }) {
  return {
    baseline,
    current: provenance.currentSnapshot,
    expectedDigest: provenance.latestEvent?.snapshot_digest,
    outputs: require("../../board/board.js").previewBoardArtifacts(),
    resolvePath,
    digest,
  };
}

function syncRefusalMessage(paths) {
  return `Refusing sync over unapproved governance drift: ${paths.join(", ")}. ` +
    "gov sync adopts only generated views whose bytes equal their regeneration from unchanged canonical records (board, plan records, prompts, policy). " +
    "This drift is not that shape (a canonical edit, a generated view that differs from its regeneration, or an incomplete baseline). " +
    "Recovery: revert the edit to each listed generated file (for example `git checkout -- <path>`) and re-run `coord/scripts/gov sync`; " +
    "revert or re-apply canonical edits through a governed verb. " +
    "Limitation: a legacy journal baseline that predates the rendering policy inputs (GOVERNANCE.md, project.config.js, board schemas) " +
    "never authorizes automatic recovery; it needs `coord/scripts/gov reconcile --reason \"<why>\" --dry-run`, then the packet-bound `--human-admin-override` reconcile.";
}

module.exports = { proveDerivedSync, policyInputPaths, syncProofInputs, syncRefusalMessage };
