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
const crypto = require("node:crypto");
const defaultCreateEnginePin = require("./engine-pin.js");
const createUpgradeReleaseSource = require("./upgrade-release-source.js");

const MANIFEST_REL = "coord/TEMPLATE_SYNC_MANIFEST.json";
// GCV-4 upstream pin (COORD-451): records WHERE this engine came from
// (version/channel/ref/sha) so `gov upgrade` knows what "latest" means and which
// distribution channel the repo is on. This is DISTINCT from engine-pin.json,
// which fingerprints the in-tree surface for DRIFT detection. Two roles, two
// files: .coord-engine.json = upstream identity; engine-pin.json = local integrity.
const ENGINE_PIN_REL = "coord/.coord-engine.json";
const DEFAULT_REPO = "https://github.com/Softsensor-org/concord";
const CHANNELS = new Set(["community", "enterprise"]);

module.exports = function createCoordUpgrade(deps = {}) {
  const fs = deps.fs || nodeFs;
  const log = deps.log || ((line) => console.log(line));
  const cwd = deps.cwd || (() => process.cwd());
  // Injected for tests; defaults to the real engine-pin module. We compose it
  // per-target (coordDir = <target>/coord) so the pin/verify run against the
  // upgraded surface, not this repo's.
  const createEnginePin = deps.createEnginePin || defaultCreateEnginePin;
  const releaseSource = deps.releaseSource || createUpgradeReleaseSource(deps);

  function parseArgs(args = []) {
    const parsed = {
      from: null, dir: null, dryRun: false, json: false, help: false,
      check: false, channel: null, entitlement: null, ref: null, sha: null, applyPlan: null, unknown: [],
    };
    // Options that take a value: support both `--opt val` and `--opt=val`.
    const valued = { "--from": "from", "--dir": "dir", "--channel": "channel", "--entitlement": "entitlement", "--ref": "ref", "--sha": "sha", "--apply-plan": "applyPlan" };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--dry-run") {
        parsed.dryRun = true;
      } else if (arg === "--json") {
        parsed.json = true;
      } else if (arg === "--check") {
        parsed.check = true;
      } else if (arg === "-h" || arg === "--help") {
        parsed.help = true;
      } else if (valued[arg]) {
        parsed[valued[arg]] = args[i + 1] || null;
        i += 1;
      } else if (arg.includes("=") && valued[arg.slice(0, arg.indexOf("="))]) {
        parsed[valued[arg.slice(0, arg.indexOf("="))]] = arg.slice(arg.indexOf("=") + 1) || null;
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

  // Read the target's GCV-4 upstream pin (.coord-engine.json), or null if the
  // repo predates it (older scaffolds / pre-COORD-451). Malformed JSON is a hard
  // error — a corrupt pin must not be silently overwritten.
  function readEnginePin(targetRoot) {
    const abs = nodePath.join(targetRoot, ENGINE_PIN_REL);
    if (!fs.existsSync(abs)) return null;
    try {
      return JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      throw new Error(`engine pin is not valid JSON: ${abs} (${error.message})`);
    }
  }

  // Rewrite the upstream pin after a successful apply. Preserves the repo field
  // and any prior channel unless explicitly changed; bumps version/ref/sha and
  // stamps applied_at. `now` is injected for deterministic tests.
  function writeEnginePin(targetRoot, patch = {}, now) {
    const prior = readEnginePin(targetRoot) || {};
    const priorSource = prior.source || {};
    const pin = {
      schema: 1,
      engine_version: patch.engineVersion != null ? patch.engineVersion : prior.engine_version || "0.0.0",
      source: {
        repo: priorSource.repo || DEFAULT_REPO,
        channel: patch.channel || priorSource.channel || "community",
        ref: patch.ref !== undefined ? patch.ref : priorSource.ref != null ? priorSource.ref : null,
        sha: patch.sha !== undefined ? patch.sha : priorSource.sha != null ? priorSource.sha : null,
      },
      applied_at: now || new Date().toISOString(),
    };
    const abs = nodePath.join(targetRoot, ENGINE_PIN_REL);
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(pin, null, 2) + "\n");
    return pin;
  }

  // The engine version a SOURCE tree ships: coord/package.json version, falling
  // back to the manifest_version so a bundle without a package.json still pins.
  function sourceEngineVersion(sourceRoot, manifest) {
    try {
      const pkg = JSON.parse(fs.readFileSync(nodePath.join(sourceRoot, "coord", "package.json"), "utf8"));
      if (pkg && pkg.version) return String(pkg.version);
    } catch {
      /* fall through to manifest */
    }
    return (manifest && manifest.manifest_version != null) ? String(manifest.manifest_version) : "0.0.0";
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

  function digestPlan(actions, source = {}) {
    const files = actions.map((action) => ({
      path: action.rel,
      action: action.action,
      before: fs.existsSync(action.tgtAbs) ? crypto.createHash("sha256").update(fs.readFileSync(action.tgtAbs)).digest("hex") : null,
      after: action.srcBuf ? crypto.createHash("sha256").update(action.srcBuf).digest("hex") : null,
    }));
    return crypto.createHash("sha256").update(JSON.stringify({ schema: 1, source, files })).digest("hex");
  }

  function writeUpgradeReceipt(targetRoot, receipt) {
    const dir = nodePath.join(targetRoot, "coord", ".runtime", "upgrade-receipts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nodePath.join(dir, `${receipt.plan_digest}.json`), JSON.stringify(receipt, null, 2) + "\n");
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
    log("Usage: coord upgrade [--dir <target>] [--channel <c>] [--json]");
    log("       coord upgrade --apply-plan <digest> [--dir <target>] [--json]");
    log("       coord upgrade --from <dir|bundle> [--dir <target>] [--channel <c>] [--dry-run] [--json]");
    log("       coord upgrade --check [--dir <target>] [--json]");
    log("");
    log("Without --from, resolve the pinned channel's latest immutable commit and");
    log("print a write-free plan. Apply it only with --apply-plan <digest>.");
    log("Apply a new engine version into a repo's coord surface, re-pin, then");
    log("verify. Idempotent; fail-closed: a verify failure rolls the applied files");
    log("back to their exact pre-upgrade bytes and exits non-zero. On success it");
    log("also records the upstream pin (coord/.coord-engine.json: version/channel).");
    log("");
    log("Options:");
    log("  --from <dir|bundle>   Source engine to upgrade FROM: a directory tree");
    log("                        containing the new coord/scripts surface +");
    log("                        coord/TEMPLATE_SYNC_MANIFEST.json. (required unless --check)");
    log("  --dir <target>        Target repo root. Defaults to the current directory.");
    log("  --apply-plan <digest> Re-resolve and apply only the exact reviewed automatic plan.");
    log("  --channel <c>         Distribution channel to pin: community | enterprise.");
    log("                        Switching to enterprise requires --entitlement (licensed).");
    log("  --entitlement <tok>   Entitlement token for the enterprise channel (or set");
    log("                        CONCORD_ENTITLEMENT). Gates access to the private source.");
    log("  --ref <ref> / --sha <sha>  Upstream ref/sha to record in the pin.");
    log("  --check               Read-only: report engine drift (hand-edited vendored");
    log("                        surface) vs the upstream pin; exit 1 on drift. No --from.");
    log("  --dry-run             Print the plan; write nothing.");
    log("  --json                Machine-readable JSON result.");
    log("  -h, --help            Show this help text.");
  }

  function emit(opts, human, jsonObj) {
    if (opts.json) {
      log(JSON.stringify(jsonObj, null, 2));
    } else {
      for (const line of human) log(line);
    }
  }

  // Read-only drift report. Verifies the in-tree engine surface against its
  // engine-pin fingerprint and surfaces the upstream pin. Exit 0 = pristine,
  // exit 1 = ENGINE drift (vendored files edited — re-run `gov upgrade` or revert).
  function runCheck(opts, targetRoot) {
    let pin = null;
    try {
      pin = readEnginePin(targetRoot);
    } catch (error) {
      if (opts.json) log(JSON.stringify({ verdict: "fail", error: error.message }, null, 2));
      else log(`coord upgrade --check: ${error.message}`);
      return { code: 1, error: error.message };
    }

    const enginePin = createEnginePin({
      coordDir: nodePath.join(targetRoot, "coord"),
      fail: (m) => { throw new Error(m); },
    });
    let report;
    try {
      report = enginePin.verify();
    } catch (error) {
      if (opts.json) log(JSON.stringify({ verdict: "fail", error: error.message }, null, 2));
      else log(`coord upgrade --check: engine verify errored: ${error.message}`);
      return { code: 1, error: error.message };
    }

    const version = pin ? pin.engine_version : (report.live_version || "unknown");
    const channel = pin && pin.source ? pin.source.channel : "community";
    const engineDrift = !report.ok ? report.problems.length : 0;
    const human = [
      `coord upgrade --check — ${targetRoot}`,
      `  engine version : ${version}`,
      `  channel        : ${channel}`,
      pin ? "" : "  (no .coord-engine.json — pre-COORD-451 scaffold; run `gov upgrade` to pin)",
      report.ok
        ? "  engine drift   : none — vendored surface matches its pin"
        : `  engine drift   : ${engineDrift} file(s) hand-edited vs the pinned surface`,
      "  project drift  : not checked — your board/config/product/.runtime are yours to change",
    ].filter((l) => l !== "");
    if (!report.ok) {
      for (const p of report.problems) human.push(`      - ${typeof p === "string" ? p : JSON.stringify(p)}`);
    }
    emit(opts, human, {
      verdict: report.ok ? "clean" : "engine-drift",
      engine_version: version,
      channel,
      pinned: Boolean(pin),
      engine_drift: engineDrift,
      problems: report.ok ? [] : report.problems,
    });
    return { code: report.ok ? 0 : 1, engineDrift };
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
    if (opts.channel && !CHANNELS.has(opts.channel)) {
      log(`coord upgrade: unknown --channel "${opts.channel}" (expected: community | enterprise).`);
      return { code: 1 };
    }

    // --check: read-only status. Does NOT need --from. Runs engine-pin verify to
    // detect ENGINE drift (a manifest-tracked vendored file was hand-edited) and
    // reports the upstream pin (version/channel). Project drift — changes to the
    // repo's OWN files (board, project.config, product, .runtime) — is expected
    // and intentionally not flagged here: those files are not engine surface.
    if (opts.check) {
      const targetRoot = opts.dir ? nodePath.resolve(cwd(), opts.dir) : nodePath.resolve(cwd());
      return runCheck(opts, targetRoot);
    }

    // Enterprise is a licensed channel: switching to (or upgrading on) it requires
    // an entitlement token — fail-closed so a Community repo can't silently pull
    // the private enterprise surface. The token gates ACCESS to the private source
    // (supplied out-of-band as --from); we record only that it was present.
    const targetRoot = opts.dir ? nodePath.resolve(cwd(), opts.dir) : nodePath.resolve(cwd());
    let priorPin;
    try {
      priorPin = readEnginePin(targetRoot);
    } catch (error) {
      log(`coord upgrade: ${error.message}`);
      return { code: 1, error: error.message };
    }
    const effectiveChannel = opts.channel || priorPin?.source?.channel || "community";
    if (effectiveChannel === "enterprise") {
      const token = opts.entitlement || process.env.CONCORD_ENTITLEMENT || "";
      if (!token.trim()) {
        log("coord upgrade: --channel enterprise requires an entitlement token.");
        log("Provide --entitlement <token> or set CONCORD_ENTITLEMENT. Enterprise is a licensed channel.");
        return { code: 1, error: "entitlement required" };
      }
    }

    let resolved = null;
    let sourceRoot;
    if (opts.from) {
      sourceRoot = nodePath.resolve(cwd(), opts.from);
    } else {
      try {
        resolved = releaseSource.resolveLatest({
          repo: priorPin?.source?.repo || DEFAULT_REPO,
          channel: effectiveChannel,
          entitlement: opts.entitlement || process.env.CONCORD_ENTITLEMENT || "",
        });
        sourceRoot = resolved.sourceRoot;
        opts.ref = resolved.ref;
        opts.sha = resolved.sha;
      } catch (error) {
        log(`coord upgrade: unable to resolve latest ${effectiveChannel} release: ${error.message}`);
        return { code: 1, error: error.message };
      }
    }

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

    const resolvedVersion = resolved ? sourceEngineVersion(sourceRoot, planned.manifest) : null;
    const sourceIdentity = resolved ? { channel: effectiveChannel, ref: resolved.ref, sha: resolved.sha, archive_sha256: resolved.archiveSha256 } : null;
    const planDigest = resolved ? digestPlan(planned.actions, sourceIdentity) : null;
    if (resolved?.cleanup) resolved.cleanup();
    const { actions } = planned;
    const adds = actions.filter((a) => a.action === "add");
    const updates = actions.filter((a) => a.action === "update");
    const unchanged = actions.filter((a) => a.action === "unchanged");
    const missingInSource = actions.filter((a) => a.action === "missing-in-source");

    const human = [];
    human.push(`coord upgrade — from: ${sourceRoot}`);
    human.push(`               target: ${targetRoot}`);
    if (resolved) human.push(`               source: ${effectiveChannel} ${resolved.sha}`);
    if (opts.dryRun) human.push("(dry run — no files will be written)");
    human.push("");

    if (resolved && !opts.applyPlan) {
      human.push(`Plan digest: ${planDigest}`);
      human.push(`Review the plan above, then run: npm run concord -- upgrade --apply-plan ${planDigest}`);
      emit(opts, human, { verdict: "plan", plan_digest: planDigest, source: sourceIdentity, would_apply: adds.length + updates.length, added: adds.length, updated: updates.length, unchanged: unchanged.length });
      return { code: 0, planned: true, planDigest, wouldApply: adds.length + updates.length };
    }
    if (resolved && opts.applyPlan !== planDigest) {
      human.push(`coord upgrade: REFUSED — plan digest changed (expected ${opts.applyPlan}, current ${planDigest}).`);
      human.push("Re-run `npm run concord -- upgrade`, review the new plan, and apply its digest.");
      emit(opts, human, { verdict: "refused", expected_plan_digest: opts.applyPlan, current_plan_digest: planDigest });
      return { code: 1, error: "plan digest mismatch", planDigest };
    }
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

    // Idempotent no-op: the engine surface already matches the source. Even so,
    // reconcile the upstream pin when the requested channel/version differs from
    // what's recorded — so a metadata-only re-pin (e.g. flipping channel with an
    // unchanged surface) still takes effect — but write nothing on a true no-op.
    if (changeCount === 0 && !opts.dryRun) {
      const newVersion = resolvedVersion || sourceEngineVersion(sourceRoot, planned.manifest);
      const prior = readEnginePin(targetRoot);
      const priorChannel = prior && prior.source ? prior.source.channel : null;
      const priorVersion = prior ? prior.engine_version : null;
      const wantChannel = opts.channel || priorChannel;
      const needsPin = !prior || priorVersion !== newVersion || (opts.channel && priorChannel !== opts.channel);
      if (needsPin) {
        const upstream = writeEnginePin(
          targetRoot,
          { engineVersion: newVersion, channel: opts.channel || undefined, ...(opts.ref != null ? { ref: opts.ref } : {}), ...(opts.sha != null ? { sha: opts.sha } : {}) },
          deps.now
        );
        human.push(`Surface already up to date; reconciled pin: version ${upstream.engine_version}, channel ${upstream.source.channel}.`);
        emit(opts, human, { verdict: "repin", applied: 0, unchanged: unchanged.length, engine_version: upstream.engine_version, channel: upstream.source.channel });
        return { code: 0, applied: 0, unchanged: unchanged.length, channel: upstream.source.channel, engineVersion: upstream.engine_version };
      }
      human.push("Already up to date — nothing to apply.");
      emit(opts, human, { verdict: "noop", applied: 0, added: 0, updated: 0, unchanged: unchanged.length, channel: wantChannel });
      return { code: 0, applied: 0, unchanged: unchanged.length };
    }
    if (changeCount === 0) {
      human.push("Already up to date — nothing to apply.");
      emit(opts, human, { verdict: "noop", applied: 0, added: 0, updated: 0, unchanged: unchanged.length });
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

    // Verify passed — record the upstream GCV-4 pin (.coord-engine.json). This is
    // the ONLY write to the pin, and it happens last: engine-pin.json (integrity)
    // is regenerated above; .coord-engine.json (identity) captures the version we
    // just applied and, when --channel is given, the channel we switched to.
    const newVersion = resolvedVersion || sourceEngineVersion(sourceRoot, planned.manifest);
    const upstream = writeEnginePin(
      targetRoot,
      {
        engineVersion: newVersion,
        channel: opts.channel || undefined,
        ...(opts.ref != null ? { ref: opts.ref } : {}),
        ...(opts.sha != null ? { sha: opts.sha } : {}),
      },
      deps.now
    );
    if (resolved) {
      writeUpgradeReceipt(targetRoot, {
        schema: 1,
        plan_digest: planDigest,
        source: sourceIdentity,
        engine_version: newVersion,
        applied: changeCount,
        completed_at: deps.now || new Date().toISOString(),
      });
    }

    human.push(
      `Applied ${changeCount} file(s) (add ${adds.length}, update ${updates.length}), ` +
        `${unchanged.length} unchanged. Re-pinned engine-pin.json; engine verify PASS.`
    );
    human.push(`Pinned upstream: version ${upstream.engine_version}, channel ${upstream.source.channel}.`);
    emit(opts, human, {
      verdict: "pass",
      applied: changeCount,
      added: adds.length,
      updated: updates.length,
      unchanged: unchanged.length,
      pinned_version: verifyReport.live_version,
      engine_version: upstream.engine_version,
      channel: upstream.source.channel,
    });
    return {
      code: 0,
      applied: changeCount,
      added: adds.length,
      updated: updates.length,
      unchanged: unchanged.length,
      channel: upstream.source.channel,
      engineVersion: upstream.engine_version,
    };
  }

  return {
    parseArgs, plan, digestPlan, surfacePaths, applyActions, rollback, run, printUsage,
    readEnginePin, writeEnginePin, sourceEngineVersion, runCheck,
  };
};
