#!/usr/bin/env node
"use strict";

// COORD-1044 / ADR 0028: runners for the eight release-edge gates that
// coord/engine/test-policy.json promotion_edges names for main -> concord-public-release and
// main -> concord-enterprise-release. The gate-manifest producer (promote.js produceGateManifest)
// runs each gate as `node coord/engine/scripts/release-gates.js <gate> --report <file>`
// inside its detached temporary worktree of the gate's commit, with that gate's lane Node
// first on PATH. Each runner wires to the EXISTING release script for its gate and reports
// pass only when that script passes; anything else is fail, with the reason recorded.
//
// Nothing here publishes, pushes, tags or creates a remote. Builds write only under the cache
// root (default: os.tmpdir()/coord-release-gates/<commit>). Steps that need the network or
// credentials are refused with a "refused:" detail, never reported as passing.
//
// The producer checks out the gate's commit in a clean worktree. The local installation
// and Enterprise qualification gates build from that explicit immutable candidate.
//
// CLI: release-gates.js <gate> [--report <file>]. Exit 0 only on pass.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { readAttestation, readQualificationAttestation, treeDigest } = require("../../cut-attestation.js");

const REPORT_SCHEMA = "release-gate-run/1";
const CUT_RECEIPT_SCHEMA = "release-cut-cache/1";
const PUBLISHED_ASSET_INSTALL = "published-asset install";
const BUILD_TIMEOUT_MS = 50 * 60 * 1000;
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;
const POSTJECT_VERSION_RE = /postject@[0-9][^\s"']*/;
const NETWORK_RE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|registry\.npmjs\.org|getaddrinfo/i;
const ENTERPRISE_DIRS = ["coord/engine/scripts/enterprise", "coord/scripts/enterprise"];

const SCRIPTS = Object.freeze({
  build: "release/build-public-release.sh",
  scanDonor: "release/scan-donor-refs.sh",
  scanSecrets: "release/scan-secrets.sh",
  scanEnterprise: "release/scan-enterprise-refs.sh",
  dualVerify: "release/verify-dual-release.sh",
  stageNpm: "release/stage-npm-package.js",
  buildSea: "release/build-linux-binary.sh",
});

// Real process execution. Tests inject their own exec so no real build runs in a fixture.
// The gate leads its own process group (detached), and that group is killed when the gate returns or times
// out: a timeout SIGKILLs only the direct child, so without this a build's grandchildren (node --test
// workers, scans) would outlive the gate and keep writing into the cache. Output goes to a file, not a pipe,
// because a grandchild holding a pipe open would block spawnSync past the timeout.
function defaultExec(command, args, options) {
  const spill = fs.mkdtempSync(path.join(os.tmpdir(), "coord-gate-exec-"));
  const outPath = path.join(spill, "output");
  const fd = fs.openSync(outPath, "w");
  let run;
  try {
    run = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout: options.timeout,
      killSignal: "SIGKILL",
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  if (run.pid) {
    try {
      process.kill(-run.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const captured = fs.readFileSync(outPath, "utf8");
  fs.rmSync(spill, { recursive: true, force: true });
  const output = `${captured}${run.error ? `\n${run.error.message}` : ""}`;
  if (options.log) fs.writeFileSync(options.log, output);
  return { status: run.status === null ? 1 : run.status, output };
}

function git(root, args) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(run.stderr || "").trim()}`);
  return run.stdout.trim();
}

function step(steps, name, ok, detail) {
  steps.push({ name, status: ok ? "pass" : "fail", detail: detail || null });
  return ok;
}

function refused(steps, name, detail) {
  // guard:governed-push-safety
  steps.push({ name, status: "refused", detail: `refused: ${detail}` });
  return false;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function cutArtifactDigest(root) {
  const absoluteRoot = fs.realpathSync(root);
  const inside = (candidate) => candidate === absoluteRoot || candidate.startsWith(`${absoluteRoot}${path.sep}`);
  const entries = [];
  const content = treeDigest(absoluteRoot, {
    onEntry(rel, full, entry) {
      const mode = (fs.lstatSync(full).mode & 0o7777).toString(8);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        if (path.isAbsolute(target)) throw new Error(`absolute symlink ${rel} -> ${target}`);
        if (!inside(path.resolve(path.dirname(full), target))) throw new Error(`escaping symlink ${rel} -> ${target}`);
        let resolved;
        try {
          resolved = fs.realpathSync(full);
        } catch (error) {
          throw new Error(`unresolved symlink ${rel} -> ${target}: ${error.message}`);
        }
        if (!inside(resolved)) throw new Error(`escaping symlink ${rel} -> ${target}`);
        entries.push(`${rel}\0symlink:${mode}:${target}\n`);
      } else if (entry.isDirectory()) entries.push(`${rel}\0directory:${mode}\n`);
      else if (entry.isFile()) entries.push(`${rel}\0file:${mode}\n`);
      else throw new Error(`unsupported filesystem entry in cut: ${rel}`);
    },
  });
  return crypto.createHash("sha256").update(`${content}\0${entries.sort().join("")}`).digest("hex");
}

function inspectCut(ctx, kind, dir, qualification) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(dir);
  } catch {
    throw new Error(`${kind} cut directory is missing`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${kind} cut path is not a real directory`);
  const gitDir = path.join(dir, ".git");
  if (!fs.lstatSync(gitDir).isDirectory()) throw new Error(`${kind} cut has no real .git directory`);
  const artifactDigest = cutArtifactDigest(dir);
  const attestationPath = `${dir}.attestation.json`;
  if (!fs.lstatSync(attestationPath).isFile()) throw new Error(`${kind} cut attestation is not a regular file`);
  const attestation = qualification
    ? readQualificationAttestation(dir, { commit: ctx.commit, tree: ctx.tree, edition: kind,
      policySha256: fileSha256(path.join(ctx.root, "coord/engine/test-policy.json")),
      builderSha256: fileSha256(path.join(ctx.root, SCRIPTS.build)) })
    : readAttestation(dir);
  const expected = kind === "enterprise"
    ? { artifact: "softsensor-concord-enterprise", cut: "Enterprise", edition: "enterprise" }
    : { artifact: "softsensor-concord", cut: "Community", edition: "community" };
  if (attestation.artifact !== expected.artifact || attestation.cut !== expected.cut || attestation.donor_edition !== expected.edition) {
    throw new Error(`${kind} cut attestation has the wrong artifact or edition`);
  }
  if (attestation.donor_commit !== ctx.commit || attestation.donor_tree_state !== "clean" || attestation.hygiene_gate !== "pass") {
    throw new Error(`${kind} cut attestation does not bind a clean, hygiene-passing build of donor ${ctx.commit}`);
  }
  // A promotion candidate is built from the exact detached commit before it is
  // necessarily reachable from the edition donor branch. The builder records
  // donor_mode=none/publishable=false for that local qualification. This gate
  // binds identity and hygiene; it does not claim branch publishability.
  if (!qualification && !["none", "donor-branch"].includes(attestation.donor_mode)) {
    throw new Error(`${kind} cut was built in unsupported donor mode ${JSON.stringify(attestation.donor_mode)}`);
  }
  if (attestation.donor_mode === "none" && (attestation.publishable !== false || !(attestation.unpublishable_reasons || []).some((reason) => reason.startsWith("no donor branch named")))) {
    throw new Error(`${kind} candidate cut has inconsistent unpublished-candidate attestation`);
  }
  if (attestation.donor_mode === "donor-branch") {
    const branch = kind === "enterprise" ? "concord-enterprise-release" : "concord-public-release";
    if (attestation.publishable !== true || attestation.donor_branch !== branch) {
      throw new Error(`${kind} donor-branch cut is not attested as publishable from ${branch}`);
    }
  }
  const cutCommit = git(dir, ["rev-parse", "HEAD"]);
  const cutTree = git(dir, ["rev-parse", "HEAD^{tree}"]);
  if (attestation.cut_commit !== cutCommit || attestation.cut_tree_digest !== cutTree) {
    throw new Error(`${kind} cut Git tree does not match its attestation`);
  }
  if (path.resolve(attestation.cut_dir || "") !== path.resolve(dir)) {
    throw new Error(`${kind} cut attestation names a different artifact directory`);
  }
  const coordDir = path.join(dir, "coord");
  if (!fs.lstatSync(coordDir).isDirectory()) throw new Error(`${kind} cut has no real coord/ directory`);
  const provenancePath = path.join(coordDir, "RELEASE_PROVENANCE.json");
  if (!fs.lstatSync(provenancePath).isFile()) throw new Error(`${kind} cut provenance is not a regular file`);
  const provenance = readJson(provenancePath);
  if (!provenance || provenance.artifact !== expected.artifact || provenance.cut !== expected.cut || provenance.donor_commit !== ctx.commit) {
    throw new Error(`${kind} cut provenance does not bind the expected artifact, edition, and donor commit`);
  }
  const dirty = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Error(`${kind} cut working tree is dirty: ${dirty.split("\n").slice(0, 5).join(", ")}`);
  return { artifactDigest, cutCommit, cutTree, attestation };
}

function receiptMatches(receipt, ctx, kind) {
  return receipt && receipt.schema === CUT_RECEIPT_SCHEMA && receipt.kind === kind &&
    receipt.commit === ctx.commit && receipt.tree === ctx.tree && typeof receipt.ok === "boolean";
}

function writeReceipt(file, receipt) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temp, file);
}

// Context for one run: the donor commit (worktree HEAD), the cache root, and the injected exec.
function makeContext(opts = {}) {
  const root = opts.root || process.cwd();
  const commit = git(root, ["rev-parse", "HEAD"]);
  const cacheRoot = opts.cacheRoot || process.env.COORD_RELEASE_GATE_CACHE || path.join(os.tmpdir(), "coord-release-gates");
  const cacheDir = path.join(cacheRoot, commit);
  fs.mkdirSync(cacheDir, { recursive: true });
  return {
    root,
    commit,
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
    dirty: git(root, ["status", "--porcelain"]),
    cacheDir,
    exec: opts.exec || defaultExec,
    // Release scripts resolve under scriptRoot. Production: the worktree itself. Tests may point at the
    // real donor so the real scan scripts run against fixture artifacts.
    script: (rel) => path.join(opts.scriptRoot || root, rel),
  };
}

// One cut per commit and edition. The builder is the only writer; later gates reuse the cut and its
// recorded outcome, so a failed build is reported by every gate that needs the cut, not rebuilt.
function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ensureCut(ctx, kind, steps, { qualification = false } = {}) {
  const cacheName = qualification ? `${kind}-qualification` : kind;
  const dir = path.join(ctx.cacheDir, cacheName);
  const marker = path.join(ctx.cacheDir, `${cacheName}.status.json`);
  let markerExists = false;
  let recorded = null;
  try {
    const markerStat = fs.lstatSync(marker);
    markerExists = true;
    if (markerStat.isFile() && !markerStat.isSymbolicLink()) recorded = readJson(marker);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (receiptMatches(recorded, ctx, kind) && recorded.ok === false) {
    step(steps, `${kind} cut (reused failure)`, false, recorded.reason || "cached cut build failed");
    return { ok: false, dir, reason: recorded.reason || "cached cut build failed" };
  }
  if (receiptMatches(recorded, ctx, kind) && recorded.ok === true) {
    try {
      const current = inspectCut(ctx, kind, dir, qualification);
      if (recorded.artifact_digest === current.artifactDigest && recorded.cut_commit === current.cutCommit && recorded.cut_tree_digest === current.cutTree) {
        step(steps, `${kind} cut (reused)`, true, "receipt and artifact content match this donor commit, tree, and edition");
        return { ok: true, dir, reason: null, attestation: current.attestation };
      }
    } catch {
      // A missing, malformed, dirty, or changed cached cut is not reusable.
      // The builder starts by removing its output directory, so rebuild below.
    }
  }
  if (markerExists) fs.rmSync(marker, { recursive: true, force: true });
  const args = [ctx.script(SCRIPTS.build), dir];
  if (kind === "enterprise") args.push("--enterprise");
  if (qualification) args.push(`--qualify-commit=${ctx.commit}`);
  const run = ctx.exec("bash", args, { cwd: ctx.root, timeout: BUILD_TIMEOUT_MS, log: path.join(ctx.cacheDir, `${cacheName}-build.log`) });
  let reason = null;
  if (run.status !== 0) reason = `${SCRIPTS.build} exited ${run.status} for the ${kind} cut`;
  if (!reason && kind === "community") {
    const leaked = ENTERPRISE_DIRS.filter((rel) => fs.existsSync(path.join(dir, rel)));
    // guard:governed-push-safety
    if (leaked.length) reason = `Enterprise paths in Community output: ${leaked.join(", ")}`;
  }
  if (!reason && kind === "enterprise") {
    const missing = ENTERPRISE_DIRS.filter((rel) => !fs.existsSync(path.join(dir, rel)));
    // guard:governed-push-safety
    if (missing.length) reason = `Enterprise cut is missing ${missing.join(", ")}`;
  }
  let artifact = null;
  if (!reason) {
    try {
      artifact = inspectCut(ctx, kind, dir, qualification);
    } catch (error) {
      reason = `built ${kind} cut failed integrity validation: ${error.message}`;
    }
  }
  const ok = !reason;
  writeReceipt(marker, {
    schema: CUT_RECEIPT_SCHEMA,
    ok,
    reason,
    kind,
    commit: ctx.commit,
    tree: ctx.tree,
    ...(artifact ? { artifact_digest: artifact.artifactDigest, cut_commit: artifact.cutCommit, cut_tree_digest: artifact.cutTree } : {}),
    built_at: new Date().toISOString(),
  });
  step(steps, `${kind} cut built`, ok, reason);
  return { ok, dir, reason, attestation: artifact?.attestation };
}

function scanStep(ctx, steps, name, rel, target, passText) {
  const run = ctx.exec("bash", [ctx.script(rel), target], { cwd: ctx.root, timeout: SCAN_TIMEOUT_MS, log: path.join(ctx.cacheDir, `${name}.log`) });
  // scan exit 0 is clean; 1 is a leak; 2 or 3 means the scan did not complete (never a pass).
  return step(steps, name, run.status === 0, run.status === 0 ? passText : `${rel} exited ${run.status}`);
}

// --- runners --------------------------------------------------------------------------------

function donorHygieneScan(ctx, steps) {
  const cut = ensureCut(ctx, "community", steps);
  if (!cut.ok) return step(steps, "donor-hygiene-scan", false, "community cut not built");
  return scanStep(ctx, steps, "donor-hygiene-scan", SCRIPTS.scanDonor, cut.dir, "donor-ref scan clean");
}

function releaseSecretScan(ctx, steps) {
  const cut = ensureCut(ctx, "community", steps);
  if (!cut.ok) return step(steps, "release-secret-scan", false, "community cut not built");
  return scanStep(ctx, steps, "release-secret-scan", SCRIPTS.scanSecrets, cut.dir, "secret scan clean");
}

function enterpriseRefScan(ctx, steps) {
  // Community output must carry no Enterprise path (COORD-111). The scan runs on the Community cut.
  const cut = ensureCut(ctx, "community", steps);
  if (!cut.ok) return step(steps, "enterprise-ref-scan", false, "community cut not built");
  return scanStep(ctx, steps, "enterprise-ref-scan", SCRIPTS.scanEnterprise, cut.dir, "no Enterprise paths in Community output");
}

function dualReleaseVerify(ctx, steps) {
  const outRoot = fs.realpathSync(fs.mkdtempSync(path.join(ctx.cacheDir, "dual-")));
  const run = ctx.exec("bash", [ctx.script(SCRIPTS.dualVerify), outRoot, `--qualify-commit=${ctx.commit}`], {
    cwd: ctx.root, timeout: BUILD_TIMEOUT_MS, log: `${outRoot}.log`,
  });
  if (run.status !== 0 || !run.output.includes("DUAL-RELEASE QUALIFICATION PASS")) {
    return step(steps, "dual-release-verify", false, `${SCRIPTS.dualVerify} exited ${run.status} without passing candidate qualification`);
  }
  const receiptPath = path.join(outRoot, "dual-qualification.json");
  const manifestPath = path.join(outRoot, "run-manifest.json");
  if (![receiptPath, manifestPath].every((file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile())) {
    return step(steps, "dual-release-verify", false, "missing or mismatched dual qualification evidence");
  }
  const receipt = readJson(receiptPath);
  const manifest = readJson(manifestPath);
  const source = manifest?.inputs?.source;
  const lanes = manifest?.lanes?.map(({ name }) => name).join(",");
  const runManifest = require("./run-manifest.js");
  const digest = (file) => runManifest.artifactDigests([file])[0].sha256?.slice("sha256:".length);
  const editionBound = (edition) => {
    const cut = receipt?.cuts?.[edition];
    const attestation = `${path.join(outRoot, edition)}.attestation.json`;
    return /^[a-f0-9]{40}$/.test(cut?.cut_commit) && /^[a-f0-9]{40}$/.test(cut.cut_tree_digest) &&
      /^[a-f0-9]{64}$/.test(cut.cut_content_digest) && /^[a-f0-9]{64}$/.test(cut.attestation_sha256) &&
      fs.lstatSync(attestation, { throwIfNoEntry: false })?.isFile() && cut.attestation_sha256 === digest(attestation);
  };
  const bound = receipt?.schema === "concord-dual-qualification/1" && receipt.purpose === "qualification" &&
    receipt.publishable === false && receipt.commit === ctx.commit && receipt.tree === ctx.tree &&
    /^[a-f0-9]{64}$/.test(receipt.cuts?.community?.payload_sha256) &&
    Object.keys(receipt.cuts).sort().join(",") === "community,enterprise" &&
    ["community", "enterprise"].every(editionBound) &&
    /^[a-f0-9]{64}$/.test(receipt.policy_sha256) && receipt.policy_sha256 === digest(path.join(ctx.root, "coord/engine/test-policy.json")) &&
    /^[a-f0-9]{64}$/.test(receipt.builder_sha256) && receipt.builder_sha256 === digest(path.join(ctx.root, SCRIPTS.build)) &&
    manifest?.tool === "release/verify-dual-release.sh qualification" && manifest.result === "pass" &&
    source?.commit === ctx.commit && source.tree === ctx.tree && source.dirty === false &&
    lanes === "community,enterprise,candidate-binding";
  if (!bound || runManifest.validateManifest(manifest).length) {
    return step(steps, "dual-release-verify", false, "missing or mismatched dual qualification evidence");
  }
  const [artifact] = runManifest.artifactDigests([receiptPath]);
  const valid = manifest.artifacts.some(({ path: file, sha256, bytes }) =>
    file === receiptPath && sha256 === artifact.sha256 && bytes === artifact.bytes);
  if (valid) ctx.qualificationReceipt = { path: receiptPath, sha256: artifact.sha256.slice("sha256:".length) };
  return step(steps, "dual-release-verify", valid, valid ? `both nonpublishable cuts qualified (${artifact.sha256})` : "dual qualification receipt bytes are not bound by its manifest");
}

function verifyLocalScaffold(ctx, steps, channel, command, args, npmEnv) {
  const name = `${channel} scaffold (offline canary)`;
  const work = fs.mkdtempSync(path.join(ctx.cacheDir, `${channel.toLowerCase()}-scaffold-`));
  const target = path.join(work, "workspace");
  const env = { ...npmEnv, npm_config_offline: "true" };
  delete env.CONCORD_DONOR;
  delete env.CONCORD_BUNDLE_DIR;
  const run = (phase, flags) => ctx.exec(command, [...args, target, ...flags], {
    cwd: work,
    env,
    timeout: SCAN_TIMEOUT_MS,
    log: path.join(ctx.cacheDir, `${path.basename(work)}-${phase}.log`),
  });
  try {
    const dryRun = run("plan", ["--dry-run"]);
    if (dryRun.status !== 0 || fs.lstatSync(target, { throwIfNoEntry: false })) {
      return step(steps, name, false, "installer dry-run failed or wrote to the target");
    }
    let digest;
    try {
      const planText = dryRun.output.slice(dryRun.output.indexOf("{"), dryRun.output.lastIndexOf("}") + 1);
      digest = JSON.parse(planText)?.digest;
    } catch {
      return step(steps, name, false, "installer did not emit a valid dry-run plan");
    }
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      return step(steps, name, false, "installer did not emit a valid plan digest");
    }
    const applied = run("apply", ["--apply-plan", digest]);
    const receipt = readJson(path.join(target, "coord", ".concord-install-receipt.json"));
    const ok = applied.status === 0 && receipt?.plan_digest === digest
      && fs.existsSync(path.join(target, "coord", "scripts", "governance.js"));
    return step(steps, name, ok, ok ? digest : "install did not produce the reviewed scaffold and receipt");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function installCanariesNpmSea(ctx, steps) {
  const recordPublishedAssetRefusal = () => refused(steps, PUBLISHED_ASSET_INSTALL, "requires published release assets; local-only verification does not publish");
  const cut = ensureCut(ctx, "community", steps, { qualification: true });
  if (!cut.ok) {
    step(steps, "install-canaries-npm-sea", false, "community cut not built");
    recordPublishedAssetRefusal();
    return false;
  }
  // npm canary: stage create-concord from the cut, validate, pack, then install the tarball offline into a
  // fresh prefix. The package has no runtime dependencies, so the install needs no registry access.
  const stage = path.join(ctx.cacheDir, "npm-stage");
  const pack = path.join(ctx.cacheDir, "npm-pack");
  const prefix = path.join(ctx.cacheDir, "npm-prefix");
  for (const dir of [stage, pack, prefix]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(pack, { recursive: true });
  const npmEnv = { ...process.env, npm_config_cache: path.join(ctx.cacheDir, "npm-cache"), npm_config_update_notifier: "false" };
  const node = (args) => ctx.exec(process.execPath, args, { cwd: ctx.root, timeout: SCAN_TIMEOUT_MS, env: npmEnv });
  let ok = step(steps, "npm stage", node([ctx.script(SCRIPTS.stageNpm), "stage-qualification", cut.dir, stage]).status === 0);
  ok = ok && step(steps, "npm validate", node([ctx.script(SCRIPTS.stageNpm), "validate-qualification", cut.dir, stage]).status === 0);
  let tarball = null;
  if (ok) {
    const packed = ctx.exec("npm", ["pack", "--pack-destination", pack, "--ignore-scripts", "--silent"], { cwd: stage, timeout: SCAN_TIMEOUT_MS, env: npmEnv });
    const archives = fs.existsSync(pack) ? fs.readdirSync(pack, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".tgz")) : [];
    if (archives.length === 1 && archives[0].isFile()) tarball = archives[0].name;
    ok = step(steps, "npm pack", packed.status === 0 && Boolean(tarball));
  }
  if (ok) {
    const archive = path.join(pack, tarball);
    const digest = fileSha256(archive);
    const installed = ctx.exec("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, archive], { cwd: ctx.root, timeout: SCAN_TIMEOUT_MS, env: npmEnv });
    const executable = path.join(prefix, "node_modules", ".bin", "create-concord");
    const packageDir = path.join(prefix, "node_modules", "create-concord");
    const matched = installed.status === 0 && fileSha256(archive) === digest && fs.existsSync(executable) &&
      step(steps, "npm installed payload", node([ctx.script(SCRIPTS.stageNpm), "validate-qualification", cut.dir, packageDir]).status === 0);
    ok = step(steps, "npm install (offline canary)", matched, matched ? digest : null);
    if (ok) ok = verifyLocalScaffold(ctx, steps, "npm", executable, [], npmEnv);
  }
  // SEA canary: the binary builder fetches the pinned postject from the npm registry at build time.
  const seaOut = fs.mkdtempSync(path.join(ctx.cacheDir, "sea-"));
  const sea = ctx.exec("bash", [ctx.script(SCRIPTS.buildSea), seaOut, "--qualification-cut", cut.dir], { cwd: ctx.root, timeout: BUILD_TIMEOUT_MS, log: path.join(ctx.cacheDir, "sea-build.log") });
  const binary = path.join(seaOut, `concord-qualification-linux-${os.machine()}`);
  const binaryStat = fs.lstatSync(binary, { throwIfNoEntry: false });
  if (sea.status !== 0 || !binaryStat?.isFile() || !(binaryStat.mode & 0o111)) {
    const pin = (sea.output.match(POSTJECT_VERSION_RE) || [])[0];
    // guard:governed-push-safety
    const detail = NETWORK_RE.test(sea.output) && pin
      ? `SEA step needs ${pin} from the npm registry at build time, and this run has no network access`
      : null;
    if (detail) refused(steps, "SEA binary build", detail);
    else step(steps, "SEA binary build", false, `${SCRIPTS.buildSea} exited ${sea.status} without a binary`);
    ok = false;
  } else {
    const sidecar = readJson(`${binary}.qualification.json`);
    const digest = fileSha256(binary);
    const bound = sidecar?.schema_version === 2 && sidecar.purpose === "qualification" &&
      sidecar.publishable === false && sidecar.binary === path.basename(binary) &&
      sidecar.donor_commit === ctx.commit && sidecar.cut_tree_digest === cut.attestation.cut_tree_digest &&
      sidecar.cut_content_digest === cut.attestation.cut_content_digest && sidecar.sha256 === digest;
    step(steps, "SEA binary build", bound, bound ? digest : "binary attestation does not bind the qualification cut");
    ok = bound && verifyLocalScaffold(ctx, steps, "SEA", binary, ["init"], npmEnv) && ok;
  }
  // The released-asset install check (release/verify-released-install.sh) needs the published
  // release assets, which only exist after an actual release. It is not run here.
  // Record that expected refusal explicitly; the manifest remains local-only and does not
  // claim that a published asset was installed or verified.
  recordPublishedAssetRefusal();
  return ok;
}

function enterpriseQualification(ctx, steps) {
  const cut = ensureCut(ctx, "enterprise", steps, { qualification: true });
  return step(steps, "enterprise-qualification", cut.ok,
    cut.ok ? `nonpublishable Enterprise cut passed its hygiene and shim checks (${cut.attestation.cut_content_digest})`
      : "enterprise cut not built");
}

const RUNNERS = Object.freeze({
  "community-cut-build": (ctx, steps) => ensureCut(ctx, "community", steps).ok,
  "donor-hygiene-scan": donorHygieneScan,
  "release-secret-scan": releaseSecretScan,
  "dual-release-verify": dualReleaseVerify,
  "install-canaries-npm-sea": installCanariesNpmSea,
  "enterprise-cut-build": (ctx, steps) => ensureCut(ctx, "enterprise", steps).ok,
  "enterprise-qualification": enterpriseQualification,
  "enterprise-ref-scan": enterpriseRefScan,
});

// An explicit refused failure can invalidate a reported pass. The published-asset
// refusal is expected in a local canary and does not explain a failed gate.
function gateDiagnostic(steps, pass) {
  const failing = steps.filter((step) => step.status === "fail");
  // guard:governed-push-safety
  const refusedFailure = failing.find((step) => step.detail && step.detail.startsWith("refused:"));
  if (refusedFailure) return refusedFailure.detail;
  if (pass) return null;
  const reportedStep = failing.find((step) => step.detail) || steps.find((step) => step.status === "refused" && step.name !== PUBLISHED_ASSET_INSTALL);
  if (reportedStep) return reportedStep.detail;
  return failing.length ? `failed: ${failing.map((step) => step.name).join(", ")}` : "gate did not pass";
}

// Runs one gate. Returns { schema, gate, result: "pass"|"fail", commit, tree, steps, detail }.
// A runner that throws is a fail with the error recorded; a dirty worktree is a fail before any build.
function runGate(gate, opts = {}) {
  const runner = RUNNERS[gate];
  // guard:governed-push-safety
  if (!Object.hasOwn(RUNNERS, gate)) return { schema: REPORT_SCHEMA, gate, result: "fail", commit: null, tree: null, steps: [], detail: `no runner for gate ${gate}` };
  const ctx = makeContext(opts);
  const base = { schema: REPORT_SCHEMA, gate, commit: ctx.commit, tree: ctx.tree };
  // guard:governed-push-safety
  if (ctx.dirty) {
    return { ...base, result: "fail", steps: [], detail: "donor worktree is dirty; release gates run only on a clean commit" };
  }
  const steps = [];
  let pass = false;
  let detail = null;
  try {
    pass = runner(ctx, steps) === true;
  } catch (error) {
    detail = `runner threw: ${error.message}`;
  }
  detail ||= gateDiagnostic(steps, pass);
  return { ...base, result: pass && !detail ? "pass" : "fail", steps, detail,
    ...(pass && !detail && ctx.qualificationReceipt ? { qualification_receipt: ctx.qualificationReceipt } : {}) };
}

function main(argv) {
  const gate = argv[0];
  const reportAt = argv.indexOf("--report");
  const report = reportAt >= 0 ? argv[reportAt + 1] : null;
  if (!gate || (reportAt >= 0 && !report)) {
    process.stderr.write("usage: release-gates.js <gate> [--report <file>]\n");
    return 2;
  }
  const outcome = runGate(gate, { root: process.cwd() });
  if (report) fs.writeFileSync(report, `${JSON.stringify(outcome, null, 2)}\n`);
  process.stdout.write(`release-gate ${gate}: ${outcome.result}${outcome.detail ? ` (${outcome.detail})` : ""}\n`);
  return outcome.result === "pass" ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { RUNNERS, REPORT_SCHEMA, SCRIPTS, ENTERPRISE_DIRS, runGate, ensureCut, defaultExec, gateDiagnostic };
