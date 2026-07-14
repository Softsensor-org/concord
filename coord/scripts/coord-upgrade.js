"use strict";

// COORD-118: `coord upgrade` — managed engine-upgrade automation.
//
// Applies a NEW engine version into an adopter repo's coord surface, then
// re-pins and verifies. This is PRODUCT-facing automation built ON the existing engine-pin /
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
//   ever replace manifest-tracked reusable surface files (plus the manifest
//   itself). The board, project.config.js, and product specs are never changed.
//   Operational locks, recovery journals, and receipts live under coord/.runtime.
//
// Serialization: one target-local lock spans source resolution, planning,
//   revalidation, apply, pinning, and receipt publication. Automatic plan
//   digests bind both surface pre-state and upstream-pin bytes.
//
// Apply: persist a durable recovery journal with exact pre-state before the
//   first managed mutation, then apply content, mode, and retired-file changes. The transaction
//   also covers engine-pin.json, .coord-engine.json, and the success receipt.
//
// Verify + rollback: compare the target to source-manifest hashes before pinning,
//   then run engine-pin verification. Failures attempt every exact pre-state
//   restore; unresolved paths remain in an explicit incomplete-recovery journal.
//   A later upgrade run reconciles an interrupted transaction before planning.
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
const nodeOs = require("node:os");
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
const INTEGRITY_PIN_REL = "coord/engine-pin.json";
const TRANSACTIONS_REL = "coord/.runtime/upgrade-transactions";
const RECEIPTS_REL = "coord/.runtime/upgrade-receipts";
const UPGRADE_LOCK_REL = "coord/.runtime/upgrade-lock";
const DEFAULT_REPO = "https://github.com/Softsensor-org/concord";
const CHANNELS = new Set(["community", "enterprise"]);
const DEFAULT_UNVERIFIABLE_LOCK_STALE_MS = 60 * 60 * 1000;

module.exports = function createCoordUpgrade(deps = {}) {
  const fs = deps.fs || nodeFs;
  const log = deps.log || ((line) => console.log(line));
  const cwd = deps.cwd || (() => process.cwd());
  // Injected for tests; defaults to the real engine-pin module. We compose it
  // per-target (coordDir = <target>/coord) so the pin/verify run against the
  // upgraded surface, not this repo's.
  const createEnginePin = deps.createEnginePin || defaultCreateEnginePin;
  const releaseSource = deps.releaseSource || createUpgradeReleaseSource(deps);
  const checkpoint = deps.checkpoint || (() => {});
  const hostname = deps.hostname || (() => nodeOs.hostname());
  const nowMs = deps.nowMs || (() => Date.now());
  const signalProcess = deps.signalProcess || ((pid) => process.kill(pid, 0));
  const unverifiableLockStaleMs = deps.unverifiableLockStaleMs ?? DEFAULT_UNVERIFIABLE_LOCK_STALE_MS;
  const platform = deps.platform || process.platform;
  const supportsPosixModes = platform !== "win32";

  function fsyncDirectoryBestEffort(dir) {
    let fd = null;
    try {
      fd = fs.openSync(dir, "r");
      fs.fsyncSync(fd);
    } catch {
      // Some platforms do not support directory fsync. File fsync + rename still
      // prevents readers from observing a partially written file.
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  function fsyncFileBestEffort(file) {
    let fd = null;
    try {
      fd = fs.openSync(file, "r");
      fs.fsyncSync(fd);
    } catch {
      // Best effort on platforms/filesystems that do not support fsync here.
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  function writeFileAtomicSync(file, data, options = {}) {
    const dir = nodePath.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: options.dirMode || 0o700 });
    const temp = nodePath.join(dir, `.${nodePath.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    let fd = null;
    try {
      fd = fs.openSync(temp, "wx", options.mode == null ? 0o600 : options.mode);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, file);
      if (options.mode != null) fs.chmodSync(file, options.mode);
      fsyncDirectoryBestEffort(dir);
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* preserve the original failure */ }
      }
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  function writeJsonAtomicSync(file, value, options = {}) {
    writeFileAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`, options);
  }

  function redactSensitive(value, secrets = []) {
    let redacted = String(value == null ? "" : value);
    for (const secret of secrets) {
      if (typeof secret === "string" && secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted;
  }

  function upgradeLockPath(targetRoot) {
    return nodePath.join(targetRoot, UPGRADE_LOCK_REL);
  }

  function lockOwnerPath(lockDir) {
    return nodePath.join(lockDir, "owner.json");
  }

  function publicLockOwner(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (
      value.schema !== 1 || typeof value.lock_id !== "string" || !/^[0-9a-f]{32}$/.test(value.lock_id) ||
      !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.host !== "string" || !value.host ||
      typeof value.acquired_at !== "string"
    ) return null;
    return {
      schema: 1,
      lock_id: value.lock_id,
      pid: value.pid,
      host: value.host,
      acquired_at: value.acquired_at,
    };
  }

  function readLockOwner(lockDir) {
    try {
      return publicLockOwner(JSON.parse(fs.readFileSync(lockOwnerPath(lockDir), "utf8")));
    } catch {
      return null;
    }
  }

  function processIsAlive(pid) {
    try {
      signalProcess(pid);
      return true;
    } catch (error) {
      if (error && error.code === "ESRCH") return false;
      return true;
    }
  }

  function classifyExistingLock(lockDir) {
    const owner = readLockOwner(lockDir);
    const stat = fs.lstatSync(lockDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { stale: false, owner: null, reason: "upgrade lock path is not a real directory" };
    }
    if (owner && owner.host === hostname()) {
      if (processIsAlive(owner.pid)) return { stale: false, owner, reason: "same-host process is alive" };
      return { stale: true, owner, reason: "same-host process is no longer running" };
    }
    if (owner) return { stale: false, owner, reason: "foreign-host ownership cannot be verified safely" };
    const ageMs = Math.max(0, nowMs() - stat.mtimeMs);
    if (ageMs >= unverifiableLockStaleMs) {
      return { stale: true, owner: null, reason: `unverifiable lock metadata exceeded ${unverifiableLockStaleMs}ms` };
    }
    return { stale: false, owner: null, reason: "lock metadata is missing or invalid and has not expired" };
  }

  function releaseUpgradeLock(lock) {
    if (!lock) return { released: false };
    const owner = readLockOwner(lock.dir);
    if (!owner || owner.lock_id !== lock.owner.lock_id) {
      return { released: false, error: "upgrade lock ownership changed before release" };
    }
    fs.rmSync(lock.dir, { recursive: true, force: true });
    fsyncDirectoryBestEffort(nodePath.dirname(lock.dir));
    return { released: true };
  }

  function acquireUpgradeLock(targetRoot) {
    const dir = upgradeLockPath(targetRoot);
    fs.mkdirSync(nodePath.dirname(dir), { recursive: true, mode: 0o700 });
    let recovered = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
        const owner = {
          schema: 1,
          lock_id: crypto.randomBytes(16).toString("hex"),
          pid: process.pid,
          host: hostname(),
          acquired_at: new Date(nowMs()).toISOString(),
        };
        try {
          writeJsonAtomicSync(lockOwnerPath(dir), owner, { mode: 0o600 });
          const lock = { dir, owner };
          if (recovered) {
            writeUpgradeReceipt(targetRoot, {
              schema: 1,
              outcome: "stale-lock-recovered",
              prior_holder: recovered.owner,
              recovery_reason: recovered.reason,
              recovered_by: owner,
              completed_at: new Date(nowMs()).toISOString(),
            }, `lock-recovery-${nowMs()}-${owner.lock_id}`);
            fs.rmSync(recovered.quarantine, { recursive: true, force: true });
          }
          checkpoint("after-upgrade-lock-acquired");
          return lock;
        } catch (error) {
          fs.rmSync(dir, { recursive: true, force: true });
          if (recovered && fs.existsSync(recovered.quarantine) && !fs.existsSync(dir)) {
            fs.renameSync(recovered.quarantine, dir);
          }
          throw error;
        }
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        const classification = classifyExistingLock(dir);
        if (!classification.stale) {
          const holder = classification.owner
            ? `${classification.owner.host}:${classification.owner.pid} acquired ${classification.owner.acquired_at}`
            : "unknown holder";
          throw new Error(`upgrade lock busy for target (${holder}; ${classification.reason})`);
        }
        const quarantine = `${dir}.stale-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
        try {
          fs.renameSync(dir, quarantine);
          recovered = { ...classification, quarantine };
        } catch (renameError) {
          if (renameError && renameError.code === "ENOENT") continue;
          throw renameError;
        }
      }
    }
    throw new Error("unable to acquire target upgrade lock after concurrent recovery attempts");
  }

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
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`engine manifest must be a JSON object: ${abs}`);
    }
    if (!Array.isArray(manifest.items)) {
      throw new Error(`engine manifest items must be an array: ${abs}`);
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
    writeJsonAtomicSync(abs, pin, { mode: 0o600 });
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
  function validateManagedRelPath(value) {
    const rel = String(value || "");
    if (!rel || rel.trim() !== rel || rel.includes("\\") || rel.includes("\0")) {
      throw new Error(`unsafe engine manifest path: ${JSON.stringify(value)}`);
    }
    if (nodePath.posix.isAbsolute(rel) || nodePath.win32.isAbsolute(rel)) {
      throw new Error(`unsafe engine manifest path: ${rel}`);
    }
    const parts = rel.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`unsafe engine manifest path: ${rel}`);
    }
    if (nodePath.posix.normalize(rel) !== rel) {
      throw new Error(`ambiguous engine manifest path: ${rel}`);
    }
    return rel;
  }

  function surfacePaths(manifest) {
    const paths = [MANIFEST_REL];
    const seen = new Set([MANIFEST_REL.toLowerCase()]);
    for (const item of manifest.items || []) {
      if (!item || typeof item.path !== "string") continue;
      const rel = validateManagedRelPath(item.path);
      const key = rel.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`duplicate or case-ambiguous engine manifest path: ${rel}`);
      }
      seen.add(key);
      if (item.match_policy === "advisory") continue;
      if (item.match_policy !== "exact") {
        throw new Error(`unsupported engine manifest match_policy for ${item.path}: ${item.match_policy || "missing"}`);
      }
      paths.push(rel);
    }
    return paths.sort();
  }

  function inspectManagedPath(root, rel, role, options = {}) {
    const rootAbs = nodePath.resolve(root);
    const rootStat = fs.lstatSync(rootAbs);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`${role} root must be a real directory: ${rootAbs}`);
    }
    const parts = validateManagedRelPath(rel).split("/");
    let current = rootAbs;
    for (let index = 0; index < parts.length; index += 1) {
      current = nodePath.join(current, parts[index]);
      if (!fs.existsSync(current)) {
        if (options.allowMissing) return current;
        throw new Error(`${role} engine path is missing: ${rel}`);
      }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`${role} engine path contains a symbolic link: ${rel}`);
      }
      const final = index === parts.length - 1;
      if (final ? !stat.isFile() : !stat.isDirectory()) {
        throw new Error(`${role} engine path has unsupported file type: ${rel}`);
      }
    }
    return current;
  }

  function expectedSourceChecksum(manifest, rel, srcBuf) {
    if (rel === MANIFEST_REL) {
      return { sha256: crypto.createHash("sha256").update(srcBuf).digest("hex"), bytes: srcBuf.length };
    }
    const item = manifest.items.find((candidate) => candidate && candidate.path === rel);
    const checksum = item && item.checksum;
    if (
      !checksum || checksum.algo !== "sha256" ||
      !/^[0-9a-f]{64}$/i.test(String(checksum.hex || "")) ||
      !Number.isInteger(checksum.bytes) || checksum.bytes < 0
    ) {
      throw new Error(`exact engine manifest item lacks a valid sha256 checksum: ${rel}`);
    }
    const actual = {
      sha256: crypto.createHash("sha256").update(srcBuf).digest("hex"),
      bytes: srcBuf.length,
    };
    if (actual.sha256 !== String(checksum.hex).toLowerCase() || actual.bytes !== checksum.bytes) {
      throw new Error(`source checksum mismatch for ${rel}`);
    }
    return actual;
  }

  function declaredExactChecksum(manifest, rel, role) {
    const item = manifest.items.find((candidate) => candidate && candidate.path === rel);
    const checksum = item && item.checksum;
    if (
      !checksum || checksum.algo !== "sha256" ||
      !/^[0-9a-f]{64}$/i.test(String(checksum.hex || "")) ||
      !Number.isInteger(checksum.bytes) || checksum.bytes < 0
    ) {
      throw new Error(`${role} exact manifest item lacks a valid sha256 checksum: ${rel}`);
    }
    return { sha256: String(checksum.hex).toLowerCase(), bytes: checksum.bytes };
  }

  function sha256State(bytes, mode = null) {
    return {
      exists: true,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      ...(supportsPosixModes && Number.isInteger(mode) ? { mode: mode & 0o777 } : {}),
    };
  }

  function captureUpstreamPinIdentity(targetRoot) {
    const absolute = nodePath.join(targetRoot, ENGINE_PIN_REL);
    if (!fs.existsSync(absolute)) return { exists: false, sha256: null, bytes: 0 };
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`upstream engine pin has unsupported file type: ${ENGINE_PIN_REL}`);
    }
    return sha256State(fs.readFileSync(absolute));
  }

  function sameFileState(expected, actual) {
    return Boolean(expected?.exists) === Boolean(actual?.exists) &&
      (!expected?.exists || (
        expected.sha256 === actual.sha256 && expected.bytes === actual.bytes &&
        (!supportsPosixModes || expected.mode === actual.mode)
      ));
  }

  function captureTargetActionState(targetRoot, rel) {
    const absolute = inspectManagedPath(targetRoot, rel, "target", { allowMissing: true });
    if (!fs.existsSync(absolute)) return { exists: false, sha256: null, bytes: 0 };
    const stat = fs.lstatSync(absolute);
    return sha256State(fs.readFileSync(absolute), stat.mode);
  }

  // Diff source vs target for each surface path: add (absent in target),
  // update (present + bytes differ), unchanged (present + identical bytes),
  // missing-in-source (tracked by manifest but the source tree lacks the file —
  // a malformed source; reported and skipped, never applied).
  function plan(sourceRoot, targetRoot) {
    const manifest = readManifest(sourceRoot);
    const actions = [];
    const sourcePaths = surfacePaths(manifest);
    const sourceDeclaredPaths = new Set((manifest.items || [])
      .filter((item) => item && typeof item.path === "string")
      .map((item) => validateManagedRelPath(item.path)));
    for (const rel of sourcePaths) {
      let srcAbs;
      try {
        srcAbs = inspectManagedPath(sourceRoot, rel, "source");
      } catch (error) {
        if (/ is missing:/.test(error.message)) {
          const tgtAbs = nodePath.join(nodePath.resolve(targetRoot), ...rel.split("/"));
          actions.push({ rel, action: "missing-in-source", srcAbs: nodePath.join(sourceRoot, rel), tgtAbs });
          continue;
        }
        throw error;
      }
      const tgtAbs = inspectManagedPath(targetRoot, rel, "target", { allowMissing: true });
      if (!fs.existsSync(srcAbs)) {
        actions.push({ rel, action: "missing-in-source", srcAbs, tgtAbs });
        continue;
      }
      const srcBuf = fs.readFileSync(srcAbs);
      const sourceMode = fs.lstatSync(srcAbs).mode & 0o777;
      const expected = {
        ...expectedSourceChecksum(manifest, rel, srcBuf),
        ...(supportsPosixModes ? { mode: sourceMode } : {}),
      };
      if (!fs.existsSync(tgtAbs)) {
        actions.push({ rel, action: "add", srcAbs, tgtAbs, srcBuf, expected, before: { exists: false, sha256: null, bytes: 0 } });
        continue;
      }
      const tgtBuf = fs.readFileSync(tgtAbs);
      const before = sha256State(tgtBuf, fs.lstatSync(tgtAbs).mode);
      if (Buffer.compare(srcBuf, tgtBuf) === 0) {
        const action = supportsPosixModes && before.mode !== expected.mode ? "chmod" : "unchanged";
        actions.push({ rel, action, srcAbs, tgtAbs, srcBuf, expected, before });
      } else {
        actions.push({ rel, action: "update", srcAbs, tgtAbs, srcBuf, expected, before });
      }
    }

    const targetManifestPath = nodePath.join(targetRoot, MANIFEST_REL);
    if (fs.existsSync(targetManifestPath)) {
      const targetManifest = readManifest(targetRoot);
      const sourcePathSet = new Set(sourcePaths);
      const sourcePathByCaseFold = new Map([...sourceDeclaredPaths].map((rel) => [rel.toLowerCase(), rel]));
      for (const rel of surfacePaths(targetManifest)) {
        if (rel === MANIFEST_REL || sourcePathSet.has(rel) || sourceDeclaredPaths.has(rel)) continue;
        const caseFoldMatch = sourcePathByCaseFold.get(rel.toLowerCase());
        if (caseFoldMatch) {
          throw new Error(`case-ambiguous engine manifest transition: ${rel} -> ${caseFoldMatch}`);
        }
        const tgtAbs = inspectManagedPath(targetRoot, rel, "retired target", { allowMissing: true });
        if (!fs.existsSync(tgtAbs)) continue;
        const tgtBuf = fs.readFileSync(tgtAbs);
        const before = sha256State(tgtBuf, fs.lstatSync(tgtAbs).mode);
        const declared = declaredExactChecksum(targetManifest, rel, "target");
        const matchesOldManifest = before.sha256 === declared.sha256 && before.bytes === declared.bytes;
        actions.push({
          rel,
          action: matchesOldManifest ? "remove" : "retire-conflict",
          srcAbs: null,
          tgtAbs,
          srcBuf: null,
          expected: null,
          before,
          retiredExpected: declared,
        });
      }
    }
    return { manifest, actions };
  }

  function digestPlan(actions, source = {}, target = {}) {
    const files = actions.map((action) => ({
      path: action.rel,
      action: action.action,
      before: action.before?.exists ? action.before.sha256 : null,
      before_bytes: action.before?.exists ? action.before.bytes : 0,
      before_mode: action.before?.exists && supportsPosixModes ? action.before.mode : null,
      after: action.expected ? action.expected.sha256 : null,
      after_mode: action.expected && supportsPosixModes ? action.expected.mode : null,
    }));
    return crypto.createHash("sha256").update(JSON.stringify({ schema: 2, source, target, files })).digest("hex");
  }

  function revalidateTargetPrestate(actions, targetRoot, upstreamPinIdentity) {
    const problems = [];
    for (const action of actions) {
      if (!action.before || action.action === "missing-in-source") continue;
      try {
        const current = captureTargetActionState(targetRoot, action.rel);
        if (!sameFileState(action.before, current)) {
          problems.push({ path: action.rel, expected: action.before, actual: current });
        }
      } catch (error) {
        problems.push({ path: action.rel, error: error.message });
      }
    }
    try {
      const currentPin = captureUpstreamPinIdentity(targetRoot);
      if (!sameFileState(upstreamPinIdentity, currentPin)) {
        problems.push({ path: ENGINE_PIN_REL, expected: upstreamPinIdentity, actual: currentPin });
      }
    } catch (error) {
      problems.push({ path: ENGINE_PIN_REL, error: error.message });
    }
    return { ok: problems.length === 0, problems };
  }

  function receiptPath(targetRoot, receiptId) {
    return nodePath.join(targetRoot, RECEIPTS_REL, `${receiptId}.json`);
  }

  function writeUpgradeReceipt(targetRoot, receipt, receiptId = receipt.plan_digest) {
    writeJsonAtomicSync(receiptPath(targetRoot, receiptId), receipt, { mode: 0o600 });
  }

  function verifyTargetAgainstPlan(actions, targetRoot) {
    const problems = [];
    for (const action of actions) {
      if (action.action === "remove") {
        if (fs.existsSync(action.tgtAbs)) problems.push({ path: action.rel, error: "retired engine file still exists" });
        continue;
      }
      if (!action.expected || ["missing-in-source", "retire-conflict"].includes(action.action)) continue;
      try {
        const targetAbs = inspectManagedPath(targetRoot, action.rel, "target");
        const bytes = fs.readFileSync(targetAbs);
        const actualSha = crypto.createHash("sha256").update(bytes).digest("hex");
        const actualMode = supportsPosixModes ? fs.lstatSync(targetAbs).mode & 0o777 : null;
        if (
          bytes.length !== action.expected.bytes || actualSha !== action.expected.sha256 ||
          (supportsPosixModes && actualMode !== action.expected.mode)
        ) {
          problems.push({
            path: action.rel,
            expected: action.expected,
            actual: { sha256: actualSha, bytes: bytes.length, ...(supportsPosixModes ? { mode: actualMode } : {}) },
          });
        }
      } catch (error) {
        problems.push({ path: action.rel, error: error.message });
      }
    }
    return { ok: problems.length === 0, problems };
  }

  // Apply add/update actions, capturing an exact pre-write backup of every file
  // touched so rollback is byte-exact. Backup entry: { rel, tgtAbs, existed,
  // priorBuf }. priorBuf is the exact prior bytes (existed) or null (did not
  // exist → rollback deletes the written file).
  function applyActions(actions) {
    const backups = [];
    for (const a of actions) {
      if (!["add", "update", "chmod", "remove"].includes(a.action)) continue;
      const existed = fs.existsSync(a.tgtAbs);
      const stat = existed ? fs.lstatSync(a.tgtAbs) : null;
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
        throw new Error(`target engine path changed to unsupported file type before apply: ${a.rel}`);
      }
      const priorBuf = existed ? fs.readFileSync(a.tgtAbs) : null;
      const mode = stat ? stat.mode & 0o777 : null;
      backups.push({ rel: a.rel, tgtAbs: a.tgtAbs, existed, priorBuf, mode });
      if (a.action === "remove") {
        fs.rmSync(a.tgtAbs, { force: true });
        fsyncDirectoryBestEffort(nodePath.dirname(a.tgtAbs));
        checkpoint(`after-remove:${a.rel}`);
      } else if (a.action === "chmod") {
        fs.chmodSync(a.tgtAbs, a.expected.mode);
        fsyncFileBestEffort(a.tgtAbs);
        checkpoint(`after-chmod:${a.rel}`);
      } else {
        const nextMode = supportsPosixModes
          ? a.expected.mode
          : mode == null ? 0o666 : mode;
        writeFileAtomicSync(a.tgtAbs, a.srcBuf, { mode: nextMode });
        checkpoint(`after-write:${a.rel}`);
      }
    }
    return backups;
  }

  // Exact byte-restore: rewrite each backed-up file to its prior bytes, and
  // delete files that did not exist before the apply.
  function rollback(backups) {
    const failures = [];
    for (const b of [...backups].reverse()) {
      try {
        if (b.existed) {
          writeFileAtomicSync(b.tgtAbs, b.priorBuf, { mode: b.mode == null ? 0o644 : b.mode });
        } else if (fs.existsSync(b.tgtAbs)) {
          fs.rmSync(b.tgtAbs, { force: true });
          fsyncDirectoryBestEffort(nodePath.dirname(b.tgtAbs));
        }
      } catch (error) {
        failures.push({ path: b.rel || b.tgtAbs, error: error.message });
      }
    }
    return { ok: failures.length === 0, failures, restored: backups.length - failures.length };
  }

  function transactionRoot(targetRoot) {
    return nodePath.join(targetRoot, TRANSACTIONS_REL);
  }

  function transactionJournalPath(transactionDir) {
    return nodePath.join(transactionDir, "transaction.json");
  }

  function targetRelativePath(targetRoot, absolute) {
    const rel = nodePath.relative(nodePath.resolve(targetRoot), nodePath.resolve(absolute));
    if (!rel || rel === ".." || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)) {
      throw new Error(`transaction target escapes workspace: ${absolute}`);
    }
    return rel.split(nodePath.sep).join("/");
  }

  function captureTransactionEntry(targetRoot, transactionDir, absolute, index) {
    const rel = targetRelativePath(targetRoot, absolute);
    if (!fs.existsSync(absolute)) return { rel, existed: false, mode: null, backup: null };
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`transaction target has unsupported file type: ${rel}`);
    }
    const backup = `${String(index).padStart(4, "0")}.bin`;
    writeFileAtomicSync(nodePath.join(transactionDir, backup), fs.readFileSync(absolute), { mode: 0o600 });
    return { rel, existed: true, mode: stat.mode & 0o777, backup };
  }

  function writeTransactionJournal(transaction) {
    writeJsonAtomicSync(transactionJournalPath(transaction.dir), transaction.journal, { mode: 0o600 });
  }

  function updateTransactionStatus(transaction, status, patch = {}) {
    transaction.journal = { ...transaction.journal, ...patch, status, updated_at: new Date().toISOString() };
    writeTransactionJournal(transaction);
  }

  function beginUpgradeTransaction(targetRoot, actions, operationDigest) {
    const id = `${Date.now()}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const dir = nodePath.join(transactionRoot(targetRoot), id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const successReceipt = receiptPath(targetRoot, operationDigest);
    const managed = [
      ...actions.filter((action) => ["add", "update", "chmod", "remove"].includes(action.action)).map((action) => action.tgtAbs),
      nodePath.join(targetRoot, INTEGRITY_PIN_REL),
      nodePath.join(targetRoot, ENGINE_PIN_REL),
      successReceipt,
    ];
    const unique = [...new Set(managed.map((value) => nodePath.resolve(value)))];
    try {
      const entries = unique.map((absolute, index) => captureTransactionEntry(targetRoot, dir, absolute, index));
      const transaction = {
        dir,
        journal: {
          schema: 1,
          transaction_id: id,
          operation_digest: operationDigest,
          status: "prepared",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          entries,
        },
      };
      writeTransactionJournal(transaction);
      checkpoint("after-transaction-prepared");
      return transaction;
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  function loadTransaction(transactionDir) {
    const journal = JSON.parse(fs.readFileSync(transactionJournalPath(transactionDir), "utf8"));
    if (
      !journal || journal.schema !== 1 ||
      typeof journal.transaction_id !== "string" || !/^\d{10,}-\d+-[0-9a-f]{16}$/.test(journal.transaction_id) ||
      typeof journal.operation_digest !== "string" || !/^[0-9a-f]{64}$/.test(journal.operation_digest) ||
      !Array.isArray(journal.entries)
    ) {
      throw new Error(`invalid upgrade transaction journal: ${transactionDir}`);
    }
    return { dir: transactionDir, journal };
  }

  function resolveTransactionTarget(targetRoot, rel) {
    if (
      typeof rel !== "string" || !rel || rel.includes("\\") || nodePath.posix.isAbsolute(rel) ||
      rel.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`invalid transaction target path: ${String(rel)}`);
    }
    const absolute = nodePath.resolve(targetRoot, ...rel.split("/"));
    targetRelativePath(targetRoot, absolute);
    return absolute;
  }

  function rollbackTransaction(targetRoot, transaction, originalError) {
    const failures = [];
    let restored = 0;
    try {
      updateTransactionStatus(transaction, "rolling-back", {
        original_error: String(originalError && originalError.message || originalError),
      });
    } catch (error) {
      failures.push({ path: "transaction.json", error: redactSensitive(error.message, [targetRoot, transaction.dir]) });
    }
    for (const entry of [...transaction.journal.entries].reverse()) {
      try {
        const absolute = resolveTransactionTarget(targetRoot, entry.rel);
        if (entry.existed) {
          if (typeof entry.backup !== "string" || !/^\d{4}\.bin$/.test(entry.backup)) {
            throw new Error(`invalid transaction backup path: ${String(entry.backup)}`);
          }
          const backup = nodePath.join(transaction.dir, entry.backup);
          writeFileAtomicSync(absolute, fs.readFileSync(backup), { mode: entry.mode == null ? 0o644 : entry.mode });
        } else if (fs.existsSync(absolute)) {
          fs.rmSync(absolute, { force: true });
          fsyncDirectoryBestEffort(nodePath.dirname(absolute));
        }
        restored += 1;
      } catch (error) {
        failures.push({ path: entry.rel, error: redactSensitive(error.message, [targetRoot, transaction.dir]) });
      }
    }
    let outcome = failures.length === 0 ? "rolled-back" : "incomplete-recovery";
    const receipt = {
      schema: 1,
      outcome,
      transaction_id: transaction.journal.transaction_id,
      plan_digest: transaction.journal.operation_digest,
      original_error: String(originalError && originalError.message || originalError),
      rollback_failures: failures,
      completed_at: new Date().toISOString(),
    };
    try {
      writeUpgradeReceipt(targetRoot, receipt, `${outcome}-${transaction.journal.transaction_id}`);
    } catch (error) {
      failures.push({ path: RECEIPTS_REL, error: redactSensitive(error.message, [targetRoot, transaction.dir]) });
      outcome = "incomplete-recovery";
    }
    try {
      updateTransactionStatus(transaction, outcome, { rollback_failures: failures });
    } catch (error) {
      failures.push({ path: "transaction.json", error: redactSensitive(error.message, [targetRoot, transaction.dir]) });
      outcome = "incomplete-recovery";
    }
    if (failures.length === 0) fs.rmSync(transaction.dir, { recursive: true, force: true });
    return { ok: failures.length === 0, failures, restored, outcome };
  }

  function pendingTransactionDirs(targetRoot) {
    const root = transactionRoot(targetRoot);
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => nodePath.join(root, entry.name));
  }

  function recoverPendingTransactions(targetRoot, options = {}) {
    const dirs = pendingTransactionDirs(targetRoot);
    if (dirs.length === 0) return { recovered: 0, pending: [] };
    if (options.readOnly) {
      return { recovered: 0, pending: dirs.map((dir) => nodePath.basename(dir)) };
    }
    let recovered = 0;
    for (const dir of dirs) {
      const journalFile = transactionJournalPath(dir);
      if (!fs.existsSync(journalFile)) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      const transaction = loadTransaction(dir);
      if (transaction.journal.status === "committed" || transaction.journal.status === "rolled-back") {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      const result = rollbackTransaction(targetRoot, transaction, new Error("interrupted upgrade recovered on next run"));
      if (!result.ok) {
        throw new Error(`manual recovery required for ${transaction.journal.transaction_id}: ${JSON.stringify(result.failures)}`);
      }
      recovered += 1;
    }
    return { recovered, pending: [] };
  }

  function printUsage() {
    log("Usage: coord upgrade [--dir <target>] [--channel <c>] [--json]");
    log("       coord upgrade --apply-plan <digest> [--dir <target>] [--json]");
    log("       coord upgrade --from <dir|bundle> [--dir <target>] [--channel <c>] [--dry-run] [--json]");
    log("       coord upgrade --check [--dir <target>] [--json]");
    log("");
    log("Without --from, resolve the pinned channel's latest immutable commit and");
    log("print a managed-write-free plan. Apply it only with --apply-plan <digest>.");
    log("The digest binds both target surface hashes and the upstream-pin bytes;");
    log("any intervening edit is refused and requires a newly reviewed plan.");
    log("Apply a new engine version into a repo's coord surface, re-pin, then");
    log("verify. Idempotent; fail-closed: a verify failure rolls the applied files");
    log("back to their exact pre-upgrade bytes and exits non-zero. On success it");
    log("also records the upstream pin (coord/.coord-engine.json: version/channel).");
    log("One exclusive target lock is held through planning, verification, pins,");
    log("and receipt publication. Dead same-host locks are recovered with a receipt;");
    log("live or foreign-host lock ownership is refused fail-closed.");
    log("On POSIX, executable modes are copied and verified. Windows skips POSIX");
    log("execute-bit enforcement and preserves existing modes on updated files.");
    log("Files retired from the new exact-match manifest are removed only when");
    log("their bytes still match the old manifest; locally changed paths are refused.");
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
    log("  --dry-run             Print the plan; do not change engine or pin files.");
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
    const recovery = recoverPendingTransactions(targetRoot, { readOnly: true });
    if (recovery.pending.length > 0) {
      const error = `incomplete upgrade transaction(s) require recovery: ${recovery.pending.join(", ")}`;
      if (opts.json) log(JSON.stringify({ verdict: "incomplete-recovery", error, transactions: recovery.pending }, null, 2));
      else log(`coord upgrade --check: ${error}. Run coord upgrade again to recover before checking drift.`);
      return { code: 1, error, pendingTransactions: recovery.pending };
    }
    const lockDir = upgradeLockPath(targetRoot);
    if (fs.existsSync(lockDir)) {
      const classification = classifyExistingLock(lockDir);
      const verdict = classification.stale ? "stale-upgrade-lock" : "upgrade-in-progress";
      const error = classification.stale
        ? `stale upgrade lock requires audited recovery (${classification.reason})`
        : `upgrade currently owns the target lock (${classification.reason})`;
      if (opts.json) log(JSON.stringify({ verdict, error, holder: classification.owner }, null, 2));
      else log(`coord upgrade --check: ${error}.`);
      return { code: 1, error, lockOwner: classification.owner, staleLock: classification.stale };
    }
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
      platform,
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
    const unpinned = !report.ok && report.problems.length > 0 && report.problems.every((problem) => (problem && problem.code) === "no_pin");
    const human = [
      `coord upgrade --check — ${targetRoot}`,
      `  engine version : ${version}`,
      `  channel        : ${channel}`,
      pin ? "" : "  (no .coord-engine.json — pre-COORD-451 scaffold; run `gov upgrade` to pin)",
      unpinned
        ? "  engine pin     : absent — legacy installation, not engine-file drift"
        : report.ok
        ? "  engine drift   : none — vendored surface matches its pin"
        : `  engine drift   : ${engineDrift} file(s) hand-edited vs the pinned surface`,
      "  project drift  : not checked — your board/config/product files remain outside engine drift",
      "  runtime state  : active upgrade locks and recovery journals are checked separately",
    ].filter((l) => l !== "");
    if (!report.ok) {
      for (const p of report.problems) human.push(`      - ${typeof p === "string" ? p : JSON.stringify(p)}`);
    }
    emit(opts, human, {
      verdict: report.ok ? "clean" : unpinned ? "unpinned" : "engine-drift",
      engine_version: version,
      channel,
      pinned: Boolean(pin),
      engine_drift: unpinned ? 0 : engineDrift,
      problems: report.ok ? [] : report.problems,
    });
    return { code: report.ok ? 0 : 1, engineDrift: unpinned ? 0 : engineDrift, unpinned };
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
    // repo's OWN files (board, project.config, product) is expected and
    // intentionally not flagged here. Upgrade locks and recovery journals under
    // .runtime are checked separately before the engine surface is inspected.
    if (opts.check) {
      const targetRoot = opts.dir ? nodePath.resolve(cwd(), opts.dir) : nodePath.resolve(cwd());
      return runCheck(opts, targetRoot);
    }

    const targetRoot = opts.dir ? nodePath.resolve(cwd(), opts.dir) : nodePath.resolve(cwd());
    let upgradeLock = null;
    try {
      const targetStat = fs.lstatSync(targetRoot);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw new Error(`target root must be a real directory: ${targetRoot}`);
      }
      upgradeLock = acquireUpgradeLock(targetRoot);
      return runLocked(opts, targetRoot);
    } catch (error) {
      const safeMessage = redactSensitive(error.message, [opts.entitlement, process.env.CONCORD_ENTITLEMENT]);
      if (opts.json) log(JSON.stringify({ verdict: "refused", error: safeMessage }, null, 2));
      else log(`coord upgrade: ${safeMessage}`);
      return { code: 1, error: safeMessage };
    } finally {
      if (upgradeLock) {
        const released = releaseUpgradeLock(upgradeLock);
        if (!released.released) log(`coord upgrade: WARNING — ${released.error}`);
      }
    }
  }

  function runLocked(opts, targetRoot) {

    // Enterprise is a licensed channel: switching to (or upgrading on) it requires
    // an entitlement token — fail-closed so a Community repo can't silently pull
    // the private enterprise surface. The token gates ACCESS to the private source
    // (supplied out-of-band as --from); we record only that it was present.
    try {
      const pending = recoverPendingTransactions(targetRoot, { readOnly: true });
      if (opts.dryRun && pending.pending.length > 0) {
        const error = `dry-run refused while interrupted upgrade transaction(s) require recovery: ${pending.pending.join(", ")}`;
        log(`coord upgrade: ${error}. Run the apply command without --dry-run to recover first.`);
        return { code: 1, error, pendingTransactions: pending.pending };
      }
      const recovery = recoverPendingTransactions(targetRoot);
      if (recovery.recovered > 0) {
        log(`coord upgrade: recovered ${recovery.recovered} interrupted transaction(s) before planning.`);
        checkpoint("after-interrupted-recovery");
      }
    } catch (error) {
      log(`coord upgrade: ${error.message}`);
      return { code: 1, error: error.message };
    }
    let priorPin;
    let plannedPinIdentity;
    try {
      priorPin = readEnginePin(targetRoot);
      plannedPinIdentity = captureUpstreamPinIdentity(targetRoot);
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
    let resolvedVersion = null;
    try {
      planned = plan(sourceRoot, targetRoot);
      resolvedVersion = resolved ? sourceEngineVersion(sourceRoot, planned.manifest) : null;
    } catch (error) {
      const msg = `coord upgrade: ${error.message}`;
      if (opts.json) {
        log(JSON.stringify({ verdict: "fail", error: error.message }, null, 2));
      } else {
        log(msg);
      }
      return { code: 1, error: error.message };
    } finally {
      if (resolved?.cleanup) resolved.cleanup();
    }

    const sourceIdentity = resolved ? { channel: effectiveChannel, ref: resolved.ref, sha: resolved.sha, archive_sha256: resolved.archiveSha256 } : null;
    const targetIdentity = { upstream_pin: plannedPinIdentity };
    const planDigest = resolved ? digestPlan(planned.actions, sourceIdentity, targetIdentity) : null;
    const { actions } = planned;
    const adds = actions.filter((a) => a.action === "add");
    const updates = actions.filter((a) => a.action === "update");
    const modeChanges = actions.filter((a) => a.action === "chmod");
    const removes = actions.filter((a) => a.action === "remove");
    const unchanged = actions.filter((a) => a.action === "unchanged");
    const missingInSource = actions.filter((a) => a.action === "missing-in-source");
    const retireConflicts = actions.filter((a) => a.action === "retire-conflict");
    const changeCount = adds.length + updates.length + modeChanges.length + removes.length;

    const human = [];
    human.push(`coord upgrade — from: ${sourceRoot}`);
    human.push(`               target: ${targetRoot}`);
    if (resolved) human.push(`               source: ${effectiveChannel} ${resolved.sha}`);
    if (opts.dryRun) human.push("(dry run — engine and pin files will not be changed)");
    human.push("");

    if (resolved && opts.applyPlan && opts.applyPlan !== planDigest) {
      human.push(`coord upgrade: REFUSED — plan digest changed (expected ${opts.applyPlan}, current ${planDigest}).`);
      human.push("Re-run `npm run concord -- upgrade`, review the new plan, and apply its digest.");
      emit(opts, human, { verdict: "refused", expected_plan_digest: opts.applyPlan, current_plan_digest: planDigest });
      return { code: 1, error: "plan digest mismatch", planDigest };
    }
    for (const a of actions) {
      if (a.action === "add") human.push(`  add        ${a.rel}`);
      else if (a.action === "update") human.push(`  update     ${a.rel}`);
      else if (a.action === "chmod") human.push(`  mode       ${a.rel}  (${a.before.mode.toString(8)} -> ${a.expected.mode.toString(8)})`);
      else if (a.action === "remove") human.push(`  remove     ${a.rel}  (retired exact-match engine file)`);
      else if (a.action === "retire-conflict") human.push(`  CONFLICT   ${a.rel}  (retired path differs from old manifest checksum)`);
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

    if (retireConflicts.length > 0) {
      human.push(
        `coord upgrade: REFUSED — ${retireConflicts.length} retired engine file(s) differ from ` +
          "the old exact-match manifest. Move or resolve those local changes before re-planning."
      );
      emit(opts, human, {
        verdict: "refused",
        error: "retired engine file modified",
        conflicts: retireConflicts.map((action) => action.rel),
      });
      return {
        code: 1,
        error: "retired engine file modified",
        conflicts: retireConflicts.map((action) => action.rel),
      };
    }

    if (resolved && !opts.applyPlan) {
      human.push(`Plan digest: ${planDigest}`);
      human.push(`Review this plan, then run: npm run concord -- upgrade --apply-plan ${planDigest}`);
      emit(opts, human, {
        verdict: "plan",
        plan_digest: planDigest,
        source: sourceIdentity,
        would_apply: changeCount,
        added: adds.length,
        updated: updates.length,
        mode_changed: modeChanges.length,
        removed: removes.map((action) => action.rel),
        unchanged: unchanged.length,
      });
      return { code: 0, planned: true, planDigest, wouldApply: changeCount };
    }

    if (!opts.dryRun && (!resolved || opts.applyPlan)) {
      checkpoint("before-preapply-revalidation");
      const preflight = revalidateTargetPrestate(actions, targetRoot, plannedPinIdentity);
      if (!preflight.ok) {
        human.push("coord upgrade: REFUSED — target state changed after planning; review a new plan before applying.");
        emit(opts, human, {
          verdict: "refused",
          error: "target changed after planning",
          problems: preflight.problems,
        });
        return { code: 1, error: "target changed after planning", problems: preflight.problems };
      }
    }

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
      human.push(`Would apply ${changeCount} change(s) (add ${adds.length}, update ${updates.length}, ` +
        `chmod ${modeChanges.length}, remove ${removes.length}), ` +
        `${unchanged.length} unchanged, then re-pin + verify.`);
      emit(opts, human, {
        verdict: "dry-run",
        would_apply: changeCount,
        added: adds.length,
        updated: updates.length,
        mode_changed: modeChanges.length,
        removed: removes.map((action) => action.rel),
        unchanged: unchanged.length,
      });
      return { code: 0, dryRun: true, wouldApply: changeCount };
    }

    const operationDigest = planDigest || digestPlan(
      actions,
      { channel: effectiveChannel, source: "local" },
      targetIdentity
    );
    let transaction;
    let verifyReport;
    let upstream;
    const newVersion = resolvedVersion || sourceEngineVersion(sourceRoot, planned.manifest);
    try {
      transaction = beginUpgradeTransaction(targetRoot, actions, operationDigest);
      updateTransactionStatus(transaction, "applying");
      checkpoint("after-transaction-applying");
      applyActions(actions);

      updateTransactionStatus(transaction, "verifying");
      checkpoint("after-transaction-verifying");
      const independentReport = verifyTargetAgainstPlan(actions, targetRoot);
      if (!independentReport.ok) {
        const error = new Error("independent target verification failed");
        error.problems = independentReport.problems;
        throw error;
      }
      checkpoint("after-independent-verification");

      const enginePin = createEnginePin({
        coordDir: nodePath.join(targetRoot, "coord"),
        platform,
        fail: (m) => { throw new Error(m); },
      });
      const pinStage = nodePath.join(transaction.dir, "next-engine-pin.json");
      enginePin.pin({ pinPath: pinStage });
      writeFileAtomicSync(
        nodePath.join(targetRoot, INTEGRITY_PIN_REL),
        fs.readFileSync(pinStage),
        { mode: 0o600 }
      );
      verifyReport = enginePin.verify();
      if (!verifyReport.ok) {
        const error = new Error("engine verify failed after apply");
        error.problems = verifyReport.problems;
        throw error;
      }
      checkpoint("after-integrity-pin");

      updateTransactionStatus(transaction, "committing");
      checkpoint("after-transaction-committing");
      upstream = writeEnginePin(
        targetRoot,
        {
          engineVersion: newVersion,
          channel: opts.channel || undefined,
          ...(opts.ref != null ? { ref: opts.ref } : {}),
          ...(opts.sha != null ? { sha: opts.sha } : {}),
        },
        deps.now
      );
      checkpoint("after-upstream-pin");

      writeUpgradeReceipt(targetRoot, {
        schema: 1,
        outcome: "success",
        transaction_id: transaction.journal.transaction_id,
        plan_digest: operationDigest,
        source: sourceIdentity || { channel: effectiveChannel, local: true },
        engine_version: newVersion,
        applied: changeCount,
        added: adds.map((action) => action.rel),
        updated: updates.map((action) => action.rel),
        mode_changed: modeChanges.map((action) => action.rel),
        removed: removes.map((action) => action.rel),
        completed_at: deps.now || new Date().toISOString(),
      }, operationDigest);
      checkpoint("after-success-receipt");
      updateTransactionStatus(transaction, "committed");
      fs.rmSync(transaction.dir, { recursive: true, force: true });
    } catch (error) {
      if (!transaction) {
        const safeMessage = redactSensitive(error.message, [opts.entitlement, process.env.CONCORD_ENTITLEMENT]);
        human.push(`coord upgrade: FAIL — transaction preparation failed: ${safeMessage}`);
        emit(opts, human, { verdict: "fail", error: safeMessage, rolled_back: 0 });
        return { code: 1, error: safeMessage, rolledBack: 0 };
      }
      const safeMessage = redactSensitive(error.message, [opts.entitlement, process.env.CONCORD_ENTITLEMENT]);
      const receiptMessage = redactSensitive(safeMessage, [targetRoot, sourceRoot]);
      const recovery = rollbackTransaction(targetRoot, transaction, new Error(receiptMessage));
      const problems = error.problems || [];
      human.push(`coord upgrade: FAIL — ${safeMessage}.`);
      if (recovery.ok) {
        human.push(`Rolled back ${recovery.restored} managed path(s) to their pre-upgrade state.`);
      } else {
        human.push(`MANUAL RECOVERY REQUIRED — ${recovery.failures.length} path(s) could not be restored.`);
      }
      emit(opts, human, {
        verdict: recovery.ok ? "rolled-back" : "incomplete-recovery",
        error: safeMessage,
        problems,
        rolled_back: recovery.restored,
        rollback_failures: recovery.failures,
        transaction_id: transaction.journal.transaction_id,
      });
      return {
        code: 1,
        error: safeMessage,
        rolledBack: recovery.restored,
        rollbackFailures: recovery.failures,
        transactionId: transaction.journal.transaction_id,
      };
    }

    human.push(
      `Applied ${changeCount} change(s) (add ${adds.length}, update ${updates.length}, ` +
        `chmod ${modeChanges.length}, remove ${removes.length}), ` +
        `${unchanged.length} unchanged. Re-pinned engine-pin.json; engine verify PASS.`
    );
    human.push(`Pinned upstream: version ${upstream.engine_version}, channel ${upstream.source.channel}.`);
    emit(opts, human, {
      verdict: "pass",
      applied: changeCount,
      added: adds.length,
      updated: updates.length,
      mode_changed: modeChanges.length,
      removed: removes.length,
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
      modeChanged: modeChanges.length,
      removed: removes.length,
      unchanged: unchanged.length,
      channel: upstream.source.channel,
      engineVersion: upstream.engine_version,
    };
  }

  return {
    parseArgs, plan, digestPlan, surfacePaths, applyActions, rollback, run, printUsage,
    readEnginePin, writeEnginePin, sourceEngineVersion, runCheck,
    validateManagedRelPath, inspectManagedPath, expectedSourceChecksum, verifyTargetAgainstPlan,
    beginUpgradeTransaction, rollbackTransaction, recoverPendingTransactions, pendingTransactionDirs,
    writeFileAtomicSync, receiptPath, redactSensitive,
    acquireUpgradeLock, releaseUpgradeLock, upgradeLockPath, captureUpstreamPinIdentity,
    revalidateTargetPrestate,
  };
};
