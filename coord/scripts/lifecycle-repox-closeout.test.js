const test = require("node:test");
const assert = require("node:assert/strict");

const createLifecycleRepoXCloseout = require("./lifecycle-repox-closeout.js");

// COORD-512: Repo-X closeout must refuse mark-done while the coord-workspace
// ticket branch holds unmerged commits (silent doc-loss: board says done,
// workspace main still has pre-ticket content). These tests drive the factory
// with a stubbed gitTry so branch topology is fully controlled; no real git
// repo is needed. Product-worktree residue behavior (the pre-existing half of
// ensureRepoXCloseoutReady) is stubbed empty except where noted.

const ROOT = "/ws";

// COORD-591 defaults: a clean enginePin stub whose manifest tracks one engine
// file, so pre-COORD-591 tests (no merged engine files, no plan surface) skip
// the integrity gate exactly as a non-engine-facing ticket would.
function makeEnginePinStub({
  manifestOk = true,
  manifestFailures = [],
  pinOk = true,
  pinDrifted = [],
  pinProblems = [],
  engineItems = [{ path: "coord/scripts/lifecycle.js", match_policy: "exact" }],
} = {}) {
  return {
    verifyManifest: () => ({ ok: manifestOk, failures: manifestFailures }),
    verify: () => ({ ok: pinOk, pinned: true, drifted_files: pinDrifted, problems: pinProblems }),
    deriveManifestFingerprint: () => ({ manifest: { items: engineItems } }),
  };
}

function makeFactory({
  branches = [],
  ancestorOf = {},
  listStatus = 0,
  probeError = null,
  residue = [],
  merges = [],
  mergeDiffFiles = {},
  tipShaOf = {},
  planSurface = [],
  enginePin = makeEnginePinStub(),
  // COORD-667 knobs: the in-process workspace merge. Defaults describe the
  // ordinary case — attached HEAD on the integration branch, clean tree, merge
  // succeeds — so every pre-COORD-667 test above is unaffected by their presence.
  headBranch = "main",
  dirtyPaths = [],
  statusStatus = 0,
  incomingFiles = [],
  incomingStatus = 0,
  mergeStatus = 0,
  mergeStderr = "",
  mergeHeadSha = "merge-commit-sha",
  calls = [],
  sideEffects = [],
  // Lets a test apply the real-git consequence of the stubbed merge (the branch
  // becoming an ancestor of HEAD) at the moment the merge is issued.
  onMerge = null,
} = {}) {
  const gitTry = (dir, args) => {
    assert.equal(dir, ROOT);
    calls.push(args.join(" "));
    // --- COORD-667 surface -------------------------------------------------
    if (args[0] === "symbolic-ref") {
      return headBranch === null
        ? { status: 128, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref" }
        : { status: 0, stdout: `${headBranch}\n`, stderr: "" };
    }
    if (args[0] === "status") {
      return {
        status: statusStatus,
        stdout: dirtyPaths.map((p) => ` M ${p}`).join("\n"),
        stderr: statusStatus === 0 ? "" : "status boom",
      };
    }
    if (args[0] === "merge") {
      if (args[1] === "--abort") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (mergeStatus === 0 && typeof onMerge === "function") {
        onMerge();
      }
      return {
        status: mergeStatus,
        stdout: "",
        stderr: mergeStatus === 0 ? "" : (mergeStderr || "CONFLICT (content): Merge conflict"),
      };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { status: 0, stdout: `${mergeHeadSha}\n`, stderr: "" };
    }
    // The three-dot form is the COORD-667 incoming-surface probe; the two-arg
    // form below is the pre-existing COORD-591 merge-attribution diff.
    if (args[0] === "diff" && typeof args[2] === "string" && args[2].includes("...")) {
      return {
        status: incomingStatus,
        stdout: incomingFiles.join("\n"),
        stderr: incomingStatus === 0 ? "" : "diff boom",
      };
    }
    // --- pre-existing surface ----------------------------------------------
    if (args[0] === "for-each-ref") {
      return { status: listStatus, stdout: branches.join("\n"), stderr: listStatus === 0 ? "" : "boom" };
    }
    if (args[0] === "merge-base") {
      const branch = args[2];
      if (probeError === branch) {
        return { status: 128, stdout: "", stderr: `fatal: bad object ${branch}` };
      }
      return { status: ancestorOf[branch] ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      const branch = String(args[2] || "").replace(/\^\{commit\}$/, "");
      const sha = tipShaOf[branch] || `${branch}-tip`;
      return { status: 0, stdout: `${sha}\n`, stderr: "" };
    }
    if (args[0] === "log") {
      return {
        status: 0,
        stdout: merges.map((m) => `${m.sha} ${m.p1} ${m.p2}`).join("\n"),
        stderr: "",
      };
    }
    if (args[0] === "diff") {
      const mergeSha = args[3];
      return { status: 0, stdout: (mergeDiffFiles[mergeSha] || []).join("\n"), stderr: "" };
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
  return createLifecycleRepoXCloseout({
    COORD_DIR: `${ROOT}/coord`,
    REPO_ROOTS: { X: ROOT, B: `${ROOT}/backend` },
    // COORD-635: control-plane git resolves to coordRepoRoot, not ROOT_DIR.
    // The donor topology (coord/ versioned by the enclosing repository) keeps
    // coordRepoRoot === ROOT, so this fixture's expectations are unchanged.
    controlPlaneLayout: () => ({
      workspaceRoot: ROOT,
      coordDir: `${ROOT}/coord`,
      coordRepoRoot: ROOT,
      coordPathPrefix: "coord",
      topology: "ancestor_repository",
    }),
    enginePin,
    getRepoRoot: (code) => (code === "B" ? `${ROOT}/backend` : ROOT),
    gitTry,
    inferTicketIdFromPath: (p) => (p.match(/COORD-\d+/) || [null])[0],
    listGitWorktrees: () => residue,
    readTicketFileSurface: () => planSurface,
    recordExternalSideEffect: (effect) => sideEffects.push(effect),
    repoDisplayNameForCode: (code) => code,
  });
}

// COORD-667: this test used to assert the refusal named `merge --no-ff`, i.e.
// a hand-run git command. That instruction WAS the defect: pre-bash-guard.js
// refuses it under head-on-protected-branch (COORD-664) whenever HEAD is on the
// protected integration branch, which is exactly where a Repo-X closeout runs —
// so the refusal pointed at the one command the operator could never execute
// and no repo-X ticket could land by any sanctioned path. The refusal must now
// name a command GOVERNANCE ITSELF runs.
test("repo-x closeout refuses when the workspace ticket branch is unmerged, naming a governed command", () => {
  const branch = "agent/claudea11-coord-512-landing-integrity";
  const { ensureRepoXCloseoutReady } = makeFactory({ branches: [branch], ancestorOf: {} });
  assert.throws(
    () => ensureRepoXCloseoutReady("COORD-512"),
    (error) => {
      assert.match(error.message, /COORD-512/);
      assert.match(error.message, new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(error.message, /--merge-workspace/);
      assert.match(error.message, /gov (land|finalize)/);
      assert.match(error.message, /COORD-512\)/); // cites the governing ticket
      return true;
    }
  );
});

test("COORD-667: the refusal never instructs a hand-run git merge the pre-bash-guard refuses", () => {
  const branch = "agent/claudea11-coord-512-landing-integrity";
  const { ensureRepoXCloseoutReady } = makeFactory({ branches: [branch], ancestorOf: {} });
  assert.throws(
    () => ensureRepoXCloseoutReady("COORD-512"),
    (error) => {
      // The literal instruction form the guard blocks must not be issued as a
      // directive. Naming it inside the explicit "Do NOT run" warning is fine,
      // so the check is that no `git ... merge --no-ff <branch>` command is
      // presented for the operator to copy.
      assert.doesNotMatch(error.message, /git -C \S+ merge --no-ff/);
      assert.match(error.message, /Do NOT run/);
      assert.match(error.message, /head-on-protected-branch/);
      return true;
    }
  );
});

test("repo-x closeout passes when the ticket branch is an ancestor of workspace HEAD", () => {
  const branch = "agent/claudea11-coord-512-landing-integrity";
  const { ensureRepoXCloseoutReady } = makeFactory({ branches: [branch], ancestorOf: { [branch]: true } });
  assert.equal(ensureRepoXCloseoutReady("COORD-512"), null);
});

test("repo-x closeout passes when no branch matches the ticket (merged-and-deleted or direct-commit)", () => {
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: ["agent/claudea11-coord-999-other-work"],
    ancestorOf: {},
  });
  assert.equal(ensureRepoXCloseoutReady("COORD-512"), null);
});

test("ticket-id matching is exact: COORD-51 does not match a COORD-512 branch and vice versa", () => {
  const branch512 = "agent/claudea11-coord-512-landing-integrity";
  const factory = makeFactory({ branches: [branch512], ancestorOf: {} });
  // COORD-51 must not see the COORD-512 branch.
  assert.equal(factory.ensureRepoXCloseoutReady("COORD-51"), null);
  // COORD-512 still does.
  assert.deepEqual(factory.findUnmergedWorkspaceTicketBranches("COORD-512"), [branch512]);
});

test("matches a branch whose name ends at the ticket id (no trailing slug)", () => {
  const bare = "agent/claudea11-coord-512";
  const { findUnmergedWorkspaceTicketBranches } = makeFactory({ branches: [bare], ancestorOf: {} });
  assert.deepEqual(findUnmergedWorkspaceTicketBranches("COORD-512"), [bare]);
});

test("a hard git error while probing fails closed with the git message, not a silent pass", () => {
  const branch = "agent/claudea11-coord-512-landing-integrity";
  const { ensureRepoXCloseoutReady } = makeFactory({ branches: [branch], probeError: branch });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /could not verify branch .*bad object/);
});

test("a hard git error while listing branches fails closed", () => {
  const { ensureRepoXCloseoutReady } = makeFactory({ listStatus: 128 });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /could not list workspace ticket branches/);
});

test("product-repo worktree residue still refuses first (pre-existing behavior preserved)", () => {
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: [],
    residue: [{ path: `${ROOT}/backend/.worktrees/claudea11/COORD-512`, branch: "agent/x" }],
  });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /worktree residue/);
});

test("factory without gitTry fails closed with a clear wiring message", () => {
  const factory = createLifecycleRepoXCloseout({
    COORD_DIR: `${ROOT}/coord`,
    REPO_ROOTS: { X: ROOT },
    getRepoRoot: () => ROOT,
    inferTicketIdFromPath: () => null,
    listGitWorktrees: () => [],
    repoDisplayNameForCode: (code) => code,
    controlPlaneLayout: () => ({ coordRepoRoot: ROOT, coordPathPrefix: "coord" }),
  });
  assert.throws(() => factory.ensureRepoXCloseoutReady("COORD-512"), /requires gitTry/);
});

// COORD-635: the control-plane git root is coordRepoRoot. With NO control-plane
// repository there is nothing to verify delivery against, and closeout must say
// so rather than probing the workspace container (which ADR-0008 forbids from
// being a repository at all).
test("COORD-635: closeout fails closed, naming coord/, when there is no control-plane repository", () => {
  const factory = createLifecycleRepoXCloseout({
    COORD_DIR: `${ROOT}/coord`,
    REPO_ROOTS: { X: ROOT },
    getRepoRoot: () => ROOT,
    gitTry: () => { throw new Error("git must not be reached without a control-plane repository"); },
    inferTicketIdFromPath: () => null,
    listGitWorktrees: () => [],
    repoDisplayNameForCode: (code) => code,
    controlPlaneLayout: () => ({
      workspaceRoot: ROOT,
      coordDir: `${ROOT}/coord`,
      coordRepoRoot: null,
      coordPathPrefix: null,
      topology: "none",
    }),
  });
  assert.throws(() => factory.ensureRepoXCloseoutReady("COORD-512"), (error) => {
    assert.match(error.message, /cannot verify control-plane delivery/);
    assert.match(error.message, /coord\//);
    return true;
  });
});

// ---------------------------------------------------------------------------
// COORD-591: engine-facing Repo-X closeout must fail closed while the donor
// integrity surfaces (check-template-sync + verify-engine) report drift.
// ---------------------------------------------------------------------------

const BRANCH_512 = "agent/claudea11-coord-512-landing-integrity";
const TIP_512 = "tip512";
const MERGE_512 = { sha: "merge512", p1: "premerge", p2: TIP_512 };

function makeCoord512Sequence(overrides = {}) {
  // The COORD-512 sequence: reviewed Repo-X branch merged into main
  // (merge commit second parent == branch tip), engine file in the diff.
  return makeFactory({
    branches: [BRANCH_512],
    ancestorOf: { [BRANCH_512]: true },
    tipShaOf: { [BRANCH_512]: TIP_512 },
    merges: [MERGE_512],
    mergeDiffFiles: { [MERGE_512.sha]: ["coord/scripts/lifecycle.js", "coord/docs/NOTES.md"] },
    ...overrides,
  });
}

test("COORD-512 sequence: merged engine change + drifted surfaces refuses closeout with the exact drifted paths", () => {
  const { ensureRepoXCloseoutReady } = makeCoord512Sequence({
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/scripts/lifecycle.js", kind: "checksum-drift", detail: "expected x got y" }],
      pinOk: false,
      pinDrifted: [{ path: "coord/scripts/lifecycle.js", kind: "changed", detail: "sha mismatch" }],
    }),
  });
  assert.throws(
    () => ensureRepoXCloseoutReady("COORD-512"),
    (error) => {
      assert.match(error.message, /engine-facing changes \(coord\/scripts\/lifecycle\.js\)/);
      assert.match(error.message, /check-template-sync drift: coord\/scripts\/lifecycle\.js \(checksum-drift\)/);
      assert.match(error.message, /verify-engine drift: coord\/scripts\/lifecycle\.js \(changed\)/);
      assert.match(error.message, /COORD-591/);
      assert.match(error.message, /verify-engine --pin/);
      return true;
    }
  );
});

test("COORD-512 sequence: after intentional re-stamp/re-pin (both surfaces clean) closeout passes", () => {
  const { ensureRepoXCloseoutReady } = makeCoord512Sequence({
    enginePin: makeEnginePinStub({ manifestOk: true, pinOk: true }),
  });
  assert.equal(ensureRepoXCloseoutReady("COORD-512"), null);
});

test("non-engine-facing Repo-X ticket is not blocked by pre-existing drift it did not create", () => {
  const { ensureRepoXCloseoutReady } = makeCoord512Sequence({
    mergeDiffFiles: { [MERGE_512.sha]: ["coord/docs/NOTES.md"] },
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/scripts/lifecycle.js", kind: "checksum-drift", detail: "pre-existing" }],
      pinOk: false,
      pinDrifted: [{ path: "coord/scripts/lifecycle.js", kind: "changed", detail: "pre-existing" }],
    }),
  });
  assert.equal(ensureRepoXCloseoutReady("COORD-512"), null);
});

test("plan-record surface triggers the gate even when the ticket branch is gone (merged-and-deleted)", () => {
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: [],
    planSurface: ["coord/scripts/lifecycle.js"],
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/scripts/lifecycle.js", kind: "checksum-drift", detail: "drift" }],
    }),
  });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /check-template-sync drift: coord\/scripts\/lifecycle\.js/);
});

test("re-stamp tickets are engine-facing: manifest/pin file changes trigger the gate", () => {
  const { ensureEngineIntegrityForCloseout } = makeFactory({
    branches: [],
    planSurface: ["coord/TEMPLATE_SYNC_MANIFEST.json", "coord/engine-pin.json"],
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/scripts/lifecycle.js", kind: "checksum-drift", detail: "bad re-stamp" }],
    }),
  });
  assert.throws(() => ensureEngineIntegrityForCloseout("COORD-591"), /check-template-sync drift/);
});

test("verify-engine no_pin / problem-only reports still refuse with the problem code", () => {
  const { ensureEngineIntegrityForCloseout } = makeFactory({
    branches: [],
    planSurface: ["coord/scripts/lifecycle.js"],
    enginePin: makeEnginePinStub({ pinOk: false, pinProblems: [{ code: "no_pin", detail: "no pin recorded" }] }),
  });
  assert.throws(() => ensureEngineIntegrityForCloseout("COORD-591"), /verify-engine drift: no_pin/);
});

test("unmerged branch still refuses BEFORE the integrity gate (COORD-512 ancestry guard not weakened)", () => {
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: [BRANCH_512],
    ancestorOf: {},
    planSurface: ["coord/scripts/lifecycle.js"],
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/scripts/lifecycle.js", kind: "checksum-drift", detail: "drift" }],
    }),
  });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /not merged into the workspace branch/);
});

test("engine-facing closeout without an enginePin wiring fails closed", () => {
  const factory = makeFactory({ enginePin: null, planSurface: ["coord/scripts/lifecycle.js"] });
  assert.throws(() => factory.ensureEngineIntegrityForCloseout("COORD-591"), /requires an enginePin surface/);
});

// Real-git + real engine-pin integration reproduction of the COORD-512
// sequence: reviewed Repo-X branch merged into main with an intentional
// engine change; negative case refuses with the drifted path, positive case
// closes after re-stamp + re-pin.
test("integration: COORD-512 sequence against a real git workspace and real engine-pin", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const { execFileSync } = require("node:child_process");
  const createEnginePin = require("./engine-pin.js");
  const { gitTry } = require("./git-ops.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord591-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-b", "main", root], { encoding: "utf8" });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    const coordDir = path.join(root, "coord");
    fs.mkdirSync(path.join(coordDir, "scripts"), { recursive: true });
    const enginePath = path.join(coordDir, "scripts", "lifecycle.js");
    fs.writeFileSync(enginePath, "module.exports = 1;\n");
    const stamp = () => {
      const buf = fs.readFileSync(enginePath);
      const manifest = {
        schema_version: 1,
        manifest_version: "test-v1",
        items: [{
          path: "coord/scripts/lifecycle.js",
          match_policy: "exact",
          checksum: {
            algo: "sha256",
            hex: crypto.createHash("sha256").update(buf).digest("hex"),
            bytes: buf.length,
          },
        }],
      };
      fs.writeFileSync(path.join(coordDir, "TEMPLATE_SYNC_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
    };
    stamp();
    const enginePin = createEnginePin({ coordDir, fail: (m) => { throw new Error(m); } });
    enginePin.pin();
    git("add", "-A");
    git("commit", "-m", "baseline: stamped + pinned engine surface");

    // Reviewed Repo-X ticket branch with an intentional engine change.
    const branch = "agent/claudea11-coord-512-landing-integrity";
    git("checkout", "-b", branch);
    fs.writeFileSync(enginePath, "module.exports = 2; // intentional engine change\n");
    git("add", "-A");
    git("commit", "-m", "COORD-512: intentional engine change");
    git("checkout", "main");
    git("merge", "--no-ff", "-m", "merge COORD-512", branch);

    const factory = createLifecycleRepoXCloseout({
      COORD_DIR: coordDir,
      REPO_ROOTS: { X: root },
      controlPlaneLayout: () => ({
        workspaceRoot: root,
        coordDir,
        coordRepoRoot: root,
        coordPathPrefix: "coord",
        topology: "ancestor_repository",
      }),
      enginePin,
      getRepoRoot: () => root,
      gitTry,
      inferTicketIdFromPath: (p) => (p.match(/COORD-\d+/) || [null])[0],
      listGitWorktrees: () => [],
      readTicketFileSurface: () => [],
      repoDisplayNameForCode: (code) => code,
    });

    // Negative: both integrity surfaces are stale post-merge — refuse, naming the path.
    assert.throws(
      () => factory.ensureRepoXCloseoutReady("COORD-512"),
      (error) => {
        assert.match(error.message, /engine-facing changes \(coord\/scripts\/lifecycle\.js\)/);
        assert.match(error.message, /check-template-sync drift: coord\/scripts\/lifecycle\.js/);
        assert.match(error.message, /verify-engine drift: coord\/scripts\/lifecycle\.js/);
        return true;
      }
    );

    // Positive: intentional re-stamp + re-pin on the workspace branch, then retry.
    stamp();
    enginePin.pin();
    git("add", "-A");
    git("commit", "-m", "COORD-512: re-stamp manifest + re-pin engine surface");
    assert.equal(factory.ensureRepoXCloseoutReady("COORD-512"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- COORD-667: the in-process control-plane workspace merge -----------------
//
// The deadlock: the COORD-512 ancestry guard refused mark-done and told the
// operator to run `git merge --no-ff <branch>`; the COORD-664 pre-bash-guard
// refuses that command whenever HEAD is on a protected integration branch,
// which is where every Repo-X closeout runs. Neither guard is wrong, and
// neither is weakened here — governance performs the merge itself instead of
// delegating it to a command its own safety hook exists to reject.

const COORD667_BRANCH = "agent/claudea675-coord-667-landing-seam";

test("COORD-667: --merge-workspace merges in-process and the ancestry guard then passes", () => {
  const calls = [];
  const sideEffects = [];
  // Model real git: the branch is not an ancestor until the merge runs.
  const ancestorOf = {};
  const factory = makeFactory({ branches: [COORD667_BRANCH], ancestorOf, calls, sideEffects });

  const merged = factory.mergeWorkspaceTicketBranches("COORD-667");
  ancestorOf[COORD667_BRANCH] = true; // what the stubbed `git merge` just did

  assert.equal(merged.length, 1);
  assert.equal(merged[0].branch, COORD667_BRANCH);
  assert.equal(merged[0].base_branch, "main");
  assert.equal(merged[0].merge_commit_sha, "merge-commit-sha");
  assert.ok(calls.some((c) => c.startsWith("merge --no-ff --no-edit")), calls.join(" | "));
  // The COORD-512 ancestry check is still the authority, and now passes.
  assert.equal(factory.ensureRepoXCloseoutReady("COORD-667"), null);
});

test("COORD-667: ensureRepoXCloseoutReady drives the merge itself when mergeWorkspace is set", () => {
  const calls = [];
  const ancestorOf = {};
  // gitTry's `merge` handler flips ancestry, so the ancestry re-check that runs
  // AFTER the merge inside ensureRepoXCloseoutReady sees the merged state.
  const factory = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf,
    calls,
    onMerge: () => { ancestorOf[COORD667_BRANCH] = true; },
  });
  assert.equal(factory.ensureRepoXCloseoutReady("COORD-667", { mergeWorkspace: true }), null);
  assert.ok(calls.some((c) => c.startsWith("merge --no-ff")), calls.join(" | "));
});

test("COORD-667: the merge is --no-ff, so COORD-591 merge-commit attribution cannot be disarmed", () => {
  const calls = [];
  const factory = makeFactory({ branches: [COORD667_BRANCH], ancestorOf: {}, calls });
  factory.mergeWorkspaceTicketBranches("COORD-667");
  const mergeCall = calls.find((c) => c.startsWith("merge ") && !c.includes("--abort"));
  assert.ok(mergeCall, "no merge invocation recorded");
  assert.match(mergeCall, /^merge --no-ff --no-edit -m /);
  assert.ok(mergeCall.endsWith(COORD667_BRANCH), mergeCall);
});

test("COORD-667: the merge commit is journaled as an external side effect (rollback cannot undo it)", () => {
  const sideEffects = [];
  const factory = makeFactory({ branches: [COORD667_BRANCH], ancestorOf: {}, sideEffects });
  factory.mergeWorkspaceTicketBranches("COORD-667");
  assert.equal(sideEffects.length, 1);
  assert.equal(sideEffects[0].type, "control_plane_workspace_merge");
  assert.equal(sideEffects[0].ticket, "COORD-667");
  assert.equal(sideEffects[0].branch, COORD667_BRANCH);
  assert.equal(sideEffects[0].merge_commit_sha, "merge-commit-sha");
});

test("COORD-667: an already-merged branch is a no-op — no merge, no side effect", () => {
  const calls = [];
  const sideEffects = [];
  const factory = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: { [COORD667_BRANCH]: true },
    calls,
    sideEffects,
  });
  assert.deepEqual(factory.mergeWorkspaceTicketBranches("COORD-667"), []);
  assert.equal(sideEffects.length, 0);
  assert.ok(!calls.some((c) => c.startsWith("merge ")), calls.join(" | "));
});

test("COORD-667: without mergeWorkspace nothing is merged (COORD-512 fail-closed default preserved)", () => {
  const calls = [];
  const { ensureRepoXCloseoutReady } = makeFactory({ branches: [COORD667_BRANCH], ancestorOf: {}, calls });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-667"), /not merged into the workspace branch/);
  assert.ok(!calls.some((c) => c.startsWith("merge ")), "closeout merged without being asked");
});

test("COORD-667: refuses on detached HEAD rather than merging into nothing", () => {
  const { mergeWorkspaceTicketBranches } = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    headBranch: null,
  });
  assert.throws(() => mergeWorkspaceTicketBranches("COORD-667"), /HEAD in .* is detached/);
});

test("COORD-667: refuses to merge onto another ticket branch", () => {
  const { mergeWorkspaceTicketBranches } = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    headBranch: "agent/claudea11-coord-999-someone-elses-work",
  });
  assert.throws(() => mergeWorkspaceTicketBranches("COORD-667"), /HEAD is on ticket branch/);
});

test("COORD-667: an explicit base that disagrees with HEAD is refused, never silently retargeted", () => {
  const { mergeWorkspaceTicketBranches } = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    headBranch: "main",
  });
  assert.throws(
    () => mergeWorkspaceTicketBranches("COORD-667", { base: "dev" }),
    /--base named "dev" but HEAD in .* is on "main"/
  );
});

test("COORD-667: uncommitted work the merge would overwrite is named up front, not discovered by git", () => {
  const calls = [];
  const { mergeWorkspaceTicketBranches } = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    dirtyPaths: ["coord/PLAN.md", "coord/scripts/unrelated.js"],
    incomingFiles: ["coord/PLAN.md", "coord/scripts/lifecycle.js"],
    calls,
  });
  assert.throws(
    () => mergeWorkspaceTicketBranches("COORD-667"),
    (error) => {
      assert.match(error.message, /coord\/PLAN\.md/);
      // Only the OVERLAP is reported: a dirty file the merge does not touch is
      // not turned into a blanket refusal.
      assert.doesNotMatch(error.message, /unrelated\.js/);
      return true;
    }
  );
  assert.ok(!calls.some((c) => c.startsWith("merge ")), "merged despite overlapping dirty paths");
});

test("COORD-667: dirty paths outside the incoming surface do not block the merge", () => {
  const calls = [];
  const { mergeWorkspaceTicketBranches } = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    dirtyPaths: ["coord/QUESTIONS.md"],
    incomingFiles: ["coord/scripts/lifecycle.js"],
    calls,
  });
  assert.equal(mergeWorkspaceTicketBranches("COORD-667").length, 1);
  assert.ok(calls.some((c) => c.startsWith("merge --no-ff")));
});

test("COORD-667: a conflicting merge is aborted and refused — no half-merged tree is left behind", () => {
  const calls = [];
  const sideEffects = [];
  const { mergeWorkspaceTicketBranches } = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    mergeStatus: 1,
    mergeStderr: "CONFLICT (content): Merge conflict in coord/scripts/lifecycle.js",
    calls,
    sideEffects,
  });
  assert.throws(() => mergeWorkspaceTicketBranches("COORD-667"), /failed and was aborted: CONFLICT/);
  assert.ok(calls.includes("merge --abort"), calls.join(" | "));
  // A failed merge produced no commit, so it must produce no side-effect record.
  assert.equal(sideEffects.length, 0);
});

// THE DECISIVE PROOF, against real git rather than a stub: before the change
// the closeout refused and the only command it offered was one pre-bash-guard
// blocks; after it, the SAME closeout call completes with no shell git at all,
// the branch really is an ancestor of HEAD, and the merge really is a --no-ff
// merge commit whose second parent is the branch tip (what COORD-591 reads).
test("integration: COORD-667 breaks the deadlock against a real git workspace", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { gitTry } = require("./git-ops.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord667-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-b", "main", root], { encoding: "utf8" });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    const coordDir = path.join(root, "coord");
    fs.mkdirSync(path.join(coordDir, "docs"), { recursive: true });
    const doc = path.join(coordDir, "docs", "note.md");
    fs.writeFileSync(doc, "baseline\n");
    git("add", "-A");
    git("commit", "-m", "baseline");

    // A reviewed Repo-X ticket branch, fully committed — the COORD-665 shape.
    const branch = "agent/claudea675-coord-667-landing-seam";
    git("checkout", "-b", branch);
    fs.writeFileSync(doc, "ticket work that must not be silently lost\n");
    git("add", "-A");
    git("commit", "-m", "COORD-667: ticket work");
    const branchTip = git("rev-parse", branch).trim();
    git("checkout", "main");

    const factory = createLifecycleRepoXCloseout({
      COORD_DIR: coordDir,
      REPO_ROOTS: { X: root },
      controlPlaneLayout: () => ({
        workspaceRoot: root,
        coordDir,
        coordRepoRoot: root,
        coordPathPrefix: "coord",
        topology: "ancestor_repository",
      }),
      enginePin: makeEnginePinStub({ engineItems: [] }),
      getRepoRoot: () => root,
      gitTry,
      inferTicketIdFromPath: (p) => (p.match(/COORD-\d+/) || [null])[0],
      listGitWorktrees: () => [],
      readTicketFileSurface: () => [],
      recordExternalSideEffect: () => {},
      repoDisplayNameForCode: (code) => code,
    });

    // BEFORE: the ancestry guard refuses, exactly as COORD-512 intends.
    assert.throws(
      () => factory.ensureRepoXCloseoutReady("COORD-667"),
      /not merged into the workspace branch/
    );
    assert.equal(fs.readFileSync(doc, "utf8"), "baseline\n");

    // AFTER: the same call with the governed opt-in completes.
    assert.equal(factory.ensureRepoXCloseoutReady("COORD-667", { mergeWorkspace: true }), null);

    // The work is really on main now — the silent doc-loss COORD-512 exists to
    // prevent is prevented by DELIVERY, not merely by refusal.
    assert.equal(fs.readFileSync(doc, "utf8"), "ticket work that must not be silently lost\n");
    assert.equal(
      gitTry(root, ["merge-base", "--is-ancestor", branch, "HEAD"]).status,
      0,
      "branch is still not an ancestor of HEAD after the governed merge"
    );

    // --no-ff really produced a merge commit with the branch tip as 2nd parent,
    // which is what findTicketMergedChangeSurface attributes engine changes by.
    const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/);
    assert.equal(parents.length, 3, `expected a merge commit, got parents: ${parents.join(" ")}`);
    assert.equal(parents[2], branchTip);
    assert.deepEqual(factory.findTicketMergedChangeSurface("COORD-667"), ["coord/docs/note.md"]);

    // Idempotent: a second closeout is a no-op, not a second merge.
    assert.deepEqual(factory.mergeWorkspaceTicketBranches("COORD-667"), []);
    assert.equal(git("rev-list", "--count", "HEAD").trim(), "3");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-667: a hard git status error fails closed instead of assuming a clean tree", () => {
  const { mergeWorkspaceTicketBranches } = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    dirtyPaths: ["coord/PLAN.md"],
    statusStatus: 128,
  });
  assert.throws(() => mergeWorkspaceTicketBranches("COORD-667"), /could not read the working tree state/);
});
