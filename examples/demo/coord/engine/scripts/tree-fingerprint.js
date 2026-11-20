"use strict";

// COORD-862 (COORD-516a): deterministic tree fingerprint primitive.
//
// COORD-516b replaces the engine pin's per-file map with one tree digest. That
// digest must be identical on every host for the same bytes and modes, and it
// must never be ambiguous. The encoding therefore:
//   - sorts entries by the raw UTF-8 bytes of their POSIX relative path
//     (Buffer.compare), never by locale collation;
//   - records the Git file mode (100644 or 100755, derived from the owner
//     execute bit exactly as file-mode.js gitFileMode does), never the raw
//     umask-dependent mode, so a group-writable umask cannot change the digest;
//     omitted as 0 when modes are disabled, for example on win32;
//   - refuses symlinks and any non-regular file instead of following or
//     skipping them, so a link cannot redirect the digest outside the tree;
//   - length-prefixes every variable field, so no path/content split can
//     collide with another ("a" + "bc" never equals "ab" + "c").
//
// Record layout, concatenated in sorted order after the ASCII header
// `coord-tree-v1\n`:
//   u32be(path byte length) | path bytes | u32be(mode) | u64be(size) | sha256(content)
// digest = sha256(header | records). Directories contribute only through the
// files they contain; an empty directory changes nothing.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { gitFileMode } = require("./file-mode.js");

const TREE_ALGO = "coord-tree-v1+sha256";
const HEADER = Buffer.from("coord-tree-v1\n", "utf8");

class TreeFingerprintError extends Error {
  constructor(code, relativePath, message) {
    super(message);
    this.name = "TreeFingerprintError";
    this.code = code;
    this.path = relativePath;
  }
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}

// Names are read as raw bytes ({encoding: "buffer"}), so a name that is not
// valid UTF-8 keeps its exact bytes in the sort and the digest. `path` is a
// display string; the non-enumerable `pathBytes` is what gets encoded.
const SEPARATOR = Buffer.from(path.sep);
const SLASH = Buffer.from("/");

function collectEntries(rootBytes, relativeBytes, options, out) {
  const directory = relativeBytes ? Buffer.concat([rootBytes, SEPARATOR, relativeBytes]) : rootBytes;
  for (const name of fs.readdirSync(directory, { encoding: "buffer" })) {
    const childBytes = relativeBytes ? Buffer.concat([relativeBytes, SLASH, name]) : name;
    const childRelative = childBytes.toString("utf8");
    if (options.exclude && options.exclude(childRelative)) continue;
    const absolute = Buffer.concat([directory, SEPARATOR, name]);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      // guard:input-path-safety
      throw new TreeFingerprintError("symlink_refused", childRelative, `treeFingerprint refuses symlink: ${childRelative}`);
    }
    if (stat.isDirectory()) {
      collectEntries(rootBytes, childBytes, options, out);
      continue;
    }
    if (!stat.isFile()) {
      throw new TreeFingerprintError("special_file_refused", childRelative, `treeFingerprint refuses non-regular file: ${childRelative}`);
    }
    const content = fs.readFileSync(absolute);
    const entry = {
      path: childRelative,
      mode: options.modes ? gitFileMode(stat.mode) : 0,
      size: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
    Object.defineProperty(entry, "pathBytes", { value: childBytes, enumerable: false });
    out.push(entry);
  }
}

function encodeEntries(entries) {
  const bytesOf = (entry) => entry.pathBytes || Buffer.from(entry.path, "utf8");
  const sorted = [...entries].sort((left, right) => Buffer.compare(bytesOf(left), bytesOf(right)));
  const hash = crypto.createHash("sha256").update(HEADER);
  for (const entry of sorted) {
    const pathBytes = bytesOf(entry);
    hash.update(u32(pathBytes.length)).update(pathBytes).update(u32(entry.mode)).update(u64(entry.size))
      .update(Buffer.from(entry.sha256, "hex"));
  }
  return { sorted, digest: hash.digest("hex") };
}

function treeFingerprint(dir, options = {}) {
  const root = path.resolve(dir);
  const rootStat = fs.lstatSync(root);
  // guard:input-path-safety
  if (rootStat.isSymbolicLink()) throw new TreeFingerprintError("symlink_refused", ".", `treeFingerprint refuses symlink root: ${dir}`);
  if (!rootStat.isDirectory()) throw new TreeFingerprintError("not_a_directory", ".", `treeFingerprint requires a directory: ${dir}`);
  const settings = {
    modes: options.modes === undefined ? process.platform !== "win32" : Boolean(options.modes),
    exclude: typeof options.exclude === "function" ? options.exclude : null,
  };
  const entries = [];
  collectEntries(Buffer.from(root), null, settings, entries);
  const { sorted, digest } = encodeEntries(entries);
  return { algo: TREE_ALGO, digest, entries: sorted };
}

module.exports = { TREE_ALGO, TreeFingerprintError, treeFingerprint, encodeEntries };
