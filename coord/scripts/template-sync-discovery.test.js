"use strict";

// COORD-607 regression suite for rule-based engine-surface discovery.
//
// The bug: coord/TEMPLATE_SYNC_MANIFEST.json was hand-curated from a static
// April-2026 inventory snapshot, so an engine file created afterwards was
// invisible to check-template-sync.sh AND gov verify-engine — both green while
// 256 untracked engine files (identity-v2.js, gate-plan.js,
// plan-record-field-validators.js, hooks/*, enterprise/*, check-test-isolation.sh)
// could drift or be tampered with. The manifest fingerprint also feeds
// conformance attestation (ENT-010) and the engine pin (ENT-011), so the gap
// weakened every downstream integrity claim.
//
// The guard: the FIRST test below is the one that matters. It builds a fixture
// engine tree whose manifest is complete, proves the audit is green, then drops
// ONE new engine file into the tree and proves the audit goes RED. That is the
// gap reopening, caught by construction rather than by memory.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const discovery = require("./template-sync-discovery.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REAL_MANIFEST = path.join(REPO_ROOT, "coord", "TEMPLATE_SYNC_MANIFEST.json");

function readRealManifest() {
  return JSON.parse(fs.readFileSync(REAL_MANIFEST, "utf8"));
}

function realTrackedPaths() {
  return new Set(readRealManifest().items.map((item) => item.path));
}

// --- COORD-609: edition awareness ------------------------------------------
//
// This suite runs against THREE different trees: the donor repo, the COMMUNITY
// cut (which strips coord/scripts/enterprise/**), and the ENTERPRISE cut (which
// keeps it). COORD-607 correctly made release/build-public-release.sh step 7a
// REGENERATE manifest membership by rule against the built tree, so in a
// Community cut the enterprise entries are legitimately absent — yet the
// assertions below asserted a donor-only truth as if it were universal and blew
// up the pre-publish hygiene gate on every Community cut.
//
// The edition signal is `coord/RELEASE_PROVENANCE.json`.`cut`, because:
//   * it is the BUILDER's own stamp of which cut these bytes are (step 7b of
//     release/build-public-release.sh), written INSIDE the artifact and before
//     the pre-publish hygiene gate (step 10) runs the suite, so it is visible
//     exactly where the failure happened;
//   * the engine already treats it as the authoritative "which release am I"
//     fact — coord/scripts/conformance-attestation.js binds the attestation to
//     its donor SHA (COORD-044). This test adds no new source of truth;
//   * the cut ATTESTATION (`<OUT>.attestation.json`) also names the cut, but it
//     is deliberately written OUTSIDE the artifact so it cannot pollute the
//     publishable tree — a suite running inside the cut cannot read it;
//   * the presence of coord/scripts/enterprise/ is NOT used as the signal: that
//     is the very thing being asserted, so keying off it would make the test
//     tautological. Instead the tree is cross-checked AGAINST the stamp below,
//     which is what turns a leaked enterprise file in a Community cut into a
//     test failure rather than a silently satisfied condition.
//
// The donor has no RELEASE_PROVENANCE.json (it is generated only by the
// builder), so "absent" means "donor".
const EDITION_DONOR = "donor";
const EDITION_COMMUNITY = "Community";
const EDITION_ENTERPRISE = "Enterprise";

function detectEdition(repoRoot) {
  const provenancePath = path.join(repoRoot, "coord", "RELEASE_PROVENANCE.json");
  if (!fs.existsSync(provenancePath)) return EDITION_DONOR;
  const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  const cut = typeof provenance.cut === "string" ? provenance.cut.trim() : "";
  if (cut !== EDITION_COMMUNITY && cut !== EDITION_ENTERPRISE) {
    // Fail closed: an unrecognized stamp must not silently degrade to "donor"
    // and re-assert donor-only truths about an unknown tree.
    throw new Error(
      `coord/RELEASE_PROVENANCE.json declares cut "${provenance.cut}", which is neither ` +
        `"${EDITION_COMMUNITY}" nor "${EDITION_ENTERPRISE}". Teach this suite the new cut ` +
        `(and its open-core boundary) instead of widening the check.`
    );
  }
  return cut;
}

// Editions that ship the enterprise subtree. The Community cut is the only one
// that strips it (release/build-public-release.sh, COORD-111 open-core boundary).
function editionShipsEnterprise(edition) {
  return edition !== EDITION_COMMUNITY;
}

const ENTERPRISE_PREFIX = "coord/scripts/enterprise/";

// Lower bound on the rule-discovered engine surface, per edition. The point of
// the bound is to catch a discovery rule that silently stops matching; it is NOT
// a census, so each floor sits comfortably below the measured size while still
// being far above "the rule broke".
//   donor      493 engine-managed files (measured at COORD-609)
//   Community  441 — the ~46-file enterprise subtree plus the maintainer-only
//              tooling named in the release builder's DELETE list are stripped
//   Enterprise keeps enterprise/, so it tracks the donor floor
const MIN_ENGINE_MANAGED_FILES = {
  [EDITION_DONOR]: 450,
  [EDITION_ENTERPRISE]: 450,
  [EDITION_COMMUNITY]: 400,
};

// A minimal fixture repo shaped like the engine: engine-managed roots plus one
// project-owned board file that the exclusion list claims.
function makeFixtureRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord607-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "coord", "scripts", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", "board", "plans"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord", "scripts", "lifecycle.js"), "// engine\n");
  fs.writeFileSync(path.join(root, "coord", "scripts", "agent"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(root, "coord", "scripts", "hooks", "pre-bash-guard.js"), "// guard\n");
  fs.writeFileSync(path.join(root, "coord", "board", "board.js"), "// board\n");
  fs.writeFileSync(path.join(root, "coord", "board", "tasks.json"), '{"tasks":[]}\n');
  fs.writeFileSync(path.join(root, "coord", "board", "plans", ".gitkeep"), "");
  return root;
}

function writeFixtureManifest(root) {
  const { manifest } = discovery.buildManifest(root, null, {
    useGit: false,
    manifestVersion: "fixture",
  });
  const manifestPath = path.join(root, "coord", "TEMPLATE_SYNC_MANIFEST.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifest };
}

test("COORD-607: coverage audit goes RED when a new engine file is untracked", (t) => {
  const root = makeFixtureRepo(t);
  const { manifest } = writeFixtureManifest(root);
  const tracked = new Set(manifest.items.map((item) => item.path));

  // Baseline: the rule-derived manifest covers the whole engine surface.
  const before = discovery.auditCoverage(root, tracked, { useGit: false });
  assert.equal(before.ok, true, "a rule-derived manifest must start with zero untracked files");
  assert.deepEqual(before.untracked, []);

  // Reopen the gap exactly the way it happened in real life: a new engine file
  // appears and nobody edits the manifest.
  fs.writeFileSync(path.join(root, "coord", "scripts", "identity-v3.js"), "// new engine code\n");
  const after = discovery.auditCoverage(root, tracked, { useGit: false });
  assert.equal(after.ok, false, "an untracked engine file must fail the coverage audit");
  assert.deepEqual(after.untracked, ["coord/scripts/identity-v3.js"]);
  assert.equal(after.untracked_count, 1);
});

test("COORD-607: no extension allowlist — an extensionless entrypoint is still discovered", (t) => {
  const root = makeFixtureRepo(t);
  const discovered = discovery.discover(root, { useGit: false });
  // The pre-COORD-607 audit filtered on .js/.mjs/.sh, which is precisely how the
  // extensionless `coord/scripts/agent` entrypoint stayed invisible.
  assert.ok(
    discovered.files.includes("coord/scripts/agent"),
    "extensionless engine entrypoints must be discovered"
  );

  fs.writeFileSync(path.join(root, "coord", "scripts", "newverb"), "#!/usr/bin/env bash\n");
  const tracked = new Set(discovered.files);
  const audit = discovery.auditCoverage(root, tracked, { useGit: false });
  assert.deepEqual(audit.untracked, ["coord/scripts/newverb"]);
});

test("COORD-607: check-template-sync.sh --audit-coverage exits non-zero on an untracked engine file", (t) => {
  const root = makeFixtureRepo(t);
  const { manifestPath } = writeFixtureManifest(root);
  const script = path.join(__dirname, "check-template-sync.sh");

  const run = () =>
    execFileSync(
      "bash",
      [script, "--repo-root", root, "--manifest", manifestPath, "--audit-coverage", "--json"],
      { encoding: "utf8" }
    );

  const clean = JSON.parse(run());
  assert.equal(clean.ok, true);
  assert.equal(clean.coverage_audit.untracked_count, 0);

  fs.writeFileSync(path.join(root, "coord", "scripts", "smuggled.js"), "// untracked engine code\n");
  let failed = null;
  try {
    run();
    assert.fail("check-template-sync.sh must exit non-zero when an engine file is untracked");
  } catch (error) {
    failed = error;
  }
  assert.equal(failed.status, 1);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.coverage_audit.untracked, ["coord/scripts/smuggled.js"]);
  assert.ok(
    report.failures.some((entry) => entry.path === "coord/scripts/smuggled.js" && entry.status === "untracked"),
    "the untracked file must be reported as a failure, not a note"
  );
});

test("COORD-607: project-owned state is excluded, and every exclusion records a reason", (t) => {
  const root = makeFixtureRepo(t);
  const discovered = discovery.discover(root, { useGit: false });

  assert.ok(!discovered.files.includes("coord/board/tasks.json"));
  assert.ok(!discovered.files.includes("coord/board/plans/.gitkeep"));

  for (const entry of discovered.excluded) {
    assert.equal(typeof entry.category, "string");
    assert.ok(entry.category.trim().length > 0, `${entry.path} needs an exclusion category`);
    assert.ok(
      typeof entry.reason === "string" && entry.reason.trim().length >= 40,
      `${entry.path} needs a substantive recorded reason, not a label`
    );
  }

  // The exclusion list itself must never be a silent escape hatch.
  for (const exclusion of discovery.EXCLUSIONS) {
    assert.ok(exclusion.pattern && exclusion.category && exclusion.reason);
    assert.ok(
      exclusion.reason.trim().length >= 40,
      `exclusion ${exclusion.pattern} needs a recorded reason`
    );
  }
});

test("COORD-607: this repo's manifest tracks every engine-managed file", () => {
  const audit = discovery.auditCoverage(REPO_ROOT, realTrackedPaths());
  assert.deepEqual(
    audit.untracked,
    [],
    "engine-managed files are untracked; regenerate with " +
      "`node coord/scripts/template-sync-discovery.js --write`"
  );
  assert.equal(audit.ok, true);
  // COORD-609: the floor is edition-aware. A Community cut legitimately has a
  // smaller engine surface, so a single donor-calibrated number is either a
  // false failure there or a vacuous one here.
  const edition = detectEdition(REPO_ROOT);
  const floor = MIN_ENGINE_MANAGED_FILES[edition];
  assert.ok(
    audit.engine_managed_count > floor,
    `the discovery rule must see the whole engine surface: edition=${edition} ` +
      `engine_managed_count=${audit.engine_managed_count} floor=${floor}`
  );
});

test("COORD-607/COORD-609: named security- and gate-relevant files are tracked, and the open-core boundary holds in this edition", () => {
  const tracked = realTrackedPaths();
  const edition = detectEdition(REPO_ROOT);

  // Core engine files: present and tracked in EVERY edition.
  const named = [
    "coord/scripts/identity-v2.js",
    "coord/scripts/gate-plan.js",
    "coord/scripts/plan-record-field-validators.js",
    "coord/scripts/check-test-isolation.sh",
    "coord/scripts/agent",
    "coord/scripts/hooks/pre-bash-guard.js",
    "coord/scripts/hooks/session-start.js",
    "coord/scripts/hooks/hook-lib.js",
    "coord/scripts/gates/registry.js",
    "coord/scripts/template-sync-discovery.js",
  ];
  for (const rel of named) {
    assert.ok(tracked.has(rel), `${rel} must be tracked by the manifest (edition=${edition})`);
  }

  // The enterprise files the COORD-607 ticket named by hand. These are
  // Enterprise-only surface, so the claim about them is edition-dependent — but
  // it is a claim in BOTH directions, never a skipped assertion.
  const namedEnterprise = [
    "coord/scripts/enterprise/rehash-verifier.js",
    "coord/scripts/enterprise/enterprise-rbac-policy.js",
  ];
  const enterpriseOnDisk = fs.existsSync(path.join(REPO_ROOT, "coord", "scripts", "enterprise"));
  const enterpriseTracked = [...tracked].filter((rel) => rel.startsWith(ENTERPRISE_PREFIX));

  if (editionShipsEnterprise(edition)) {
    // Direction 1 (donor / Enterprise cut): the subtree ships, so every named
    // security-relevant enterprise file must be manifest-tracked — the original
    // COORD-607 guarantee, unweakened.
    assert.equal(
      enterpriseOnDisk,
      true,
      `edition=${edition} must ship coord/scripts/enterprise/ (open-core boundary)`
    );
    for (const rel of namedEnterprise) {
      assert.ok(tracked.has(rel), `${rel} must be tracked by the manifest (edition=${edition})`);
    }
    assert.ok(
      enterpriseTracked.length > 0,
      `edition=${edition} manifest must track the enterprise subtree`
    );
  } else {
    // Direction 2 (Community cut): the subtree is stripped, so it must be gone
    // from the TREE *and* from manifest MEMBERSHIP. Both halves matter:
    //   * a surviving file is an open-core leak (COORD-111);
    //   * a surviving manifest ITEM is the COORD-607 failure mode — a shipped
    //     manifest listing files the cut does not contain, which fails the
    //     artifact's own check-template-sync and the engine pin. This is what
    //     proves step 7a regenerated membership by rule instead of re-hashing
    //     the donor's item list.
    assert.equal(
      enterpriseOnDisk,
      false,
      "a Community cut must not ship coord/scripts/enterprise/ (open-core leak)"
    );
    assert.deepEqual(
      enterpriseTracked,
      [],
      "a Community cut's manifest must not list stripped enterprise files; regenerate " +
        "membership by rule (build-public-release.sh step 7a / " +
        "`node coord/scripts/template-sync-discovery.js --write`)"
    );
    for (const rel of namedEnterprise) {
      assert.ok(
        !tracked.has(rel),
        `${rel} is Enterprise-only and must not be tracked by a Community cut's manifest`
      );
    }
  }
});

test("COORD-609: the edition signal comes from the builder's provenance stamp and fails closed on an unknown cut", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord609-edition-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "coord"), { recursive: true });
  const provenance = path.join(root, "coord", "RELEASE_PROVENANCE.json");
  const stamp = (cut) => fs.writeFileSync(provenance, `${JSON.stringify({ schema_version: 1, cut })}\n`);

  // No stamp at all => donor. Only the builder writes RELEASE_PROVENANCE.json.
  assert.equal(detectEdition(root), EDITION_DONOR);

  stamp("Community");
  assert.equal(detectEdition(root), EDITION_COMMUNITY);
  assert.equal(editionShipsEnterprise(detectEdition(root)), false);

  stamp("Enterprise");
  assert.equal(detectEdition(root), EDITION_ENTERPRISE);
  assert.equal(editionShipsEnterprise(detectEdition(root)), true);

  // An unrecognized cut must NOT degrade to "donor" and re-assert donor-only
  // truths about a tree nobody has classified.
  stamp("Somethingelse");
  assert.throws(() => detectEdition(root), /neither "Community" nor "Enterprise"/);

  // Every edition must have a declared engine-surface floor.
  for (const edition of [EDITION_DONOR, EDITION_COMMUNITY, EDITION_ENTERPRISE]) {
    assert.equal(typeof MIN_ENGINE_MANAGED_FILES[edition], "number", `${edition} needs a floor`);
  }
});

test("COORD-607: the manifest records the discovery rule and its reasoned exclusions", () => {
  const manifest = readRealManifest();
  assert.equal(manifest.discovery.mode, "rule-based");
  assert.deepEqual(manifest.discovery.engine_managed_roots, discovery.ENGINE_MANAGED_ROOTS);
  assert.equal(manifest.discovery.owner_module, "coord/scripts/template-sync-discovery.js");
  assert.equal(manifest.discovery.exclusions.length, discovery.EXCLUSIONS.length);
  for (const exclusion of manifest.discovery.exclusions) {
    assert.ok(exclusion.pattern && exclusion.category);
    assert.ok(exclusion.reason.trim().length >= 40, `${exclusion.pattern} needs a recorded reason`);
  }
  // Items under the roots are rule-derived; the surviving hand-listed entries
  // live outside the roots and are labelled as such.
  for (const item of manifest.items) {
    const underRoots = discovery.isUnderRoots(item.path, discovery.ENGINE_MANAGED_ROOTS);
    assert.equal(
      item.discovery,
      underRoots ? "rule" : "curated-extra",
      `${item.path} has the wrong discovery provenance`
    );
  }
});

test("COORD-607: regenerating the manifest is idempotent and preserves curated rationale", () => {
  const previous = readRealManifest();
  const { manifest } = discovery.buildManifest(REPO_ROOT, previous, {
    manifestVersion: previous.manifest_version,
    now: previous.generated_at,
  });
  assert.deepEqual(
    manifest.items.map((item) => item.path),
    previous.items.map((item) => item.path),
    "regeneration must be a fixed point on an up-to-date manifest"
  );
  for (const item of manifest.items) {
    const before = previous.items.find((candidate) => candidate.path === item.path);
    assert.equal(item.rationale, before.rationale, `${item.path} lost its recorded rationale`);
    assert.equal(item.checksum.hex, before.checksum.hex);
  }
});
