"use strict";

// COORD-981: characterization of the Git file-mode rule. The shared gitFileMode in
// file-mode.js and its consumers (engine-pin.js and tree-fingerprint.js) must give the
// same Git mode for the same stat mode, so the engine pin and the tree digest keep their
// bytes. Each module's output is pinned here for the same file modes.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFileMode } = require("./file-mode.js");
const createEnginePin = require("./engine-pin.js");
const { treeFingerprint } = require("./tree-fingerprint.js");

// Raw modes as stat reports them (with or without the file-type bits) and edge modes.
const RAW_CASES = [
  [0o644, 0o644],
  [0o755, 0o755],
  [0o100644, 0o644],
  [0o100755, 0o755],
  [0o664, 0o644],
  [0o775, 0o755],
  [0o600, 0o644],
  [0o700, 0o755],
  [0o744, 0o755],
  [0o477, 0o644],
  [0o4755, 0o755],
  [0o100664, 0o644],
  [0o100775, 0o755],
  [0o100000, 0o644],
  [0, 0o644],
];

// File modes applied on disk so the module under test reads them from stat.
const DISK_CASES = [
  ["a-644.txt", 0o644, 0o644],
  ["b-755.txt", 0o755, 0o755],
  ["c-664.txt", 0o664, 0o644],
  ["d-600.txt", 0o600, 0o644],
  ["e-700.txt", 0o700, 0o755],
  ["f-477.txt", 0o477, 0o644],
];

test("COORD-981: gitFileMode maps raw stat modes to 100644 or 100755 by the owner execute bit", () => {
  for (const [raw, expected] of RAW_CASES) {
    assert.equal(gitFileMode(raw), expected, `raw ${raw.toString(8)}`);
  }
});

test("COORD-981: tree-fingerprint records the same Git mode for each on-disk file mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord981-tree-"));
  try {
    for (const [name, mode] of DISK_CASES.map(([n, m]) => [n, m])) {
      const absolute = path.join(root, name);
      fs.writeFileSync(absolute, `body of ${name}\n`);
      fs.chmodSync(absolute, mode);
    }
    const { entries, digest } = treeFingerprint(root, { modes: true });
    const byPath = new Map(entries.map((entry) => [entry.path, entry.mode]));
    for (const [name, , expected] of DISK_CASES) {
      assert.equal(byPath.get(name), expected, name);
    }
    // Pinned digest: the same bytes and Git modes must keep producing this value.
    assert.equal(digest, "f20e7feaa40a10ab6c79fed076abb43253670fb3d643927eedcfe1eea28bf013");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-981: engine-pin records the same Git mode for each on-disk file mode", () => {
  const artifact = fs.mkdtempSync(path.join(os.tmpdir(), "coord981-pin-"));
  try {
    const coordDir = path.join(artifact, "coord");
    fs.mkdirSync(coordDir, { recursive: true });
    const items = [];
    for (const [name, mode] of DISK_CASES.map(([n, m]) => [n, m])) {
      const rel = `fixture/${name}`;
      const absolute = path.join(artifact, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `body of ${name}\n`);
      fs.chmodSync(absolute, mode);
      items.push({ path: rel, match_policy: "exact" });
    }
    fs.writeFileSync(path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"), JSON.stringify({
      manifest_version: "fixture", items,
    }) + "\n");
    createEnginePin({ coordDir }).pin();
    const pin = JSON.parse(fs.readFileSync(path.join(coordDir, "engine-pin.json"), "utf8"));
    for (const [name, , expected] of DISK_CASES) {
      assert.equal(pin.files[`fixture/${name}`].mode, expected, name);
    }
  } finally {
    fs.rmSync(artifact, { recursive: true, force: true });
  }
});

test("file mode diagnosis requires an actual change under a group-writable umask", () => {
  const { modeDifferenceIsUmask, umaskNote } = require("./file-mode.js");
  assert.equal(modeDifferenceIsUmask(0o644, 0o644, 0o002), false);
  assert.equal(modeDifferenceIsUmask(0o664, 0o644, 0o022), false);
  assert.equal(umaskNote(0o022), null);
  assert.equal(modeDifferenceIsUmask(0o664, 0o644, 0o002), true);
  assert.match(umaskNote(0o002), /group-writable umask 0002/);
});
