"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const bootstrap = require("../concord-bootstrap.js");

function write(root, rel, value) { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function archive(source, output) {
  execFileSync("tar", ["-czf", output, "-C", path.dirname(source), path.basename(source)]);
}
function resolverExec(archiveFile, observed = {}) {
  return (bin, args, options) => {
    if (bin !== "curl") return execFileSync(bin, args, options);
    const configIndex = args.indexOf("--config");
    if (configIndex >= 0) {
      observed.configMode = fs.statSync(args[configIndex + 1]).mode & 0o777;
      observed.configText = fs.readFileSync(args[configIndex + 1], "utf8");
    }
    const outputIndex = args.indexOf("-o");
    if (outputIndex >= 0) {
      observed.downloadStage = path.dirname(args[outputIndex + 1]);
      fs.copyFileSync(archiveFile, args[outputIndex + 1]);
      return Buffer.alloc(0);
    }
    return JSON.stringify({ sha: "a".repeat(40) });
  };
}
function fixture(enterprise = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-bootstrap-test-"));
  const target = path.join(root, "target"), source = path.join(root, "source");
  write(target, "coord/scripts/coord-cli.js", "old");
  write(target, "coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify({ manifest_version: "legacy" }));
  if (enterprise) write(target, "coord/scripts/enterprise/a.js", "enterprise");
  write(target, "coord/scripts/a.js", "old");
  const next = "new";
  write(source, "coord/scripts/a.js", next);
  write(source, "coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify({ items: [{ path: "coord/scripts/a.js", match_policy: "exact", checksum: { hex: require("node:crypto").createHash("sha256").update(next).digest("hex") } }] }));
  return { root, target, source };
}

test("pre-pin edition detection is explicit and no_pin is not called drift", () => {
  const community = fixture(false), enterprise = fixture(true);
  try {
    assert.deepEqual({ channel: bootstrap.detectInstalled(community.target).channel, pin: bootstrap.detectInstalled(community.target).pin_status }, { channel: "community", pin: "unpinned" });
    assert.deepEqual({ channel: bootstrap.detectInstalled(enterprise.target).channel, pin: bootstrap.detectInstalled(enterprise.target).pin_status }, { channel: "enterprise", pin: "unpinned" });
  } finally { fs.rmSync(community.root, { recursive: true, force: true }); fs.rmSync(enterprise.root, { recursive: true, force: true }); }
});

test("pinned edition and installed surface must agree in both directions", () => {
  const community = fixture(false), enterprise = fixture(true);
  try {
    write(community.target, "coord/.coord-engine.json", JSON.stringify({ source: { channel: "enterprise", repo: "https://github.com/Softsensor-org/concord-enterprise" } }));
    write(enterprise.target, "coord/.coord-engine.json", JSON.stringify({ source: { channel: "community", repo: "https://github.com/Softsensor-org/concord" } }));
    assert.throws(() => bootstrap.detectInstalled(community.target), /Enterprise pin without Enterprise surface/);
    assert.throws(() => bootstrap.detectInstalled(enterprise.target), /Community pin with Enterprise surface/);
  } finally { fs.rmSync(community.root, { recursive: true, force: true }); fs.rmSync(enterprise.root, { recursive: true, force: true }); }
});

test("release repositories are bound to the official repo for each channel", () => {
  assert.equal(bootstrap.validateSourceRepo("git@github.com:Softsensor-org/concord.git", "community"), "Softsensor-org/concord");
  assert.throws(() => bootstrap.validateSourceRepo("https://github.com/attacker/concord", "community"), /untrusted community/);
  assert.throws(() => bootstrap.validateSourceRepo("https://github.com/Softsensor-org/concord", "enterprise"), /untrusted enterprise/);
  assert.throws(() => bootstrap.parseRepo("https://notgithub.com/Softsensor-org/concord"), /unsupported/);
});

test("plan binds immutable source and exact target bytes", () => {
  const f = fixture();
  try {
    const installed = bootstrap.detectInstalled(f.target);
    const resolved = { source: f.source, sha: "a".repeat(40), archive_sha256: "b".repeat(64) };
    const first = bootstrap.buildPlan(installed, resolved, "community");
    write(f.target, "coord/scripts/a.js", "locally changed");
    const second = bootstrap.buildPlan(installed, resolved, "community");
    assert.match(first.digest, /^[0-9a-f]{64}$/);
    assert.notEqual(first.digest, second.digest);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("plan/apply delegates to legacy --from only after matching digest", () => {
  const f = fixture();
  const calls = [];
  const resolver = { resolve: () => ({ source: f.source, sha: "a".repeat(40), archive_sha256: "b".repeat(64), cleanup: () => {} }) };
  const exec = (_bin, args) => { calls.push(args); return args.includes("--dry-run") ? "legacy preview" : "ok"; };
  try {
    const planned = bootstrap.runBootstrap(["upgrade", "--target", f.target], { resolver, execFileSync: exec });
    assert.equal(planned.verdict, "plan");
    assert.equal(calls.length, 1);
    assert.throws(() => bootstrap.runBootstrap(["upgrade", "--target", f.target, "--apply-plan", "0".repeat(64)], { resolver, execFileSync: exec }), /digest changed/);
    const applied = bootstrap.runBootstrap(["upgrade", "--target", f.target, "--apply-plan", planned.plan_digest], { resolver, execFileSync: exec });
    assert.equal(applied.verdict, "pass");
    assert.ok(calls.some((args) => args.includes("--from") && !args.includes("--dry-run")));
    const receipt = path.join(f.target, "coord/.runtime/upgrade-receipts", `bootstrap-${planned.plan_digest}.json`);
    assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed independent check reports that apply already occurred", () => {
  const f = fixture();
  const resolver = { resolve: () => ({ source: f.source, sha: "a".repeat(40), archive_sha256: "b".repeat(64), cleanup: () => {} }) };
  const previewExec = (_bin, args) => args.includes("--dry-run") ? "legacy preview" : "ok";
  try {
    const planned = bootstrap.runBootstrap(["upgrade", "--target", f.target], { resolver, execFileSync: previewExec });
    const failingExec = (_bin, args) => {
      if (args.includes("--check")) throw new Error("check failed");
      return args.includes("--dry-run") ? "legacy preview" : "ok";
    };
    assert.throws(
      () => bootstrap.runBootstrap(["upgrade", "--target", f.target, "--apply-plan", planned.plan_digest], { resolver, execFileSync: failingExec }),
      /engine applied but independent post-apply verification failed/
    );
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("edition mismatch and unsafe archives fail closed", () => {
  const f = fixture(true);
  try {
    assert.throws(() => bootstrap.runBootstrap(["upgrade", "--target", f.target, "--channel", "community"], {}), /installed edition is enterprise/);
    assert.throws(() => bootstrap.validateEntries("root/../escape\n"), /unsafe/);
    assert.throws(() => bootstrap.validateLinks("lrwx root/root 0 date root/link -> inside\n"), /links are not permitted/);
    assert.throws(() => bootstrap.validateLinks("? unsupported listing\n"), /unsupported archive entry type/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("real resolver validates tar entries, extracts files, and protects entitlement config", () => {
  const f = fixture();
  const releaseRoot = path.join(f.root, "release-root");
  const archiveFile = path.join(f.root, "release.tar.gz");
  const observed = {};
  write(releaseRoot, "coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify({ items: [] }));
  write(releaseRoot, "coord/scripts/a.js", "safe");
  archive(releaseRoot, archiveFile);
  try {
    const resolver = bootstrap.createResolver({ execFileSync: resolverExec(archiveFile, observed) });
    assert.throws(
      () => resolver.resolve({ repo: "https://github.com/Softsensor-org/concord-enterprise", channel: "enterprise", entitlement: "" }),
      /requires --entitlement/
    );
    const resolved = resolver.resolve({ repo: "https://github.com/Softsensor-org/concord-enterprise", channel: "enterprise", entitlement: "entitlement-value" });
    assert.equal(fs.readFileSync(path.join(resolved.source, "coord/scripts/a.js"), "utf8"), "safe");
    assert.equal(observed.configMode, 0o600);
    assert.match(observed.configText, /Authorization: Bearer entitlement-value/);
    resolved.cleanup();
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("real resolver rejects archive links and removes the failed staging directory", () => {
  const f = fixture();
  const releaseRoot = path.join(f.root, "linked-release");
  const archiveFile = path.join(f.root, "linked-release.tar.gz");
  const observed = {};
  write(releaseRoot, "coord/TEMPLATE_SYNC_MANIFEST.json", JSON.stringify({ items: [] }));
  fs.symlinkSync("coord/TEMPLATE_SYNC_MANIFEST.json", path.join(releaseRoot, "manifest-link"));
  archive(releaseRoot, archiveFile);
  try {
    const resolver = bootstrap.createResolver({ execFileSync: resolverExec(archiveFile, observed) });
    assert.throws(
      () => resolver.resolve({ repo: "https://github.com/Softsensor-org/concord", channel: "community", entitlement: "" }),
      /links are not permitted/
    );
    assert.equal(fs.existsSync(observed.downloadStage), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
