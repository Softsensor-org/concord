"use strict";

// ENT-011: engine version-pin + drift-check (COMMUNITY per-team half of ENT-008,
// the signing/registry authority being the Enterprise half and OUT OF SCOPE here).
//
// A project PINS its engine surface to a known-good version and is then alerted
// when the local engine files drift from that pinned snapshot — WITHOUT any
// signing. The pinned snapshot is a small committed file (coord/engine-pin.json)
// recording:
//   - the pinned engine version (the TEMPLATE_SYNC_MANIFEST manifest_version),
//   - the sha256 fingerprint of TEMPLATE_SYNC_MANIFEST.json (reusing ENT-010's
//     conformance-attestation fingerprint computation so the two AGREE), and
//   - a per-file checksum snapshot of the exact-match engine surface the manifest
//     declares, so drift can be reported per offending PATH (not just "the
//     fingerprint changed").
//
// `gov verify-engine --pin` (re)pins to the CURRENT surface — the ONLY mutation.
// `gov verify-engine` is READ-ONLY: it re-derives the live surface and compares
// it against the pin, reporting either in-sync or DRIFTED (which files / whether
// the manifest fingerprint changed).
//
// RELATIONSHIP to check-template-sync (GOV-013): they are COMPLEMENTARY.
//   - check-template-sync verifies INTERNAL CONSISTENCY: do the live files still
//     match the checksums the CURRENT manifest declares? (manifest vs files).
//   - verify-engine verifies DRIFT FROM A FROZEN VERSION: does the live surface
//     (manifest fingerprint + tracked files) still match the snapshot pinned at a
//     known-good moment? Re-pinning is expected after an intentional engine bump.
// A surface can be self-consistent (check-template-sync clean) yet drifted from
// the pin (an intentional engine upgrade not yet re-pinned), and vice versa.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

module.exports = function createEnginePin(deps = {}) {
  const { coordDir, fail } = deps;

  const failFn =
    fail ||
    ((m) => {
      throw new Error(m);
    });

  const MANIFEST_PATH = path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json");
  const PIN_PATH = path.join(coordDir, "engine-pin.json");
  const PIN_SCHEMA_VERSION = 1;

  function readManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) {
      failFn(`Engine manifest not found: ${MANIFEST_PATH}`);
    }
    const buf = fs.readFileSync(MANIFEST_PATH);
    let manifest = null;
    try {
      manifest = JSON.parse(buf.toString("utf8"));
    } catch (error) {
      failFn(`Engine manifest is not valid JSON: ${MANIFEST_PATH} (${error.message})`);
    }
    return { buf, manifest };
  }

  // Manifest fingerprint: byte sha256 of TEMPLATE_SYNC_MANIFEST.json. This is
  // identical to ENT-010's conformance-attestation deriveManifestFingerprint so
  // an attestation and a pin agree on the same surface fingerprint.
  function deriveManifestFingerprint() {
    const { buf, manifest } = readManifest();
    return {
      present: true,
      sha256: sha256Hex(buf),
      bytes: buf.length,
      manifest_version: manifest.manifest_version || null,
      manifest,
    };
  }

  // Snapshot the per-file checksums of the exact-match engine surface the manifest
  // declares. Mirrors check-template-sync's checksum contract (sha256 + bytes) but
  // captures the LIVE state so drift can be reported per offending path. A missing
  // file is recorded as { missing: true } so dropping a tracked file is drift too.
  function deriveSurfaceFiles(manifest) {
    const repoRoot = path.join(coordDir, "..");
    const files = {};
    for (const item of manifest.items || []) {
      if (!item || typeof item.path !== "string") continue;
      if (item.match_policy === "advisory") continue;
      const absPath = path.join(repoRoot, item.path);
      if (!fs.existsSync(absPath)) {
        files[item.path] = { missing: true };
        continue;
      }
      const buf = fs.readFileSync(absPath);
      files[item.path] = { sha256: sha256Hex(buf), bytes: buf.length };
    }
    return files;
  }

  function deriveSurface() {
    const fingerprint = deriveManifestFingerprint();
    return {
      manifest_version: fingerprint.manifest_version,
      manifest_fingerprint: {
        sha256: fingerprint.sha256,
        bytes: fingerprint.bytes,
      },
      files: deriveSurfaceFiles(fingerprint.manifest),
    };
  }

  // PIN: snapshot the current surface and write coord/engine-pin.json. This is
  // the ONLY mutation in this module.
  function pin(options = {}) {
    const surface = deriveSurface();
    const pinRecord = {
      schema_version: PIN_SCHEMA_VERSION,
      pinned_at: new Date().toISOString(),
      manifest_version: surface.manifest_version,
      manifest_fingerprint: surface.manifest_fingerprint,
      files: surface.files,
    };
    const outPath = options.pinPath || PIN_PATH;
    fs.writeFileSync(outPath, JSON.stringify(pinRecord, null, 2) + "\n");
    return { path: outPath, pin: pinRecord };
  }

  // VERIFY: re-derive the live surface and compare it against the pin. READ-ONLY.
  // Reports in-sync, or DRIFTED with the offending paths and whether the manifest
  // fingerprint changed.
  function verify(options = {}) {
    const pinPath = options.pinPath || PIN_PATH;
    if (!fs.existsSync(pinPath)) {
      return {
        ok: false,
        pinned: false,
        path: pinPath,
        problems: [
          {
            code: "no_pin",
            detail:
              "No engine pin recorded. Run `gov verify-engine --pin` to pin the current engine surface.",
          },
        ],
      };
    }
    let pinRecord = null;
    try {
      pinRecord = JSON.parse(fs.readFileSync(pinPath, "utf8"));
    } catch (error) {
      failFn(`Engine pin file is not valid JSON: ${pinPath} (${error.message})`);
    }

    const live = deriveSurface();
    const problems = [];

    // (1) Manifest fingerprint drift.
    const pinnedFp = pinRecord.manifest_fingerprint || {};
    const fingerprintDrifted =
      pinnedFp.sha256 !== live.manifest_fingerprint.sha256 ||
      pinnedFp.bytes !== live.manifest_fingerprint.bytes;
    if (fingerprintDrifted) {
      problems.push({
        code: "manifest_fingerprint_drift",
        detail:
          `TEMPLATE_SYNC_MANIFEST.json fingerprint changed: pinned sha256=${pinnedFp.sha256} ` +
          `bytes=${pinnedFp.bytes}, live sha256=${live.manifest_fingerprint.sha256} ` +
          `bytes=${live.manifest_fingerprint.bytes}`,
        pinned: pinnedFp,
        live: live.manifest_fingerprint,
      });
    }

    // (2) Per-file drift: changed, missing, or newly-tracked files vs the pin.
    const driftedFiles = [];
    const pinnedFiles = pinRecord.files || {};
    const liveFiles = live.files;
    const allPaths = new Set([
      ...Object.keys(pinnedFiles),
      ...Object.keys(liveFiles),
    ]);
    for (const filePath of [...allPaths].sort()) {
      const pinnedEntry = pinnedFiles[filePath];
      const liveEntry = liveFiles[filePath];
      if (!pinnedEntry) {
        driftedFiles.push({ path: filePath, kind: "added", detail: "file not in pin (added to surface)" });
      } else if (!liveEntry) {
        driftedFiles.push({ path: filePath, kind: "removed", detail: "file in pin no longer tracked by manifest" });
      } else if (liveEntry.missing) {
        driftedFiles.push({ path: filePath, kind: "missing", detail: "tracked file is missing on disk" });
      } else if (pinnedEntry.missing) {
        driftedFiles.push({ path: filePath, kind: "appeared", detail: "file was missing at pin time, now present" });
      } else if (
        pinnedEntry.sha256 !== liveEntry.sha256 ||
        pinnedEntry.bytes !== liveEntry.bytes
      ) {
        driftedFiles.push({
          path: filePath,
          kind: "changed",
          detail:
            `pinned sha256=${pinnedEntry.sha256} bytes=${pinnedEntry.bytes}, ` +
            `live sha256=${liveEntry.sha256} bytes=${liveEntry.bytes}`,
        });
      }
    }
    if (driftedFiles.length > 0) {
      problems.push({
        code: "engine_file_drift",
        detail: `${driftedFiles.length} engine file(s) drifted from the pin`,
        files: driftedFiles,
      });
    }

    const ok = problems.length === 0;
    return {
      ok,
      pinned: true,
      path: pinPath,
      pinned_version: pinRecord.manifest_version || null,
      live_version: live.manifest_version,
      manifest_fingerprint_drift: fingerprintDrifted,
      drifted_files: driftedFiles,
      problems,
    };
  }

  return {
    pin,
    verify,
    // Exposed for tests + reuse.
    deriveSurface,
    deriveManifestFingerprint,
    paths: { MANIFEST_PATH, PIN_PATH },
  };
};

module.exports.__internals = { sha256Hex };
