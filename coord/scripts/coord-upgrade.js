"use strict";

// COORD-118: `coord upgrade` — managed engine-upgrade automation.
//
// Applies a NEW engine version into an adopter repo's coord surface, then
// re-pins and verifies — idempotent, with backup + exact byte-rollback on
// failure. This is PRODUCT-facing automation built ON the existing engine-pin /
// verify-engine foundation (ENT-011): there is ZERO reimplementation of the
// fingerprint / drift / verify logic — every pin + verify verdict comes from
// `engine-pin.js` (createEnginePin(...).pin()/verify()).
//
// Model
// -----
//   Source engine  (--from <dir|bundle>): a directory tree that contains a NEW
//                  `coord/scripts` surface + `coord/TEMPLATE_SYNC_MANIFEST.json`.
//                  The SOURCE manifest defines the reusable engine surface to
//                  apply (the exact-match, manifest-tracked files).
//   Target         (--dir <path>, default cwd repo): the adopter repo to upgrade.
//
// Plan: diff the source surface against the target per the SOURCE manifest.
//   Each manifest-tracked file is classified add / update / unchanged. We only
//   ever touch manifest-tracked reusable surface files (plus the manifest
//   itself); project-local files (the board, project.config.js, product specs,
//   .runtime) are NEVER written — they are not in the exact-match surface.
//
// Apply: back up every target file we are about to write (its exact prior bytes,
//   or a "did-not-exist" marker), then copy the source bytes in. The manifest is
//   applied first/last consistently as a tracked file so the target's surface
//   definition matches what we wrote.
//
// Re-pin: createEnginePin(target).pin() regenerates coord/engine-pin.json over
//   the NEW surface.
//
// Verify + rollback: createEnginePin(target).verify(). If verify FAILS, roll the
//   applied files back to their exact pre-upgrade bytes (restore from backup;
//   delete files that did not exist before) and exit non-zero. On success exit 0.
//
// Idempotent: upgrading to the same version => every file unchanged => no writes,
//   exit 0.
//
// DI-factory convention (matches coord-init.js / coord-conformance.js):
//   module.exports = function createCoordUpgrade(deps = {}) { ... }
// so tests inject fs / log / cwd / createEnginePin and never touch real global
// state. The wrapper returns { code, ... } and never calls process.exit.

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const defaultCreateEnginePin = require("./engine-pin.js");

const MANIFEST_REL = "coord/TEMPLATE_SYNC_MANIFEST.json";

module.exports = function createCoordUpgrade(deps = {}) {
  const fs = deps.fs || nodeFs;
  const log = deps.log || ((line) => console.log(line));
  const cwd = deps.cwd || (() => process.cwd());
  // Injected for tests; defaults to the real engine-pin module. We compose it
  // per-target (coordDir = <target>/coord) so the pin/verify run against the
  // upgraded surface, not this repo's.
  const createEnginePin = deps.createEnginePin || defaultCreateEnginePin;

  function parseArgs(args = []) {
    const parsed = { from: null, dir: null, dryRun: false, json: false, help: false, unknown: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--dry-run") {
        parsed.dryRun = true;
      } else if (arg === "--json") {
        parsed.json = true;
      } else if (arg === "-h" || arg === "--help") {
        parsed.help = true;
      } else if (arg === "--from") {
        parsed.from = args[i + 1] || null;
        i += 1;
      } else if (arg.startsWith("--from=")) {
        parsed.from = arg.slice("--from=".length) || null;
      } else if (arg === "--dir") {
        parsed.dir = args[i + 1] || null;
        i += 1;
      } else if (arg.startsWith("--dir=")) {
        parsed.dir = arg.slice("--dir=".length) || null;
      } else {
        parsed.unknown.push(arg);
      }
    }
    return parsed;
  }

  function readManifest(root) {
    const abs = nodePath.join(root, MANIFEST_REL);
    if (!fs.existsSync(abs)) {
      throw new Error(`engine manifest not found: ${abs}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      throw new Error(`engine manifest is not valid JSON: ${abs} (${error.message})`);
    }
    return manifest;
  }

  // The reusable engine surface the SOURCE manifest declares: the exact-match,
  // manifest-tracked file paths PLUS the manifest itself (so the target's
  // surface definition matches what we apply). Returns a sorted, de-duped list
  // of repo-root-relative paths. Advisory entries are intentionally excluded —
  // they mirror the same surface engine-pin tracks.
  function surfacePaths(manifest) {
    const paths = new Set([MANIFEST_REL]);
    for (const item of manifest.items || []) {
      if (!item || typeof item.path !== "string") continue;
      if (item.match_policy === "advisory") continue;
      paths.add(item.path);
    }
    return [...paths].sort();
  }

  // Diff source vs target for each surface path: add (absent in target),
  // update (present + bytes differ), unchanged (present + identical bytes),
  // missing-in-source (tracked by manifest but the source tree lacks the file —
  // a malformed source; reported and skipped, never applied).
  function plan(sourceRoot, targetRoot) {
    const manifest = readManifest(sourceRoot);
    const actions = [];
    for (const rel of surfacePaths(manifest)) {
      const srcAbs = nodePath.join(sourceRoot, rel);
      const tgtAbs = nodePath.join(targetRoot, rel);
      if (!fs.existsSync(srcAbs)) {
        actions.push({ rel, action: "missing-in-source", srcAbs, tgtAbs });
        continue;
      }
      const srcBuf = fs.readFileSync(srcAbs);
      if (!fs.existsSync(tgtAbs)) {
        actions.push({ rel, action: "add", srcAbs, tgtAbs, srcBuf });
        continue;
      }
      const tgtBuf = fs.readFileSync(tgtAbs);
      if (Buffer.compare(srcBuf, tgtBuf) === 0) {
        actions.push({ rel, action: "unchanged", srcAbs, tgtAbs });
      } else {
        actions.push({ rel, action: "update", srcAbs, tgtAbs, srcBuf });
      }
    }
    return { manifest, actions };
  }

  // Apply add/update actions, capturing an exact pre-write backup of every file
  // touched so rollback is byte-exact. Backup entry: { rel, tgtAbs, existed,
  // priorBuf }. priorBuf is the exact prior bytes (existed) or null (did not
  // exist → rollback deletes the written file).
  function applyActions(actions) {
    const backups = [];
    for (const a of actions) {
      if (a.action !== "add" && a.action !== "update") continue;
      const existed = fs.existsSync(a.tgtAbs);
      const priorBuf = existed ? fs.readFileSync(a.tgtAbs) : null;
      backups.push({ rel: a.rel, tgtAbs: a.tgtAbs, existed, priorBuf });
      fs.mkdirSync(nodePath.dirname(a.tgtAbs), { recursive: true });
      fs.writeFileSync(a.tgtAbs, a.srcBuf);
    }
    return backups;
  }

  // Exact byte-restore: rewrite each backed-up file to its prior bytes, and
  // delete files that did not exist before the apply.
  function rollback(backups) {
    // Restore in reverse application order for determinism.
    for (const b of [...backups].reverse()) {
      if (b.existed) {
        fs.writeFileSync(b.tgtAbs, b.priorBuf);
      } else if (fs.existsSync(b.tgtAbs)) {
        fs.rmSync(b.tgtAbs);
      }
    }
  }

  function printUsage() {
    log("Usage: coord upgrade --from <dir|bundle> [--dir <target>] [--dry-run] [--json]");
    log("");
    log("Apply a new engine version into a repo's coord surface, re-pin, then");
    log("verify. Idempotent; fail-closed: a verify failure rolls the applied files");
    log("back to their exact pre-upgrade bytes and exits non-zero.");
    log("");
    log("Options:");
    log("  --from <dir|bundle>  Source engine to upgrade FROM: a directory tree");
    log("                       containing the new coord/scripts surface +");
    log("                       coord/TEMPLATE_SYNC_MANIFEST.json. (required)");
    log("  --dir <target>       Target repo root. Defaults to the current directory.");
    log("  --dry-run            Print the plan; write nothing.");
    log("  --json               Machine-readable JSON result.");
    log("  -h, --help           Show this help text.");
  }

  function emit(opts, human, jsonObj) {
    if (opts.json) {
      log(JSON.stringify(jsonObj, null, 2));
    } else {
      for (const line of human) log(line);
    }
  }

  function run(args = []) {
    const opts = parseArgs(args);
    if (opts.help) {
      printUsage();
      return { code: 0 };
    }
    if (opts.unknown.length > 0) {
      log(`coord upgrade: unexpected argument(s): ${opts.unknown.join(", ")}`);
      log("Run `coord upgrade --help` for usage.");
      return { code: 1 };
    }
    if (!opts.from) {
      log("coord upgrade: --from <dir|bundle> is required.");
      log("Run `coord upgrade --help` for usage.");
      return { code: 1 };
    }

    const sourceRoot = nodePath.resolve(cwd(), opts.from);
    const targetRoot = opts.dir ? nodePath.resolve(cwd(), opts.dir) : nodePath.resolve(cwd());

    let planned;
    try {
      planned = plan(sourceRoot, targetRoot);
    } catch (error) {
      const msg = `coord upgrade: ${error.message}`;
      if (opts.json) {
        log(JSON.stringify({ verdict: "fail", error: error.message }, null, 2));
      } else {
        log(msg);
      }
      return { code: 1, error: error.message };
    }

    const { actions } = planned;
    const adds = actions.filter((a) => a.action === "add");
    const updates = actions.filter((a) => a.action === "update");
    const unchanged = actions.filter((a) => a.action === "unchanged");
    const missingInSource = actions.filter((a) => a.action === "missing-in-source");

    const human = [];
    human.push(`coord upgrade — from: ${sourceRoot}`);
    human.push(`               target: ${targetRoot}`);
    if (opts.dryRun) human.push("(dry run — no files will be written)");
    human.push("");
    for (const a of actions) {
      if (a.action === "add") human.push(`  add        ${a.rel}`);
      else if (a.action === "update") human.push(`  update     ${a.rel}`);
      else if (a.action === "unchanged") human.push(`  unchanged  ${a.rel}`);
      else human.push(`  MISSING    ${a.rel}  (declared by source manifest but absent in source)`);
    }
    human.push("");

    // Malformed source: a manifest-tracked file is missing from the source tree.
    // Refuse to apply a partial surface.
    if (missingInSource.length > 0) {
      human.push(
        `coord upgrade: FAIL — ${missingInSource.length} surface file(s) declared by the ` +
          `source manifest are missing from the source tree; refusing to apply a partial surface.`
      );
      emit(opts, human, {
        verdict: "fail",
        error: "source surface incomplete",
        missing: missingInSource.map((a) => a.rel),
      });
      return { code: 1, error: "source surface incomplete" };
    }

    const changeCount = adds.length + updates.length;

    // Idempotent no-op: nothing to apply.
    if (changeCount === 0) {
      human.push("Already up to date — nothing to apply.");
      emit(opts, human, {
        verdict: "noop",
        applied: 0,
        added: 0,
        updated: 0,
        unchanged: unchanged.length,
      });
      return { code: 0, applied: 0, unchanged: unchanged.length };
    }

    // Dry run: report the plan, write nothing.
    if (opts.dryRun) {
      human.push(`Would apply ${changeCount} file(s) (add ${adds.length}, update ${updates.length}), ` +
        `${unchanged.length} unchanged, then re-pin + verify.`);
      emit(opts, human, {
        verdict: "dry-run",
        would_apply: changeCount,
        added: adds.length,
        updated: updates.length,
        unchanged: unchanged.length,
      });
      return { code: 0, dryRun: true, wouldApply: changeCount };
    }

    // Apply: back up + write the surface files.
    const backups = applyActions(actions);

    // Re-pin + verify against the upgraded target surface. Any throw here is
    // treated as a failure and triggers rollback.
    const enginePin = createEnginePin({
      coordDir: nodePath.join(targetRoot, "coord"),
      fail: (m) => {
        throw new Error(m);
      },
    });

    let verifyReport;
    try {
      enginePin.pin();
      verifyReport = enginePin.verify();
    } catch (error) {
      rollback(backups);
      human.push(`coord upgrade: FAIL — re-pin/verify errored: ${error.message}`);
      human.push(`Rolled back ${backups.length} file(s) to their pre-upgrade bytes.`);
      emit(opts, human, { verdict: "fail", error: error.message, rolled_back: backups.length });
      return { code: 1, error: error.message, rolledBack: backups.length };
    }

    if (!verifyReport.ok) {
      rollback(backups);
      human.push(
        `coord upgrade: FAIL — engine verify reported drift after apply ` +
          `(${verifyReport.problems.length} problem(s)). Rolling back.`
      );
      human.push(`Rolled back ${backups.length} file(s) to their pre-upgrade bytes.`);
      emit(opts, human, {
        verdict: "fail",
        error: "engine verify failed after apply",
        problems: verifyReport.problems,
        rolled_back: backups.length,
      });
      return { code: 1, error: "engine verify failed after apply", rolledBack: backups.length };
    }

    human.push(
      `Applied ${changeCount} file(s) (add ${adds.length}, update ${updates.length}), ` +
        `${unchanged.length} unchanged. Re-pinned engine-pin.json; engine verify PASS.`
    );
    emit(opts, human, {
      verdict: "pass",
      applied: changeCount,
      added: adds.length,
      updated: updates.length,
      unchanged: unchanged.length,
      pinned_version: verifyReport.live_version,
    });
    return {
      code: 0,
      applied: changeCount,
      added: adds.length,
      updated: updates.length,
      unchanged: unchanged.length,
    };
  }

  return { parseArgs, plan, surfacePaths, applyActions, rollback, run, printUsage };
};
