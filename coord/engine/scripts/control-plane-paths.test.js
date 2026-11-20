"use strict";

// COORD-1015: git reports canonical toplevels. A control-plane directory reached through
// a symlinked parent must classify the same as its real path.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
const { resolveControlPlaneLayout, CONTROL_PLANE_TOPOLOGY } = require("./control-plane-paths.js");

const gitTry = (cwd, args) => gitFixtureSpawn(cwd, args);

test("COORD-1015 pin: coord/ that is its own repository, reached through a symlink, is COORD_REPOSITORY", () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cpp-1015-")));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-1015-link-"));
  try {
    const coord = path.join(real, "coord");
    fs.mkdirSync(coord);
    gitFixture(coord, ["init", "-q"]);
    gitFixture(coord, ["commit", "-q", "--allow-empty", "-m", "base"]);
    fs.symlinkSync(coord, path.join(linkParent, "coord"), "dir");
    const layout = resolveControlPlaneLayout({ coordDir: path.join(linkParent, "coord"), gitTry });
    assert.equal(layout.topology, CONTROL_PLANE_TOPOLOGY.COORD_REPOSITORY);
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("COORD-1015 resolveControlPlaneLayout: the donor layout reached through a symlinked workspace is ANCESTOR_REPOSITORY", () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cpp-1015-donor-")));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "cpp-1015-donor-link-"));
  try {
    gitFixture(real, ["init", "-q"]);
    gitFixture(real, ["commit", "-q", "--allow-empty", "-m", "base"]);
    fs.mkdirSync(path.join(real, "coord"));
    const workspaceViaLink = path.join(linkParent, "ws");
    fs.symlinkSync(real, workspaceViaLink, "dir");
    const layout = resolveControlPlaneLayout({
      coordDir: path.join(workspaceViaLink, "coord"),
      workspaceRoot: workspaceViaLink,
      gitTry,
    });
    assert.equal(layout.topology, CONTROL_PLANE_TOPOLOGY.ANCESTOR_REPOSITORY, JSON.stringify(layout.topology));
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("control-plane discovery treats missing Git evidence conservatively and recognizes a direct Git toplevel", (t) => {
  assert.throws(() => resolveControlPlaneLayout(), /requires a coordDir/);
  const coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-layout-fixture-"));
  t.after(() => fs.rmSync(coordDir, { recursive: true, force: true }));
  for (const gitTry of [
    () => { throw new Error("fixture Git unavailable"); },
    () => ({ status: 0 }),
  ]) {
    const layout = resolveControlPlaneLayout({ coordDir, gitTry });
    assert.equal(layout.topology, CONTROL_PLANE_TOPOLOGY.NONE);
    assert.equal(layout.has_control_plane_repository, false);
  }
  const direct = resolveControlPlaneLayout({
    coordDir, gitTry: () => ({ status: 0, stdout: fs.realpathSync(coordDir) + "\n" }),
  });
  assert.equal(direct.topology, CONTROL_PLANE_TOPOLOGY.COORD_REPOSITORY);
  assert.equal(direct.coordRepoRoot, coordDir);
});
