"use strict";
// COORD-958: replays every refusal and admission of the two guards that the engine-surface
// merge replaces (template-sync: check-template-sync.sh + template-sync-discovery audit;
// engine-pin: engine-pin.js pin/verify/verifyManifest and the Repo-X closeout integrity gate).
// The recorded outcomes are the equivalence fixture (engine-surface-equivalence.json). Uses
// only public entry points that survive the merge: the check script path, createEnginePin,
// createLifecycleRepoXCloseout, and the factory's ensureEngineIntegrityForCloseout export.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const COORD = path.resolve(__dirname, "..", "..", "..");
const { gitFixture } = require(path.join(COORD, "engine", "scripts", "test-git-fixture.js"));
const CHECK = path.join(COORD, "engine", "scripts", "check-template-sync.sh");
const createEnginePin = require(path.join(COORD, "engine", "scripts", "engine-pin.js"));
const createCloseout = require(path.join(COORD, "engine", "scripts", "lifecycle-repox-closeout.js"));
const { __testing: repoXTesting } = require(path.join(COORD, "engine", "scripts", "lifecycle-repox-closeout.js"));

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const ENGINE_FILE = "coord/engine/scripts/lifecycle.js";
const ENGINE_FILE_2 = "coord/engine/scripts/journal.js";

function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "concord-engine-eq-")); }
function writeFile(root, rel, content, mode) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mode) fs.chmodSync(full, mode);
}
function checksumOf(content) { const b = Buffer.from(content); return { algo: "sha256", hex: sha(b), bytes: b.length }; }
function manifestOf(items, extra = {}) {
  return JSON.stringify({ schema_version: 1, manifest_version: "fixture-1", items, ...extra }, null, 2) + "\n";
}
function item(rel, content, policy = "exact") { return { path: rel, match_policy: policy, checksum: checksumOf(content) }; }
// Normalizes machine-specific tmp paths so the recorded outcome is host-independent.
function norm(text, root) { return String(text).split(root).join("<FIXTURE>").replace(/\r/g, ""); }

// --- template-sync (check-template-sync.sh + discovery audit) --------------------------------
function runCheck(root, manifestRel, flags = []) {
  const r = spawnSync("bash", [CHECK, "--repo-root", root, "--manifest", path.join(root, manifestRel), ...flags], { encoding: "utf8" });
  return { exit: r.status, output: norm(`${r.stdout}${r.stderr}`, root) };
}
function gitRepo(root) {
  gitFixture(root, ["init", "-q"]);
  gitFixture(root, ["add", "--all"]);
  gitFixture(root, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base", "--allow-empty"]);
}
function trackAll(root) {
  gitFixture(root, ["add", "--all"]);
}

const CHECK_CASES = [
  { name: "check: all exact items match passes", build(root) {
    writeFile(root, ENGINE_FILE, "a\n"); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n")])); }, flags: [] },
  { name: "check: exact checksum drift fails", build(root) {
    writeFile(root, ENGINE_FILE, "changed\n"); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n")])); }, flags: [] },
  { name: "check: exact missing file fails", build(root) {
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n")])); }, flags: [] },
  { name: "check: advisory drift warns and passes", build(root) {
    writeFile(root, ENGINE_FILE, "changed\n"); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n", "advisory")])); }, flags: [] },
  { name: "check: advisory drift fails under --strict", build(root) {
    writeFile(root, ENGINE_FILE, "changed\n"); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n", "advisory")])); }, flags: ["--strict"] },
  { name: "check: duplicate manifest path refused", build(root) {
    writeFile(root, ENGINE_FILE, "a\n"); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n"), item(ENGINE_FILE, "a\n")])); }, flags: [] },
  { name: "check: item without sha256 contract refused", build(root) {
    writeFile(root, ENGINE_FILE, "a\n"); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([{ path: ENGINE_FILE, match_policy: "exact" }])); }, flags: [] },
  { name: "check: unsupported schema_version refused", build(root) {
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify({ schema_version: 2, items: [item(ENGINE_FILE, "a\n")] })); }, flags: [] },
  { name: "check: empty items refused", build(root) {
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([])); }, flags: [] },
  { name: "check: unparseable manifest refused", build(root) {
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", "{ not json"); }, flags: [] },
  { name: "check: absent manifest refused", build() {}, flags: [] },
  { name: "check: --json output on drift", build(root) {
    writeFile(root, ENGINE_FILE, "changed\n"); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n")])); }, flags: ["--json"] },
  { name: "coverage: untracked engine-managed file fails (COORD-606/607)", git: true, build(root) {
    writeFile(root, ENGINE_FILE, "a\n"); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n")]));
    writeFile(root, ENGINE_FILE_2, "untracked\n"); }, flags: ["--audit-coverage"] },
  { name: "coverage: fully tracked engine surface passes", git: true, build(root) {
    writeFile(root, ENGINE_FILE, "a\n"); writeFile(root, ENGINE_FILE_2, "b\n");
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n"), item(ENGINE_FILE_2, "b\n")])); }, flags: ["--audit-coverage"] },
  { name: "check: unknown option is a usage error", build(root) {
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "a\n")])); }, flags: ["--bogus"] },
];

function runCheckCase(c) {
  const root = mkRoot();
  try {
    c.build(root);
    if (c.git) { gitRepo(root); trackAll(root); }
    const manifest = "coord/TEMPLATE_SYNC_MANIFEST.json";
    const flags = c.flags.slice();
    if (c.flags.includes("--bogus")) {
      const r = spawnSync("bash", [CHECK, "--bogus"], { encoding: "utf8" });
      return { exit: r.status, output: norm(`${r.stdout}${r.stderr}`, root) };
    }
    return runCheck(root, manifest, flags);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- engine-pin (pin / verify / verifyManifest) -----------------------------------------------
function pinFixture(build) {
  const root = mkRoot();
  const coordDir = path.join(root, "coord");
  try {
    build(root, coordDir);
    return { root, coordDir };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
function normalizeVerify(report, root) {
  return JSON.parse(norm(JSON.stringify({
    ok: report.ok,
    pinned: report.pinned,
    manifest_fingerprint_drift: report.manifest_fingerprint_drift,
    drifted_files: report.drifted_files,
    problems: report.problems,
  }), root));
}
function baseManifest(root, extraItems = [], policyAdvisory = false) {
  const items = [item(ENGINE_FILE, "engine a\n"), item(ENGINE_FILE_2, "engine b\n"), ...extraItems];
  writeFile(root, ENGINE_FILE, "engine a\n");
  writeFile(root, ENGINE_FILE_2, "engine b\n");
  writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf(items));
  return items;
}

const PIN_CASES = [
  { name: "pin: verify with no pin reports no_pin", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); return normalizeVerify(pin.verify(), root); } },
  { name: "pin: verify is in-sync immediately after pin", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); pin.pin(); return normalizeVerify(pin.verify(), root); } },
  { name: "pin: engine file edit reports changed with the path", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); pin.pin(); writeFile(root, ENGINE_FILE, "edited\n"); return normalizeVerify(pin.verify(), root); } },
  { name: "pin: manifest edit reports manifest_fingerprint_drift", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); pin.pin(); writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "engine a\n"), item(ENGINE_FILE_2, "engine b\n")], { note: "edited" })); return normalizeVerify(pin.verify(), root); } },
  { name: "pin: deleted engine file reports missing", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); pin.pin(); fs.rmSync(path.join(root, ENGINE_FILE)); return normalizeVerify(pin.verify(), root); } },
  { name: "pin: newly tracked item reports added", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); pin.pin();
    writeFile(root, "coord/engine/scripts/extra.js", "extra\n");
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "engine a\n"), item(ENGINE_FILE_2, "engine b\n"), item("coord/engine/scripts/extra.js", "extra\n")]));
    return normalizeVerify(pin.verify(), root); } },
  { name: "pin: dropped item reports removed", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); pin.pin();
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "engine a\n")]));
    return normalizeVerify(pin.verify(), root); } },
  { name: "pin: file absent at pin time reports appeared", run(root, coordDir) {
    baseManifest(root); fs.rmSync(path.join(root, ENGINE_FILE)); const pin = createEnginePin({ coordDir }); pin.pin(); writeFile(root, ENGINE_FILE, "engine a\n"); return normalizeVerify(pin.verify(), root); } },
  { name: "pin: executable-bit flip reports mode-changed", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); pin.pin(); fs.chmodSync(path.join(root, ENGINE_FILE), 0o755); return normalizeVerify(pin.verify(), root); } },
  { name: "pin: advisory items are not pinned", run(root, coordDir) {
    baseManifest(root, [item("coord/advisory.txt", "adv\n", "advisory")]); writeFile(root, "coord/advisory.txt", "adv\n");
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifestOf([item(ENGINE_FILE, "engine a\n"), item(ENGINE_FILE_2, "engine b\n"), item("coord/advisory.txt", "adv\n", "advisory")]));
    const pin = createEnginePin({ coordDir }); const out = pin.pin(); return { pinned_files: Object.keys(out.pin.files).sort() }; } },
  { name: "pin: verifyManifest clean on a consistent tree", run(root, coordDir) {
    baseManifest(root); const pin = createEnginePin({ coordDir }); return { ok: pin.verifyManifest().ok, failures: pin.verifyManifest().failures }; } },
  { name: "pin: verifyManifest reports checksum-drift (COORD-591 manifest-vs-files)", run(root, coordDir) {
    baseManifest(root); writeFile(root, ENGINE_FILE, "drifted\n"); const pin = createEnginePin({ coordDir }); const r = pin.verifyManifest(); return normalizeVerify({ ok: r.ok, pinned: true, problems: r.failures }, root); } },
  { name: "pin: verifyManifest reports a missing tracked file", run(root, coordDir) {
    baseManifest(root); fs.rmSync(path.join(root, ENGINE_FILE_2)); const pin = createEnginePin({ coordDir }); const r = pin.verifyManifest(); return { ok: r.ok, failures: r.failures.map((f) => ({ path: f.path, kind: f.kind })) }; } },
  { name: "pin: pin without a manifest refused", run(root, coordDir) {
    const pin = createEnginePin({ coordDir }); try { pin.pin(); return { refused: "no throw" }; } catch (error) { return { refused: norm(error.message, root) }; } } },
  { name: "pin: invalid manifest JSON refused", run(root, coordDir) {
    writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", "{ nope"); const pin = createEnginePin({ coordDir }); try { pin.pin(); return { refused: "no throw" }; } catch (error) { return { refused: norm(error.message, root) }; } } },
  { name: "pin: invalid pin JSON refused", run(root, coordDir) {
    baseManifest(root); writeFile(root, "coord/engine-pin.json", "{ broken"); const pin = createEnginePin({ coordDir }); try { pin.verify(); return { refused: "no throw" }; } catch (error) { return { refused: norm(error.message, root) }; } } },
];

// --- Repo-X closeout integrity gate (ensureEngineIntegrityForCloseout) -------------------------
function stubPin({ manifestOk = true, manifestFailures = [], pinOk = true, pinDrifted = [], pinProblems = [] } = {}) {
  return {
    verifyManifest: () => ({ ok: manifestOk, failures: manifestFailures }),
    verify: () => ({ ok: pinOk, pinned: true, drifted_files: pinDrifted, problems: pinProblems }),
    deriveManifestFingerprint: () => ({ manifest: { items: [{ path: ENGINE_FILE, match_policy: "exact" }] } }),
  };
}
function closeoutGate({ enginePin, planSurface, ticket = "COORD-958" }) {
  const ROOT = "/ws";
  const factory = createCloseout({
    COORD_DIR: `${ROOT}/coord`,
    REPO_ROOTS: { X: ROOT, B: `${ROOT}/backend` },
    controlPlaneLayout: () => ({ workspaceRoot: ROOT, coordDir: `${ROOT}/coord`, coordRepoRoot: ROOT, coordPathPrefix: "coord", topology: "ancestor_repository" }),
    enginePin,
    getRepoRoot: () => ROOT,
    gitTry: () => ({ status: 0, stdout: "", stderr: "" }),
    inferTicketIdFromPath: (p) => (p.match(/COORD-\d+/) || [null])[0],
    listGitWorktrees: () => [],
    readTicketFileSurface: () => planSurface,
    recordExternalSideEffect: () => {},
    repoDisplayNameForCode: (code) => code,
  });
  try {
    const value = factory.ensureEngineIntegrityForCloseout(ticket);
    return { admitted: true, value: value ?? null };
  } catch (error) {
    return { refused: String(error.message) };
  }
}

const CLOSEOUT_CASES = [
  { name: "closeout: non-engine ticket with pin drift admitted", run: () => closeoutGate({ enginePin: stubPin({ manifestOk: false, manifestFailures: [{ path: ENGINE_FILE, kind: "checksum-drift" }] }), planSurface: ["docs/readme.md"] }) },
  { name: "closeout: engine-facing clean surface admitted", run: () => closeoutGate({ enginePin: stubPin(), planSurface: [ENGINE_FILE] }) },
  { name: "closeout: engine-facing manifest drift refused", run: () => closeoutGate({ enginePin: stubPin({ manifestOk: false, manifestFailures: [{ path: ENGINE_FILE, kind: "checksum-drift", detail: "drift" }] }), planSurface: [ENGINE_FILE] }) },
  { name: "closeout: engine-facing pin drift refused with named files", run: () => closeoutGate({ enginePin: stubPin({ pinOk: false, pinDrifted: [{ path: ENGINE_FILE, kind: "changed" }] }), planSurface: [ENGINE_FILE] }) },
  { name: "closeout: engine-facing no pin refused", run: () => closeoutGate({ enginePin: stubPin({ pinOk: false, pinProblems: [{ code: "no_pin", detail: "none" }] }), planSurface: [ENGINE_FILE] }) },
  { name: "closeout: both surfaces drifted refused together", run: () => closeoutGate({ enginePin: stubPin({ manifestOk: false, manifestFailures: [{ path: ENGINE_FILE, kind: "missing" }], pinOk: false, pinProblems: [{ code: "manifest_fingerprint_drift" }] }), planSurface: [ENGINE_FILE] }) },
  { name: "closeout: manifest change in plan surface is engine-facing", run: () => closeoutGate({ enginePin: stubPin({ manifestOk: false, manifestFailures: [{ path: ENGINE_FILE, kind: "checksum-drift" }] }), planSurface: ["coord/TEMPLATE_SYNC_MANIFEST.json"] }) },
  { name: "closeout: engine-facing without pin wiring refused", run: () => closeoutGate({ enginePin: null, planSurface: [ENGINE_FILE] }) },
  { name: "closeout: fixture pin overrides a drifted live pin", run: () => {
    repoXTesting.setEngineIntegrityPinOverride(stubPin());
    try { return closeoutGate({ enginePin: stubPin({ pinOk: false, pinDrifted: [{ path: ENGINE_FILE_2, kind: "changed" }] }), planSurface: [ENGINE_FILE] }); } finally { repoXTesting.setEngineIntegrityPinOverride(null); } } },
  { name: "closeout: drifted fixture pin refused without override", run: () => closeoutGate({ enginePin: stubPin({ pinOk: false, pinDrifted: [{ path: ENGINE_FILE_2, kind: "changed" }] }), planSurface: [ENGINE_FILE] }) },
  { name: "closeout: real pin on an edited engine file refused", run: () => {
    const { root, coordDir } = pinFixture((r, c) => { baseManifest(r); });
    try {
      const pin = createEnginePin({ coordDir }); pin.pin(); writeFile(root, ENGINE_FILE, "edited after pin\n");
      return closeoutGate({ enginePin: createEnginePin({ coordDir }), planSurface: [ENGINE_FILE] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  } },
  { name: "closeout: real pin clean on pinned tree admitted", run: () => {
    const { root, coordDir } = pinFixture((r) => { baseManifest(r); });
    try { createEnginePin({ coordDir }).pin(); return closeoutGate({ enginePin: createEnginePin({ coordDir }), planSurface: [ENGINE_FILE] }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  } },
];

function runCases() {
  const out = [];
  for (const c of CHECK_CASES) out.push({ name: c.name, outcome: runCheckCase(c) });
  for (const c of PIN_CASES) {
    const { root, coordDir } = pinFixture(() => {});
    try { out.push({ name: c.name, outcome: c.run(root, coordDir) }); } catch (error) { out.push({ name: c.name, outcome: { threw: norm(error.message, root) } }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  for (const c of CLOSEOUT_CASES) out.push({ name: c.name, outcome: c.run() });
  return out;
}

module.exports = { runCases, CHECK_CASES, PIN_CASES, CLOSEOUT_CASES };

if (require.main === module) {
  const target = process.argv[2];
  const cases = runCases();
  const text = JSON.stringify({ captured_cases: cases.length, cases }, null, 2) + "\n";
  if (target) fs.writeFileSync(target, text); else process.stdout.write(text);
}
