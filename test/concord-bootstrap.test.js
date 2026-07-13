"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bootstrap = require("../concord-bootstrap.js");

function write(root, rel, value) { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
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
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("edition mismatch and unsafe archives fail closed", () => {
  const f = fixture(true);
  try {
    assert.throws(() => bootstrap.runBootstrap(["upgrade", "--target", f.target, "--channel", "community"], {}), /installed edition is enterprise/);
    assert.throws(() => bootstrap.validateEntries("root/../escape\n"), /unsafe/);
    assert.throws(() => bootstrap.validateLinks("lrwx root/root 0 date root/link -> ../../escape\n"), /escapes/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
