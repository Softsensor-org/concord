const test = require("node:test");
const { gitFixtureEnv } = require("./test-git-fixture.js"); // COORD-952
const assert = require("node:assert/strict");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = require("node:path").resolve(__dirname, "..", "..");

const createLifecycleRepoXCloseout = require("./lifecycle-repox-closeout.js");

// COORD-512: Repo-X closeout must refuse mark-done while the coord-workspace
// ticket branch holds unmerged commits (silent doc-loss: board says done,
// workspace main still has pre-ticket content). These tests drive the factory
// with a stubbed gitTry so branch topology is fully controlled; no real git
// repo is needed. Product-worktree residue behavior (the pre-existing half of
// ensureRepoXCloseoutReady) is stubbed empty except where noted.

const ROOT = "/ws";
// COORD-1008: the fake git's tree sha (merge-tree/commit-tree preview) and head sha.
const TREE_SHA = "b".repeat(40);

// COORD-591 defaults: a clean enginePin stub whose manifest tracks one engine
// file, so pre-COORD-591 tests (no merged engine files, no plan surface) skip
// the integrity gate exactly as a non-engine-facing ticket would.
function makeEnginePinStub({
  manifestOk = true,
  manifestFailures = [],
  pinOk = true,
  pinDrifted = [],
  pinProblems = [],
  engineItems = [{ path: "coord/engine/scripts/lifecycle.js", match_policy: "exact" }],
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
  probeErrorStderr = null,
  residue = [],
  merges = [],
  mergeDiffFiles = {},
  tipShaOf = {},
  tipStdoutOf = {},
  planSurface = [],
  readTicketFileSurface = () => planSurface,
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
  mergeHeadStatus = 0,
  currentHeadSha = "a".repeat(40),
  currentHeadStatus = 0,
  currentHeadStderr = "HEAD resolution failed",
  currentHeadFailureObservation = 1,
  currentHeadStdoutOmittedObservation = 0,
  tipStatusOf = {},
  tipStderrOf = {},
  tipFailureObservationOf = {},
  logStatus = 0,
  logStderr = "",
  diffStatusOf = {},
  diffStderrOf = {},
  calls = [],
  sideEffects = [],
  // Lets a test apply the real-git consequence of the stubbed merge (the branch
  // becoming an ancestor of HEAD) at the moment the merge is issued.
  onMerge = null,
  // COORD-1008: the engine ratchet and guard registry blobs prodloc-closeout.js reads with
  // `git show <rev>:<path>`. null is absent (git exits non-zero); a string is the blob.
  ratchetCandidate = null,
  ratchetBase = null,
  guardsCandidate = null,
} = {}) {
  let currentHeadObservations = 0;
  // COORD-1008: the candidate revision is the head commit until a merge preview produces a tree,
  // exactly as previewIntegrationTree returns headSha when no branch is pending.
  let candidateRev = currentHeadSha;
  const tipObservations = new Map();
  const gitTry = (dir, args) => {
    assert.equal(dir, ROOT);
    calls.push(args.join(" "));
    if (args[0] === "check-ref-format") return require("node:child_process").spawnSync("git", args, { encoding: "utf8" });
    // These topology fixtures contain no production modules. Real immutable
    // source and combined-merge budget enforcement lives in prodloc-closeout.test.
    if (args[0] === "ls-tree") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "merge-tree") candidateRev = TREE_SHA;
    if (args[0] === "merge-tree" || args[0] === "commit-tree") return { status: 0, stdout: `${TREE_SHA}\n`, stderr: "" };
    // COORD-839: these topologies change no decision record; the ADR packet
    // check against real Git lives in landing-decision-packet.test.js.
    if (args[0] === "diff-tree") return { status: 0, stdout: "", stderr: "" };
    // --- COORD-667 surface -------------------------------------------------
    if (args[0] === "symbolic-ref") {
      return headBranch === null
        ? { status: 128, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref" }
        : { status: 0, stdout: headBranch ? `${headBranch}\n` : "", stderr: "" };
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
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD^{commit}") {
      currentHeadObservations += 1;
      const status = currentHeadObservations === currentHeadFailureObservation ? currentHeadStatus : 0;
      return {
        status,
        stdout: status !== 0 ? "" : currentHeadObservations === currentHeadStdoutOmittedObservation ? undefined : `${currentHeadSha}\n`,
        stderr: status === 0 ? "" : currentHeadStderr,
      };
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return { status: mergeHeadStatus, stdout: mergeHeadSha ? `${mergeHeadSha}\n` : "", stderr: mergeHeadStatus ? "HEAD probe failed" : "" };
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
        return { status: 128, stdout: "", stderr: probeErrorStderr === null ? `fatal: bad object ${branch}` : probeErrorStderr };
      }
      return { status: ancestorOf[branch] ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      const branch = String(args[2] || "").replace(/\^\{commit\}$/, "");
      const sha = tipShaOf[branch] || `${branch}-tip`;
      const observation = (tipObservations.get(branch) || 0) + 1;
      tipObservations.set(branch, observation);
      const status = observation === (tipFailureObservationOf[branch] || 1) ? (tipStatusOf[branch] || 0) : 0;
      return {
        status,
        stdout: status === 0 ? (Object.hasOwn(tipStdoutOf, branch) ? tipStdoutOf[branch] : `${sha}\n`) : "",
        stderr: status === 0 ? "" : (Object.hasOwn(tipStderrOf, branch) ? tipStderrOf[branch] : "planned branch resolution failed"),
      };
    }
    if (args[0] === "log") {
      return {
        status: logStatus,
        stdout: logStatus === 0 ? merges.map((m) => `${m.sha} ${m.p1} ${m.p2}`).join("\n") : "",
        stderr: logStatus === 0 ? "" : logStderr,
      };
    }
    if (args[0] === "diff") {
      const mergeSha = args[3];
      const status = diffStatusOf[mergeSha] || 0;
      return {
        status,
        stdout: status === 0 ? (mergeDiffFiles[mergeSha] || []).join("\n") : "",
        stderr: status === 0 ? "" : (Object.hasOwn(diffStderrOf, mergeSha) ? diffStderrOf[mergeSha] : "diff failed"),
      };
    }
    // COORD-1008: the only `show` reads are the three ratchet/guard blobs prodloc-closeout.js
    // makes: the ratchet at the candidate tree and at the base head, and the guard registry
    // at the candidate tree. Absent paths exit 128 as `git show` does. Any other `show` throws.
    if (args[0] === "show") {
      const served = [
        { rev: candidateRev, path: "coord/engine/architecture-ratchet.json", text: ratchetCandidate },
        { rev: currentHeadSha, path: "coord/engine/architecture-ratchet.json", text: ratchetBase },
        { rev: candidateRev, path: "coord/engine/governance-guards.json", text: guardsCandidate },
      ];
      const key = String(args[1]);
      const hit = args.length === 2 ? served.find((blob) => `${blob.rev}:${blob.path}` === key) : undefined;
      if (hit) {
        return hit.text == null
          ? { status: 128, stdout: "", stderr: `fatal: path '${hit.path}' does not exist in '${hit.rev}'` }
          : { status: 0, stdout: hit.text, stderr: "" };
      }
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
    readTicketFileSurface,
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
  assert.equal(ensureRepoXCloseoutReady("COORD-512").mergeCommitSha, null);
});

test("repo-x closeout passes when no branch matches the ticket (merged-and-deleted or direct-commit)", () => {
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: ["agent/claudea11-coord-999-other-work"],
    ancestorOf: {},
  });
  assert.equal(ensureRepoXCloseoutReady("COORD-512").mergeCommitSha, null);
});

test("COORD-786: absent repo worktree lists contribute no closeout residue", () => {
  const { collectTicketWorktreeResidue } = makeFactory();
  assert.deepEqual(collectTicketWorktreeResidue("COORD-512", { B: null, F: undefined }), []);
});

test("ticket-id matching is exact: COORD-51 does not match a COORD-512 branch and vice versa", () => {
  const branch512 = "agent/claudea11-coord-512-landing-integrity";
  const factory = makeFactory({ branches: [branch512], ancestorOf: {} });
  // COORD-51 must not see the COORD-512 branch.
  assert.equal(factory.ensureRepoXCloseoutReady("COORD-51").mergeCommitSha, null);
  // COORD-512 still does.
  assert.deepEqual(factory.findUnmergedWorkspaceTicketBranches("COORD-512"), [branch512]);
});

test("matches a branch whose name ends at the ticket id (no trailing slug)", () => {
  const bare = "agent/claudea11-coord-512";
  const { findUnmergedWorkspaceTicketBranches } = makeFactory({ branches: [bare], ancestorOf: {} });
  assert.deepEqual(findUnmergedWorkspaceTicketBranches("COORD-512"), [bare]);
});

// COORD-1013: governed branches are agent/<handle>-<ticket-id>-<slug>; a ticket id
// that appears inside another ticket's slug must not make that branch this ticket's.
test("COORD-1013: closeout for COORD-908 lists only the branch that is COORD-908, not one naming it in a slug", () => {
  const own = "agent/h1-coord-908-x";
  const foreign = "agent/h2-coord-1012-found-by-the-coord-908-y";
  const { findUnmergedWorkspaceTicketBranches } = makeFactory({ branches: [own, foreign], ancestorOf: {} });
  assert.deepEqual(findUnmergedWorkspaceTicketBranches("COORD-908"), [own]);
});

test("COORD-1013: a COORD-1012 closeout lists its own branch, not the COORD-908 branch that names it in a slug", () => {
  const own = "agent/h2-coord-1012-found-by-the-coord-908-y";
  const other = "agent/h1-coord-908-x";
  const { findUnmergedWorkspaceTicketBranches } = makeFactory({ branches: [other, own], ancestorOf: {} });
  assert.deepEqual(findUnmergedWorkspaceTicketBranches("COORD-1012"), [own]);
});

test("COORD-1013: ticket-id branch listing is exact for COORD-51 vs COORD-512 and ignores case", () => {
  const b512 = "agent/h1-coord-512-x";
  const b51 = "agent/h1-coord-51-x";
  const upper = "agent/H1-COORD-908-X";
  const lower = "agent/h1-coord-908-x";
  const { findUnmergedWorkspaceTicketBranches } = makeFactory({ branches: [b512, b51, upper, lower], ancestorOf: {} });
  assert.deepEqual(findUnmergedWorkspaceTicketBranches("COORD-51"), [b51]);
  assert.deepEqual(findUnmergedWorkspaceTicketBranches("COORD-512"), [b512]);
  assert.deepEqual(findUnmergedWorkspaceTicketBranches("coord-908"), [upper, lower]);
  assert.deepEqual(findUnmergedWorkspaceTicketBranches("COORD-908"), [upper, lower]);
});

test("a hard git error while probing fails closed with the git message, not a silent pass", () => {
  const branch = "agent/claudea11-coord-512-landing-integrity";
  const { ensureRepoXCloseoutReady } = makeFactory({ branches: [branch], probeError: branch });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /could not verify branch .*bad object/);
});

test("COORD-809: an empty merge-base diagnostic still refuses with the numeric Git exit", () => {
  const branch = "agent/claudea11-coord-512-landing-integrity";
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: [branch], probeError: branch, probeErrorStderr: "",
  });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /could not verify branch .*git merge-base exited 128/);
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
    mergeDiffFiles: { [MERGE_512.sha]: ["coord/engine/scripts/lifecycle.js", "coord/docs/NOTES.md"] },
    ...overrides,
  });
}

test("COORD-512 sequence: merged engine change + drifted surfaces refuses closeout with the exact drifted paths", () => {
  const { ensureRepoXCloseoutReady } = makeCoord512Sequence({
    planSurface: null,
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/engine/scripts/lifecycle.js", kind: "checksum-drift", detail: "expected x got y" }],
      pinOk: false,
      pinDrifted: [{ path: "coord/engine/scripts/lifecycle.js", kind: "changed", detail: "sha mismatch" }],
    }),
  });
  assert.throws(
    () => ensureRepoXCloseoutReady("COORD-512"),
    (error) => {
      assert.match(error.message, /engine-facing changes \(coord\/engine\/scripts\/lifecycle\.js\)/);
      assert.match(error.message, /check-template-sync drift: coord\/engine\/scripts\/lifecycle\.js \(checksum-drift\)/);
      assert.match(error.message, /verify-engine drift: coord\/engine\/scripts\/lifecycle\.js \(changed\)/);
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
  assert.equal(ensureRepoXCloseoutReady("COORD-512").mergeCommitSha, null);
});

test("non-engine-facing Repo-X ticket is not blocked by pre-existing drift it did not create", () => {
  const { ensureRepoXCloseoutReady } = makeCoord512Sequence({
    mergeDiffFiles: { [MERGE_512.sha]: ["coord/docs/NOTES.md"] },
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/engine/scripts/lifecycle.js", kind: "checksum-drift", detail: "pre-existing" }],
      pinOk: false,
      pinDrifted: [{ path: "coord/engine/scripts/lifecycle.js", kind: "changed", detail: "pre-existing" }],
    }),
  });
  assert.equal(ensureRepoXCloseoutReady("COORD-512").mergeCommitSha, null);
});

test("plan-record surface triggers the gate even when the ticket branch is gone (merged-and-deleted)", () => {
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: [],
    planSurface: ["coord/engine/scripts/lifecycle.js"],
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/engine/scripts/lifecycle.js", kind: "checksum-drift", detail: "drift" }],
    }),
  });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /check-template-sync drift: coord\/engine\/scripts\/lifecycle\.js/);
});

test("re-stamp tickets are engine-facing: manifest/pin file changes trigger the gate", () => {
  const { ensureEngineIntegrityForCloseout } = makeFactory({
    branches: [],
    planSurface: ["coord/TEMPLATE_SYNC_MANIFEST.json", "coord/engine-pin.json"],
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/engine/scripts/lifecycle.js", kind: "checksum-drift", detail: "bad re-stamp" }],
    }),
  });
  assert.throws(() => ensureEngineIntegrityForCloseout("COORD-591"), /check-template-sync drift/);
});

test("merged pin changes trigger integrity checks without plan lookup or listed manifest items", () => {
  const factory = makeCoord512Sequence({
    readTicketFileSurface: null,
    mergeDiffFiles: { [MERGE_512.sha]: ["coord/engine-pin.json"] },
    enginePin: makeEnginePinStub({ engineItems: null, pinOk: false, pinProblems: ["missing pin"] }),
  });
  assert.throws(() => factory.ensureEngineIntegrityForCloseout("COORD-512"), /engine-facing changes \(coord\/engine-pin\.json\).*DRIFTED/);
});

test("verify-engine no_pin / problem-only reports still refuse with the problem code", () => {
  const { ensureEngineIntegrityForCloseout } = makeFactory({
    branches: [],
    planSurface: ["coord/engine/scripts/lifecycle.js"],
    enginePin: makeEnginePinStub({ pinOk: false, pinProblems: [{ code: "no_pin", detail: "no pin recorded" }] }),
  });
  assert.throws(() => ensureEngineIntegrityForCloseout("COORD-591"), /verify-engine drift: no_pin/);
});

test("unmerged branch still refuses BEFORE the integrity gate (COORD-512 ancestry guard not weakened)", () => {
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: [BRANCH_512],
    ancestorOf: {},
    planSurface: ["coord/engine/scripts/lifecycle.js"],
    enginePin: makeEnginePinStub({
      manifestOk: false,
      manifestFailures: [{ path: "coord/engine/scripts/lifecycle.js", kind: "checksum-drift", detail: "drift" }],
    }),
  });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-512"), /not merged into the workspace branch/);
});

// COORD-952: the Repo X engine-integrity outcome must not depend on the live engine pin
// when a fixture pin is installed. A drifted live pin seam (an un-re-pinned engine edit)
// refuses without the fixture pin and is ignored with it.
test("COORD-952: fixture engine pin makes the integrity outcome independent of a drifted live pin", () => {
  const { __testing: repoXTesting } = require("./lifecycle-repox-closeout.js");
  const surface = ["coord/engine/scripts/lifecycle.js"];
  const drifted = makeEnginePinStub({
    pinOk: false,
    pinDrifted: [{ path: "coord/engine/scripts/journal.js", kind: "content" }],
  });
  const clean = makeEnginePinStub();
  const outcome = (livePin, fixturePin) => {
    repoXTesting.setEngineIntegrityPinOverride(fixturePin);
    try {
      const { ensureEngineIntegrityForCloseout } = makeFactory({ enginePin: livePin, planSurface: surface });
      try {
        return { refused: false, value: ensureEngineIntegrityForCloseout("COORD-952") ?? null };
      } catch (error) {
        return { refused: true, message: error.message };
      }
    } finally {
      repoXTesting.setEngineIntegrityPinOverride(null);
    }
  };
  const liveDrift = outcome(drifted, null);
  assert.equal(liveDrift.refused, true, "without a fixture pin the drifted live pin must refuse");
  assert.match(liveDrift.message, /DRIFTED/);
  const onPinnedTree = outcome(clean, null);
  assert.equal(onPinnedTree.refused, false);
  assert.deepEqual(outcome(drifted, makeEnginePinStub()), onPinnedTree, "fixture pin overrides the drifted live pin");
  assert.deepEqual(outcome(clean, makeEnginePinStub()), onPinnedTree, "fixture pin matches the pinned-tree outcome");
  assert.equal(outcome(drifted, null).refused, true, "override is cleared after the fixture run");
});

test("engine-facing closeout without an enginePin wiring fails closed", () => {
  const factory = makeFactory({ enginePin: null, planSurface: ["coord/engine/scripts/lifecycle.js"] });
  assert.throws(() => factory.ensureEngineIntegrityForCloseout("COORD-591"), /requires an enginePin surface/);
});

test("COORD-809: merged-surface attribution refuses an unresolved ticket branch tip before integrity checks", () => {
  const calls = [];
  let integrityChecks = 0;
  const enginePin = makeEnginePinStub();
  enginePin.verifyManifest = () => { integrityChecks += 1; return { ok: true, failures: [] }; };
  enginePin.verify = () => { integrityChecks += 1; return { ok: true, pinned: true, drifted_files: [], problems: [] }; };
  const { ensureEngineIntegrityForCloseout } = makeFactory({
    branches: [BRANCH_512],
    tipStatusOf: { [BRANCH_512]: 128 },
    tipStderrOf: { [BRANCH_512]: "" },
    enginePin,
    calls,
  });
  assert.throws(() => ensureEngineIntegrityForCloseout("COORD-512"), /could not resolve branch .*git rev-parse exited 128/);
  assert.ok(calls.some((call) => call === `rev-parse --verify ${BRANCH_512}^{commit}`));
  assert.equal(calls.some((call) => call.startsWith("log ")), false, "unresolved branch tips cannot be attributed to a merge");
  assert.equal(integrityChecks, 0, "integrity approval is never attempted without a resolved source branch");
});

test("COORD-809: unmerged ticket branches are excluded from merged-change attribution", () => {
  const calls = [];
  let integrityChecks = 0;
  const enginePin = makeEnginePinStub();
  enginePin.verifyManifest = () => { integrityChecks += 1; return { ok: true, failures: [] }; };
  enginePin.verify = () => { integrityChecks += 1; return { ok: true, pinned: true, drifted_files: [], problems: [] }; };
  const { ensureEngineIntegrityForCloseout } = makeFactory({
    branches: [BRANCH_512],
    ancestorOf: {},
    planSurface: [],
    enginePin,
    calls,
  });
  assert.equal(ensureEngineIntegrityForCloseout("COORD-512"), null);
  assert.ok(calls.some((call) => call === `merge-base --is-ancestor ${BRANCH_512} HEAD`));
  assert.equal(calls.some((call) => call.startsWith("log ")), false, "unmerged work has no merge commit to attribute");
  assert.equal(integrityChecks, 0, "unmerged branch history cannot trigger an integrity decision");
});

test("COORD-809: merge-log read failure fails closed during source attribution", () => {
  const calls = [];
  const { ensureEngineIntegrityForCloseout } = makeFactory({
    branches: [BRANCH_512],
    ancestorOf: { [BRANCH_512]: true },
    tipShaOf: { [BRANCH_512]: TIP_512 },
    merges: [MERGE_512],
    logStatus: 128,
    logStderr: "",
    calls,
  });
  assert.throws(() => ensureEngineIntegrityForCloseout("COORD-512"), /could not scan workspace merges: git log exited 128/);
  assert.ok(calls.some((call) => call === "log --merges --format=%H %P -n 500 HEAD"));
});

test("COORD-809: merge-diff failure fails closed instead of losing the changed-file surface", () => {
  const calls = [];
  const { ensureEngineIntegrityForCloseout } = makeFactory({
    branches: [BRANCH_512],
    ancestorOf: { [BRANCH_512]: true },
    tipShaOf: { [BRANCH_512]: TIP_512 },
    merges: [MERGE_512],
    diffStatusOf: { [MERGE_512.sha]: 128 },
    diffStderrOf: { [MERGE_512.sha]: "" },
    calls,
  });
  assert.throws(() => ensureEngineIntegrityForCloseout("COORD-512"), /could not diff merge merge512: git diff exited 128/);
  assert.ok(calls.some((call) => call === "diff --name-only premerge merge512"));
});

test("COORD-809: empty merge diffs and paths outside coord do not invent engine changes", () => {
  const emptyDiffCalls = [];
  let emptyDiffIntegrityChecks = 0;
  const emptyDiffPin = makeEnginePinStub();
  emptyDiffPin.verifyManifest = () => { emptyDiffIntegrityChecks += 1; return { ok: true, failures: [] }; };
  emptyDiffPin.verify = () => { emptyDiffIntegrityChecks += 1; return { ok: true, pinned: true, drifted_files: [], problems: [] }; };
  const emptyDiff = makeFactory({
    branches: [BRANCH_512],
    ancestorOf: { [BRANCH_512]: true },
    tipShaOf: { [BRANCH_512]: TIP_512 },
    merges: [MERGE_512],
    enginePin: emptyDiffPin,
    calls: emptyDiffCalls,
  });
  assert.equal(emptyDiff.ensureEngineIntegrityForCloseout("COORD-512"), null);
  assert.ok(emptyDiffCalls.some((call) => call === "diff --name-only premerge merge512"));
  assert.equal(emptyDiffIntegrityChecks, 0, "an empty merge diff contributes no changed surface");

  const outsidePrefixCalls = [];
  let outsidePrefixIntegrityChecks = 0;
  const outsidePrefixPin = makeEnginePinStub();
  outsidePrefixPin.verifyManifest = () => { outsidePrefixIntegrityChecks += 1; return { ok: true, failures: [] }; };
  outsidePrefixPin.verify = () => { outsidePrefixIntegrityChecks += 1; return { ok: true, pinned: true, drifted_files: [], problems: [] }; };
  const outsidePrefix = makeFactory({
    branches: [BRANCH_512],
    ancestorOf: { [BRANCH_512]: true },
    tipShaOf: { [BRANCH_512]: TIP_512 },
    merges: [MERGE_512],
    mergeDiffFiles: { [MERGE_512.sha]: ["README.md"] },
    enginePin: outsidePrefixPin,
    calls: outsidePrefixCalls,
  });
  assert.equal(outsidePrefix.ensureEngineIntegrityForCloseout("COORD-512"), null);
  assert.equal(outsidePrefixIntegrityChecks, 0, "a repository path outside coord is not a manifest engine path");
});

// COORD-759: content-bearing staging proof for real-git fixtures. One
// Enterprise qualification run saw this fixture's final commit fail after
// `git add -A` with the regenerated manifest and pin unstaged; the report was
// not retained and the cause is not established. So staging is never trusted
// on git's exit code alone: every expected path's index blob must equal the
// blob of its bytes on disk. On a mismatch the error carries stat, content and
// index evidence from before and after staging, and the fixture is kept. A
// stat-cache miss and an index overwritten after staging leave different
// evidence (`git status` clean versus "Changes not staged"). No retry.
function stagingSnapshot(root, relPaths) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const run = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return relPaths.map((rel) => {
    const st = fs.statSync(path.join(root, rel), { bigint: true });
    const indexEntry = run("ls-files", "-s", "--", rel).stdout.trim();
    return {
      path: rel,
      ino: String(st.ino),
      size: String(st.size),
      mtime_ns: String(st.mtimeNs),
      ctime_ns: String(st.ctimeNs),
      content_blob: run("hash-object", "--", rel).stdout.trim(),
      index_blob: indexEntry ? indexEntry.split(/\s+/)[1] : null,
    };
  });
}

function stageAllWithProof(git, root, relPaths, label) {
  const { spawnSync } = require("node:child_process");
  const before = stagingSnapshot(root, relPaths);
  git("add", "-A");
  const after = stagingSnapshot(root, relPaths);
  const unstaged = after.filter((entry) => entry.index_blob !== entry.content_blob).map((entry) => entry.path);
  if (unstaged.length === 0) return;
  const status = spawnSync("git", ["-C", root, "status", "--porcelain=v2", "--untracked-files=all"], { encoding: "utf8" });
  const error = new Error(
    `COORD-759 staging proof failed (${label}): git add -A exited 0 but the index does not hold the on-disk content of ` +
      `${unstaged.join(", ")}. Evidence: ${JSON.stringify({ fixture: root, before, after, status: status.stdout })}`
  );
  error.preserveFixture = true;
  throw error;
}

function removeFixtureUnlessPreserved(root, failure) {
  if (failure && failure.preserveFixture) {
    process.stderr.write(`COORD-759: failing staging fixture preserved at ${root}\n`);
    return;
  }
  require("node:fs").rmSync(root, { recursive: true, force: true });
}

test("COORD-759: the staging proof refuses an index that lost staged content, with the evidence, and keeps the fixture", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord759-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(root, "pin.json"), "{\"v\":1}\n");
    stageAllWithProof(git, root, ["pin.json"], "baseline");
    git("commit", "-q", "-m", "baseline");
    const indexPath = path.join(root, ".git", "index");
    const staleIndex = fs.readFileSync(indexPath);
    fs.writeFileSync(path.join(root, "pin.json"), "{\"v\":2}\n"); // same size, same inode
    // COORD-832: a same-size rewrite in the same second can be invisible to git's
    // stat cache (racy git), which made the status assertion below intermittent.
    // Move the mtime clearly past the index entry so git always re-reads the file.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, "pin.json"), later, later);
    // Deterministic stand-in for an index that ends up without the staged
    // blob: the real `git add -A` runs, then the pre-staging index returns.
    const restoringGit = (...args) => {
      const out = git(...args);
      if (args[0] === "add") fs.writeFileSync(indexPath, staleIndex);
      return out;
    };
    let caught = null;
    try {
      stageAllWithProof(restoringGit, root, ["pin.json"], "re-pin");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "an index without the on-disk blob must be refused");
    assert.equal(caught.preserveFixture, true);
    assert.match(caught.message, /staging proof failed \(re-pin\).*pin\.json/);
    const evidence = JSON.parse(caught.message.slice(caught.message.indexOf("Evidence: ") + "Evidence: ".length));
    assert.equal(evidence.fixture, root);
    assert.equal(evidence.before[0].size, evidence.after[0].size, "the rewrite kept the size");
    assert.equal(evidence.before[0].ino, evidence.after[0].ino, "the rewrite kept the inode");
    assert.notEqual(evidence.after[0].content_blob, evidence.after[0].index_blob);
    assert.equal(evidence.after[0].index_blob, evidence.before[0].index_blob);
    assert.match(evidence.status, /^1 \.M .* pin\.json$/m, "status records the path as modified, not staged");
    const stderrWrites = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrWrites.push(String(chunk)); return true; };
    try {
      removeFixtureUnlessPreserved(root, caught);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.ok(fs.existsSync(path.join(root, "pin.json")), "the failing fixture is kept for inspection");
    assert.match(stderrWrites.join(""), /fixture preserved at /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  const createEnginePin = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/engine-pin.js"));
  const { gitTry } = require("./git-ops.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord591-"));
  const SURFACE = ["coord/engine/scripts/lifecycle.js", "coord/TEMPLATE_SYNC_MANIFEST.json", "coord/engine-pin.json"];
  let failure = null;
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitFixtureEnv() });
    execFileSync("git", ["init", "-b", "main", root], { encoding: "utf8", env: gitFixtureEnv() });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    const coordDir = path.join(root, "coord");
    fs.mkdirSync(path.join(coordDir, "engine", "scripts"), { recursive: true });
    const enginePath = path.join(coordDir, "engine", "scripts", "lifecycle.js");
    fs.writeFileSync(enginePath, "module.exports = 1;\n");
    const stamp = () => {
      const buf = fs.readFileSync(enginePath);
      const manifest = {
        schema_version: 1,
        manifest_version: "test-v1",
        items: [{
          path: "coord/engine/scripts/lifecycle.js",
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
    stageAllWithProof(git, root, SURFACE, "baseline");
    git("commit", "-m", "baseline: stamped + pinned engine surface");

    // Reviewed Repo-X ticket branch with an intentional engine change.
    const branch = "agent/claudea11-coord-512-landing-integrity";
    git("checkout", "-b", branch);
    fs.writeFileSync(enginePath, "module.exports = 2; // intentional engine change\n");
    stageAllWithProof(git, root, SURFACE, "engine change");
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
        assert.match(error.message, /engine-facing changes \(coord\/engine\/scripts\/lifecycle\.js\)/);
        assert.match(error.message, /check-template-sync drift: coord\/engine\/scripts\/lifecycle\.js/);
        assert.match(error.message, /verify-engine drift: coord\/engine\/scripts\/lifecycle\.js/);
        return true;
      }
    );

    // Positive: intentional re-stamp + re-pin on the workspace branch, then retry.
    stamp();
    enginePin.pin();
    stageAllWithProof(git, root, SURFACE, "re-stamp + re-pin");
    git("commit", "-m", "COORD-512: re-stamp manifest + re-pin engine surface");
    assert.equal(factory.ensureRepoXCloseoutReady("COORD-512").mergeCommitSha, null);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    removeFixtureUnlessPreserved(root, failure);
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
  assert.equal(factory.ensureRepoXCloseoutReady("COORD-667").mergeCommitSha, null);
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
  // COORD-706: the closeout now RETURNS what the merge produced, so the record
  // writer can name the commit instead of classifying a real merge local_only.
  const readiness = factory.ensureRepoXCloseoutReady("COORD-667", { mergeWorkspace: true });
  assert.ok(readiness.mergeCommitSha, "the governed merge must report the commit it created");
  assert.equal(readiness.merged.length, 1);
  assert.equal(readiness.merged[0].merge_commit_sha, readiness.mergeCommitSha);
  assert.ok(calls.some((c) => c.startsWith("merge --no-ff")), calls.join(" | "));
});

test("COORD-809: closeout preserves a successful merge with no resolvable SHA as unknown", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-809-missing-merge-sha-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journalPath = path.join(dir, "journal.ndjson");
  fs.writeFileSync(journalPath, "");
  const ancestorOf = {};
  const sideEffects = [];
  const factory = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf,
    mergeHeadSha: "",
    mergeHeadStatus: 128,
    enginePin: makeEnginePinStub({ engineItems: [] }),
    onMerge: () => { ancestorOf[COORD667_BRANCH] = true; },
    sideEffects,
  });
  const readiness = factory.ensureRepoXCloseoutReady("COORD-667", { mergeWorkspace: true, journalPath });
  assert.equal(readiness.merged.length, 1, "the real merge act remains recorded even without a SHA probe");
  assert.equal(readiness.merged[0].merge_commit_sha, null);
  assert.equal(readiness.mergeCommitSha, null, "closeout must not invent a commit identity");
  assert.equal(readiness.recoveredMerge, null, "an empty history cannot manufacture a prior merge receipt");
  assert.equal(sideEffects.length, 1);
  assert.equal(sideEffects[0].merge_commit_sha, null);
});

test("COORD-809: planned integration validation sees every incoming tip before the first workspace merge", () => {
  const secondBranch = "agent/claudea675-coord-667-secondary";
  const calls = [];
  const planned = [];
  const factory = makeFactory({
    branches: [COORD667_BRANCH, secondBranch],
    ancestorOf: {},
    tipShaOf: {
      [COORD667_BRANCH]: "b".repeat(40),
      [secondBranch]: "c".repeat(40),
    },
    calls,
  });
  assert.throws(() => factory.ensureRepoXCloseoutReady("COORD-667", {
    mergeWorkspace: true,
    validatePlannedWorkspaceIntegration: (plan) => {
      planned.push(plan);
      throw new Error("PR merge ancestry refused before integration");
    },
  }), /PR merge ancestry refused before integration/);
  assert.equal(planned.length, 1, "planner validates one complete plan, not each branch after a prior merge");
  assert.equal(planned[0].currentHeadSha, "a".repeat(40));
  assert.deepEqual(planned[0].incomingBranchTips, [
    { branch: COORD667_BRANCH, head_sha: "b".repeat(40) },
    { branch: secondBranch, head_sha: "c".repeat(40) },
  ]);
  assert.ok(calls.some((call) => call === `rev-parse --verify ${COORD667_BRANCH}^{commit}`));
  assert.ok(calls.some((call) => call === `rev-parse --verify ${secondBranch}^{commit}`));
  assert.equal(calls.some((call) => call.startsWith("merge ")), false, "no workspace merge starts after a failed plan validation");
});

test("COORD-809: unresolved current integration HEAD refuses before validation or merge", () => {
  const calls = [];
  let validationCalled = false;
  const factory = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    currentHeadStatus: 128,
    currentHeadStderr: "fatal: bad HEAD",
    currentHeadFailureObservation: 2,
    calls,
  });
  assert.throws(() => factory.ensureRepoXCloseoutReady("COORD-667", {
    mergeWorkspace: true,
    validatePlannedWorkspaceIntegration: () => { validationCalled = true; },
  }), /could not resolve current integration HEAD before the merge: fatal: bad HEAD/);
  assert.equal(calls.filter((call) => call === "rev-parse --verify HEAD^{commit}").length, 2,
    "the first current-HEAD read is prodloc preview; the injected failure is the planner's second read");
  assert.equal(validationCalled, false);
  assert.equal(calls.some((call) => call.startsWith("merge ")), false);
});

// COORD-830 coverage: a current-HEAD read that succeeds without stdout hands the
// planner an empty SHA (never the string "undefined"), so a validator that
// requires a real head refuses rather than approving a plan against nothing.
test("COORD-830: a current integration HEAD read with no stdout reaches the planner as an empty SHA", () => {
  const calls = [];
  const planned = [];
  const factory = makeFactory({
    branches: [COORD667_BRANCH],
    ancestorOf: {},
    currentHeadStdoutOmittedObservation: 2,
    calls,
  });
  assert.throws(() => factory.ensureRepoXCloseoutReady("COORD-667", {
    mergeWorkspace: true,
    validatePlannedWorkspaceIntegration: (plan) => {
      planned.push(plan);
      if (!/^[0-9a-f]{40}$/.test(plan.currentHeadSha)) throw new Error("planner refused: no current integration HEAD");
    },
  }), /planner refused: no current integration HEAD/);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].currentHeadSha, "", "an absent stdout is an empty SHA, not \"undefined\"");
  assert.equal(calls.some((call) => call.startsWith("merge ")), false, "no workspace merge starts");
});

for (const { label, stderr, diagnostic } of [
  { label: "Git stderr", stderr: "fatal: bad object", diagnostic: "fatal: bad object" },
  { label: "empty Git stderr", stderr: "", diagnostic: "git rev-parse exited 128" },
]) {
  test(`COORD-809: unresolved later incoming tip with ${label} refuses before validation or any merge`, () => {
    const secondBranch = "agent/claudea675-coord-667-secondary";
    const calls = [];
    let validationCalled = false;
    const factory = makeFactory({
      branches: [COORD667_BRANCH, secondBranch],
      ancestorOf: {},
      tipShaOf: { [COORD667_BRANCH]: "b".repeat(40) },
      tipStatusOf: { [secondBranch]: 128 },
      tipStderrOf: { [secondBranch]: stderr },
      // Prodloc previews the incoming tip before the planner resolves it.
      // Fail the planner's second read so the earlier guard can complete.
      tipFailureObservationOf: { [secondBranch]: 2 },
      calls,
    });
    assert.throws(() => factory.ensureRepoXCloseoutReady("COORD-667", {
      mergeWorkspace: true,
      validatePlannedWorkspaceIntegration: () => { validationCalled = true; },
    }), new RegExp(`could not resolve planned branch ${secondBranch} before the first merge: ${diagnostic}`));
    assert.ok(calls.some((call) => call === `rev-parse --verify ${COORD667_BRANCH}^{commit}`), "the first tip resolves before discovering the second-tip failure");
    assert.equal(calls.filter((call) => call === `rev-parse --verify ${secondBranch}^{commit}`).length, 2,
      "prodloc preview resolves the branch before the planner's injected second-read failure");
    assert.equal(validationCalled, false, "incomplete plans are never submitted for PR-merge ancestry approval");
    assert.equal(calls.some((call) => call.startsWith("merge ")), false, "a failed tip lookup cannot partially integrate earlier branches");
  });
}

test("COORD-809: PR ancestry validation refuses an empty successful branch tip before integration", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { verifyControlPlanePrEvidence, assertGithubMergeInPlannedIntegration } = require("./control-plane-pr-evidence.js");
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coord-809-empty-planned-tip-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-b", "main", repoRoot], { encoding: "utf8" });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    const commit = (name) => {
      fs.writeFileSync(path.join(repoRoot, name), `${name}\n`);
      git("add", name);
      git("commit", "-m", `fixture ${name}`);
      return git("rev-parse", "HEAD");
    };
    const sourceSha = commit("source.txt");
    const headSha = commit("head.txt");
    const mergeSha = commit("merge.txt");
    const ref = "https://github.com/acme/coord/pull/667";
    const prEvidence = verifyControlPlanePrEvidence({
      ticketId: "COORD-667",
      refs: [ref],
      verifiedPrs: [{
        ref,
        payload: {
          url: ref,
          number: 667,
          baseRefName: "main",
          state: "MERGED",
          mergedAt: "2026-10-06T12:00:00.000Z",
          headRefName: "agent/claudea675-coord-667-landing-seam",
          headRefOid: headSha,
          mergeCommit: { oid: mergeSha },
        },
      }],
      expectedRepository: "acme/coord",
      selectedBaseRef: "main",
      sourceCommitSha: sourceSha,
      repoRoot,
    });

    const secondBranch = "agent/claudea675-coord-667-secondary";
    const calls = [];
    const factory = makeFactory({
      branches: [COORD667_BRANCH, secondBranch],
      ancestorOf: {},
      currentHeadSha: mergeSha,
      tipShaOf: { [COORD667_BRANCH]: headSha },
      // Model a malformed successful adapter response; the actual verifier's
      // full-OID check must refuse it before any branch merge is attempted.
      tipStdoutOf: { [secondBranch]: "" },
      calls,
    });
    assert.throws(() => factory.ensureRepoXCloseoutReady("COORD-667", {
      mergeWorkspace: true,
      validatePlannedWorkspaceIntegration: (plan) => assertGithubMergeInPlannedIntegration({
        ticketId: "COORD-667",
        prEvidence,
        repoRoot,
        currentHeadSha: plan.currentHeadSha,
        incomingBranchTips: plan.incomingBranchTips,
      }),
    }), /could not resolve every planned control-plane integration candidate/);
    assert.equal(calls.filter((call) => call.startsWith("merge ")).length, 0,
      "unverifiable planned tips refuse before the first irreversible integration");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
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
    incomingFiles: ["coord/PLAN.md", "coord/engine/scripts/lifecycle.js"],
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
    incomingFiles: ["coord/engine/scripts/lifecycle.js"],
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
    mergeStderr: "CONFLICT (content): Merge conflict in coord/engine/scripts/lifecycle.js",
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
    const prompt = path.join(coordDir, "prompts", "tickets", "COORD-667.md");
    const promptBody = "# COORD-667\n\n## Acceptance\n\n- Preserve this prompt.\n";
    fs.writeFileSync(doc, "baseline\n");
    fs.mkdirSync(path.dirname(prompt), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(prompt), "README.md"), "Ticket prompts\n");
    git("add", "-A");
    git("commit", "-m", "baseline");

    // A reviewed Repo-X ticket branch, fully committed — the COORD-665 shape.
    const branch = "agent/claudea675-coord-667-landing-seam";
    git("checkout", "-b", branch);
    fs.writeFileSync(doc, "ticket work that must not be silently lost\n");
    fs.mkdirSync(path.dirname(prompt), { recursive: true });
    fs.writeFileSync(prompt, promptBody);
    git("add", "-A");
    git("commit", "-m", "COORD-667: ticket work");
    const branchTip = git("rev-parse", branch).trim();
    git("checkout", "main");

    const effects = [];
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
      recordExternalSideEffect: (effect) => effects.push(effect),
      repoDisplayNameForCode: (code) => code,
    });

    // BEFORE: the ancestry guard refuses, exactly as COORD-512 intends.
    assert.throws(
      () => factory.ensureRepoXCloseoutReady("COORD-667"),
      /not merged into the workspace branch/
    );
    assert.equal(fs.readFileSync(doc, "utf8"), "baseline\n");

    // AFTER: the same call with the governed opt-in completes.
    // COORD-706: against a REAL git workspace, the returned sha must be the
    // merge commit that now sits on the integration branch — the value the
    // landing record needs, proven against git rather than against the stub.
    fs.writeFileSync(prompt, promptBody);
    const readiness = factory.ensureRepoXCloseoutReady("COORD-667", { mergeWorkspace: true });
    assert.equal(fs.readFileSync(prompt, "utf8"), promptBody);
    assert.ok(effects.some((effect) => effect.type === "authored_untracked_identical_removed"));
    assert.equal(git("ls-files", "coord/prompts/tickets/COORD-667.md").trim(), "coord/prompts/tickets/COORD-667.md");
    assert.ok(readiness.mergeCommitSha, "the governed merge must report the commit it created");
    assert.equal(
      readiness.mergeCommitSha,
      git("rev-parse", "HEAD").trim(),
      "the reported sha must be the merge commit on the integration branch"
    );

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
    assert.deepEqual(factory.findTicketMergedChangeSurface("COORD-667").sort(),
      ["coord/docs/note.md", "coord/prompts/tickets/COORD-667.md"]);

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

// COORD-946: the recovery reader verifies the journalled receipt against a REAL
// repository: the SHA must exist in repo_root and repo_root must be this checkout
// (COORD-950). The retry fixtures therefore build a real workspace and journal
// real merge commits, instead of inventing SHAs the reader must reject.
function makeRealRetryWorkspace(t) {
  const os_ = require("node:os");
  const fs_ = require("node:fs");
  const path_ = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { gitTry } = require("./git-ops.js");
  const root = fs_.mkdtempSync(path_.join(os_.tmpdir(), "coord-706-retry-"));
  const journalDir = fs_.mkdtempSync(path_.join(os_.tmpdir(), "coord-706-journal-"));
  t.after(() => {
    fs_.rmSync(root, { recursive: true, force: true });
    fs_.rmSync(journalDir, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-b", "main", root], { encoding: "utf8" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const commit = (message) => {
    fs_.writeFileSync(path_.join(root, "note.md"), `${message}\n`);
    git("add", "-A");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const journalPath = path_.join(journalDir, "journal.ndjson");
  const journal = (shas) => {
    const effects = shas.map(([sha, branch]) => ({
      type: "control_plane_workspace_merge",
      ticket: "COORD-512",
      branch,
      base_branch: "main",
      merge_commit_sha: sha,
      repo_root: root,
      recorded_at: new Date().toISOString(),
    }));
    fs_.writeFileSync(journalPath, `${JSON.stringify({
      ts: new Date().toISOString(),
      command: "land",
      ticket: "COORD-512",
      result: "failed",
      details: { external_side_effects: effects },
    })}\n`);
  };
  const factory = createLifecycleRepoXCloseout({
    COORD_DIR: path_.join(root, "coord"),
    REPO_ROOTS: { X: root },
    controlPlaneLayout: () => ({
      workspaceRoot: root,
      coordDir: path_.join(root, "coord"),
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
  return { git, commit, journal, journalPath, factory };
}

test("COORD-706: a retry recovers the merge SHA the first attempt journalled", (t) => {
  const ws = makeRealRetryWorkspace(t);
  ws.commit("baseline");
  const branch = "agent/claudea11-coord-512-landing-integrity";
  ws.git("branch", branch); // already an ancestor of HEAD: the first attempt merged it
  const RECOVERED = ws.commit("COORD-512 workspace merge");
  ws.journal([[RECOVERED, branch]]);

  const readiness = ws.factory.ensureRepoXCloseoutReady("COORD-512", { mergeWorkspace: true, journalPath: ws.journalPath });

  assert.equal(readiness.merged.length, 0, "fixture: the retry must perform no new merge");
  assert.equal(
    readiness.mergeCommitSha,
    RECOVERED,
    "without recovery the record regresses to local_only on every retry"
  );
  assert.equal(readiness.recoveredMerge.recovered, true, "a recovered merge must be distinguishable from a fresh one");
});

test("COORD-706: nothing is recovered for a ticket with no journalled merge", (t) => {
  const os_ = require("node:os");
  const fs_ = require("node:fs");
  const path_ = require("node:path");
  const dir = fs_.mkdtempSync(path_.join(os_.tmpdir(), "coord-706-noretry-"));
  t.after(() => fs_.rmSync(dir, { recursive: true, force: true }));
  const journalPath = path_.join(dir, "journal.ndjson");
  fs_.writeFileSync(journalPath, "");

  const branch = "agent/claudea11-coord-512-landing-integrity";
  const { ensureRepoXCloseoutReady } = makeFactory({ branches: [branch], ancestorOf: { [branch]: true } });
  const readiness = ensureRepoXCloseoutReady("COORD-512", { mergeWorkspace: true, journalPath });

  assert.equal(readiness.mergeCommitSha, null, "a record must never gain a commit no attempt ever produced");
  assert.equal(readiness.recoveredMerge, null);
});

// COORD-706 round 2, finding 1: a transaction that merged MORE THAN ONE branch.
//
// Every merge in one closeout lands in the SAME event's external_side_effects
// array, in merge order. The fresh path takes the LAST (merged[length - 1]); a
// history reader that scanned effects forward returned the FIRST, so the two
// paths disagreed exactly when a retry mattered most. Driven through the gate,
// not the reader, because the previous round's version of this test called the
// reader directly and the wiring mutation passed the whole suite.
test("COORD-706: a retry after a MULTI-branch merge recovers the FINAL merge, matching the fresh path", (t) => {
  const ws = makeRealRetryWorkspace(t);
  ws.commit("baseline");
  const partOne = "agent/claudea11-coord-512-part-one";
  const branch = "agent/claudea11-coord-512-landing-integrity";
  ws.git("branch", partOne);
  ws.git("branch", branch);
  const FIRST = ws.commit("COORD-512 first workspace merge");
  const FINAL = ws.commit("COORD-512 final workspace merge");
  ws.journal([[FIRST, partOne], [FINAL, branch]]);

  const readiness = ws.factory.ensureRepoXCloseoutReady("COORD-512", { mergeWorkspace: true, journalPath: ws.journalPath });

  assert.equal(
    readiness.mergeCommitSha,
    FINAL,
    "the retry must recover the LAST merge of the transaction, the way the fresh path selects it"
  );
  assert.notEqual(readiness.mergeCommitSha, FIRST, "returning the first merge is the round-2 defect");
});

for (const base of ["dev", "origin/dev", "refs/heads/dev"]) test(`COORD-803: workspace merge resolves explicit ${base} to the dev branch`, () => {
  const calls = [], sideEffects = [];
  const factory = makeFactory({ branches: [COORD667_BRANCH], headBranch: "dev", calls, sideEffects });
  const merged = factory.mergeWorkspaceTicketBranches("COORD-667", { base, configuredBranch: "refs/heads/dev" });
  assert.equal(merged[0].base_branch, "dev");
  assert.equal(sideEffects[0].integration_branch, "dev");
  assert.equal(sideEffects[0].base_branch, "dev");
  assert.equal(calls.filter(call => call.startsWith("merge --no-ff")).length, 1);
});

test("COORD-803: conflicting merge selectors refuse before invoking merge", () => {
  const calls = [];
  const factory = makeFactory({ branches: [COORD667_BRANCH], headBranch: "dev", calls });
  assert.throws(() => factory.mergeWorkspaceTicketBranches("COORD-667", { base: "dev", configuredBranch: "main" }), /Conflicting control-plane base/);
  assert.equal(calls.some(call => call.startsWith("merge --no-ff")), false);
});


// Faults at the documented injected Git adapter boundary. These prove refusal
// and truthful receipts, not that stock Git emits a successful empty response.
for (const headBranch of ["", COORD667_BRANCH]) test(`COORD-803: unsafe workspace HEAD ${headBranch || "empty"} refuses before merge`, () => {
  const calls = [];
  const factory = makeFactory({ branches: [COORD667_BRANCH], headBranch, calls });
  assert.throws(() => factory.mergeWorkspaceTicketBranches("COORD-667", { base: "dev" }), /could not read|already on the ticket branch/);
  assert.equal(calls.some(call => call.startsWith("merge --no-ff")), false);
});
for (const mergeHeadStatus of [0, 128]) test(`COORD-803: unreadable post-merge HEAD status ${mergeHeadStatus} cannot invent a landing SHA`, () => {
  const sideEffects = [];
  const factory = makeFactory({ branches: [COORD667_BRANCH], headBranch: "dev", mergeHeadSha: "", mergeHeadStatus, sideEffects });
  const result = factory.mergeWorkspaceTicketBranches("COORD-667", { base: "dev" });
  assert.equal(result[0].merge_commit_sha, null);
  assert.equal(sideEffects[0].merge_commit_sha, null);
});

// COORD-830 review (fourth pass), finding 3: the planned tips are validated
// before the merge, so the merge must land exactly the validated commit, not
// whatever the branch name resolves to when the merge runs.
test("COORD-830: a validated workspace merge lands the validated SHA, and refuses a branch that moved since", () => {
  const validated = "b".repeat(40);
  const run = (moveTo, extra = {}) => {
    const calls = [];
    const tipShaOf = { [COORD667_BRANCH]: validated };
    const ancestorOf = {};
    const factory = makeFactory({ branches: [COORD667_BRANCH], ancestorOf, tipShaOf, calls, enginePin: makeEnginePinStub({ engineItems: [] }),
      onMerge: () => { ancestorOf[COORD667_BRANCH] = true; }, ...extra });
    let error = null;
    try {
      factory.ensureRepoXCloseoutReady("COORD-667", {
        mergeWorkspace: true,
        validatePlannedWorkspaceIntegration: () => { if (moveTo) tipShaOf[COORD667_BRANCH] = moveTo; },
      });
    } catch (caught) { error = caught; }
    return { error, merges: calls.filter((call) => call.startsWith("merge --no-ff")) };
  };
  const ok = run(null);
  assert.equal(ok.error, null);
  assert.equal(ok.merges.length, 1);
  assert.ok(ok.merges[0].endsWith(` ${validated}`), `the merge names the validated SHA, not the branch: ${ok.merges[0]}`);

  const moved = run("c".repeat(40));
  assert.match(moved.error.message, new RegExp(`${COORD667_BRANCH} is now at ${"c".repeat(40)}, not the validated tip ${validated}\\. `));
  assert.deepEqual(moved.merges, [], "refused before any merge");

  const gone = run(null, { tipStatusOf: { [COORD667_BRANCH]: 128 }, tipStderrOf: { [COORD667_BRANCH]: "fatal: bad ref" }, tipFailureObservationOf: { [COORD667_BRANCH]: 3 } });
  assert.match(gone.error.message, new RegExp(`is now at \\(unresolvable\\), not the validated tip ${validated} \\(fatal: bad ref\\)`));
  assert.deepEqual(gone.merges, []);
});

test("COORD-830: without a planned validation the workspace merge still names the branch", () => {
  const calls = [];
  makeFactory({ branches: [COORD667_BRANCH], ancestorOf: {}, calls }).mergeWorkspaceTicketBranches("COORD-667");
  assert.ok(calls.some((call) => call.startsWith("merge --no-ff") && call.endsWith(` ${COORD667_BRANCH}`)), calls.join(" | "));
});

// COORD-1008: the COORD-976 engine ratchet is read by prodloc-closeout.js with `git show`
// at the candidate tree and at the base head. With no pending branch the candidate is the head
// itself, so the same blob answers both reads; a pending merge makes a distinct candidate tree.
const RATCHET_PATH = "coord/engine/architecture-ratchet.json";
const GUARDS_PATH = "coord/engine/governance-guards.json";
const HEAD_SHA = "a".repeat(40);
const RATCHET_BRANCH = "agent/claudea809-coord-1008-ratchet";
const ratchetText = (guards) => JSON.stringify({
  schema_version: 1,
  ticket: "COORD-976",
  values: { guards, production_modules: 0, production_loc: 0 },
  growth: [],
});
const guardsText = (count) => JSON.stringify({ guards: Array.from({ length: count }, (_, i) => ({ id: `g${i}` })) });

test("COORD-1008: ratchet absent at both the candidate and the base is not yet adopted and closeout passes", () => {
  const calls = [];
  const { ensureRepoXCloseoutReady } = makeFactory({ calls });
  assert.equal(ensureRepoXCloseoutReady("COORD-1008").mergeCommitSha, null);
  assert.ok(calls.includes(`show ${HEAD_SHA}:${RATCHET_PATH}`), "the ratchet is read at the candidate and base");
  assert.equal(calls.some((call) => call.includes(GUARDS_PATH)), false, "no guard registry read without a ratchet");
});

test("COORD-1008: ratchet present at both within the recorded caps passes and reads the candidate guard registry", () => {
  const calls = [];
  const ratchet = ratchetText(1);
  const { ensureRepoXCloseoutReady } = makeFactory({
    calls,
    ratchetCandidate: ratchet,
    ratchetBase: ratchet,
    guardsCandidate: guardsText(1),
  });
  assert.equal(ensureRepoXCloseoutReady("COORD-1008").mergeCommitSha, null);
  assert.ok(calls.includes(`show ${HEAD_SHA}:${RATCHET_PATH}`));
  assert.ok(calls.includes(`show ${HEAD_SHA}:${GUARDS_PATH}`));
});

test("COORD-1008: ratchet present at both still refuses a guard count above the recorded cap", () => {
  const ratchet = ratchetText(1);
  const { ensureRepoXCloseoutReady } = makeFactory({
    ratchetCandidate: ratchet,
    ratchetBase: ratchet,
    guardsCandidate: guardsText(2),
  });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-1008"),
    /engine ratchet refused: guards: measured 2 exceeds the recorded ratchet 1/);
});

test("COORD-1008: a ratchet deleted from the candidate tree is refused even though the base has it", () => {
  const calls = [];
  const { ensureRepoXCloseoutReady } = makeFactory({
    branches: [RATCHET_BRANCH],
    ancestorOf: {},
    calls,
    ratchetCandidate: null,
    ratchetBase: ratchetText(1),
  });
  assert.throws(() => ensureRepoXCloseoutReady("COORD-1008", { mergeWorkspace: true }),
    /engine ratchet refused: .*architecture-ratchet\.json was removed; the engine ratchet may not be deleted/);
  assert.equal(calls.some((call) => call.startsWith("merge ")), false, "no workspace merge starts");
});
