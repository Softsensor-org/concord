"use strict";
const { performance } = require("node:perf_hooks");

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
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");

const createCoordUpgrade = require("./coord-upgrade.js");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const { dispatch, buildRegistry } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/coord-cli.js"));

// A minimal exact-match manifest tracking two engine files. (The manifest file
// itself is always part of the applied surface.)
function checksum(content) {
  const bytes = Buffer.from(content);
  return {
    algo: "sha256",
    hex: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function manifest(version, items, contents = {}) {
  return JSON.stringify(
    {
      schema_version: 1,
      manifest_version: version,
      items: items.map((p) => ({ path: p, match_policy: "exact", checksum: checksum(contents[p] || "") })),
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

function fixedReleaseSource(source) {
  return {
    resolveLatest: () => ({
      sourceRoot: source,
      ref: "refs/heads/main",
      sha: "2".repeat(40),
      archiveSha256: "3".repeat(64),
      cleanup: () => {},
    }),
  };
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("COORD-753: readiness polling survives an adjustable wall clock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord753-ready-"));
  const ready = path.join(dir, "ready");
  const originalWallClock = Date.now;
  const jump = setTimeout(() => { Date.now = () => originalWallClock() + 60000; }, 5);
  const create = setTimeout(() => fs.writeFileSync(ready, "ready"), 40);
  try {
    await waitForFile(ready);
    assert.ok(fs.existsSync(ready));
  } finally {
    clearTimeout(jump);
    clearTimeout(create);
    Date.now = originalWallClock;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Build a SOURCE engine (new version) and a TARGET repo (old version). The
// source bumps alpha.js, adds gamma.js, leaves beta.js identical. The target
// also has project-local files that must never be touched.
function makeFixture(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord-118-"));
  const source = path.join(tmp, "source");
  const target = path.join(tmp, "target");

  const tracked = ["coord/scripts/alpha.js", "coord/scripts/beta.js", "coord/scripts/gamma.js"];
  const sourceContents = {
    "coord/scripts/alpha.js": "module.exports = 2; // v2\n",
    "coord/scripts/beta.js": "module.exports = 'beta';\n",
    "coord/scripts/gamma.js": "module.exports = 'gamma-new';\n",
  };

  // SOURCE (new engine v2): alpha changed, beta same, gamma new.
  writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", tracked, sourceContents));
  for (const [rel, content] of Object.entries(sourceContents)) writeFile(source, rel, content);

  // TARGET (old engine v1): alpha old, beta same, gamma absent. Plus project-local.
  writeFile(target, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v1", tracked, {
    "coord/scripts/alpha.js": "module.exports = 1; // v1\n",
    "coord/scripts/beta.js": "module.exports = 'beta';\n",
    "coord/scripts/gamma.js": "",
  }));
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

test("COORD-895: an upgrade preserves the project-configured board branch", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const config = 'module.exports = { boardBranch: "governance", repos: {} }; // LOCAL\n';
    writeFile(target, "coord/project.config.js", config);
    // The new engine ships its own (template) config; it is not managed surface.
    writeFile(source, "coord/project.config.js", "module.exports = { repos: {} };\n");
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 2; // v2\n", "the engine did upgrade");
    assert.strictEqual(read(target, "coord/project.config.js"), config);
    const { resolveProjectConfig } = require("../../paths.js");
    assert.strictEqual(resolveProjectConfig(path.join(target, "coord"), undefined, { forceDefault: true }).boardBranch, "governance");
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
    const beforeDryRun = treeState(target);
    const dryRunOutput = capture();
    const dryRun = createCoordUpgrade({ log: dryRunOutput.log })
      .run(["--from", source, "--dir", target, "--dry-run", "--json"]);
    assert.equal(dryRun.code, 0);
    assert.equal(dryRun.applied, 0);
    assert.equal(JSON.parse(dryRunOutput.text()).verdict, "noop");
    assert.deepStrictEqual(treeState(target), beforeDryRun);
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
      pin: ({ pinPath }) => fs.writeFileSync(pinPath, "{}\n"),
      verify: () => ({ ok: false, problems: [{ code: "engine_file_drift", detail: "injected" }] }),
    });

    const cap = capture();
    const result = createCoordUpgrade({
      log: cap.log,
      cwd: () => tmp,
      createEnginePin: stubCreateEnginePin,
    }).run(["--from", source, "--dir", target, "--json"]);

    assert.strictEqual(result.code, 1);
    assert.ok(result.rolledBack > 0, "must report rolled-back count");
    assert.equal(result.error, "engine verify failed after apply");
    const report = JSON.parse(cap.text());
    assert.equal(report.verdict, "rolled-back");
    assert.deepStrictEqual(report.problems, [{ code: "engine_file_drift", detail: "injected" }]);

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

test("COORD-786 engine-pin failure callback aborts upgrade and restores the target", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const before = read(target, "coord/scripts/alpha.js");
    const createEnginePin = ({ fail }) => {
      fail("injected engine-pin failure");
      assert.fail("engine-pin failure callback must throw");
    };
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp, createEnginePin })
      .run(["--from", source, "--dir", target]);
    assert.equal(result.code, 1);
    assert.match(result.error, /injected engine-pin failure/);
    assert.equal(read(target, "coord/scripts/alpha.js"), before);
    assert.equal(fs.existsSync(path.join(target, "coord/scripts/gamma.js")), false);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-786 read-only upgrade check propagates engine-pin failure without writing", () => {
  const { tmp, target } = makeFixture();
  try {
    const before = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    const command = createCoordUpgrade({
      log: () => {},
      cwd: () => tmp,
      createEnginePin: ({ fail }) => fail("injected check pin failure"),
    });
    assert.throws(() => command.run(["--check", "--dir", target]), /injected check pin failure/);
    assert.equal(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), before);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-786 warns when the target upgrade lock changes owner before release", () => {
  const { tmp, source, target } = makeFixture();
  const lines = [];
  let changedOwner = false;
  const command = createCoordUpgrade({
    cwd: () => tmp,
    log: (line) => {
      const message = String(line);
      lines.push(message);
      if (!changedOwner && message.startsWith("coord upgrade:")) {
        const ownerPath = path.join(command.upgradeLockPath(target), "owner.json");
        const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        owner.lock_id = "0".repeat(32);
        fs.writeFileSync(ownerPath, JSON.stringify(owner));
        changedOwner = true;
      }
    },
  });
  try {
    fs.rmSync(path.join(source, "coord", "TEMPLATE_SYNC_MANIFEST.json"));
    const result = command.run(["--from", source, "--dir", target]);
    assert.equal(result.code, 1, "invalid source manifest must be refused");
    assert.equal(changedOwner, true, "fixture must swap lock ownership during error reporting");
    assert.ok(lines.some((line) => /WARNING — upgrade lock ownership changed before release/.test(line)));
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
    const requests = [];
    const releaseSource = {
      resolveLatest: (request) => {
        requests.push(request);
        return fixedReleaseSource(source).resolveLatest();
      },
    };
    const cap = capture();
    const command = createCoordUpgrade({ log: cap.log, cwd: () => tmp, releaseSource, now: "2026-07-12T00:00:00Z" });
    const planned = command.run(["--dir", target]);
    assert.strictEqual(planned.code, 0);
    assert.strictEqual(planned.planned, true);
    assert.strictEqual(requests[0].repo, "https://github.com/Softsensor-org/concord");
    assert.strictEqual(requests[0].channel, "community");
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

test("reviewed plan refuses a user surface edit and requires a new digest", () => {
  const { tmp, source, target } = makeFixture();
  try {
    writeFile(target, "coord/.coord-engine.json", JSON.stringify({
      schema: 1,
      engine_version: "engine-v1",
      source: { repo: "https://github.com/Softsensor-org/concord", channel: "community", ref: "old", sha: "1".repeat(40) },
    }) + "\n");
    const command = createCoordUpgrade({ log: () => {}, cwd: () => tmp, releaseSource: fixedReleaseSource(source) });
    const planned = command.run(["--dir", target]);
    assert.strictEqual(planned.code, 0);
    writeFile(target, "coord/scripts/alpha.js", "developer edit after review\n");

    const refused = command.run(["--dir", target, "--apply-plan", planned.planDigest]);
    assert.strictEqual(refused.code, 1);
    assert.strictEqual(refused.error, "plan digest mismatch");
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "developer edit after review\n");
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")));

    const replanned = command.run(["--dir", target]);
    assert.notStrictEqual(replanned.planDigest, planned.planDigest);
  } finally {
    cleanup(tmp);
  }
});

test("reviewed plan digest binds the upstream pin identity", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const pin = {
      schema: 1,
      engine_version: "engine-v1",
      source: { repo: "https://github.com/Softsensor-org/concord", channel: "community", ref: "old", sha: "1".repeat(40) },
    };
    writeFile(target, "coord/.coord-engine.json", JSON.stringify(pin) + "\n");
    const command = createCoordUpgrade({ log: () => {}, cwd: () => tmp, releaseSource: fixedReleaseSource(source) });
    const planned = command.run(["--dir", target]);
    pin.source.sha = "4".repeat(40);
    writeFile(target, "coord/.coord-engine.json", JSON.stringify(pin) + "\n");

    const refused = command.run(["--dir", target, "--apply-plan", planned.planDigest]);
    assert.strictEqual(refused.code, 1);
    assert.strictEqual(refused.error, "plan digest mismatch");
    assert.strictEqual(JSON.parse(read(target, "coord/.coord-engine.json")).source.sha, "4".repeat(40));
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 1; // v1\n");
  } finally {
    cleanup(tmp);
  }
});

test("final pre-apply revalidation refuses an edit made inside the locked invocation", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    const result = createCoordUpgrade({
      log: () => {},
      cwd: () => tmp,
      checkpoint: (name) => {
        if (name === "before-preapply-revalidation") {
          writeFile(target, "coord/scripts/alpha.js", "concurrent developer edit\n");
        }
      },
    }).run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.error, "target changed after planning");
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "concurrent developer edit\n");
    assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore);
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")));
    assert.ok(!fs.existsSync(path.join(target, "coord/engine-pin.json")));
  } finally {
    cleanup(tmp);
  }
});

test("two live upgrade processes cannot interleave on one target", { skip: process.platform === "win32" }, async () => {
  const { tmp, source, target } = makeFixture();
  const ready = path.join(tmp, "holder-ready");
  const release = path.join(tmp, "holder-release");
  const contenderResult = path.join(tmp, "contender-result.json");
  const modulePath = path.resolve(__dirname, "coord-upgrade.js");
  const holderScript = [
    "const fs = require('node:fs');",
    "const create = require(process.argv[1]);",
    "const ready = process.argv[4]; const release = process.argv[5];",
    "const wait = new Int32Array(new SharedArrayBuffer(4));",
    "const result = create({ log: () => {}, checkpoint(name) {",
    "  if (name === 'after-upgrade-lock-acquired') {",
    "    fs.writeFileSync(ready, 'ready');",
    "    while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 25);",
    "  }",
    "} }).run(['--from', process.argv[2], '--dir', process.argv[3]]);",
    "process.exitCode = result.code;",
  ].join("\n");
  const contenderScript = [
    "const fs = require('node:fs');",
    "const create = require(process.argv[1]);",
    "const result = create({ log: () => {} }).run(['--from', process.argv[2], '--dir', process.argv[3]]);",
    "fs.writeFileSync(process.argv[4], JSON.stringify(result)); process.exitCode = result.code;",
  ].join("\n");
  const holder = spawn(process.execPath, ["-e", holderScript, modulePath, source, target, ready, release], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForFile(ready);
    const liveLockDir = path.join(target, "coord/.runtime/upgrade-lock");
    assert.strictEqual(fs.statSync(liveLockDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(liveLockDir, "owner.json")).mode & 0o777, 0o600);
    const contender = spawnSync(process.execPath, ["-e", contenderScript, modulePath, source, target, contenderResult], { encoding: "utf8" });
    assert.strictEqual(contender.status, 1);
    assert.ok(fs.existsSync(contenderResult), contender.stderr || "contender produced no result");
    const refused = JSON.parse(fs.readFileSync(contenderResult, "utf8"));
    assert.match(refused.error, /upgrade lock busy/);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 1; // v1\n");
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")));

    fs.writeFileSync(release, "release");
    const [code] = await once(holder, "close");
    assert.strictEqual(code, 0);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 2; // v2\n");
    assert.ok(!fs.existsSync(path.join(target, "coord/.runtime/upgrade-lock")));
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    cleanup(tmp);
  }
});

test("dead same-host lock recovery records the prior holder and decision", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const lockDir = path.join(target, "coord/.runtime/upgrade-lock");
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFile(lockDir, "owner.json", JSON.stringify({
      schema: 1,
      lock_id: "a".repeat(32),
      pid: 424242,
      host: os.hostname(),
      acquired_at: "2026-07-14T00:00:00.000Z",
    }) + "\n");
    const cap = capture();
    const result = createCoordUpgrade({
      log: cap.log,
      cwd: () => tmp,
      signalProcess: () => {
        const error = new Error("not running");
        error.code = "ESRCH";
        throw error;
      },
      nowMs: () => Date.parse("2026-07-14T12:00:00.000Z"),
    }).run(["--from", source, "--dir", target, "--dry-run"]);

    assert.strictEqual(result.code, 0);
    assert.ok(!fs.existsSync(lockDir));
    const receiptDir = path.join(target, "coord/.runtime/upgrade-receipts");
    const receiptName = fs.readdirSync(receiptDir).find((name) => name.startsWith("lock-recovery-"));
    assert.ok(receiptName);
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receiptName), "utf8"));
    assert.strictEqual(receipt.outcome, "stale-lock-recovered");
    assert.strictEqual(receipt.prior_holder.pid, 424242);
    assert.match(receipt.recovery_reason, /no longer running/);
    assert.strictEqual(fs.statSync(path.join(receiptDir, receiptName)).mode & 0o777, 0o600);
  } finally {
    cleanup(tmp);
  }
});

test("foreign-host lock is fail-closed and is not recovered by age alone", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const lockDir = path.join(target, "coord/.runtime/upgrade-lock");
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFile(lockDir, "owner.json", JSON.stringify({
      schema: 1,
      lock_id: "b".repeat(32),
      pid: 10,
      host: "another-host",
      acquired_at: "2000-01-01T00:00:00.000Z",
    }) + "\n");
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp, hostname: () => "this-host" })
      .run(["--from", source, "--dir", target, "--dry-run"]);
    assert.strictEqual(result.code, 1);
    assert.match(result.error, /foreign-host ownership cannot be verified safely/);
    assert.ok(fs.existsSync(lockDir));
  } finally {
    cleanup(tmp);
  }
});

test("--check reports a live upgrade lock without mutating it", () => {
  const { tmp, target } = makeFixture();
  try {
    const lockDir = path.join(target, "coord/.runtime/upgrade-lock");
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFile(lockDir, "owner.json", JSON.stringify({
      schema: 1,
      lock_id: "c".repeat(32),
      pid: process.pid,
      host: os.hostname(),
      acquired_at: "2026-07-14T12:00:00.000Z",
    }) + "\n");
    const before = fs.readFileSync(path.join(lockDir, "owner.json"));
    const result = createCoordUpgrade({ log: () => {} }).run(["--check", "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.match(result.error, /currently owns the target lock/);
    assert.deepStrictEqual(fs.readFileSync(path.join(lockDir, "owner.json")), before);
  } finally {
    cleanup(tmp);
  }
});

test("invalid target path is refused without creating a repository skeleton", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord-508-invalid-"));
  const missing = path.join(tmp, "typo-target");
  try {
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp })
      .run(["--from", tmp, "--dir", missing]);
    assert.strictEqual(result.code, 1);
    assert.match(result.error, /ENOENT|target root must be a real directory/);
    assert.ok(!fs.existsSync(missing));
  } finally {
    cleanup(tmp);
  }
});

test("POSIX upgrades copy executable modes and treat mode-only drift as a managed change", { skip: process.platform === "win32" }, () => {
  const { tmp, source, target } = makeFixture();
  try {
    fs.chmodSync(path.join(source, "coord/scripts/alpha.js"), 0o755);
    fs.chmodSync(path.join(source, "coord/scripts/beta.js"), 0o755);
    fs.chmodSync(path.join(source, "coord/scripts/gamma.js"), 0o750);
    fs.chmodSync(path.join(target, "coord/scripts/alpha.js"), 0o640);
    fs.chmodSync(path.join(target, "coord/scripts/beta.js"), 0o644);

    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.modeChanged, 1, "unchanged beta bytes still require a mode action");
    assert.strictEqual(fs.statSync(path.join(target, "coord/scripts/alpha.js")).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(path.join(target, "coord/scripts/beta.js")).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(path.join(target, "coord/scripts/gamma.js")).mode & 0o777, 0o750);
  } finally {
    cleanup(tmp);
  }
});

// COORD-938: a mode-only difference that is only the group-write bit is a
// umask artifact under a group-writable umask. The upgrade plan must name the
// umask and the remedy there; under umask 0022 the same fixture gets no note.
test("COORD-938: an upgrade mode change explained by a group-writable umask names the umask and remedy", { skip: process.platform === "win32" }, () => {
  const planUnder = (umask) => {
    const { tmp, source, target } = makeFixture();
    const logs = [];
    const previous = process.umask(umask);
    try {
      fs.chmodSync(path.join(source, "coord/scripts/beta.js"), 0o644);
      fs.chmodSync(path.join(target, "coord/scripts/beta.js"), 0o664);
      const result = createCoordUpgrade({ log: (line) => logs.push(String(line)), cwd: () => tmp })
        .run(["--from", source, "--dir", target, "--dry-run"]);
      assert.strictEqual(result.code, 0);
      return logs.join("\n");
    } finally {
      process.umask(previous);
      cleanup(tmp);
    }
  };
  if (process.platform === "win32") return;
  const underGroupWritable = planUnder(0o002);
  assert.match(underGroupWritable, /mode       coord\/scripts\/beta\.js/);
  assert.match(underGroupWritable, /group-writable umask 0002 explains this mode difference/);
  assert.match(underGroupWritable, /Remedy: run under `umask 0022`/);
  const underStandard = planUnder(0o022);
  assert.doesNotMatch(underStandard, /group-writable umask/);
});

// v0.1.16 -> current upgrades add whole new directories (coord/engine/**). The
// planner used to resolve every add under a missing directory to that first
// missing ancestor, so all of them were written onto one FILE at coord/<newdir>
// and independent verification then rolled the upgrade back.
test("adds into directories the target lacks land at their real paths with traversable dirs", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const added = { "coord/newdir/a.js": "module.exports = 'a';\n", "coord/newdir/sub/b.js": "module.exports = 'b';\n" };
    const tracked = ["coord/scripts/alpha.js", "coord/scripts/beta.js", "coord/scripts/gamma.js", ...Object.keys(added)];
    const contents = { "coord/scripts/alpha.js": read(source, "coord/scripts/alpha.js"),
      "coord/scripts/beta.js": read(source, "coord/scripts/beta.js"), "coord/scripts/gamma.js": read(source, "coord/scripts/gamma.js"), ...added };
    writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", tracked, contents));
    for (const [rel, content] of Object.entries(added)) writeFile(source, rel, content);
    assert.equal(fs.existsSync(path.join(target, "coord/newdir")), false);

    const cmd = createCoordUpgrade({ log: () => {}, cwd: () => tmp });
    const targets = cmd.plan(source, target).actions.filter((a) => a.rel in added).map((a) => [a.action, path.relative(target, a.tgtAbs)]);
    assert.deepEqual(targets, [["add", "coord/newdir/a.js"], ["add", "coord/newdir/sub/b.js"]]);

    const result = cmd.run(["--from", source, "--dir", target, "--json"]);
    assert.strictEqual(result.code, 0, JSON.stringify(result));
    for (const [rel, content] of Object.entries(added)) assert.strictEqual(read(target, rel), content);
    for (const dir of ["coord/newdir", "coord/newdir/sub"]) {
      const stat = fs.lstatSync(path.join(target, dir));
      assert.ok(stat.isDirectory(), `${dir} must be a directory`);
      if (process.platform !== "win32") assert.strictEqual(stat.mode & 0o777, 0o755 & ~process.umask(), `${dir} mode`);
    }
    const check = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--check", "--dir", target]);
    assert.strictEqual(check.code, 0, "the upgraded surface verifies clean");
  } finally {
    cleanup(tmp);
  }
});

// COORD-961 (must_still_cover of upgrade-bridge: the v0.1.16 apply rollback,
// COORD-885/COORD-886): a new-directory upgrade whose post-write verification
// fails must roll back to the exact pre-upgrade bytes and remove the files it
// added under the new directories. In-suite replacement for the archived v0.1.16
// bridge rollback fixture while the guard is kept.
test("COORD-961: a new-directory upgrade whose post-write verification fails rolls back to the pre-upgrade bytes", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const added = { "coord/newdir/a.js": "module.exports = 'a';\n", "coord/newdir/sub/b.js": "module.exports = 'b';\n" };
    const tracked = ["coord/scripts/alpha.js", "coord/scripts/beta.js", "coord/scripts/gamma.js", ...Object.keys(added)];
    const contents = { "coord/scripts/alpha.js": read(source, "coord/scripts/alpha.js"),
      "coord/scripts/beta.js": read(source, "coord/scripts/beta.js"), "coord/scripts/gamma.js": read(source, "coord/scripts/gamma.js"), ...added };
    writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", tracked, contents));
    for (const [rel, content] of Object.entries(added)) writeFile(source, rel, content);
    const before = treeState(target);
    const corruptTarget = path.join(target, "coord/newdir/sub/b.js");
    let corruptNextWrite = true;
    const corruptingFs = Object.create(fs);
    corruptingFs.renameSync = (from, to) => {
      if (corruptNextWrite && to === corruptTarget) {
        corruptNextWrite = false;
        fs.writeFileSync(from, fs.readFileSync(from).subarray(0, 4));
      }
      return fs.renameSync(from, to);
    };
    const cap = capture();
    const result = createCoordUpgrade({ fs: corruptingFs, log: cap.log, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.error, "independent target verification failed");
    // The rollback receipt under coord/.runtime is the audit record of the rollback itself; every other byte must match.
    const withoutRuntime = (state) => Object.fromEntries(Object.entries(state).filter(([rel]) => !rel.startsWith("coord/.runtime/")));
    assert.deepStrictEqual(withoutRuntime(treeState(target)), withoutRuntime(before), "the target is byte-identical to before the apply");
    assert.ok(!fs.existsSync(path.join(target, "coord/newdir/a.js")), "the added file under the new directory is removed");
    assert.ok(!fs.existsSync(path.join(target, "coord/newdir/sub/b.js")), "the nested added file is removed");
    assert.ok(!fs.existsSync(path.join(target, "coord/engine-pin.json")), "nothing was pinned");
  } finally {
    cleanup(tmp);
  }
});

// A surface can verify byte-for-byte against its manifest and still be dead: the
// v0.1.16 coord/paths.js had no resolveEngineModule, so every shim and the CLI
// entry threw. The post-apply probe loads the resolver, the CLI entry and the
// shim registry in a fresh process and rolls the upgrade back when they fail.
test("post-apply load smoke check rolls back a workspace whose CLI entry cannot load", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord-upgrade-smoke-"));
  try {
    const goodPaths = "module.exports = { resolveEngineModule() {}, verifyShimRegistry: () => [] };\n";
    for (const [name, pathsSource, cliSource, expectedCode] of [
      ["dead", "module.exports = {};\n", "require('../paths.js').resolveEngineModule();\n", 1],
      ["missing-dependency", goodPaths, "require('../project-owned-state.js');\n", 1],
      ["healthy", goodPaths, "module.exports = { main() {} };\n", 0],
    ]) {
      const source = path.join(tmp, name, "source");
      const target = path.join(tmp, name, "target");
      const contents = { "coord/paths.js": pathsSource, "coord/scripts/coord-cli.js": cliSource };
      writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", Object.keys(contents), contents));
      for (const [rel, content] of Object.entries(contents)) writeFile(source, rel, content);
      writeFile(target, "coord/project.config.js", "module.exports = { repos: {} };\n");
      const cap = capture();
      const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run(["--from", source, "--dir", target, "--json"]);
      assert.strictEqual(result.code, expectedCode, `${name}: ${cap.text()}`);
      if (expectedCode === 0) continue;
      const report = JSON.parse(cap.text());
      assert.equal(report.verdict, "rolled-back", name);
      assert.equal(report.error, "upgraded workspace failed the load smoke check", name);
      assert.match(report.problems[0].error, /workspace does not load after apply: .*(resolveEngineModule|project-owned-state)/, name);
      for (const rel of Object.keys(contents)) assert.equal(fs.existsSync(path.join(target, rel)), false, `${name}: ${rel} rolled back`);
    }
  } finally {
    cleanup(tmp);
  }
});

test("mode verification failure rolls bytes and prior modes back exactly", { skip: process.platform === "win32" }, () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alphaPath = path.join(target, "coord/scripts/alpha.js");
    const betaPath = path.join(target, "coord/scripts/beta.js");
    const alphaBefore = fs.readFileSync(alphaPath);
    fs.chmodSync(alphaPath, 0o640);
    fs.chmodSync(betaPath, 0o600);
    fs.chmodSync(path.join(source, "coord/scripts/alpha.js"), 0o755);
    fs.chmodSync(path.join(source, "coord/scripts/beta.js"), 0o755);
    let corruptOnce = true;
    const result = createCoordUpgrade({
      log: () => {},
      cwd: () => tmp,
      checkpoint: (name) => {
        if (corruptOnce && name === "after-write:coord/scripts/alpha.js") {
          corruptOnce = false;
          fs.chmodSync(alphaPath, 0o644);
        }
      },
    }).run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.error, "independent target verification failed");
    assert.deepStrictEqual(fs.readFileSync(alphaPath), alphaBefore);
    assert.strictEqual(fs.statSync(alphaPath).mode & 0o777, 0o640);
    assert.strictEqual(fs.statSync(betaPath).mode & 0o777, 0o600);
  } finally {
    cleanup(tmp);
  }
});

test("retired exact-match engine files are removed and listed in the success receipt", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const tracked = ["coord/scripts/alpha.js", "coord/scripts/gamma.js"];
    const contents = Object.fromEntries(tracked.map((rel) => [rel, read(source, rel)]));
    writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v3", tracked, contents));
    // Another exact file retired in the same upgrade was already absent.
    const targetManifest = JSON.parse(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"));
    targetManifest.items.push({
      path: "coord/scripts/already-absent.js",
      match_policy: "exact",
      checksum: checksum("historical contents"),
    });
    writeFile(target, "coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify(targetManifest));
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.removed, 1);
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/beta.js")));
    assert.strictEqual(read(target, "coord/project.config.js"), "module.exports = { repos: {} }; // LOCAL\n");
    const receiptDir = path.join(target, "coord/.runtime/upgrade-receipts");
    const success = fs.readdirSync(receiptDir)
      .map((name) => JSON.parse(fs.readFileSync(path.join(receiptDir, name), "utf8")))
      .find((receipt) => receipt.outcome === "success");
    assert.deepStrictEqual(success.removed, ["coord/scripts/beta.js"]);
  } finally {
    cleanup(tmp);
  }
});

test("developer-modified retired file is refused before any mutation", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const tracked = ["coord/scripts/alpha.js", "coord/scripts/gamma.js"];
    const contents = Object.fromEntries(tracked.map((rel) => [rel, read(source, rel)]));
    writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v3", tracked, contents));
    writeFile(target, "coord/scripts/beta.js", "developer-owned change\n");
    const alphaBefore = read(target, "coord/scripts/alpha.js");
    const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.error, "retired engine file modified");
    assert.deepStrictEqual(result.conflicts, ["coord/scripts/beta.js"]);
    assert.strictEqual(read(target, "coord/scripts/beta.js"), "developer-owned change\n");
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), alphaBefore);
    assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore);
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")));
  } finally {
    cleanup(tmp);
  }
});

// COORD-884: COORD-587 made coord/engine/gates/* canonical but kept byte-identical
// copies at coord/gates/* that no manifest tracks. Upgrading the engine copy alone
// left a divergent pair that resolveEngineModule refuses as a collision.
function makeLegacyMirrorFixture(legacyContent) {
  const fixture = makeFixture();
  const engineRel = "coord/engine/gates/affected-targets.json";
  const legacyRel = "coord/gates/affected-targets.json";
  const oldMap = '{"version":1,"targets":["coord/scripts/alpha.js"]}\n';
  const newMap = '{"version":1,"targets":["coord/engine/scripts/alpha.js"]}\n';
  const tracked = [...fixture.tracked, engineRel];
  writeFile(fixture.source, engineRel, newMap);
  writeFile(fixture.source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", tracked, {
    ...Object.fromEntries(fixture.tracked.map((rel) => [rel, read(fixture.source, rel)])),
    [engineRel]: newMap,
  }));
  writeFile(fixture.target, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v1", tracked, {
    "coord/scripts/alpha.js": "module.exports = 1; // v1\n",
    "coord/scripts/beta.js": "module.exports = 'beta';\n",
    "coord/scripts/gamma.js": "",
    [engineRel]: oldMap,
  }));
  writeFile(fixture.target, engineRel, oldMap);
  writeFile(fixture.target, legacyRel, legacyContent === undefined ? oldMap : legacyContent);
  return { ...fixture, engineRel, legacyRel, oldMap, newMap };
}

test("COORD-884: a pristine untracked legacy copy follows its engine copy so the resolver sees no collision", () => {
  const { tmp, source, target, engineRel, legacyRel, newMap } = makeLegacyMirrorFixture();
  try {
    const dry = capture();
    const planned = createCoordUpgrade({ log: dry.log, cwd: () => tmp }).run(["--from", source, "--dir", target, "--dry-run"]);
    assert.strictEqual(planned.code, 0, dry.text());
    assert.match(dry.text(), new RegExp(`update {5}${legacyRel} {2}\\(pristine legacy copy follows ${engineRel}\\)`));
    assert.strictEqual(read(target, legacyRel), read(target, engineRel), "dry run writes nothing");

    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0, JSON.stringify(result));
    assert.strictEqual(read(target, engineRel), newMap);
    assert.strictEqual(read(target, legacyRel), newMap);
    assert.strictEqual(resolveEngineModule(path.join(target, "coord"), "gates/affected-targets.json"),
      path.join(target, "coord", "engine", "gates", "affected-targets.json"));

    const again = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(again.code, 0, "a legacy copy already matching the engine copy needs no action");
    assert.strictEqual(read(target, legacyRel), newMap);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-884: on win32 a pristine legacy copy follows its engine copy without a POSIX mode expectation", () => {
  const { tmp, source, target, engineRel, legacyRel, newMap } = makeLegacyMirrorFixture();
  try {
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp, platform: "win32" })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0, JSON.stringify(result));
    assert.strictEqual(read(target, engineRel), newMap);
    assert.strictEqual(read(target, legacyRel), newMap);
    assert.strictEqual(result.modeChanged, 0);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-884: an adopter-modified untracked legacy copy is reported and nothing is mutated", () => {
  const edited = '{"version":1,"targets":["adopter-owned"]}\n';
  const { tmp, source, target, engineRel, legacyRel, oldMap } = makeLegacyMirrorFixture(edited);
  try {
    const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.error, "retired engine file modified");
    assert.deepStrictEqual(result.conflicts, [legacyRel]);
    assert.match(cap.text(), new RegExp(`CONFLICT {3}${legacyRel} {2}\\(locally modified legacy copy of ${engineRel}`));
    assert.strictEqual(read(target, legacyRel), edited, "an adopter edit is never overwritten");
    assert.strictEqual(read(target, engineRel), oldMap);
    assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore);
  } finally {
    cleanup(tmp);
  }
});

test("COORD-884: a manifest-tracked or absent legacy path is left to the existing surface handling", () => {
  const { tmp, source, target, legacyRel } = makeLegacyMirrorFixture();
  try {
    fs.rmSync(path.join(target, legacyRel));
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0, JSON.stringify(result));
    assert.ok(!fs.existsSync(path.join(target, legacyRel)), "an absent legacy copy is not created");
  } finally {
    cleanup(tmp);
  }
  const tracked = makeLegacyMirrorFixture();
  try {
    const oldItems = [...tracked.tracked, tracked.engineRel, tracked.legacyRel];
    writeFile(tracked.target, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v1", oldItems, {
      "coord/scripts/alpha.js": "module.exports = 1; // v1\n",
      "coord/scripts/beta.js": "module.exports = 'beta';\n",
      "coord/scripts/gamma.js": "",
      [tracked.engineRel]: tracked.oldMap,
      [tracked.legacyRel]: tracked.oldMap,
    }));
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tracked.tmp })
      .run(["--from", tracked.source, "--dir", tracked.target]);
    assert.strictEqual(result.code, 0, JSON.stringify(result));
    assert.strictEqual(result.removed, 1, "a legacy copy the old manifest tracked is retired, not mirrored");
    assert.ok(!fs.existsSync(path.join(tracked.target, tracked.legacyRel)));
  } finally {
    cleanup(tracked.tmp);
  }
});

// The legacy-copy set is the explicit COORD-587 list, never "any untracked
// coord/<x> beside a tracked coord/engine/<x>": coord/README.md and a legacy
// script path are unrelated files, so a self-upgrade must stay a no-op.
test("COORD-884: an untracked coord/<x> beside an unrelated coord/engine/<x> is never a legacy copy", () => {
  const { tmp, source, target, tracked, engineRel, newMap } = makeLegacyMirrorFixture();
  try {
    const namesakes = { "coord/engine/README.md": "# engine v2\n", "coord/engine/scripts/delta.js": "module.exports = 'd2';\n" };
    const items = [...tracked, engineRel, ...Object.keys(namesakes)];
    const contents = { ...Object.fromEntries(tracked.map((rel) => [rel, read(source, rel)])), [engineRel]: newMap, ...namesakes };
    for (const root of [source, target]) {
      for (const rel of items) writeFile(root, rel, contents[rel]);
      writeFile(root, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", items, contents));
    }
    writeFile(target, "coord/gates/affected-targets.json", newMap);
    writeFile(target, "coord/README.md", "# workspace readme\n");
    writeFile(target, "coord/scripts/delta.js", "require('../engine/scripts/delta.js');\n");
    const repin = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.deepStrictEqual([repin.code, repin.applied], [0, 0], JSON.stringify(repin));
    const cap = capture();
    const noop = createCoordUpgrade({ log: cap.log, cwd: () => tmp }).run(["--from", source, "--dir", target, "--json"]);
    assert.strictEqual(noop.code, 0, cap.text());
    assert.strictEqual(JSON.parse(cap.text()).verdict, "noop");

    writeFile(source, "coord/engine/README.md", "# engine v3\n");
    writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v3", items, { ...contents, "coord/engine/README.md": "# engine v3\n" }));
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0, JSON.stringify(result));
    assert.strictEqual(read(target, "coord/engine/README.md"), "# engine v3\n");
    assert.strictEqual(read(target, "coord/README.md"), "# workspace readme\n", "an unrelated namesake is never rewritten");
    assert.strictEqual(read(target, "coord/scripts/delta.js"), "require('../engine/scripts/delta.js');\n");
  } finally {
    cleanup(tmp);
  }
});

// A pre-COORD-587 target has no engine copy to compare against, and a target an
// older engine upgraded carries a stale legacy copy beside a newer engine copy.
// Either way a copy matching a shipped legacy version is pristine; the shipped
// list must cover the copy this tree ships today.
test("COORD-884: a shipped legacy copy follows the engine copy even when the target has no engine copy", () => {
  for (const name of ["affected-targets.json", "affected-targets.schema.json", "track-evidence-policy.json"]) {
    const shipped = fs.readFileSync(path.join(COORD_ROOT_DIR, "gates", name), "utf8");
    const { tmp, source, target, tracked } = makeLegacyMirrorFixture();
    try {
      const engineRel = `coord/engine/gates/${name}`;
      const legacyRel = `coord/gates/${name}`;
      const newBytes = `${shipped.trimEnd()}\n\n`;
      const items = [...tracked, engineRel];
      writeFile(source, engineRel, newBytes);
      writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", items, {
        ...Object.fromEntries(tracked.map((rel) => [rel, read(source, rel)])), [engineRel]: newBytes,
      }));
      fs.rmSync(path.join(target, engineRel), { force: true });
      writeFile(target, legacyRel, shipped);
      const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
      assert.strictEqual(result.code, 0, `${name}: ${JSON.stringify(result)}`);
      assert.strictEqual(read(target, engineRel), newBytes);
      assert.strictEqual(read(target, legacyRel), newBytes, `${name}: the shipped legacy copy follows`);
    } finally {
      cleanup(tmp);
    }
  }
  const edited = '{"version":1,"targets":["adopter-owned"]}\n';
  const { tmp, source, target, legacyRel } = makeLegacyMirrorFixture(edited);
  try {
    fs.rmSync(path.join(target, "coord", "engine", "gates", "affected-targets.json"));
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp }).run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.deepStrictEqual(result.conflicts, [legacyRel], "an unshipped copy without an engine copy is an adopter edit");
    assert.strictEqual(read(target, legacyRel), edited);
  } finally {
    cleanup(tmp);
  }
});

test("exact-to-advisory transition relinquishes ownership without deleting the file", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alpha = read(source, "coord/scripts/alpha.js");
    const gamma = read(source, "coord/scripts/gamma.js");
    const advisoryManifest = {
      schema_version: 1,
      manifest_version: "engine-v3",
      items: [
        { path: "coord/scripts/alpha.js", match_policy: "exact", checksum: checksum(alpha) },
        { path: "coord/scripts/beta.js", match_policy: "advisory" },
        { path: "coord/scripts/gamma.js", match_policy: "exact", checksum: checksum(gamma) },
      ],
    };
    writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify(advisoryManifest, null, 2) + "\n");
    const betaBefore = read(target, "coord/scripts/beta.js");
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(read(target, "coord/scripts/beta.js"), betaBefore);
  } finally {
    cleanup(tmp);
  }
});

test("failure after retired-file removal restores its bytes and mode", { skip: process.platform === "win32" }, () => {
  const { tmp, source, target } = makeFixture();
  try {
    const tracked = ["coord/scripts/alpha.js", "coord/scripts/gamma.js"];
    const contents = Object.fromEntries(tracked.map((rel) => [rel, read(source, rel)]));
    writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v3", tracked, contents));
    const betaPath = path.join(target, "coord/scripts/beta.js");
    const betaBefore = fs.readFileSync(betaPath);
    fs.chmodSync(betaPath, 0o750);
    const result = createCoordUpgrade({
      log: () => {},
      cwd: () => tmp,
      checkpoint: (name) => {
        if (name === "after-remove:coord/scripts/beta.js") throw new Error("injected removal failure");
      },
    }).run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 1);
    assert.deepStrictEqual(fs.readFileSync(betaPath), betaBefore);
    assert.strictEqual(fs.statSync(betaPath).mode & 0o777, 0o750);
  } finally {
    cleanup(tmp);
  }
});

test("Windows policy skips executable-bit drift and preserves modes for updated files", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alphaPath = path.join(target, "coord/scripts/alpha.js");
    const betaPath = path.join(target, "coord/scripts/beta.js");
    fs.chmodSync(alphaPath, 0o640);
    fs.chmodSync(betaPath, 0o644);
    fs.chmodSync(path.join(source, "coord/scripts/alpha.js"), 0o755);
    fs.chmodSync(path.join(source, "coord/scripts/beta.js"), 0o755);
    const result = createCoordUpgrade({ log: () => {}, cwd: () => tmp, platform: "win32" })
      .run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.modeChanged, 0);
    assert.strictEqual(fs.statSync(alphaPath).mode & 0o777, 0o640);
    assert.strictEqual(fs.statSync(betaPath).mode & 0o777, 0o644);
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

test("source checksum mismatch is rejected before target mutation", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const before = read(target, "coord/scripts/alpha.js");
    writeFile(source, "coord/scripts/alpha.js", "tampered after manifest generation\n");
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.match(cap.text(), /source checksum mismatch/);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), before);
    assert.ok(!fs.existsSync(path.join(target, "coord/engine-pin.json")));
  } finally {
    cleanup(tmp);
  }
});

// Every file under root as rel -> { bytes (hex), mode }, so a test can assert a
// workspace is byte-identical (contents, modes and the set of paths) to before.
function treeState(root) {
  const state = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      const rel = path.relative(root, abs).split(path.sep).join("/");
      state[rel] = { bytes: fs.readFileSync(abs).toString("hex"), mode: fs.lstatSync(abs).mode & 0o777 };
    }
  };
  walk(root);
  return state;
}

test("COORD-884: a source exact item without a valid sha256 checksum is refused before target mutation", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const before = treeState(target);
    const good = JSON.parse(read(source, "coord/TEMPLATE_SYNC_MANIFEST.json"));
    const valid = good.items.find((item) => item.path === "coord/scripts/alpha.js").checksum;
    const invalid = [
      undefined,
      { ...valid, algo: "sha1" },
      { ...valid, hex: "not-a-sha256" },
      { ...valid, bytes: -1 },
      { ...valid, bytes: "26" },
    ];
    for (const bad of invalid) {
      const broken = JSON.parse(JSON.stringify(good));
      const item = broken.items.find((candidate) => candidate.path === "coord/scripts/alpha.js");
      if (bad === undefined) delete item.checksum; else item.checksum = bad;
      writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify(broken, null, 2) + "\n");
      const cap = capture();
      const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp })
        .run(["--from", source, "--dir", target]);
      const label = JSON.stringify(bad === undefined ? "missing" : bad);
      assert.strictEqual(result.code, 1, label);
      assert.match(cap.text(), /source exact manifest item lacks a valid sha256 checksum: coord\/scripts\/alpha\.js/, label);
      assert.deepStrictEqual(treeState(target), before, `${label}: the target is untouched`);
    }
  } finally {
    cleanup(tmp);
  }
});

test("COORD-884: rollback deletes a file the apply added and leaves the target byte-identical", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const before = treeState(target);
    const gamma = path.join(target, "coord/scripts/gamma.js");
    assert.ok(!fs.existsSync(gamma), "gamma is new to the target, in a directory the target already has");
    const command = createCoordUpgrade({ log: () => {}, cwd: () => tmp });
    const { actions } = command.plan(source, target);
    const add = actions.find((action) => action.rel === "coord/scripts/gamma.js");
    assert.strictEqual(add && add.action, "add");
    assert.strictEqual(add.tgtAbs, gamma);

    const backups = command.applyActions(actions);
    assert.strictEqual(read(target, "coord/scripts/gamma.js"), "module.exports = 'gamma-new';\n", "the apply wrote the added file");
    assert.deepStrictEqual(backups.find((backup) => backup.rel === "coord/scripts/gamma.js"),
      { rel: "coord/scripts/gamma.js", tgtAbs: gamma, existed: false, priorBuf: null, mode: null });
    assert.notDeepStrictEqual(treeState(target), before);

    const recovery = command.rollback(backups);
    assert.deepStrictEqual(recovery, { ok: true, failures: [], restored: backups.length });
    assert.ok(!fs.existsSync(gamma), "rollback removes the file the apply added");
    assert.deepStrictEqual(treeState(target), before, "the target is byte-identical to before the apply");
  } finally {
    cleanup(tmp);
  }
});

test("manifest traversal and case-ambiguous duplicate paths are rejected", () => {
  const command = createCoordUpgrade({ log: () => {} });
  assert.throws(
    () => command.surfacePaths({ items: [{ path: "../outside", match_policy: "exact" }] }),
    /unsafe engine manifest path/
  );
  assert.throws(
    () => command.surfacePaths({ items: [{ path: "../outside", match_policy: "advisory" }] }),
    /unsafe engine manifest path/
  );
  assert.throws(
    () => command.surfacePaths({
      items: [
        { path: "coord/scripts/A.js", match_policy: "exact" },
        { path: "coord/scripts/a.js", match_policy: "exact" },
      ],
    }),
    /duplicate or case-ambiguous/
  );
});

test("target symlink is refused without modifying its destination", { skip: process.platform === "win32" }, () => {
  const { tmp, source, target } = makeFixture();
  try {
    const targetFile = path.join(target, "coord/scripts/alpha.js");
    const victim = path.join(tmp, "victim.txt");
    fs.writeFileSync(victim, "victim-bytes\n");
    fs.rmSync(targetFile);
    fs.symlinkSync(victim, targetFile);
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.match(cap.text(), /target engine path contains a symbolic link/);
    assert.strictEqual(fs.readFileSync(victim, "utf8"), "victim-bytes\n");
  } finally {
    cleanup(tmp);
  }
});

test("source symlink is refused before target mutation", { skip: process.platform === "win32" }, () => {
  const { tmp, source, target } = makeFixture();
  try {
    const sourceFile = path.join(source, "coord/scripts/alpha.js");
    const outside = path.join(tmp, "outside-source.txt");
    fs.writeFileSync(outside, "module.exports = 2; // v2\n");
    fs.rmSync(sourceFile);
    fs.symlinkSync(outside, sourceFile);
    const before = read(target, "coord/scripts/alpha.js");
    const cap = capture();
    const result = createCoordUpgrade({ log: cap.log, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.match(cap.text(), /source engine path contains a symbolic link/);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), before);
  } finally {
    cleanup(tmp);
  }
});

test("independent post-write verification catches corruption and rolls back before pinning", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alphaPath = path.join(target, "coord/scripts/alpha.js");
    const before = fs.readFileSync(alphaPath);
    let corruptNextAlphaWrite = true;
    const corruptingFs = Object.create(fs);
    corruptingFs.renameSync = (from, to) => {
      if (corruptNextAlphaWrite && to === alphaPath) {
        corruptNextAlphaWrite = false;
        const staged = fs.readFileSync(from);
        fs.writeFileSync(from, staged.subarray(0, 8));
      }
      return fs.renameSync(from, to);
    };
    const cap = capture();
    const result = createCoordUpgrade({ fs: corruptingFs, log: cap.log, cwd: () => tmp })
      .run(["--from", source, "--dir", target]);
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.error, "independent target verification failed");
    assert.match(cap.text(), /independent target verification failed/);
    assert.deepStrictEqual(fs.readFileSync(alphaPath), before);
    assert.ok(!fs.existsSync(path.join(target, "coord/engine-pin.json")));
  } finally {
    cleanup(tmp);
  }
});

// COORD-886: verifyTargetAgainstPlan turns a read that throws during the
// post-apply check into a { path, error } problem instead of letting it escape.
// Fail exactly one verification read (armed at the verifying checkpoint, so the
// apply itself reads normally) and prove the problem is reported and the whole
// surface rolls back before anything is pinned.
test("COORD-886: a post-apply verification read that throws is reported with its path and message and rolls back", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alphaPath = path.join(target, "coord/scripts/alpha.js");
    const gammaPath = path.join(target, "coord/scripts/gamma.js");
    const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    const alphaBefore = fs.readFileSync(alphaPath);
    const betaBefore = fs.readFileSync(path.join(target, "coord/scripts/beta.js"));
    const message = "EIO: simulated read failure during post-apply verification";
    let armed = false;
    let thrown = 0;
    const failingFs = Object.create(fs);
    failingFs.readFileSync = (file, ...rest) => {
      if (armed && path.resolve(String(file)) === alphaPath) {
        armed = false;
        thrown += 1;
        throw Object.assign(new Error(message), { code: "EIO" });
      }
      return fs.readFileSync(file, ...rest);
    };
    const cap = capture();
    const result = createCoordUpgrade({
      fs: failingFs,
      log: cap.log,
      cwd: () => tmp,
      checkpoint: (name) => {
        if (name === "after-transaction-verifying") {
          // The apply really happened: alpha holds the new bytes before the check.
          assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 2; // v2\n");
          armed = true;
        }
      },
    }).run(["--from", source, "--dir", target, "--json"]);

    assert.strictEqual(thrown, 1, "exactly one verification read failed");
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.error, "independent target verification failed");
    const report = JSON.parse(cap.text());
    assert.strictEqual(report.verdict, "rolled-back");
    assert.strictEqual(report.error, "independent target verification failed");
    assert.deepStrictEqual(report.problems, [{ path: "coord/scripts/alpha.js", error: message }]);
    assert.deepStrictEqual(report.rollback_failures, []);
    assert.ok(report.rolled_back > 0, "managed paths were restored");
    assert.strictEqual(result.rolledBack, report.rolled_back);
    // Rolled back to the exact pre-upgrade state, and nothing was pinned.
    assert.deepStrictEqual(fs.readFileSync(alphaPath), alphaBefore);
    assert.deepStrictEqual(fs.readFileSync(path.join(target, "coord/scripts/beta.js")), betaBefore);
    assert.ok(!fs.existsSync(gammaPath), "the added file is removed");
    assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore);
    assert.ok(!fs.existsSync(path.join(target, "coord/engine-pin.json")));
  } finally {
    cleanup(tmp);
  }
});

test("write-time failure restores the full surface and records a redacted rollback receipt", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alphaBefore = read(target, "coord/scripts/alpha.js");
    const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    const result = createCoordUpgrade({
      log: () => {},
      cwd: () => tmp,
      checkpoint: (name) => {
        if (name === "after-write:coord/scripts/alpha.js") throw new Error(`injected write interruption at ${target}`);
      },
    }).run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 1);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), alphaBefore);
    assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore);
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")));
    assert.deepStrictEqual(
      fs.readdirSync(path.join(target, "coord/.runtime/upgrade-transactions")),
      [],
      "completed rollback must remove durable backup state"
    );
    const receiptsDir = path.join(target, "coord/.runtime/upgrade-receipts");
    const receipts = fs.readdirSync(receiptsDir);
    assert.strictEqual(receipts.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptsDir, receipts[0]), "utf8"));
    assert.strictEqual(receipt.outcome, "rolled-back");
    assert.match(receipt.original_error, /injected write interruption at \[REDACTED\]/);
    assert.ok(!receipt.original_error.includes(target));
    assert.strictEqual(fs.statSync(path.join(receiptsDir, receipts[0])).mode & 0o777, 0o600);
  } finally {
    cleanup(tmp);
  }
});

test("post-pin failure restores the prior integrity and upstream pins byte-for-byte", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const oldIntegrityPin = "{\"old_integrity\":true}\n";
    const oldUpstreamPin = "{\"old_upstream\":true}\n";
    writeFile(target, "coord/engine-pin.json", oldIntegrityPin);
    writeFile(target, "coord/.coord-engine.json", oldUpstreamPin);
    const alphaBefore = read(target, "coord/scripts/alpha.js");
    const result = createCoordUpgrade({
      log: () => {},
      cwd: () => tmp,
      checkpoint: (name) => {
        if (name === "after-integrity-pin") throw new Error("injected post-pin failure");
      },
    }).run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 1);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), alphaBefore);
    assert.strictEqual(read(target, "coord/engine-pin.json"), oldIntegrityPin);
    assert.strictEqual(read(target, "coord/.coord-engine.json"), oldUpstreamPin);
  } finally {
    cleanup(tmp);
  }
});

test("every apply mutation boundary restores exact pre-state and redacts entitlement material", async (t) => {
  const boundaries = [
    "after-transaction-prepared",
    "after-transaction-applying",
    "after-write:coord/TEMPLATE_SYNC_MANIFEST.json",
    "after-write:coord/scripts/alpha.js",
    "after-write:coord/scripts/gamma.js",
    "after-transaction-verifying",
    "after-independent-verification",
    "after-integrity-pin",
    "after-transaction-committing",
    "after-upstream-pin",
    "after-success-receipt",
  ];
  for (const boundary of boundaries) {
    await t.test(boundary, () => {
      const { tmp, source, target } = makeFixture();
      try {
        const secret = "tok-507-secret";
        const oldIntegrityPin = "{\"old_integrity\":true}\n";
        const oldUpstreamPin = "{\"old_upstream\":true}\n";
        writeFile(target, "coord/engine-pin.json", oldIntegrityPin);
        writeFile(target, "coord/.coord-engine.json", oldUpstreamPin);
        const alphaBefore = read(target, "coord/scripts/alpha.js");
        const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
        const cap = capture();
        const result = createCoordUpgrade({
          log: cap.log,
          cwd: () => tmp,
          checkpoint: (name) => {
            if (name === boundary) throw new Error(`injected ${secret} at ${boundary}`);
          },
        }).run([
          "--from", source, "--dir", target,
          "--channel", "enterprise", "--entitlement", secret,
        ]);

        assert.strictEqual(result.code, 1);
        assert.strictEqual(read(target, "coord/scripts/alpha.js"), alphaBefore);
        assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore);
        assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")));
        assert.strictEqual(read(target, "coord/engine-pin.json"), oldIntegrityPin);
        assert.strictEqual(read(target, "coord/.coord-engine.json"), oldUpstreamPin);
        assert.ok(!cap.text().includes(secret));
        assert.ok(!JSON.stringify(result).includes(secret));
        const transactionRoot = path.join(target, "coord/.runtime/upgrade-transactions");
        if (fs.existsSync(transactionRoot)) assert.deepStrictEqual(fs.readdirSync(transactionRoot), []);
        const runtime = path.join(target, "coord/.runtime");
        if (fs.existsSync(runtime)) {
          const json = fs.readdirSync(runtime, { recursive: true })
            .filter((name) => String(name).endsWith(".json"))
            .map((name) => fs.readFileSync(path.join(runtime, name), "utf8"))
            .join("\n");
          assert.ok(!json.includes(secret));
        }
      } finally {
        cleanup(tmp);
      }
    });
  }
});

test("rollback attempts every path and retains the journal when one restore fails", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alphaPath = path.join(target, "coord/scripts/alpha.js");
    const alphaBefore = fs.readFileSync(alphaPath);
    const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    let failRestore = false;
    const failingFs = Object.create(fs);
    failingFs.renameSync = (from, to) => {
      if (failRestore && to === alphaPath && fs.readFileSync(from).equals(alphaBefore)) {
        throw new Error("injected alpha restore failure");
      }
      return fs.renameSync(from, to);
    };
    const result = createCoordUpgrade({
      fs: failingFs,
      log: () => {},
      cwd: () => tmp,
      checkpoint: (name) => {
        if (name === "after-independent-verification") {
          failRestore = true;
          throw new Error("injected apply failure");
        }
      },
    }).run(["--from", source, "--dir", target]);

    assert.strictEqual(result.code, 1);
    assert.ok(result.rollbackFailures.some((failure) => failure.path === "coord/scripts/alpha.js"));
    assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore);
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")), "other paths must still restore");
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 2; // v2\n");
    const txDirs = fs.readdirSync(path.join(target, "coord/.runtime/upgrade-transactions"));
    assert.strictEqual(txDirs.length, 1, "failed recovery must retain its durable backups");
    const journal = JSON.parse(read(target, `coord/.runtime/upgrade-transactions/${txDirs[0]}/transaction.json`));
    assert.strictEqual(journal.status, "incomplete-recovery");
    assert.ok(journal.rollback_failures.some((failure) => failure.path === "coord/scripts/alpha.js"));
  } finally {
    cleanup(tmp);
  }
});

test("SIGKILL leaves a detectable transaction that the next run can recover", { skip: process.platform === "win32" }, () => {
  const { tmp, source, target } = makeFixture();
  try {
    const alphaBefore = read(target, "coord/scripts/alpha.js");
    const manifestBefore = read(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
    const modulePath = path.resolve(__dirname, "coord-upgrade.js");
    const script = [
      "const create = require(process.argv[1]);",
      "const command = create({ log: () => {}, checkpoint(name) {",
      "  if (name === 'after-write:coord/scripts/alpha.js') process.kill(process.pid, 'SIGKILL');",
      "} });",
      "command.run(['--from', process.argv[2], '--dir', process.argv[3]]);",
    ].join("\n");
    const child = spawnSync(process.execPath, ["-e", script, modulePath, source, target]);
    assert.strictEqual(child.signal, "SIGKILL");
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 2; // v2\n");

    const cap = capture();
    const command = createCoordUpgrade({ log: cap.log });
    const check = command.run(["--check", "--dir", target]);
    assert.strictEqual(check.code, 1);
    assert.match(check.error, /incomplete upgrade transaction/);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), "module.exports = 2; // v2\n", "check must be read-only");

    const interrupted = treeState(target);
    const pending = command.pendingTransactionDirs(target);
    const dryRun = command.run(["--from", source, "--dir", target, "--dry-run"]);
    assert.equal(dryRun.code, 1);
    assert.match(dryRun.error, /dry-run refused while interrupted upgrade transaction/);
    assert.deepStrictEqual(dryRun.pendingTransactions, pending.map((dir) => path.basename(dir)));
    // Dry-run may recover the dead lock and record that recovery receipt.
    const lock = path.relative(target, command.upgradeLockPath(target)).split(path.sep).join("/") + "/";
    const transactionState = (state) => Object.fromEntries(Object.entries(state)
      .filter(([file]) => !file.startsWith(lock) && !file.startsWith("coord/.runtime/upgrade-receipts/lock-recovery-")));
    assert.deepStrictEqual(transactionState(treeState(target)), transactionState(interrupted));

    const recoveryRun = createCoordUpgrade({
      log: cap.log,
      checkpoint: (name) => {
        if (name === "after-interrupted-recovery") throw new Error("stop after recovery proof");
      },
    }).run(["--from", source, "--dir", target]);
    assert.strictEqual(recoveryRun.code, 1);
    assert.strictEqual(recoveryRun.error, "stop after recovery proof");
    assert.match(cap.text(), /recovered 1 interrupted transaction/);
    assert.strictEqual(read(target, "coord/scripts/alpha.js"), alphaBefore);
    assert.strictEqual(read(target, "coord/TEMPLATE_SYNC_MANIFEST.json"), manifestBefore);
    assert.ok(!fs.existsSync(path.join(target, "coord/scripts/gamma.js")));
    assert.deepStrictEqual(command.pendingTransactionDirs(target), []);
    const receipts = fs.readdirSync(path.join(target, "coord/.runtime/upgrade-receipts"));
    assert.ok(receipts.some((name) => name.startsWith("rolled-back-")));
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
      .run(["--from", source, "--dir", target, "--channel", "enterprise", "--entitlement", "tok",
        "--ref", "refs/tags/v2", "--sha", "2".repeat(40)]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.applied, 0);
    const pin = readPin(target);
    assert.strictEqual(pin.source.channel, "enterprise");
    assert.strictEqual(pin.source.ref, "refs/tags/v2");
    assert.strictEqual(pin.source.sha, "2".repeat(40));
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

// ---------------------------------------------------------------------------
// COORD-624: upgrades operate ONLY on the workspace governance surface. Concord
// is a SIBLING of the product repositories it governs, and those repositories
// are read-only for every install / upgrade / recovery path. This is a
// STRUCTURAL confinement: a manifest path outside coord/ or .claude/ is
// rejected before it is ever resolved to an absolute location, so no runtime
// barrier is needed to keep an upgrade out of a product repo.
// ---------------------------------------------------------------------------

test("COORD-624: an engine manifest path outside the workspace governance surface is refused", () => {
  const upgrade = createCoordUpgrade({});
  const validate = upgrade.validateManagedRelPath;
  // Allowed: the workspace governance surface.
  assert.equal(validate("coord/scripts/governance.js"), "coord/scripts/governance.js");
  assert.equal(validate(".claude/settings.json"), ".claude/settings.json");
  // RED: anything that could reach a sibling product repository.
  for (const rel of ["backend/src/app.js", "frontend/package.json", "repo-one/AGENTS.md", "package.json", "AGENTS.md"]) {
    assert.throws(
      () => validate(rel),
      /outside the workspace governance surface[\s\S]*Product repositories are\n?\s*read-only/,
      `${rel} must be refused`,
    );
  }
});

test("upgrade accepts equals-form options and refuses a malformed source manifest without target writes", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const before = treeState(target);
    const withoutTarget = createCoordUpgrade({ cwd: () => tmp, log: () => {} });
    const omitted = createCoordUpgrade({ cwd: () => tmp, log: () => {} });
    assert.deepEqual(withoutTarget.run(["--dir=", "--help"]), omitted.run(["--help"]));
    assert.deepStrictEqual(treeState(target), before);
    for (const [input, expected] of [
      ["{broken", /engine manifest is not valid JSON/],
      ["{}", /engine manifest items must be an array/],
      ['{"items":null}', /engine manifest items must be an array/],
      ['{"items":{}}', /engine manifest items must be an array/],
    ]) {
      writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", input);
      const cap = capture();
      const command = createCoordUpgrade({ cwd: () => tmp, log: cap.log });
      const result = command.run([`--from=${source}`, `--dir=${target}`, "--json"]);
      assert.equal(result.code, 1);
      assert.match(result.error, expected);
      assert.deepStrictEqual(JSON.parse(cap.text()), { verdict: "fail", error: result.error });
      assert.deepStrictEqual(treeState(target), before);
    }
  } finally {
    cleanup(tmp);
  }
});

test("upgrade refuses a case-only manifest transition before writing", () => {
  const { tmp, source, target, tracked } = makeFixture();
  try {
    const oldPath = "coord/scripts/alpha.js";
    const newPath = "coord/scripts/Alpha.js";
    fs.renameSync(path.join(source, oldPath), path.join(source, newPath));
    const sourcePaths = tracked.map((rel) => rel === oldPath ? newPath : rel);
    const contents = Object.fromEntries(sourcePaths.map((rel) => [rel, read(source, rel)]));
    writeFile(source, "coord/TEMPLATE_SYNC_MANIFEST.json", manifest("engine-v2", sourcePaths, contents));
    const before = treeState(target);

    const result = createCoordUpgrade({ log: () => {} }).run(["--from", source, "--dir", target]);
    assert.equal(result.code, 1);
    assert.equal(result.error, `case-ambiguous engine manifest transition: ${oldPath} -> ${newPath}`);
    assert.deepStrictEqual(treeState(target), before);
  } finally {
    cleanup(tmp);
  }
});

test("upgrade refuses a source file removed during planning", () => {
  const { tmp, source, target } = makeFixture();
  try {
    const sourceFile = path.join(source, "coord/scripts/alpha.js");
    const targetFile = path.join(target, "coord/scripts/alpha.js");
    const before = treeState(target);
    const cap = capture();
    const command = createCoordUpgrade({
      log: cap.log,
      fs: {
        ...fs,
        lstatSync(file, ...options) {
          const stat = fs.lstatSync(file, ...options);
          // The source has been inspected when planning inspects the target file.
          if (file === targetFile) fs.unlinkSync(sourceFile);
          return stat;
        },
      },
    });

    const result = command.run(["--from", source, "--dir", target]);
    assert.equal(result.code, 1);
    assert.match(cap.text(), /missing.*coord\/scripts\/alpha\.js/i);
    assert.deepStrictEqual(treeState(target), before);
  } finally {
    cleanup(tmp);
  }
});

test("automatic upgrade refuses corrupt pins and release lookup failures before writing", () => {
  const { tmp, target } = makeFixture();
  try {
    const pinPath = "coord/.coord-engine.json";
    writeFile(target, pinPath, "{broken");
    const cap = capture();
    let releaseLookups = 0;
    const command = createCoordUpgrade({
      log: cap.log,
      releaseSource: {
        resolveLatest() {
          releaseLookups += 1;
          throw new Error("release service unavailable");
        },
      },
    });

    const withCorruptPin = treeState(target);
    const pinFailure = command.run(["--dir", target]);
    assert.equal(pinFailure.code, 1);
    assert.match(pinFailure.error, /engine pin is not valid JSON/);
    assert.equal(releaseLookups, 0);
    assert.deepStrictEqual(treeState(target), withCorruptPin);

    fs.unlinkSync(path.join(target, pinPath));
    const withoutPin = treeState(target);
    const lookupFailure = command.run(["--dir", target]);
    assert.deepStrictEqual(lookupFailure, { code: 1, error: "release service unavailable" });
    assert.match(cap.text(), /unable to resolve latest community release: release service unavailable/);
    assert.equal(releaseLookups, 1);
    assert.deepStrictEqual(treeState(target), withoutPin);
  } finally {
    cleanup(tmp);
  }
});
