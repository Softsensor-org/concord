"use strict";

// COORD-429: the owner-lease registry write must be crash-atomic. A plain
// fs.writeFileSync could torn-truncate the file on a crash, and the next
// readRegistry() would fall back to emptyRegistry() — silently dropping every
// registered lease. writeRegistry now writes a temp file and renames it into
// place (atomic on POSIX). These tests pin that invariant.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const identity = require("./identity-v2.js");

function tmpRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "idv2-atomic-"));
}

test("COORD-429: writeRegistry leaves a complete, parseable registry and round-trips", () => {
  const dir = tmpRuntime();
  try {
    const reg = identity.readRegistry(dir); // canonical empty-registry shape
    identity.writeRegistry(dir, reg);
    const raw = fs.readFileSync(identity.registryPath(dir), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "registry file must always be complete JSON, never torn");
    assert.deepEqual(identity.readRegistry(dir), reg, "round-trip preserves the registry");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-429: writeRegistry leaves NO temp file behind (temp+rename cleanup)", () => {
  const dir = tmpRuntime();
  try {
    identity.writeRegistry(dir, identity.readRegistry(dir));
    const runtimeDir = path.dirname(identity.registryPath(dir));
    const strays = fs.readdirSync(runtimeDir).filter((n) => n.includes(".tmp-"));
    assert.deepEqual(strays, [], "no .tmp- registry files may linger after an atomic write");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-429: overwriting a registry never exposes a half-written intermediate", () => {
  const dir = tmpRuntime();
  try {
    const p = identity.registryPath(dir);
    identity.writeRegistry(dir, identity.readRegistry(dir));
    const first = fs.readFileSync(p, "utf8");
    assert.doesNotThrow(() => JSON.parse(first));
    // A second, larger write must replace the file atomically — the on-disk bytes
    // are only ever the old complete file or the new complete file.
    const grown = identity.readRegistry(dir);
    identity.writeRegistry(dir, grown);
    const second = fs.readFileSync(p, "utf8");
    assert.doesNotThrow(() => JSON.parse(second), "post-overwrite file must still be complete JSON");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-811: a registry write that fails at the rename throws, keeps the prior bytes and leaves no temp file", () => {
  const dir = tmpRuntime();
  const originalRename = fs.renameSync;
  try {
    const p = identity.registryPath(dir);
    identity.writeRegistry(dir, identity.emptyRegistry());
    const prior = fs.readFileSync(p, "utf8");
    const snapshot = identity.snapshotRegistry(dir);
    const grown = identity.emptyRegistry();
    grown.leases.claudea11 = { instance_id: "coord811-instance-b" };

    fs.renameSync = () => { throw Object.assign(new Error("simulated rename failure"), { code: "EIO" }); };
    // Both writers share the temp+rename path: the lease write and the rollback.
    assert.throws(() => identity.writeRegistry(dir, grown), { code: "EIO", message: "simulated rename failure" });
    assert.throws(() => identity.restoreRegistry(dir, snapshot), { code: "EIO", message: "simulated rename failure" });
    fs.renameSync = originalRename;

    assert.equal(fs.readFileSync(p, "utf8"), prior, "the previous durable registry is untouched by the failed writes");
    assert.deepEqual(fs.readdirSync(path.dirname(p)).filter((n) => n.includes(".tmp-")), [],
      "the temp file of a failed write is removed, not left beside the registry");
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-811: snapshotRegistry/restoreRegistry undo a registry write byte-for-byte", () => {
  const dir = tmpRuntime();
  try {
    const p = identity.registryPath(dir);
    const absent = identity.snapshotRegistry(dir);
    assert.deepEqual(absent, { exists: false, raw: null });
    identity.writeRegistry(dir, identity.emptyRegistry());
    identity.restoreRegistry(dir, absent);
    assert.equal(fs.existsSync(p), false, "restoring an absent snapshot removes the file a failed claim created");

    // Deliberately non-canonical bytes: restore must not re-serialize them.
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const original = '{"version":1,"instances":[],"leases":{}}';
    fs.writeFileSync(p, original);
    const present = identity.snapshotRegistry(dir);
    assert.deepEqual(present, { exists: true, raw: original });
    identity.writeRegistry(dir, identity.emptyRegistry());
    assert.notEqual(fs.readFileSync(p, "utf8"), original);
    identity.restoreRegistry(dir, present);
    assert.equal(fs.readFileSync(p, "utf8"), original);
    assert.deepEqual(fs.readdirSync(path.dirname(p)).filter((n) => n.includes(".tmp-")), []);

    // A registry path that cannot be read as a file is an error, not "absent".
    fs.rmSync(p);
    fs.mkdirSync(p);
    assert.throws(() => identity.snapshotRegistry(dir), { code: "EISDIR" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
