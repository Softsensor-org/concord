"use strict";

// Shared attestation parsing and payload hashing for release gates and publishers.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ATTESTATION_SCHEMA_VERSION = 1;
const QUALIFICATION_SCHEMA_VERSION = 2;
const GIT_ID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const QUALIFICATION_EDITIONS = Object.freeze({
  community: { cut: "Community", artifact: "softsensor-concord" },
  enterprise: { cut: "Enterprise", artifact: "softsensor-concord-enterprise" },
});

function attestationPathFor(cutDir) {
  return `${String(cutDir).replace(/\/+$/, "")}.attestation.json`;
}

// `cutDirOrFile` is either a cut directory (the attestation is read from the
// sidecar next to it) or the attestation file itself — the publish job has only
// the attestation, never the cut it was built from.
function readAttestationFile(cutDirOrFile) {
  const file = String(cutDirOrFile).endsWith(".attestation.json")
    ? String(cutDirOrFile)
    : attestationPathFor(cutDirOrFile);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no cut attestation at ${file} — build the cut with release/build-public-release.sh ` +
      `(it stamps the attestation) instead of copying bytes from an unverified source.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cut attestation ${file} is not valid JSON: ${error.message}`);
  }
  return { file, parsed };
}

function readAttestation(cutDirOrFile) {
  const { file, parsed } = readAttestationFile(cutDirOrFile);
  if (parsed?.schema_version !== ATTESTATION_SCHEMA_VERSION) {
    throw new Error(
      `cut attestation ${file} has schema_version ${parsed?.schema_version}; ` +
      `this tool understands ${ATTESTATION_SCHEMA_VERSION}. Rebuild the cut.`,
    );
  }
  if (parsed.purpose === "qualification" || parsed.donor_mode === "qualification") {
    throw new Error(`cut attestation ${file} is qualification-only and cannot authorize publication`);
  }
  return parsed;
}

// Qualification is a distinct schema and needs the actual artifact directory.
function readQualificationAttestation(cutDir, { commit, tree, edition, policySha256, builderSha256 } = {}) {
  const root = path.resolve(cutDir);
  const sidecar = attestationPathFor(root);
  if (!fs.lstatSync(root).isDirectory() || !fs.lstatSync(sidecar).isFile()) {
    throw new Error("qualification requires a real cut directory and regular attestation");
  }
  const { parsed } = readAttestationFile(sidecar);
  if (parsed?.schema_version !== QUALIFICATION_SCHEMA_VERSION || parsed.purpose !== "qualification" ||
      parsed.donor_mode !== "qualification" || parsed.publishable !== false || parsed.donor_tag !== null ||
      parsed.donor_tree_state !== "clean" || parsed.hygiene_gate !== "pass") {
    throw new Error("cut does not carry a nonpublishable, hygiene-passing qualification attestation");
  }
  const checks = [
    ["donor_commit", GIT_ID, commit], ["source_tree", GIT_ID, tree],
    ["policy_sha256", SHA256, policySha256], ["builder_sha256", SHA256, builderSha256],
    ["cut_commit", GIT_ID], ["cut_tree_digest", GIT_ID], ["cut_content_digest", SHA256],
  ];
  for (const [field, pattern, expected] of checks) {
    if (typeof parsed[field] !== "string" || !pattern.test(parsed[field]) ||
        (expected !== undefined && parsed[field] !== expected)) {
      throw new Error(`qualification attestation has invalid or mismatched ${field}`);
    }
  }
  const editionIdentity = Object.hasOwn(QUALIFICATION_EDITIONS, parsed.donor_edition)
    ? QUALIFICATION_EDITIONS[parsed.donor_edition] : null;
  if (!editionIdentity || (edition !== undefined && parsed.donor_edition !== edition) ||
      parsed.cut !== editionIdentity.cut || parsed.artifact !== editionIdentity.artifact || parsed.cut_dir !== root ||
      typeof parsed.toolchain?.node !== "string" || !parsed.toolchain.node ||
      typeof parsed.toolchain?.git !== "string" || !parsed.toolchain.git) {
    throw new Error("qualification attestation has invalid cut, edition, directory or toolchain");
  }
  if (!fs.lstatSync(path.join(root, ".git")).isDirectory()) throw new Error("qualification cut has no real .git directory");
  const git = (...args) => execFileSync("git", ["--no-replace-objects", "-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (git("rev-parse", "HEAD") !== parsed.cut_commit || git("rev-parse", "HEAD^{tree}") !== parsed.cut_tree_digest ||
      git("-c", "core.filemode=true", "status", "--porcelain", "--untracked-files=all") ||
      qualificationContentDigest(root) !== parsed.cut_content_digest) {
    throw new Error("qualification cut bytes or Git tree differ from the attested artifact");
  }
  const provenance = JSON.parse(fs.readFileSync(path.join(root, "coord", "RELEASE_PROVENANCE.json"), "utf8"));
  if (provenance.donor_commit !== parsed.donor_commit || provenance.donor_mode !== "qualification" ||
      provenance.cut !== editionIdentity.cut || provenance.artifact !== editionIdentity.artifact) {
    throw new Error("qualification cut provenance does not match its attestation");
  }
  return parsed;
}

function qualificationContentDigest(root) {
  const physicalRoot = fs.realpathSync(root);
  return treeDigest(physicalRoot, {
    onEntry(relative, absolute, entry) {
      if (entry.isFile() || entry.isDirectory()) return;
      if (entry.isSymbolicLink() && !path.isAbsolute(fs.readlinkSync(absolute))) {
        const target = fs.realpathSync(absolute);
        if (target === physicalRoot || target.startsWith(physicalRoot + path.sep)) return;
      }
      throw new Error(`qualification cut has an unsupported or escaping entry: ${relative}`);
    },
  });
}

// Deterministic content digest of a directory tree: sha256 over the sorted
// "<relpath>\0<sha256(bytes)>\n" lines. Used to prove that the bytes actually
// copied into the npm template / SEA bundle are the attested cut's bytes, not a
// separately (re)built tree. `.git` is excluded — it is not part of the payload.
// `skipSymlinks` exists because the transactional install engine (COORD-475)
// REFUSES link entries in a payload, so the npm/SEA channels deliberately do not
// stage them. Digesting them on one side and not the other would report a false
// drift; skipping them on both sides keeps the byte-identity proof meaningful.
// Callers that skip must record which links they dropped (see stage-npm-package.js)
// so the omission is auditable rather than silent.
//
// `renames` (COORD-599) canonicalizes a relative path before it is digested. It
// exists because one channel MUST store a file under a different name than the
// cut does: `npm pack` never includes a file literally named `.gitignore`, so the
// npm template stores it as `gitignore` and the install engine maps it back. The
// map is applied to BOTH sides of assertSameBytes — the cut side simply has no
// matching key — so a renamed-but-byte-identical payload still proves identity,
// while any content drift is still caught.
//
// `excludePaths` (COORD-933) drops whole subtrees by canonical relative path
// (e.g. "examples"). It is a PATH match, unlike `exclude` which matches any entry
// name at any depth. It is used only on the SOURCE side of a proven omission
// (stage-npm-package.js), so a staged copy that reintroduces an omitted subtree
// still produces a different digest and fails the integrity check.
// `onEntry` observes the same included entries (before link omission), so a
// caller may validate or fingerprint metadata without another traversal.
function treeDigest(dir, { exclude = new Set([".git"]), skipSymlinks = false, onSymlink = null, renames = {}, excludePaths = [], onEntry = null } = {}) {
  const lines = [];
  const canonicalRel = (rel) => (Object.prototype.hasOwnProperty.call(renames, rel) ? renames[rel] : rel);
  const pathExcluded = (rel) => excludePaths.some((p) => rel === p || rel.startsWith(`${p}/`));
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = canonicalRel(rel ? `${rel}/${entry.name}` : entry.name);
      if (pathExcluded(childRel)) continue;
      if (onEntry) onEntry(childRel, childAbs, entry);
      if (entry.isSymbolicLink()) {
        if (onSymlink) onSymlink(childRel, fs.readlinkSync(childAbs));
        if (skipSymlinks) continue;
        lines.push(`${childRel}\0symlink:${fs.readlinkSync(childAbs)}\n`);
      } else if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(childAbs)).digest("hex");
        lines.push(`${childRel}\0${hash}\n`);
      }
    }
  };
  walk(path.resolve(dir), "");
  // Sort the LINES (not the directory entries): with `renames` a file can be
  // stored under a name that sorts differently from its canonical path, so
  // traversal order is no longer a stable key. Sorting here makes the digest a
  // pure function of the canonical path/content set, exactly as documented.
  lines.sort();
  return crypto.createHash("sha256").update(lines.join("")).digest("hex");
}

module.exports = { ATTESTATION_SCHEMA_VERSION, QUALIFICATION_SCHEMA_VERSION, attestationPathFor, readAttestation, readQualificationAttestation, qualificationContentDigest, treeDigest };
