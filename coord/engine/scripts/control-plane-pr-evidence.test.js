"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitFixture, gitFixtureSpawn } = require("./test-git-fixture.js");
const test = require("node:test");
const { resolveEngineModule } = require("../../paths.js");

const evidence = require(resolveEngineModule(path.resolve(__dirname, "../.."), "scripts/control-plane-pr-evidence.js"));
const { ensureControlPlaneLandingRecord } = require("./control-plane-landing.js");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "COORD-809 fixture",
  GIT_AUTHOR_EMAIL: "coord809@example.invalid",
  GIT_COMMITTER_NAME: "COORD-809 fixture",
  GIT_COMMITTER_EMAIL: "coord809@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  // COORD-833: commit/merge spawn `git maintenance run --auto`, which git >= 2.47
  // daemonizes (--detach). The detached child outlives spawnSync and keeps writing
  // under .git (objects/maintenance.lock, gc work) while cleanup removes the
  // fixture, so the hosted lane saw ENOTEMPTY on rmdir .git. Disable every
  // background git writer for each fixture git invocation.
  ...fixtureGitConfig([
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
    ["gc.autoDetach", "false"],
    ["core.fsmonitor", "false"],
    ["core.untrackedCache", "false"],
    ["fetch.writeCommitGraph", "false"],
  ]),
};

function fixtureGitConfig(pairs) {
  const env = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

// COORD-833: bounded retry for the fixture directory only. fs.rmSync retries
// ENOTEMPTY/EBUSY/EPERM with linear backoff when maxRetries is set.
function removeFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function git(root, ...args) {
  const result = gitFixtureSpawn(root, args, { env: gitEnv });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout || "").trim();
}

function withGitStub(t, { mergeBaseStatus = 2, mergeBaseStderr = "injected git merge-base failure", resolvedOid = null, successfulAncestryChecks = 0 }, run) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "coord809-git-stub-"));
  const executable = path.join(bin, "git");
  const tallyPath = path.join(bin, "merge-base-count");
  const code = `#!${process.execPath}\n` +
    `const args = process.argv.slice(2);\n` +
    `const op = args[2];\n` +
    `if (op === "merge-base") {
      const fs = require("node:fs");
      const tally = ${JSON.stringify(tallyPath)};
      const count = fs.existsSync(tally) ? Number(fs.readFileSync(tally, "utf8")) : 0;
      fs.writeFileSync(tally, String(count + 1));
      if (count < ${successfulAncestryChecks}) process.exit(0);
      ${JSON.stringify(mergeBaseStderr)} && process.stderr.write(${JSON.stringify(mergeBaseStderr)}); process.exit(${mergeBaseStatus}); }\n` +
    `if (op === "rev-parse") { process.stdout.write(${resolvedOid === null ? 'args.at(-1).replace(/\\^\\{commit\\}$/, "") + "\\n"' : JSON.stringify(resolvedOid)}); process.exit(0); }\n` +
    `process.stderr.write("unexpected fake git operation: " + args.join(" ")); process.exit(2);\n`;
  fs.writeFileSync(executable, code, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath || ""}`;
  try {
    return run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

function buildGraph(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord809-pr-evidence-"));
  t.after(() => removeFixture(root));
  gitFixture(root, ["init", "-b", "dev"], { env: gitEnv });
  // Persist the same settings in the fixture so git run by the module under test
  // (with its own environment) cannot start background work either.
  git(root, "config", "maintenance.auto", "false");
  git(root, "config", "gc.auto", "0");
  git(root, "config", "gc.autoDetach", "false");
  git(root, "config", "core.fsmonitor", "false");
  fs.writeFileSync(path.join(root, "state.txt"), "base\n");
  git(root, "add", "state.txt");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-b", "agent/codexa755-COORD-809-feature");
  fs.writeFileSync(path.join(root, "state.txt"), "reviewed source\n");
  git(root, "commit", "-am", "reviewed source");
  const source = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "later.txt"), "PR head\n");
  git(root, "add", "later.txt");
  git(root, "commit", "-m", "PR head update");
  const head = git(root, "rev-parse", "HEAD");
  const tree = git(root, "rev-parse", `${head}^{tree}`);
  const prMerge = spawnSync("git", ["-C", root, "commit-tree", tree, "-p", base, "-m", "fixture GitHub squash merge"], {
    encoding: "utf8", env: gitEnv,
  });
  assert.equal(prMerge.status, 0, prMerge.stderr);
  const mergeSha = prMerge.stdout.trim();
  git(root, "update-ref", "refs/heads/gh-pr-merge", mergeSha);
  git(root, "checkout", "dev");
  git(root, "merge", "--no-ff", "-m", "governed integration", "gh-pr-merge");
  const integration = git(root, "rev-parse", "HEAD");
  const unrelated = git(root, "commit-tree", tree, "-p", base, "-m", "unrelated integration");
  return { root, base, source, head, mergeSha, integration, unrelated };
}

function input(graph, overrides = {}) {
  const url = "https://github.com/Softsensor-org/coord-template/pull/809";
  const payload = {
    number: 809,
    url,
    state: "MERGED",
    mergedAt: "2026-10-06T14:00:00Z",
    headRefName: "agent/codexa755-COORD-809-feature",
    headRefOid: graph.head,
    baseRefName: "dev",
    mergeCommit: { oid: graph.mergeSha },
  };
  return {
    ticketId: "COORD-809",
    refs: [url],
    verifiedPrs: [{ ref: url, payload }],
    expectedRepository: "Softsensor-org/coord-template",
    selectedBaseRef: "refs/heads/dev",
    sourceCommitSha: graph.source,
    repoRoot: graph.root,
    ...overrides,
  };
}

test("COORD-809: binds one merged PR and an older reviewed source to the exact head", (t) => {
  const graph = buildGraph(t);
  const proof = evidence.verifyControlPlanePrEvidence(input(graph));
  assert.equal(proof.source_commit_sha, graph.source);
  assert.equal(proof.head_sha, graph.head);
  assert.equal(proof.merge_sha, graph.mergeSha);
  assert.equal(proof.base_ref, "dev");
  assert.equal(proof.repository, "softsensor-org/coord-template");
  assert.equal(proof.url, "https://github.com/softsensor-org/coord-template/pull/809");
  for (const commit of [graph.source, graph.head]) {
    const ancestry = spawnSync("git", ["-C", graph.root, "merge-base", "--is-ancestor", commit, graph.mergeSha], { encoding: "utf8" });
    assert.equal(ancestry.status, 1, "squash evidence must not require source or head ancestry of the merge commit");
  }
  assert.equal(evidence.assertGithubMergeInIntegration({
    ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root, integrationCommitSha: graph.integration,
  }), graph.integration);
  assert.throws(() => evidence.assertGithubMergeInIntegration({
    ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root, integrationCommitSha: graph.unrelated,
  }), /not an ancestor/);
  assert.equal(evidence.assertGithubMergeInPlannedIntegration({
    ticketId: "COORD-809",
    prEvidence: proof,
    repoRoot: graph.root,
    currentHeadSha: graph.base,
    incomingBranchTips: [
      { branch: "agent/other-unrelated", head_sha: graph.unrelated },
      { branch: "agent/codexa755-COORD-809-feature", head_sha: graph.integration },
    ],
  }), graph.integration, "the planner helper considers later planned branches after an unrelated earlier candidate");
  assert.throws(() => evidence.assertGithubMergeInPlannedIntegration({
    ticketId: "COORD-809",
    prEvidence: proof,
    repoRoot: graph.root,
    currentHeadSha: graph.base,
    incomingBranchTips: [{ branch: "agent/other-unrelated", head_sha: graph.unrelated }],
  }), /before workspace merge/);
  assert.throws(() => evidence.assertGithubMergeInPlannedIntegration({
    ticketId: "COORD-809", prEvidence: { merge_sha: graph.mergeSha }, repoRoot: graph.root,
    currentHeadSha: graph.base, incomingBranchTips: [],
  }), /requires verified in-process PR evidence/);
  assert.throws(() => evidence.assertGithubMergeInPlannedIntegration({
    ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root,
    currentHeadSha: graph.base, incomingBranchTips: [{ branch: "broken-ref", head_sha: "" }],
  }), /could not resolve every planned/);
  assert.throws(() => evidence.assertGithubMergeInPlannedIntegration({
    ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root,
    currentHeadSha: "f".repeat(40), incomingBranchTips: [],
  }), /does not resolve/);
  assert.throws(() => evidence.assertGithubMergeInPlannedIntegration({
    ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root,
    currentHeadSha: "", incomingBranchTips: [],
  }), /could not resolve every planned/);
  withGitStub(t, {}, () => assert.throws(() => evidence.assertGithubMergeInPlannedIntegration({
    ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root,
    currentHeadSha: graph.base, incomingBranchTips: [{ branch: "unrelated", head_sha: graph.unrelated }],
  }), /injected git merge-base failure/));
  assert.throws(() => evidence.assertGithubMergeInPlannedIntegration({
    ticketId: "COORD-809",
    prEvidence: proof,
    repoRoot: graph.root,
    currentHeadSha: "f".repeat(40),
    incomingBranchTips: [],
  }), /does not resolve/);

  // COORD-943: every recorded PR is verified and must be present in the final
  // integration. The second PR is explicitly stacked on the primary PR merge
  // and adds an independently reviewed integrity change.
  const supplementalBranch = "agent/codexa755-COORD-809-integrity";
  git(graph.root, "checkout", "-b", supplementalBranch, graph.integration);
  fs.writeFileSync(path.join(graph.root, "integrity.txt"), "supplemental reviewed change\n");
  git(graph.root, "add", "integrity.txt");
  git(graph.root, "commit", "-m", "supplemental integrity change");
  const supplementalHead = git(graph.root, "rev-parse", "HEAD");
  const supplementalTree = git(graph.root, "rev-parse", `${supplementalHead}^{tree}`);
  const supplementalMergeResult = spawnSync("git", ["-C", graph.root, "commit-tree", supplementalTree, "-p", graph.integration, "-p", supplementalHead, "-m", "fixture supplemental PR merge"], { encoding: "utf8", env: gitEnv });
  assert.equal(supplementalMergeResult.status, 0, supplementalMergeResult.stderr);
  const supplementalMerge = supplementalMergeResult.stdout.trim();
  git(graph.root, "update-ref", "refs/heads/gh-pr-supplemental", supplementalMerge);
  git(graph.root, "checkout", "dev");
  git(graph.root, "merge", "--no-ff", "--no-edit", "-m", "integrate supplemental PR", "gh-pr-supplemental");
  const integrationWithBoth = git(graph.root, "rev-parse", "HEAD");
  const first = input(graph).verifiedPrs[0];
  const supplementalUrl = "https://github.com/Softsensor-org/coord-template/pull/810";
  const supplemental = { ref: supplementalUrl, payload: {
    number: 810,
    url: supplementalUrl,
    state: "MERGED",
    mergedAt: "2026-10-06T15:00:00Z",
    headRefName: supplementalBranch,
    headRefOid: supplementalHead,
    baseRefName: "dev",
    mergeCommit: { oid: supplementalMerge },
  } };
  const setArgs = { ...input(graph), refs: [first.ref, supplementalUrl], verifiedPrs: [first, supplemental] };
  const proofs = evidence.verifyControlPlanePrEvidenceSet(setArgs);
  assert.deepEqual(proofs.map((entry) => entry.number), [809, 810]);
  // The final ancestry check revalidates the chain after both PRs are verified.
  for (const [mergeBaseStatus, mergeBaseStderr, expected] of [
    [1, "", /not based on the preceding verified PR merge/],
    [2, "fixture ancestry failure", /could not verify supplemental PR ancestry.*fixture ancestry failure/],
    [2, "", /could not verify supplemental PR ancestry.*git merge-base exited 2/],
  ]) {
    withGitStub(t, { mergeBaseStatus, mergeBaseStderr, successfulAncestryChecks: 2 }, () => {
      assert.throws(() => evidence.verifyControlPlanePrEvidenceSet(setArgs), expected);
    });
  }

  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({ ...setArgs, refs: undefined }), /one or more PR refs/);
  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({
    ...setArgs, refs: [first.ref, "locally integrated (no PR)"],
  }), /cannot mix a no-PR marker/);
  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({
    ...setArgs, refs: [first.ref, first.ref.replace("Softsensor-org", "softsensor-org")],
  }), /duplicate PR refs/);
  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({
    ...setArgs, verifiedPrs: [first, { ref: supplementalUrl.replace("/pull/", "/issues/") }],
  }), /does not have exactly one matching live verification/);
  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({
    ...setArgs, verifiedPrs: undefined,
  }), /2 recorded, 0 verified/);
  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({
    ...setArgs, verifiedPrs: [first, first],
  }), /does not have exactly one matching live verification/);
  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({
    ...setArgs, verifiedPrs: [first, { ...supplemental, payload: { ...supplemental.payload, headRefOid: graph.head } }],
  }), /reviewed source .* is not an ancestor of PR head/);

  assert.throws(() => evidence.assertGithubMergeInIntegration({
    ticketId: "COORD-809", prEvidence: null, repoRoot: graph.root, integrationCommitSha: integrationWithBoth,
  }), /requires verified in-process PR evidence/);
  assert.equal(evidence.isVerifiedControlPlanePrEvidenceSet([...proofs]), false);
  assert.throws(() => evidence.assertGithubMergeInIntegration({
    ticketId: "COORD-809", prEvidence: [...proofs], repoRoot: graph.root, integrationCommitSha: integrationWithBoth,
  }), /requires verified in-process PR evidence/);
  assert.equal(evidence.assertGithubMergeInIntegration({
    ticketId: "COORD-809", prEvidence: proofs, repoRoot: graph.root, integrationCommitSha: integrationWithBoth,
  }), integrationWithBoth);
  assert.throws(() => evidence.assertGithubMergeInIntegration({
    ticketId: "COORD-809", prEvidence: proofs, repoRoot: graph.root, integrationCommitSha: graph.integration,
  }), /is not an ancestor/);
  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({ ...setArgs, verifiedPrs: [first] }), /every recorded PR/);
  assert.throws(() => evidence.verifyControlPlanePrEvidenceSet({
    ...setArgs, verifiedPrs: [first, { ...supplemental, payload: { ...supplemental.payload, baseRefName: "main" } }],
  }), /does not match selected/);

  const board = { landing_index: {} };
  const landingOptions = {
    layout: { coordRepoRoot: graph.root },
    base: "dev",
    sourceCommit: graph.source,
    commitSha: integrationWithBoth,
    prEvidence: proofs,
  };
  assert.throws(() => ensureControlPlaneLandingRecord(
    "COORD-809", board, {}, { ...landingOptions, prEvidence: [...proofs] }, null
  ), /multi-PR landing requires a verified, ordered PR evidence set/);
  // Even a branded set cannot authorize a landing if the selected base changed
  // between provider responses during proof construction.
  let baseReads = 0;
  const inconsistentProofs = evidence.verifyControlPlanePrEvidenceSet({
    ...setArgs,
    get selectedBaseRef() { return baseReads++ === 0 ? "dev" : "main"; },
    verifiedPrs: [first, { ...supplemental, payload: { ...supplemental.payload, baseRefName: "main" } }],
  });
  assert.deepEqual(inconsistentProofs.map((entry) => entry.base_ref), ["dev", "main"]);
  assert.throws(() => ensureControlPlaneLandingRecord(
    "COORD-809", board, {}, { ...landingOptions, prEvidence: inconsistentProofs }, null
  ), /inconsistent base attribution/);
  assert.deepEqual(board, { landing_index: {} });

  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "coord809-landing-remote-"));
  t.after(() => removeFixture(remote));
  gitFixture(remote, ["init", "--bare"], { env: gitEnv });
  git(graph.root, "remote", "add", "origin", remote);
  git(graph.root, "push", "origin", "dev:dev");
  const singleBoard = { landing_index: {} };
  const singleOptions = { ...landingOptions, prEvidence: proof };
  const singleLanding = ensureControlPlaneLandingRecord("COORD-809", singleBoard, {}, singleOptions, null);
  assert.equal(singleLanding.additional_pr_evidence, undefined);
  assert.equal(ensureControlPlaneLandingRecord("COORD-809", singleBoard, {}, singleOptions, null), singleLanding);

  const landed = ensureControlPlaneLandingRecord("COORD-809", board, {}, landingOptions, null);
  assert.equal(landed.control_plane_verification, "remote_ancestry");
  assert.equal(landed.commit_sha, integrationWithBoth);
  assert.deepEqual([landed.pr_evidence, ...landed.additional_pr_evidence], proofs);

  const recorded = structuredClone(board);
  assert.equal(ensureControlPlaneLandingRecord("COORD-809", board, {}, landingOptions, null), landed);
  assert.deepEqual(board, recorded);
  assert.equal(git(remote, "rev-parse", "refs/heads/dev"), integrationWithBoth);
});

test("PR landing requires the selected base, reviewed source, integration and remote ancestry", (t) => {
  const graph = buildGraph(t);
  git(graph.root, "branch", "main", graph.integration);
  const options = {
    layout: { coordRepoRoot: graph.root },
    base: "dev",
    sourceCommit: graph.source,
    commitSha: graph.integration,
    prEvidence: evidence.verifyControlPlanePrEvidence(input(graph)),
  };
  const board = { landing_index: {} };
  const refs = git(graph.root, "show-ref");
  for (const [override, refusal] of [
    [{ base: "main" }, /base does not match the selected control-plane base/],
    [{ sourceCommit: graph.head }, /does not match its resolved reviewed source commit/],
    [{ commitSha: undefined }, /lacks the actual governed integration commit/],
    [{}, /requires remote-ancestry verification/],
  ]) {
    assert.throws(() => ensureControlPlaneLandingRecord(
      "COORD-809", board, {}, { ...options, ...override }, null
    ), refusal);
    assert.deepEqual(board, { landing_index: {} });
    assert.equal(git(graph.root, "show-ref"), refs);
  }
});

for (const [label, overrides, expected] of [
  ["wrong requested repository", { expectedRepository: "other/repository" }, /identity does not match/],
  ["wrong returned PR", { verifiedPrs: [{ ref: "https://github.com/Softsensor-org/coord-template/pull/810", payload: input({ head:"", mergeSha:"" }).verifiedPrs[0].payload }] }, /does not match its single registered PR request/],
  ["wrong authoritative PR number", { payload: { number: 810 } }, /identity does not match/],
  ["noncanonical PR port", { payload: { url: "https://github.com:8443/Softsensor-org/coord-template/pull/809" } }, /canonical https/],
  ["explicit default PR port", { payload: { url: "https://github.com:443/Softsensor-org/coord-template/pull/809" } }, /canonical https/],
  ["PR URL userinfo", { payload: { url: "https://attacker@github.com/Softsensor-org/coord-template/pull/809" } }, /canonical https/],
  ["wrong base", { selectedBaseRef: "main" }, /does not match selected/],
  ["unmerged PR", { payload: { state: "OPEN" } }, /not verifiably merged/],
  ["unaffiliated branch", { payload: { headRefName: "agent/COORD-1809-change" } }, /not affiliated/],
  ["missing head OID", { payload: { headRefOid: null } }, /full 40-character/],
  ["missing merge OID", { payload: { mergeCommit: null } }, /full 40-character/],
  ["multiple PRs", { verifiedPrs: "multiple" }, /exactly one verified PR/],
  ["mixed PR and no-PR evidence", { refs: [...input({ head:"", mergeSha:"" }).refs, "local note (no PR)"] }, /cannot mix/],
]) {
  test(`COORD-809: refuses ${label} before producing a proof`, (t) => {
    const graph = buildGraph(t);
    const args = input(graph);
    if (overrides.payload) args.verifiedPrs[0].payload = { ...args.verifiedPrs[0].payload, ...overrides.payload };
    Object.assign(args, Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "payload")));
    assert.throws(() => evidence.verifyControlPlanePrEvidence(args), expected);
  });
}

test("COORD-809: refuses an unrelated reviewed source and unverified writer payload", (t) => {
  const graph = buildGraph(t);
  const unrelated = gitCommit(graph, "unrelated source");
  assert.throws(() => evidence.verifyControlPlanePrEvidence(input(graph, { sourceCommitSha: unrelated })), /not an ancestor/);
  assert.throws(() => evidence.assertGithubMergeInIntegration({
    ticketId: "COORD-809",
    prEvidence: { merge_sha: graph.mergeSha },
    repoRoot: graph.root,
    integrationCommitSha: graph.integration,
  }), /requires verified in-process PR evidence/);
});

test("COORD-809: malformed returned URLs and unresolved OIDs refuse before proof creation", (t) => {
  const graph = buildGraph(t);
  const valid = input(graph);
  for (const [label, args, pattern] of [
    ["malformed returned URL", { payload: { url: "not a URL" } }, /not a valid GitHub pull-request URL/],
    ["empty returned URL", { payload: { url: "" } }, /not a valid GitHub pull-request URL/],
    ["non-PR returned path", { payload: { url: "https://github.com/Softsensor-org/coord-template/issues/809" } }, /must identify one GitHub pull request/],
    ["invalid repository identity", { expectedRepository: "not-a-repository" }, /valid configured control-plane repository/],
    ["missing configured repository", { expectedRepository: "" }, /valid configured control-plane repository/],
    ["missing source OID", { sourceCommitSha: "not-a-commit" }, /full 40-character commit OID/],
    ["unresolved full source OID", { sourceCommitSha: "f".repeat(40) }, /does not resolve in the control-plane repository/],
    ["invalid merge timestamp", { payload: { mergedAt: "not-a-date" } }, /not verifiably merged/],
    ["missing PR head branch", { payload: { headRefName: "" } }, /not affiliated/],
    ["invalid ticket identity", { ticketId: "not-a-ticket" }, /not affiliated/],
    ["missing ticket identity", { ticketId: "" }, /not affiliated/],
    ["missing GitHub base", { payload: { baseRefName: null } }, /PR base \(missing\) does not match selected/],
    ["empty selected base", { selectedBaseRef: "" }, /does not match selected/],
    ["unsafe numeric PR identity", {
      refs: ["https://github.com/Softsensor-org/coord-template/pull/9007199254740992"],
      verifiedPrs: [{ ref: "https://github.com/Softsensor-org/coord-template/pull/9007199254740992", payload: { number: 9007199254740992 } }],
    }, /invalid pull-request number/],
    ["non-array registered refs", { refs: "not-an-array" }, /does not match its single registered PR request/],
    ["null registered PR ref", { refs: [null] }, /does not match its single registered PR request/],
    ["empty registered PR ref", { refs: [""] }, /does not match its single registered PR request/],
    ["missing repository", { repoRoot: null }, /has no control-plane repository/],
    ["missing verified response", { verifiedPrs: [null] }, /does not match its single registered PR request/],
  ]) {
    const argsCopy = input(graph);
    if (args.payload) argsCopy.verifiedPrs[0].payload = { ...argsCopy.verifiedPrs[0].payload, ...args.payload };
    if (Object.hasOwn(args, "expectedRepository")) argsCopy.expectedRepository = args.expectedRepository;
    if (args.sourceCommitSha) argsCopy.sourceCommitSha = args.sourceCommitSha;
    if (args.ticketId) argsCopy.ticketId = args.ticketId;
    if (Object.hasOwn(args, "ticketId")) argsCopy.ticketId = args.ticketId;
    if (Object.hasOwn(args, "selectedBaseRef")) argsCopy.selectedBaseRef = args.selectedBaseRef;
    if (Object.hasOwn(args, "refs")) argsCopy.refs = args.refs;
    if (Object.hasOwn(args, "verifiedPrs")) argsCopy.verifiedPrs = args.verifiedPrs;
    if (Object.hasOwn(args, "repoRoot")) argsCopy.repoRoot = args.repoRoot;
    assert.throws(() => evidence.verifyControlPlanePrEvidence(argsCopy), pattern, label);
  }
  assert.ok(valid.verifiedPrs[0].payload.url);
});

test("COORD-809: Git ancestry errors fail closed with and without stderr", (t) => {
  const graph = buildGraph(t);
  for (const stderr of ["injected git merge-base failure", ""]) {
    withGitStub(t, { mergeBaseStatus: 2, mergeBaseStderr: stderr }, () => {
      assert.throws(() => evidence.verifyControlPlanePrEvidence(input(graph)), /could not verify reviewed-source ancestry/);
    });
  }
  const proof = evidence.verifyControlPlanePrEvidence(input(graph));
  withGitStub(t, { mergeBaseStatus: 2, mergeBaseStderr: "" }, () => {
    assert.throws(() => evidence.assertGithubMergeInIntegration({
      ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root, integrationCommitSha: graph.integration,
    }), /git merge-base exited 2/);
  });
  withGitStub(t, { resolvedOid: "not-a-commit-oid" }, () => {
    assert.throws(() => evidence.assertGithubMergeInIntegration({
      ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root, integrationCommitSha: graph.integration,
    }), /did not resolve to a full commit OID/);
  });
  withGitStub(t, { resolvedOid: "" }, () => {
    assert.throws(() => evidence.verifyControlPlanePrEvidence(input(graph)), /did not resolve to a full commit OID/);
  });
  withGitStub(t, { mergeBaseStatus: 2, mergeBaseStderr: "" }, () => {
    assert.throws(() => evidence.assertGithubMergeInPlannedIntegration({
      ticketId: "COORD-809", prEvidence: proof, repoRoot: graph.root,
      currentHeadSha: graph.base, incomingBranchTips: [{ branch: "candidate", head_sha: graph.integration }],
    }), /git merge-base exited 2/);
  });
});

function gitCommit(graph, message) {
  fs.writeFileSync(path.join(graph.root, `unrelated-${Date.now()}.txt`), message);
  git(graph.root, "add", ".");
  git(graph.root, "commit", "-m", message);
  return git(graph.root, "rev-parse", "HEAD");
}

// COORD-1013: governed branches are agent/<handle>-<ticket-id>-<slug>; the ticket id
// must be the id right after the handle, not one that appears inside another slug.
test("COORD-1013: ticketBranchMatches uses the governed id after the handle, exact and case-insensitive", () => {
  const matches = evidence.ticketBranchMatches;
  assert.equal(matches(undefined, "agent/h1-coord-908-x"), false);
  assert.equal(matches("COORD-908-invalid", "agent/h1-coord-908-x"), false);
  assert.equal(matches("COORD-908", "agent/h1-coord-908-x"), true);
  assert.equal(matches("COORD-908", "agent/h2-coord-1012-found-by-the-coord-908-y"), false);
  assert.equal(matches("COORD-1012", "agent/h2-coord-1012-found-by-the-coord-908-y"), true);
  assert.equal(matches("COORD-51", "agent/h1-coord-512-x"), false);
  assert.equal(matches("COORD-512", "agent/h1-coord-51-x"), false);
  assert.equal(matches("COORD-512", "agent/h1-coord-512"), true);
  assert.equal(matches("coord-908", "AGENT/H1-COORD-908-X"), true);
  assert.equal(matches("COORD-908", "agent/H1-Coord-908-x"), true);
  assert.equal(matches("COORD-805", "agent/agent-x-coord-805"), true, "a handle may contain hyphens");
  assert.equal(matches("COORD-862", "agent/claudea13-coord-862-coord-516"), true);
  assert.equal(matches("COORD-516", "agent/claudea13-coord-862-coord-516"), false);
  assert.equal(matches("COORD-908", "feature/coord-908-x"), true, "non-governed branches keep the bounded-token match");
  assert.equal(matches("COORD-908", "feature/coord-9080-x"), false);
});

// COORD-1019: the golden names below were captured from the pre-change inline template
// literal in ticket-transitions.js on origin/dev d138dcbd, i.e.
// `agent/${owner.toLowerCase()}-${ticketId.toLowerCase()}-${slugify(title).slice(0, 40)}`.
// buildTicketBranchName must reproduce them byte for byte.
const BRANCH_NAME_GOLDEN = [
  { owner: "claudea807", ticketId: "COORD-1019", title: "Governance safety, follow-up of COORD-1013", branch: "agent/claudea807-coord-1019-governance-safety-follow-up-of-coord-101" },
  { owner: "independent-reviews-7", ticketId: "COORD-51", title: "short", branch: "agent/independent-reviews-7-coord-51-short" },
  { owner: "ClaudeA807", ticketId: "coord-512", title: "Fix", branch: "agent/claudea807-coord-512-fix" },
  { owner: "claudea807", ticketId: "COORD-1019", title: "Single-source the governed agent branch-name format and make every builder site call one function", branch: "agent/claudea807-coord-1019-single-source-the-governed-agent-branch-" },
  { owner: "claudea807", ticketId: "COORD-1019", title: "Fix: the `foo` (bar) — now! & more?", branch: "agent/claudea807-coord-1019-fix-the-foo-bar-now-more" },
  { owner: "claudea807", ticketId: "COORD-1019", title: "Café résumé 日本語 — ok ✓", branch: "agent/claudea807-coord-1019-caf-r-sum-ok" },
  { owner: "claudea807", ticketId: "COORD-1019", title: "!!!", branch: "agent/claudea807-coord-1019-work" },
  { owner: "claudea807", ticketId: "COORD-1019", title: `${"a".repeat(39)} bbb ccc`, branch: `agent/claudea807-coord-1019-${"a".repeat(39)}-` },
  { owner: "ops-team-lead-2", ticketId: "PILOT-001", title: "pilot ticket", branch: "agent/ops-team-lead-2-pilot-001-pilot-ticket" },
  { owner: "h2", ticketId: "COORD-51", title: "COORD-51 follow-up of COORD-512", branch: "agent/h2-coord-51-coord-51-follow-up-of-coord-512" },
  { owner: "claudea807", ticketId: "COORD-1019", title: "a".repeat(40), branch: `agent/claudea807-coord-1019-${"a".repeat(40)}` },
  { owner: "claudea807", ticketId: "COORD-1019", title: "", branch: "agent/claudea807-coord-1019-work" },
];

test("COORD-1019: buildTicketBranchName is byte-identical to the pre-change inline format", () => {
  const { buildTicketBranchName } = evidence;
  for (const row of BRANCH_NAME_GOLDEN) {
    assert.equal(buildTicketBranchName({ owner: row.owner, ticketId: row.ticketId, slug: row.title }), row.branch, `${row.owner} ${row.ticketId} "${row.title}"`);
  }
});

test("COORD-1019: the matcher round-trips every built name and rejects another ticket's id", () => {
  const { buildTicketBranchName, ticketBranchMatches } = evidence;
  const ids = [...new Set(BRANCH_NAME_GOLDEN.map((row) => row.ticketId.toLowerCase()))];
  for (const row of BRANCH_NAME_GOLDEN) {
    const name = buildTicketBranchName({ owner: row.owner, ticketId: row.ticketId, slug: row.title });
    assert.equal(ticketBranchMatches(row.ticketId, name), true, `round-trip ${name}`);
    for (const other of ids) {
      if (other === row.ticketId.toLowerCase()) continue;
      assert.equal(ticketBranchMatches(other, name), false, `${other} must not match ${name}`);
    }
  }
  // An id that only appears inside another ticket's slug never affiliates the branch.
  const slugged = buildTicketBranchName({ owner: "h2", ticketId: "COORD-512", slug: "COORD-51 follow-up" });
  assert.equal(ticketBranchMatches("COORD-512", slugged), true);
  assert.equal(ticketBranchMatches("COORD-51", slugged), false);
  assert.equal(ticketBranchMatches("COORD-51", buildTicketBranchName({ owner: "h1", ticketId: "COORD-51", slug: "x" })), true);
});

test("COORD-1019: the builder refuses a handle the matcher cannot round-trip, and an empty owner or id", () => {
  const { buildTicketBranchName } = evidence;
  // "x-coord-5-coord-1-x": the handle carries a COORD-5 token the matcher would pick up for COORD-5 first.
  assert.throws(() => buildTicketBranchName({ owner: "x-coord-5", ticketId: "COORD-1", slug: "x" }), /would not match back/);
  assert.equal(buildTicketBranchName({ owner: "codexa772", ticketId: "B-772-START", slug: "start phase" }), "agent/codexa772-b-772-start-start-phase");
  assert.throws(() => buildTicketBranchName({ owner: "", ticketId: "COORD-1", slug: "x" }), /non-empty owner/);
  assert.throws(() => buildTicketBranchName({ owner: "h1", ticketId: "", slug: "x" }), /non-empty ticket id/);
});
