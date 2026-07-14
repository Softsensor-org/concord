"use strict";

// ENT-011: engine version-pin + drift-check unit tests (Community per-team half).
//
// All fixtures are temp dirs — the live manifest / engine files / real
// coord/engine-pin.json are never touched. We instantiate the DI factory against
// a temp coordDir laid out like a repo (coordDir == <root>/coord), write a small
// manifest plus the tracked engine files it declares, and prove:
//   - pin captures the current manifest fingerprint + manifest_version;
//   - verify reports IN-SYNC immediately after pin;
//   - mutating a tracked engine file -> verify reports DRIFT with the path;
//   - mutating the manifest -> verify reports manifest_fingerprint_drift;
//   - a missing tracked file -> verify reports drift (kind: missing);
//   - the fingerprint is deterministic (identical bytes -> identical sha256);
//   - verify with no pin reports no_pin (not a crash);
//   - the pin is the ONLY mutation (verify never writes the pin file).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const createEnginePin = require("./engine-pin.js");

// Build a temp repo root with coord/ + a manifest tracking two engine files.
function makeFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ent011-"));
  const coordDir = path.join(root, "coord");
  const scriptsDir = path.join(coordDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });

  // Two tracked engine files (paths are repo-root-relative, like the real manifest).
  fs.writeFileSync(path.join(scriptsDir, "alpha.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(scriptsDir, "beta.js"), "module.exports = 2;\n");

  const manifest = overrides.manifest || {
    schema_version: 1,
    manifest_version: "test-engine-v1",
    items: [
      { path: "coord/scripts/alpha.js", match_policy: "exact" },
      { path: "coord/scripts/beta.js", match_policy: "exact" },
    ],
  };
  fs.writeFileSync(
    path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  const mod = createEnginePin({
    coordDir,
    platform: overrides.platform,
    fail: (m) => { throw new Error(m); },
  });
  return { root, coordDir, scriptsDir, mod };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("ENT-011: pin captures the current manifest fingerprint + version", () => {
  const { root, coordDir, mod } = makeFixture();
  try {
    const { path: pinPath, pin } = mod.pin();
    assert.equal(pinPath, path.join(coordDir, "engine-pin.json"));
    assert.ok(fs.existsSync(pinPath), "pin file must be written");
    assert.equal(pin.manifest_version, "test-engine-v1");
    assert.match(pin.manifest_fingerprint.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pin.manifest_fingerprint.bytes > 0);
    // Per-file snapshot of the two tracked files.
    assert.deepEqual(Object.keys(pin.files).sort(), [
      "coord/scripts/alpha.js",
      "coord/scripts/beta.js",
    ]);
    assert.match(pin.files["coord/scripts/alpha.js"].sha256, /^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      assert.strictEqual(
        pin.files["coord/scripts/alpha.js"].mode,
        fs.statSync(path.join(coordDir, "scripts/alpha.js")).mode & 0o777
      );
    }
  } finally {
    cleanup(root);
  }
});

test("ENT-011: verify reports IN-SYNC immediately after pin", () => {
  const { root, mod } = makeFixture();
  try {
    mod.pin();
    const report = mod.verify();
    assert.equal(report.ok, true, "must be in-sync right after pin");
    assert.equal(report.pinned, true);
    assert.equal(report.manifest_fingerprint_drift, false);
    assert.deepEqual(report.drifted_files, []);
    assert.deepEqual(report.problems, []);
  } finally {
    cleanup(root);
  }
});

test("ENT-011: mutating a tracked engine file -> DRIFT with the offending path", () => {
  const { root, scriptsDir, mod } = makeFixture();
  try {
    mod.pin();
    // Mutate one tracked engine file.
    fs.writeFileSync(path.join(scriptsDir, "alpha.js"), "module.exports = 999;\n");
    const report = mod.verify();
    assert.equal(report.ok, false, "must report drift after a tracked file changes");
    assert.equal(report.manifest_fingerprint_drift, false, "manifest itself did not change");
    const fileProblem = report.problems.find((p) => p.code === "engine_file_drift");
    assert.ok(fileProblem, "must surface an engine_file_drift problem");
    const drifted = fileProblem.files.find((f) => f.path === "coord/scripts/alpha.js");
    assert.ok(drifted, "the offending path must be named");
    assert.equal(drifted.kind, "changed");
    // The untouched file must NOT be reported.
    assert.ok(!fileProblem.files.some((f) => f.path === "coord/scripts/beta.js"));
  } finally {
    cleanup(root);
  }
});

test("COORD-509: POSIX executable-mode drift is part of engine verification", { skip: process.platform === "win32" }, () => {
  const { root, scriptsDir, mod } = makeFixture();
  try {
    const alpha = path.join(scriptsDir, "alpha.js");
    fs.chmodSync(alpha, 0o644);
    mod.pin();
    fs.chmodSync(alpha, 0o755);
    const report = mod.verify();
    assert.strictEqual(report.ok, false);
    const drift = report.drifted_files.find((entry) => entry.path === "coord/scripts/alpha.js");
    assert.strictEqual(drift.kind, "mode-changed");
    assert.match(drift.detail, /644.*755/);
  } finally {
    cleanup(root);
  }
});

test("COORD-509: Windows engine pins omit and ignore POSIX mode bits", () => {
  const { root, scriptsDir, mod } = makeFixture({ platform: "win32" });
  try {
    const alpha = path.join(scriptsDir, "alpha.js");
    fs.chmodSync(alpha, 0o644);
    const pinned = mod.pin().pin;
    assert.strictEqual(pinned.files["coord/scripts/alpha.js"].mode, undefined);
    fs.chmodSync(alpha, 0o755);
    assert.strictEqual(mod.verify().ok, true);
  } finally {
    cleanup(root);
  }
});

test("ENT-011: mutating the manifest -> manifest_fingerprint_drift", () => {
  const { root, coordDir, mod } = makeFixture();
  try {
    mod.pin();
    // Bump the manifest version (changes the file bytes -> fingerprint).
    const manifestPath = path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.manifest_version = "test-engine-v2";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const report = mod.verify();
    assert.equal(report.ok, false);
    assert.equal(report.manifest_fingerprint_drift, true);
    assert.ok(report.problems.some((p) => p.code === "manifest_fingerprint_drift"));
    assert.equal(report.pinned_version, "test-engine-v1");
    assert.equal(report.live_version, "test-engine-v2");
  } finally {
    cleanup(root);
  }
});

test("ENT-011: a missing tracked file -> DRIFT (kind: missing)", () => {
  const { root, scriptsDir, mod } = makeFixture();
  try {
    mod.pin();
    fs.rmSync(path.join(scriptsDir, "beta.js"));
    const report = mod.verify();
    assert.equal(report.ok, false);
    const fileProblem = report.problems.find((p) => p.code === "engine_file_drift");
    const missing = fileProblem.files.find((f) => f.path === "coord/scripts/beta.js");
    assert.ok(missing);
    assert.equal(missing.kind, "missing");
  } finally {
    cleanup(root);
  }
});

test("ENT-011: the manifest fingerprint is deterministic", () => {
  const { root: r1, mod: m1 } = makeFixture();
  const { root: r2, mod: m2 } = makeFixture();
  try {
    // Identical fixture bytes must yield identical fingerprints.
    assert.equal(
      m1.deriveManifestFingerprint().sha256,
      m2.deriveManifestFingerprint().sha256
    );
    // And recomputing on the same fixture is stable.
    assert.equal(
      m1.deriveManifestFingerprint().sha256,
      m1.deriveManifestFingerprint().sha256
    );
  } finally {
    cleanup(r1);
    cleanup(r2);
  }
});

test("ENT-011: verify with no pin reports no_pin (read-only, no crash)", () => {
  const { root, coordDir, mod } = makeFixture();
  try {
    const report = mod.verify();
    assert.equal(report.pinned, false);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.code === "no_pin"));
    // verify must NOT have written a pin file.
    assert.ok(!fs.existsSync(path.join(coordDir, "engine-pin.json")));
  } finally {
    cleanup(root);
  }
});

test("ENT-011: verify is read-only — it never mutates the pin file", () => {
  const { root, coordDir, scriptsDir, mod } = makeFixture();
  try {
    mod.pin();
    const pinPath = path.join(coordDir, "engine-pin.json");
    const before = fs.readFileSync(pinPath, "utf8");
    // Drift the surface, then run verify a couple of times.
    fs.writeFileSync(path.join(scriptsDir, "alpha.js"), "module.exports = 3;\n");
    mod.verify();
    mod.verify();
    const after = fs.readFileSync(pinPath, "utf8");
    assert.equal(after, before, "verify must leave the pin file byte-identical");
  } finally {
    cleanup(root);
  }
});
