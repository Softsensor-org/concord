"use strict";

// COORD-588: the guide bodies live in the installed engine tree while old
// coord/docs URLs remain small, integrity-tracked compatibility redirects.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const discovery = require("./template-sync-discovery.js");

const ROOT = path.resolve(__dirname, "../../..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "coord/TEMPLATE_SYNC_MANIFEST.json"), "utf8"));
const pin = JSON.parse(fs.readFileSync(path.join(ROOT, "coord/engine-pin.json"), "utf8"));

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// COORD-946: the engine pin records git's file mode (100644/100755), not the raw
// filesystem mode, which depends on the host umask (COORD-901 normalization).
// COORD-981: the shared rule lives in file-mode.js.
const { gitFileMode } = require("./file-mode.js");

test("COORD-588: moved guide bodies and legacy redirects are both integrity-tracked", () => {
  assert.equal(new Set(discovery.LEGACY_DOC_REDIRECTS).size, discovery.LEGACY_DOC_REDIRECTS.length);
  const entries = new Map(manifest.items.map((item) => [item.path, item]));
  for (const oldPath of discovery.LEGACY_DOC_REDIRECTS) {
    const name = path.basename(oldPath);
    const canonicalPath = `coord/engine/docs/${name}`;
    const canonical = path.join(ROOT, canonicalPath);
    const redirect = path.join(ROOT, oldPath);
    assert.ok(fs.statSync(canonical).size > 500, `${canonicalPath} must contain the guide body`);
    const redirectText = fs.readFileSync(redirect, "utf8");
    assert.match(redirectText, new RegExp(`coord/engine/docs/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(fs.statSync(redirect).size < 600, `${oldPath} should remain a small redirect`);

    for (const filePath of [oldPath, canonicalPath]) {
      const bytes = fs.readFileSync(path.join(ROOT, filePath));
      const item = entries.get(filePath);
      assert.ok(item, `${filePath} missing from template-sync manifest`);
      assert.equal(item.checksum.hex, sha256(bytes), `${filePath} manifest checksum drift`);
      assert.equal(item.checksum.bytes, bytes.length, `${filePath} manifest size drift`);
      assert.deepEqual(pin.files[filePath], {
        sha256: sha256(bytes), bytes: bytes.length, mode: gitFileMode(fs.statSync(path.join(ROOT, filePath)).mode),
      }, `${filePath} engine pin drift`);
    }
  }
});

test("COORD-588: moved guide relative links resolve from the engine docs location", () => {
  for (const oldPath of discovery.LEGACY_DOC_REDIRECTS) {
    const name = path.basename(oldPath);
    const file = path.join(ROOT, "coord/engine/docs", name);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1].split(/[ #]/, 1)[0];
      if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
      const target = path.resolve(path.dirname(file), href);
      assert.ok(fs.existsSync(target), `${name} has unresolved relative link ${href}`);
    }
  }
});

// The public release deliberately excludes this donor-only migration census.
const inventoryPath = path.join(ROOT, "coord/docs/architecture/COORD-513-seam-inventory.json");
test("COORD-588: donor inventory engine documents all migrate and approved project evidence stays intact", {
  skip: !fs.existsSync(inventoryPath) && "Donor migration census is excluded by build-public-release.sh",
}, () => {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const engineDocs = inventory.entries.filter((entry) => entry.classification === "engine-canonical" && entry.path.startsWith("coord/docs/"));
  // COMMAND_REFERENCE.md is a redirect without a guide body under coord/docs; the
  // COORD-863 refresh classifies it from the manifest, so it may already be listed.
  const expected = [...new Set([...engineDocs.map((entry) => entry.path), "coord/docs/COMMAND_REFERENCE.md"])].sort();
  assert.deepEqual([...discovery.LEGACY_DOC_REDIRECTS].sort(), expected);
  const corrected = inventory.entries.filter((entry) => entry.ownership_correction?.ticket === "COORD-588");
  assert.equal(corrected.length, 22);
  for (const entry of corrected) {
    assert.equal(entry.classification, "project-owned");
    assert.equal(entry.ownership_correction.original_classification, "engine-canonical");
    assert.ok(entry.ownership_correction.original_rationale);
    assert.match(entry.ownership_correction.preserved_body_sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, entry.path), "utf8"), /^# [^\n]+ \(moved\)/, entry.path);
    assert.ok(!discovery.LEGACY_DOC_REDIRECTS.includes(entry.path), entry.path);
  }
  const counts = Object.fromEntries(inventory.classification_enum.map((kind) => [kind, inventory.entries.filter((entry) => entry.classification === kind).length]));
  assert.deepEqual(counts, inventory.coverage.counts);
  assert.equal(inventory.entries.length, inventory.coverage.classified);
});

// COORD-821: a live reference must name the canonical engine guide, never the
// redirect. The only files that may still spell a legacy path are the redirects
// themselves, the integrity inventories that must name them, and records that
// describe history (rewriting those would falsify what they recorded).
const LEGACY_PATH_INVENTORIES = [
  "coord/TEMPLATE_SYNC_MANIFEST.json", "coord/engine-pin.json",
  "coord/engine/scripts/engine-docs-migration.test.js",
  "coord/docs/architecture/COORD-513-seam-inventory.json",
];
const HISTORICAL_RECORDS = [
  "CHANGELOG.md", "coord/QUESTIONS.md", "coord/board/tasks.json",
];
const HISTORICAL_RECORD_DIRS = [
  "coord/.runtime/", "coord/board/plans/", "coord/docs/decisions/", "coord/docs/evidence/",
  "coord/docs/reviews/", "coord/history/", "coord/prompts/", "coord/rendered/",
];

function isDeclaredLegacyPathHolder(rel) {
  return discovery.LEGACY_DOC_REDIRECTS.includes(rel) || LEGACY_PATH_INVENTORIES.includes(rel) ||
    HISTORICAL_RECORDS.includes(rel) || HISTORICAL_RECORD_DIRS.some((dir) => rel.startsWith(dir));
}

function listTreeFiles() {
  try {
    const out = require("node:child_process").execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\0").filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory() && ![".git", "node_modules", ".worktrees"].includes(entry.name)) walk(rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    walk("");
    return files;
  }
}

// A match is the guide name plus the path segments written directly before it.
// It is a legacy reference when that spelling resolves to a redirect from the
// file's directory, the repo root or coord/ (prose spellings use all three).
function legacyReferencesIn(rel, text) {
  const stubs = new Set(discovery.LEGACY_DOC_REDIRECTS.map((oldPath) => path.join(ROOT, oldPath)));
  const names = discovery.LEGACY_DOC_REDIRECTS.map((oldPath) => path.basename(oldPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\w./-])(/?(?:[\\w.-]+/)*)(${names.join("|")})(?![\\w-])`, "g");
  const hits = [];
  text.split("\n").forEach((line, index) => {
    for (const [, prefix, name] of line.matchAll(pattern)) {
      const spelled = prefix + name;
      const bases = prefix.startsWith("/") ? [] : [path.dirname(path.join(ROOT, rel)), ...(prefix ? [ROOT, path.join(ROOT, "coord")] : [])];
      const legacy = prefix.startsWith("/") ? spelled.endsWith(`/coord/docs/${name}`) : bases.some((base) => stubs.has(path.resolve(base, spelled)));
      if (legacy) hits.push(`${rel}:${index + 1}: ${spelled}`);
    }
  });
  return hits;
}

test("COORD-821: the reference scan recognises every spelling that reaches a redirect", () => {
  const sample = [
    "See coord/docs/MEMORY_ARCHITECTURE.md and [x](../docs/SQLITE_RUNTIME.md).",
    "Mirrors the docs/PRODLOC_POLICY.md contract; /srv/x/coord/docs/ELAPSED_TIME.md.",
    "Canonical: coord/engine/docs/MEMORY_ARCHITECTURE.md, [y](../engine/docs/SQLITE_RUNTIME.md).",
    "Bare MEMORY_ARCHITECTURE.md §3 names a section, not a path.",
  ].join("\n");
  assert.deepEqual(legacyReferencesIn("coord/product/SAMPLE.md", sample), [
    "coord/product/SAMPLE.md:1: coord/docs/MEMORY_ARCHITECTURE.md",
    "coord/product/SAMPLE.md:1: ../docs/SQLITE_RUNTIME.md",
    "coord/product/SAMPLE.md:2: docs/PRODLOC_POLICY.md",
    "coord/product/SAMPLE.md:2: /srv/x/coord/docs/ELAPSED_TIME.md",
  ]);
  // Inside coord/docs a bare relative link reaches the sibling redirect.
  assert.deepEqual(legacyReferencesIn("coord/docs/OTHER.md", "[z](MCP_CONFIGURATION.md)"), [
    "coord/docs/OTHER.md:1: MCP_CONFIGURATION.md",
  ]);
  assert.equal(isDeclaredLegacyPathHolder("coord/docs/MCP_CONFIGURATION.md"), true);
  assert.equal(isDeclaredLegacyPathHolder("coord/.runtime/plans/COORD-588.json"), true);
  assert.equal(isDeclaredLegacyPathHolder("coord/product/TESTING_AND_GATES.md"), false);
});

test("COORD-821: no live reference in the tree routes through a compatibility redirect", () => {
  const hits = [];
  for (const rel of listTreeFiles()) {
    if (isDeclaredLegacyPathHolder(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    } catch {
      continue;
    }
    if (!text.includes("\0")) hits.push(...legacyReferencesIn(rel, text));
  }
  assert.deepEqual(hits, [], `point these at coord/engine/docs/ instead:\n${hits.join("\n")}`);
});
