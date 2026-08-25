"use strict";

// COORD-607: RULE-BASED discovery of the engine-managed surface.
//
// THE BUG THIS REPLACES
// --------------------
// coord/TEMPLATE_SYNC_MANIFEST.json used to be a HAND-CURATED list, seeded once
// from a static April-2026 maintainer inventory snapshot. There was no
// discovery rule at all. An engine file created after that snapshot stayed
// invisible to BOTH integrity surfaces — `check-template-sync.sh` (manifest vs
// files) and `gov verify-engine` (surface vs pin) — until somebody remembered to
// add it by hand. Both reported green while untracked engine code drifted or was
// tampered with. COORD-606 closed it for four runner/guard files and added
// `--audit-coverage`, which then reported 256 further untracked engine files,
// including security- and gate-relevant ones (identity-v2.js, gate-plan.js,
// plan-record-field-validators.js, hooks/*, enterprise/*, check-test-isolation.sh)
// and the `coord/scripts/agent` entrypoint, which the audit's own extension
// allowlist could not even see.
//
// THE RULE
// --------
// Membership is DERIVED, not listed: every file under the engine-managed roots
// declared by coord/docs/GCV4_ENGINE_CONFIG_SEAM.md ("Target Layout": scripts/
// and board/ are engine-managed; board/tasks.json and the plan records are
// project-owned) is engine-managed, MINUS an explicit exclusion list where every
// entry carries a recorded reason. Adding a new engine file makes it tracked
// without a manual manifest edit. There is no extension allowlist: an allowlist
// is how `coord/scripts/agent` stayed invisible.
//
// AN UNEXPLAINED EXCLUSION IS THE SAME HOLE IN A NEW SHAPE. Do not add an entry
// to EXCLUSIONS to make an audit pass. Add one only when the file is genuinely
// not engine-managed, and record why.
//
// RELATIONSHIP TO THE OTHER SURFACES
// ----------------------------------
// The manifest fingerprint feeds conformance attestation (ENT-010) and the
// engine pin (ENT-011), so coverage completeness is an input to every downstream
// integrity claim. This module changes only WHICH FILES those surfaces see; it
// does not change what they mean.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

// Engine-managed roots, per coord/docs/GCV4_ENGINE_CONFIG_SEAM.md "Target Layout".
// coord/paths.js and coord/project.config.js are deliberately NOT roots here:
// project.config.js is the project-owned config seam, and paths.js is already a
// curated manifest entry. Widening the roots is a governed change, not a tweak.
const ENGINE_MANAGED_ROOTS = ["coord/scripts", "coord/board"];

// Directories that never hold shipped engine source. These are generated,
// installed, or runtime state — not part of the surface an upgrade replaces.
const SKIP_DIRS = new Set([
  ".git",
  ".runtime",
  ".worktrees",
  ".stryker-tmp",
  "node_modules",
  "coverage",
  "dist",
  "reports",
]);

// EXCLUSIONS: files that live under an engine-managed root but are genuinely NOT
// engine-managed. Every entry MUST carry a category and a reason. `pattern`
// is either an exact repo-relative path or a `dir/**` prefix.
const EXCLUSIONS = [
  {
    pattern: "coord/board/tasks.json",
    category: "project_owned_state",
    reason:
      "Project-owned board state. coord/docs/GCV4_ENGINE_CONFIG_SEAM.md names " +
      "`board/tasks.json` project-owned in its Target Layout, and the Upgrade Contract " +
      "requires upgrade to preserve board state rather than copy it. Its bytes change on " +
      "every governed mutation, so a checksum over it would assert nothing about engine " +
      "integrity and would make the check permanently red.",
  },
  {
    pattern: "coord/board/plans/**",
    category: "project_owned_state",
    reason:
      "Project-owned per-ticket plan records written by the governance lifecycle, not " +
      "engine source. Same Target Layout / Upgrade Contract basis as board/tasks.json: " +
      "upgrade preserves them, so they carry no engine-integrity signal.",
  },
];

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function toPosix(rel) {
  return rel.split(path.sep).join("/");
}

function matchesPattern(rel, pattern) {
  if (pattern.endsWith("/**")) {
    return rel.startsWith(pattern.slice(0, -2));
  }
  return rel === pattern;
}

// Returns the matching exclusion record, or null when the file is engine-managed.
function classifyExclusion(rel, exclusions = EXCLUSIONS) {
  for (const exclusion of exclusions) {
    if (matchesPattern(rel, exclusion.pattern)) return exclusion;
  }
  return null;
}

function isUnderRoots(rel, roots = ENGINE_MANAGED_ROOTS) {
  return roots.some((root) => rel === root || rel.startsWith(`${root}/`));
}

function walkRoot(repoRoot, root) {
  const out = [];
  const walk = (absDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(absDir, entry.name));
      } else if (entry.isFile()) {
        out.push(toPosix(path.relative(repoRoot, path.join(absDir, entry.name))));
      }
    }
  };
  walk(path.join(repoRoot, root));
  return out;
}

// Candidate enumeration. Git is the authority on what a repo SHIPS, so when the
// repo root is a git work tree we ask git for the cached (committed/staged) plus
// non-ignored untracked files: a brand-new engine file is discovered the moment
// it exists, and generated/ignored output is not mistaken for engine source.
// Outside git (a vendored bundle in a downstream consumer) we fall back to a
// filesystem walk over the same roots.
function listCandidateFiles(repoRoot, options = {}) {
  const roots = options.roots || ENGINE_MANAGED_ROOTS;
  const useGit = options.useGit !== false;
  if (useGit) {
    try {
      const stdout = execFileSync(
        "git",
        ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 }
      );
      const files = stdout.split("\0").filter(Boolean).map(toPosix);
      // A git work tree with zero files under the roots means the roots are not
      // present here; fall through to the walk rather than silently reporting
      // an empty (and therefore trivially "complete") surface.
      if (files.length > 0) {
        return { source: "git", files: dedupeSort(files.filter((rel) => notSkipped(rel))) };
      }
    } catch {
      /* not a git work tree, or git unavailable — fall back to the walk */
    }
  }
  const walked = [];
  for (const root of roots) walked.push(...walkRoot(repoRoot, root));
  return { source: "walk", files: dedupeSort(walked) };
}

function notSkipped(rel) {
  return !rel.split("/").some((segment) => SKIP_DIRS.has(segment));
}

function dedupeSort(list) {
  return [...new Set(list)].sort();
}

// The engine-managed surface: candidates minus reasoned exclusions.
function discover(repoRoot, options = {}) {
  const exclusions = options.exclusions || EXCLUSIONS;
  const { source, files } = listCandidateFiles(repoRoot, options);
  const engineManaged = [];
  const excluded = [];
  for (const rel of files) {
    const exclusion = classifyExclusion(rel, exclusions);
    if (exclusion) {
      excluded.push({ path: rel, category: exclusion.category, reason: exclusion.reason });
      continue;
    }
    engineManaged.push(rel);
  }
  return {
    roots: options.roots || ENGINE_MANAGED_ROOTS,
    source,
    files: engineManaged,
    excluded,
  };
}

// Coverage audit: which engine-managed files the manifest does NOT track.
// `untracked` being non-empty is the reopened gap; it is a FAILURE condition for
// the regression test, not a report-only curiosity.
function auditCoverage(repoRoot, manifestPaths, options = {}) {
  const tracked = manifestPaths instanceof Set ? manifestPaths : new Set(manifestPaths);
  const discovered = discover(repoRoot, options);
  const untracked = discovered.files.filter((rel) => !tracked.has(rel));
  // Manifest entries under the roots that the rule says are excluded: tracking
  // one is not a security hole, but it means the exclusion reason and the
  // manifest disagree, so surface it.
  const trackedButExcluded = discovered.excluded
    .filter((entry) => tracked.has(entry.path))
    .map((entry) => entry.path);
  // Manifest entries under the roots that no longer exist on disk are already a
  // `missing` failure in check-template-sync; entries OUTSIDE the roots are the
  // curated extras (docs, .claude/settings.json) and are legitimate.
  const curatedExtras = [...tracked].filter((rel) => !isUnderRoots(rel, discovered.roots)).sort();
  return {
    roots: discovered.roots,
    discovery_source: discovered.source,
    tracked_total: tracked.size,
    engine_managed_count: discovered.files.length,
    untracked_count: untracked.length,
    untracked,
    excluded_count: discovered.excluded.length,
    excluded: discovered.excluded,
    tracked_but_excluded: trackedButExcluded,
    curated_extras: curatedExtras,
    ok: untracked.length === 0,
  };
}

function manifestItemFor(repoRoot, rel, previousItem, nowIso) {
  const buf = fs.readFileSync(path.join(repoRoot, rel));
  const hex = sha256Hex(buf);
  const item = {
    path: rel,
    match_policy: "exact",
    version_stamp: `sha256:${hex.slice(0, 12)}`,
    checksum: { algo: "sha256", hex, bytes: buf.length },
    rationale:
      previousItem && typeof previousItem.rationale === "string" && previousItem.rationale.trim() !== ""
        ? previousItem.rationale
        : "Engine-managed surface under an engine-managed root (coord/docs/GCV4_ENGINE_CONFIG_SEAM.md). " +
          "Tracked by the COORD-607 discovery rule, not by hand curation.",
    discovery: previousItem && previousItem.discovery === "curated-extra" ? "curated-extra" : "rule",
  };
  item.source_inventory =
    (previousItem && previousItem.source_inventory) || {
      direction: "template-canonical",
      status: "engine-managed",
      recorded_at: nowIso,
      template_head_sha: null,
    };
  return item;
}

// Regenerate the manifest items from the discovery rule, preserving the curated
// rationale of every item that already existed and keeping curated entries that
// live OUTSIDE the discovery roots (docs, .claude/settings.json). Those extras
// stay hand-listed on purpose: they are reusable governance surfaces, not engine
// roots, so no rule claims them.
function buildManifest(repoRoot, previousManifest, options = {}) {
  const nowIso = options.now || new Date().toISOString();
  const previousItems = new Map(
    ((previousManifest && previousManifest.items) || [])
      .filter((item) => item && typeof item.path === "string")
      .map((item) => [item.path, item])
  );
  const discovered = discover(repoRoot, options);
  const roots = discovered.roots;

  const paths = new Set(discovered.files);
  for (const [rel] of previousItems) {
    // Curated extras outside the roots survive regeneration.
    if (!isUnderRoots(rel, roots)) paths.add(rel);
  }

  const items = [];
  const dropped = [];
  for (const rel of [...paths].sort()) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      dropped.push(rel);
      continue;
    }
    const previousItem = previousItems.get(rel);
    const item = manifestItemFor(repoRoot, rel, previousItem, nowIso);
    if (!isUnderRoots(rel, roots)) item.discovery = "curated-extra";
    items.push(item);
  }

  const manifest = {
    schema_version: 1,
    manifest_version: options.manifestVersion || (previousManifest && previousManifest.manifest_version) || null,
    generated_at: nowIso,
    purpose:
      (previousManifest && previousManifest.purpose) ||
      "Post-sync drift detection for reusable template-canonical governance surfaces.",
    discovery: {
      mode: "rule-based",
      engine_managed_roots: roots,
      rule:
        "Every file under an engine-managed root is tracked, minus the reasoned " +
        "exclusions below. No extension allowlist: an allowlist is how the " +
        "coord/scripts/agent entrypoint stayed invisible. Regenerate with " +
        "`node coord/scripts/template-sync-discovery.js --write`.",
      owner_module: "coord/scripts/template-sync-discovery.js",
      exclusions: EXCLUSIONS.map((exclusion) => ({
        pattern: exclusion.pattern,
        category: exclusion.category,
        reason: exclusion.reason,
      })),
      curated_extras_note:
        "Items with discovery=\"curated-extra\" live OUTSIDE the engine-managed roots " +
        "(governance docs, .claude/settings.json). No rule claims them, so they remain " +
        "hand-listed and are preserved across regeneration.",
      history:
        "COORD-607 replaced hand curation. Before it, membership came from a static " +
        "2026-04-12 maintainer inventory snapshot and 256 engine files were untracked " +
        "and therefore invisible to check-template-sync.sh and gov verify-engine.",
    },
    source_inventory: previousManifest && previousManifest.source_inventory
      ? {
          ...previousManifest.source_inventory,
          notes: [
            "This manifest tracks the engine-managed surface by RULE (COORD-607); the " +
              "source_inventory reference below is historical provenance for the " +
              "original seed, no longer the membership authority.",
            "The manifest does not include itself, to avoid recursive self-hashing.",
            "Run `coord/scripts/check-template-sync.sh --audit-coverage` to verify coverage " +
              "is still closed; it fails when an engine-managed file is untracked.",
          ],
        }
      : null,
    selection: {
      include_when: [
        "path is under one of discovery.engine_managed_roots",
        "path is not matched by a reasoned discovery.exclusions entry",
        "plus curated extras outside the roots, marked discovery=\"curated-extra\"",
      ],
      enforcement: {
        exact: "Missing files or checksum drift fail the check.",
        advisory:
          "Reserved for future mixed-surface monitoring; advisory drift warns by default and fails under --strict.",
      },
    },
    items,
  };
  return { manifest, dropped };
}

function readManifestPaths(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    manifest,
    paths: new Set((manifest.items || []).map((item) => item && item.path).filter(Boolean)),
  };
}

module.exports = {
  ENGINE_MANAGED_ROOTS,
  SKIP_DIRS,
  EXCLUSIONS,
  classifyExclusion,
  isUnderRoots,
  listCandidateFiles,
  discover,
  auditCoverage,
  buildManifest,
  readManifestPaths,
  __internals: { sha256Hex, matchesPattern, walkRoot },
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const wants = (flag) => argv.includes(flag);
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const repoRoot = path.resolve(valueOf("--repo-root") || path.resolve(__dirname, "..", ".."));
  const manifestPath = path.join(repoRoot, "coord", "TEMPLATE_SYNC_MANIFEST.json");
  // --no-git forces the filesystem walk. The release builder uses it: a staged
  // cut is a plain directory, and enumeration there must not depend on whatever
  // git state the build host happens to have.
  const useGit = !wants("--no-git");

  if (wants("-h") || wants("--help")) {
    process.stdout.write(
      [
        "Usage: node coord/scripts/template-sync-discovery.js [--audit|--write] [options]",
        "",
        "  --audit             Report engine-managed files the manifest does not track (default).",
        "  --write             Regenerate coord/TEMPLATE_SYNC_MANIFEST.json from the discovery rule.",
        "  --repo-root <path>  Operate on another tree (e.g. a staged release cut).",
        "  --no-git            Enumerate by filesystem walk instead of `git ls-files`.",
        "  --json              Machine-readable output.",
        "  --manifest-version  Set manifest_version when writing.",
        "",
        "Exit 1 when the audit finds untracked engine-managed files.",
        "",
      ].join("\n")
    );
    process.exit(0);
  }

  if (wants("--write")) {
    const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
    const manifestVersion = valueOf("--manifest-version");
    const { manifest, dropped } = buildManifest(repoRoot, previous, { manifestVersion, useGit });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `Wrote ${manifestPath}: ${manifest.items.length} item(s) (${dropped.length} dropped: ${dropped.join(", ") || "none"}).\n`
    );
    process.exit(0);
  }

  const { paths } = readManifestPaths(manifestPath);
  const audit = auditCoverage(repoRoot, paths, { useGit });
  if (wants("--json")) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Engine-managed roots: ${audit.roots.join(", ")} (discovery source: ${audit.discovery_source})\n` +
        `Engine-managed files: ${audit.engine_managed_count}; tracked by manifest: ${audit.tracked_total}; ` +
        `excluded with reason: ${audit.excluded_count}\n`
    );
    for (const entry of audit.excluded) {
      process.stdout.write(`[EXCLUDED] ${entry.path} (${entry.category}) — ${entry.reason}\n`);
    }
    for (const rel of audit.untracked) process.stdout.write(`[UNTRACKED] ${rel}\n`);
    process.stdout.write(
      audit.ok
        ? "Coverage OK: every engine-managed file is tracked.\n"
        : `Coverage GAP: ${audit.untracked_count} engine-managed file(s) untracked.\n`
    );
  }
  process.exit(audit.ok ? 0 : 1);
}
