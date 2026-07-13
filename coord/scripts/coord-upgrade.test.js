"use strict";

// COORD-118: tests for `coord upgrade`. All fixtures are os.tmpdir() scratch
// trees — a fake SOURCE engine surface and a TARGET repo — so the live repo,
// the real manifest, and coord/engine-pin.json are never touched. We compose
// the REAL engine-pin module (no stub) for the happy/idempotent/dry-run paths so
// the pin/verify verdict is the genuine ENT-011 engine, and inject a stubbed
// engine-pin only to deterministically force a verify failure for the rollback
// proof.
//
// We prove:
//   - apply: changed surface files updated + a new file added; engine-pin.json
//     regenerated; engine verify passes; exit 0;
//   - idempotent: re-running the same upgrade is a no-op (all unchanged), exit 0,
//     no writes;
//   - --dry-run: prints the plan, writes NOTHING;
//   - rollback: a forced verify failure restores every applied target file to its
//     exact pre-upgrade bytes (and removes added files) + non-zero exit;
//   - project-local files (board, project.config.js) are NEVER touched;
//   - no-argument automatic upgrade is plan-only and digest-gated;
//   - dispatcher registry now routes `upgrade`.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createCoordUpgrade = require("./coord-upgrade.js");
const { dispatch, buildRegistry } = require("./coord-cli.js");

// A minimal exact-match manifest tracking two engine files. (The manifest file
// itself is always part of the applied surface.)
function manifest(version, items) {
  return JSON.stringify(
    {
      schema_version: 1,
      manifest_version: version,
      items: items.map((p) => ({ path: p, match_policy: "exact" })),
    },
    null,
    2
  ) + "\n";
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function capture() {
  const lines = [];
  return { log: (l) => lines.push(String(l)), text: () => lines.join("\n") };
}

// Build a SOURCE engine (new version) and a TARGET repo (old version). The
// source bumps alpha.js, adds gamma.js, leaves beta.js identical. The target
// also has project-local files that must never be touched.
function makeFixture(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord-118-"));
  const source = path.join(tmp, "source");
  const target = path.join(tmp, "target");

  const tracked = ["coord/scripts/alpha.js", "coord/scripts/beta.js", "coord/scripts/gamma.js"];

  // SOURCE (new engine v2): alpha changed, beta same, gamma new.
  writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", tracked));
  writeFile(source, "coord/scripts/alpha.js", "module.exports = 2; // v2\n");
  writeFile(source, "coord/scripts/beta.js", "module.exports = 'beta';\n");
  writeFile(source, "coord/scripts/gamma.js", "module.exports = 'gamma-new';\n");

  // TARGET (old engine v1): alpha old, beta same, gamma absent. Plus project-local.
  writeFile(target, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v1", tracked));
  writeFile(target, "coord/scripts/alpha.js", "module.exports = 1; // v1\n");
  writeFile(target, "coord/scripts/beta.js", "module.exports = 'beta';\n");
  writeFile(target, "coord/project.config.js", "module.exports = { repos: {} }; // LOCAL\n");
  writeFile(target, "coord/board/tasks.json", '{"tasks":[{"ID":"LOCAL-1"}]}\n');

  return { tmp, source, target, tracked };
}

function cleanup(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

test("apply: updates changed + adds new surface file, regenerates pin, verify passes, exit 0", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const cap = capture();
    const cmd = createCoordUpgrade({ log: cap.log, cwd: () => tmp });
    const result = cmd.run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 0);
    // alpha updated to v2, gamma added, beta unchanged.
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 2; // v2\n");
    assert.strictEqual(read(target, "coord/scripts/gamma.js"), "module.exports = 'gamma-new';\n");
    assert.strictEqual(read(target, "coord/scripts/beta.js"), "module.exports = 'beta';\n");
    // Manifest applied (target now declares engine-v2).
    assert.match(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), /engine-v2/);
    // engine-pin.json regenerated over the new surface, and it verifies in-sync.
    const pinPath = path.join(target, "coord", "engine-pin.json");
    assert.ok(fs.existsSync(pinPath), "engine-pin.json must be written");
    const pin = JSON.parse(read(target, "coord/engine-pin.json"));
    assert.strictEqual(pin.manifest_version, "engine-v2");
    assert.match(cap.text(), /engine verify PASS/);
  } finally {
    cleanup(tmp);
  }
});

test("idempotent: re-running the same upgrade is a no-op (all unchanged), exit 0", () => {
  const { tmp, source, target } = makeFixture();
  try {
    createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    // Second run: source == target surface now → no changes.
    const pinBefore = read(target, "coord/engine-pin.json");
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.applied, 0);
    assert.match(cap.text(), /Already up to date/);
    // No-op must not rewrite the pin.
    assert.strictEqual(read(target, "coord/engine-pin.json"), pinBefore);
  } finally {
    cleanup(tmp);
  }
});

test("--dry-run: prints the plan and writes nothing", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alphaBefore = read(target, "coord/scripts/alpha.js");
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run([
      "--from", source, "--dir", target, "--dry-run",
    ]);
    assert.strictEqual(result.code, 0);
    assert.match(cap.text(), /dry run/);
    assert.match(cap.text(), /add\s+coord\/scripts\/gamma\.js/);
    assert.match(cap.text(), /update\s+coord\/scripts\/alpha\.js/);
    // Nothing written.
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), alphaBefore);
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")));
    assert.ok(!fs.existsSync(path.join(target, "coord/engine-pin.json")));
  } finally {
    cleanup(tmp);
  }
});

test("rollback: forced verify failure restores exact pre-upgrade bytes + removes added files, non-zero exit", () => {
  const { tmp, source, target } = makeFixture();
  try {
    // Snapshot pre-upgrade bytes of every file the upgrade will touch.
    const alphaBefore = read(target, "coord/scripts/alpha.js");
    const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    const configBefore = read(target, "coord/project.config.js");
    const boardBefore = read(target, "coord/board/tasks.json");

    // Stub engine-pin so verify deterministically FAILS after apply.
    const stubCreateEnginePin = () => ({
      pin: () => ({ pinned: true }),
      verify: () => ({ ok: false, problems: [{ code: "engine_file_drift", detail: "injected" }] }),
    });

    const cap = capture();
    const result = createCoordUpgrade({
      log: cap.log,
      cwd: () => tmp,
      createEnginePin: stubCreateEnginePin,
    }).run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 1);
    assert.ok(result.rolledBack > 0, "must report rolled-back count");
    assert.match(cap.text(), /Rolling back|Rolled back/);

    // Every touched file restored to its exact pre-upgrade bytes.
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), alphaBefore, "alpha restored");
    assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore, "manifest restored");
    // The added file (gamma) must be removed by rollback (did not exist before).
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")), "added file removed on rollback");

    // Project-local files never touched.
    assert.strictEqual(read(target, "coord/project.config.js"), configBefore);
    assert.strictEqual(read(target, "coord/board/tasks.json"), boardBefore);
  } finally {
    cleanup(tmp);
  }
});

test("surface-only: project-local files are never written even on success", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const configBefore = read(target, "coord/project.config.js");
    const boardBefore = read(target, "coord/board/tasks.json");
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(read(target, "coord/project.config.js"), configBefore);
    assert.strictEqual(read(target, "coord/board/tasks.json"), boardBefore);
  } finally {
    cleanup(tmp);
  }
});

test("automatic latest upgrade is plan-only, digest-gated, and writes a receipt", () => {
  const { tmp, source, target } = makeFixture();
  try {
    writeFile(target, "coord/.coord-engine.json", JSON.stringify({
      schema: 1,
      engine_version: "engine-v1",
      source: { repo: "https://github.com/Softsensor-org/concord", channel: "community", ref: "old", sha: "1".repeat(40) },
    }) + "\n");
    const releaseSource = {
      resolveLatest: () => ({
        sourceRoot: source,
        ref: "refs/heads/main",
        sha: "2".repeat(40),
        archiveSha256: "3".repeat(64),
        cleanup: () => {},
      }),
    };
    const cap = capture();
    const command = createCoordUpgrade({ log: cap.log, cwd: () => tmp, releaseSource, now: "2026-07-12T00:00:00Z" });
    const planned = command.run(["--dir", target]);
    assert.strictEqual(planned.code, 0);
    assert.strictEqual(planned.planned, true);
    assert.match(planned.planDigest, /^[0-9a-f]{64}$/);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 1; // v1\n");

    const refused = command.run(["--dir", target, "--apply-plan", "0".repeat(64)]);
    assert.strictEqual(refused.code, 1);
    assert.match(cap.text(), /REFUSED/);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 1; // v1\n");

    const applied = command.run(["--dir", target, "--apply-plan", planned.planDigest]);
    assert.strictEqual(applied.code, 0);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 2; // v2\n");
    assert.ok(fs.existsSync(path.join(target, "coord/.runtime/upgrade-receipts", `${planned.planDigest}.json`)));
    const pin = JSON.parse(read(target, "coord/.coord-engine.json"));
    assert.strictEqual(pin.source.sha, "2".repeat(40));
  } finally {
    cleanup(tmp);
  }
});

test("--help prints usage and exits 0", () => {
  const cap = capture();
  const result = createCoordUpgrade({ log: cap.log }).run(["--help"]);
  assert.strictEqual(result.code, 0);
  assert.match(cap.text(), /Usage: coord upgrade/);
});

test("unexpected args → exit 1", () => {
  const cap = capture();
  const result = createCoordUpgrade({ log: cap.log }).run(["--from", "/x", "--bogus"]);
  assert.strictEqual(result.code, 1);
  assert.match(cap.text(), /unexpected argument/);
});

test("malformed source: manifest-tracked file missing from source tree → exit 1, no writes", () => {
  const { tmp, source, target } = makeFixture();
  try {
    // Remove a tracked file from the source so the surface is incomplete.
    fs.rmSync(path.join(source, "coord/scripts/gamma.js"));
    const alphaBefore = read(target, "coord/scripts/alpha.js");
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.match(cap.text(), /partial surface/);
    // Refused before any write.
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), alphaBefore);
    assert.ok(!fs.existsSync(path.join(target, "coord/engine-pin.json")));
  } finally {
    cleanup(tmp);
  }
});

test("--json emits a machine-readable pass result", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const out = [];
    const result = createCoordUpgrade({ log: (l) => out.push(String(l)), cwd: () => tmp }).run([
      "--from", source, "--dir", target, "--json",
    ]);
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(out.join("\n"));
    assert.strictEqual(parsed.verdict, "pass");
    assert.strictEqual(parsed.added, 1); // gamma.js
    // alpha.js + the manifest both change v1→v2.
    assert.strictEqual(parsed.updated, 2);
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// dispatcher: registry now routes upgrade
// ---------------------------------------------------------------------------

test("buildRegistry registers upgrade alongside init + conformance", () => {
  const registry = buildRegistry({ log: () => {} });
  assert.ok(registry.init, "init still registered");
  assert.ok(registry.conformance, "conformance still registered");
  assert.ok(registry.upgrade, "upgrade registered");
  assert.strictEqual(typeof registry.upgrade.run, "function");
});

test("dispatch routes upgrade to its run()", () => {
  let routedArgs = null;
  const registry = {
    upgrade: { summary: "x", run: (args) => { routedArgs = args; return { code: 0 }; } },
  };
  const result = dispatch(["upgrade", "--from", "/x"], { log: () => {}, registry });
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(routedArgs, ["--from", "/x"]);
});

// ---------------------------------------------------------------------------
// COORD-451: .coord-engine.json upstream pin, --channel/--entitlement, --check
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-07-03T00:00:00.000Z";

function readPin(target) {
  return JSON.parse(read(target, "coord/.coord-engine.json"));
}

test("COORD-451 apply records .coord-engine.json (version from manifest, default channel community)", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp, now: FIXED_NOW })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0);
    const pin = readPin(target);
    assert.strictEqual(pin.schema, 1);
    assert.strictEqual(pin.engine_version, "engine-v2");
    assert.strictEqual(pin.source.channel, "community");
    assert.strictEqual(pin.applied_at, FIXED_NOW);
    assert.match(cap.text(), /Pinned upstream: version engine-v2, channel community/);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-451 --channel enterprise WITHOUT entitlement is fail-closed (exit 1, no writes)", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const before = read(target, "coord/scripts/alpha.js");
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp })
      .run(["--from", source, "--dir", target, "--channel", "enterprise"]);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.error, "entitlement required");
    // Fail-closed BEFORE any apply: the surface is untouched, no pin written.
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), before);
    assert.ok(!fs.existsSync(path.join(target, "coord", ".coord-engine.json")));
    assert.match(cap.text(), /requires an entitlement token/);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-451 --channel enterprise WITH entitlement flips the pinned channel", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp, now: FIXED_NOW })
      .run(["--from", source, "--dir", target, "--channel", "enterprise", "--entitlement", "tok-123"]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(readPin(target).source.channel, "enterprise");
  } finally {
    cleanup(tmp);
  }
});

test("COORD-451 entitlement can come from CONCORD_ENTITLEMENT env", () => {
  const { tmp, source, target } = makeFixture();
  const prior = process.env.CONCORD_ENTITLEMENT;
  process.env.CONCORD_ENTITLEMENT = "env-tok";
  try {
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp })
      .run(["--from", source, "--dir", target, "--channel", "enterprise"]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(readPin(target).source.channel, "enterprise");
  } finally {
    if (prior === undefined) delete process.env.CONCORD_ENTITLEMENT;
    else process.env.CONCORD_ENTITLEMENT = prior;
    cleanup(tmp);
  }
});

test("COORD-451 unknown --channel is rejected", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp })
      .run(["--from", source, "--dir", target, "--channel", "premium"]);
    assert.strictEqual(result.code, 1);
    assert.match(cap.text(), /unknown --channel/);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-451 --check on a pristine upgraded target reports no engine drift (exit 0)", () => {
  const { tmp, source, target } = makeFixture();
  try {
    createCoordUpgrade({ log: () => {}, cwd: () => tmp, now: FIXED_NOW })
      .run(["--from", source, "--dir", target]);
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run(["--check", "--dir", target]);
    assert.strictEqual(result.code, 0);
    assert.match(cap.text(), /engine drift\s+: none/);
    assert.match(cap.text(), /channel\s+: community/);
    assert.match(cap.text(), /engine version\s+: engine-v2/);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-451 --check flags ENGINE drift when a vendored surface file is hand-edited (exit 1)", () => {
  const { tmp, source, target } = makeFixture();
  try {
    createCoordUpgrade({ log: () => {}, cwd: () => tmp, now: FIXED_NOW })
      .run(["--from", source, "--dir", target]);
    // Hand-edit a manifest-tracked (vendored) engine file → integrity drift.
    writeFile(target, "coord/scripts/alpha.js", "module.exports = 999; // tampered\n");
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run(["--check", "--dir", target, "--json"]);
    assert.strictEqual(result.code, 1);
    const out = JSON.parse(cap.text());
    assert.strictEqual(out.verdict, "engine-drift");
    assert.ok(out.engine_drift >= 1);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-451 --check tolerates a pre-COORD-451 scaffold with no .coord-engine.json", () => {
  const { tmp, source, target } = makeFixture();
  try {
    // Land a valid upgraded surface, then remove .coord-engine.json to mimic a
    // pre-COORD-451 scaffold whose engine surface is still pinned/clean.
    createCoordUpgrade({ log: () => {}, cwd: () => tmp, now: FIXED_NOW })
      .run(["--from", source, "--dir", target]);
    fs.rmSync(path.join(target, "coord", ".coord-engine.json"));
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run(["--check", "--dir", target]);
    assert.strictEqual(result.code, 0);
    assert.match(cap.text(), /no \.coord-engine\.json/);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-502 --check reports no_pin as unpinned, not engine-file drift", () => {
  const { tmp, target } = makeFixture();
  try {
    const out = [];
    const command = createCoordUpgrade({
      log: (line) => out.push(String(line)),
      cwd: () => tmp,
      createEnginePin: () => ({ verify: () => ({ ok: false, problems: [{ code: "no_pin" }], live_version: "legacy" }) }),
    });
    const result = command.run(["--check", "--dir", target, "--json"]);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.unpinned, true);
    const parsed = JSON.parse(out.join("\n"));
    assert.strictEqual(parsed.verdict, "unpinned");
    assert.strictEqual(parsed.engine_drift, 0);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-451 surface-unchanged + --channel switch reconciles the pin (repin, exit 0)", () => {
  const { tmp, source, target } = makeFixture();
  try {
    // First: land the surface on community.
    createCoordUpgrade({ log: () => {}, cwd: () => tmp, now: FIXED_NOW })
      .run(["--from", source, "--dir", target]);
    // Second: same source (surface unchanged) but switch channel → metadata-only re-pin.
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp, now: FIXED_NOW })
      .run(["--from", source, "--dir", target, "--channel", "enterprise", "--entitlement", "tok"]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.applied, 0);
    assert.strictEqual(readPin(target).source.channel, "enterprise");
    assert.match(cap.text(), /reconciled pin/);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-451 --ref/--sha are recorded in the pin", () => {
  const { tmp, source, target } = makeFixture();
  try {
    createCoordUpgrade({ log: () => {}, cwd: () => tmp, now: FIXED_NOW })
      .run(["--from", source, "--dir", target, "--ref", "v0.2.0", "--sha", "abc1234"]);
    const pin = readPin(target);
    assert.strictEqual(pin.source.ref, "v0.2.0");
    assert.strictEqual(pin.source.sha, "abc1234");
  } finally {
    cleanup(tmp);
  }
});
