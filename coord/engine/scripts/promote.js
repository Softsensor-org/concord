"use strict";

// COORD-1026 / ADR 0028 (accepted 2026-11-16, COORD-1030): `gov promote`.
//
// Moves a promoted branch forward to one exact commit that already passed the gate for its edge.
// Allowed edges are the four in ADR 0028 section 2 and nothing else. Every edge is a fast-forward:
// the target must be an ancestor of the commit, no merge commit is created, nothing is forced, and
// the remote receives the commit through a non-forced push. Release edges also record provenance as
// an annotated tag on the donor commit plus a journal event (ADR 0028 section 7, open question 3).
//
// The gate for each edge is named in coord/engine/test-policy.json under promotion_edges (ADR 0028
// section 3). The policy is read at the promoted commit, so an older policy cannot bind a gate.
//
// Refusals go through deps.fail (the CLI passes the governed fail), or throw PromoteRefusal when no
// fail is injected (fixtures). Both paths refuse before any push, tag or journal write.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { scrubIdentityEnv } = require("./agent-identity-env.js");
const approvalVerifier = require("./approval-verifier.js");

const MANIFEST_SCHEMA = "promotion-gate-manifest/1";
const POLICY_PATH = "coord/engine/test-policy.json";

// Static edge shape. The required gate names are NOT here: they come from the policy at the
// promoted commit (promotion_edges), so the gate binding is governed by test-policy.json.
const EDGES = Object.freeze({
  "dev->staging": { edition: null, release: false },
  "staging->main": { edition: null, release: false },
  "main->concord-public-release": { edition: "community", release: true },
  "main->concord-enterprise-release": { edition: "enterprise", release: true },
});

const RELEASE_BRANCH = Object.freeze({
  "concord-public-release": "community",
  "concord-enterprise-release": "enterprise",
});

class PromoteRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "PromoteRefusal";
  }
}

function throwRefusal(message) {
  throw new PromoteRefusal(message);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOk(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function parseFlags(args, refuse = throwRefusal) {
  const flags = { dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const take = () => {
      const v = args[i + 1];
      // guard:governed-push-safety
      if (v === undefined || v.startsWith("--")) refuse(`promote: ${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--from") flags.from = take();
    else if (a === "--to") flags.to = take();
    else if (a === "--commit") flags.commit = take();
    else if (a === "--remote") flags.remote = take();
    else if (a === "--gate-manifest") flags.gateManifest = take();
    else if (a === "--approval") flags.approval = take();
    else if (a === "--tag") flags.tag = take();
    // guard:governed-push-safety
    else refuse(`promote: unknown flag ${a}`);
  }
  for (const key of ["from", "to", "commit"]) {
    // guard:governed-push-safety
    if (!flags[key]) refuse(`promote: --${key} is required (ADR 0028 section 5: --from, --to, --commit)`);
  }
  flags.remote = flags.remote || "origin";
  return flags;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function revParse(repo, ref) {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

function isAncestor(repo, ancestor, descendant) {
  return gitOk(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

// The target branch must already exist on the remote. Creating a promoted or release branch is a
// separate human-admin step (ADR 0028 section 8), so the verb never creates one.
function remoteTip(repo, remote, branch) {
  const ref = `refs/remotes/${remote}/${branch}`;
  return gitOk(repo, ["rev-parse", "--verify", "--quiet", ref]) ? revParse(repo, ref) : null;
}

// Reads the gate names required for an edge from promotion_edges in the policy at the commit.
function requiredGatesFromPolicy(policyText, edge, fail) {
  let policy;
  try {
    policy = JSON.parse(policyText);
  } catch (error) {
    return fail(`promote ${edge}: ${POLICY_PATH} at the commit is not valid JSON: ${error.message}`);
  }
  const table = policy && policy.promotion_edges;
  if (!table || typeof table !== "object") {
    return fail(`promote ${edge}: ${POLICY_PATH} at the commit has no promotion_edges table, so the edge gate cannot be bound (ADR 0028 section 3)`);
  }
  const entry = table[edge];
  if (!entry || !Array.isArray(entry.gates) || entry.gates.length === 0) {
    return fail(`promote ${edge}: promotion_edges has no gates for this edge`);
  }
  return entry.gates;
}

// COORD-1043: the journal event the producer appends for each manifest it writes. It binds the manifest's
// sha256 to the edge, commit, tree and policy digest of the run that produced it.
const PRODUCER_COMMAND = "promotion-manifest";

function isProducerEventFor(event, want) {
  const details = event && event.details;
  return Boolean(details) && event.command === PRODUCER_COMMAND && event.result === "produced"
    && details.edge === want.edge && details.commit === want.commit && details.tree === want.tree
    && details.policy_sha256 === want.policySha && details.manifest_sha256 === want.sha;
}

// Gate binding: the manifest must name this edge, this exact commit, its tree and the policy that
// is in force at that commit, and every gate required by the edge must be "pass". A red gate
// refuses (ADR 0028 open question 7 is still open, so no red-baseline exception applies).
// COORD-1043: the file itself is not trusted. Its sha256 must match a journaled producer event for this
// edge, commit, tree and policy digest, so an edited or reordered manifest, or one no producer wrote, is refused.
// (A signature from COORD-1034's approval key can replace or strengthen this later.)
function readGateManifest(file, edge, commit, tree, policyText, fail, journal = []) {
  // guard:governed-push-safety
  if (!file) fail(`promote ${edge}: --gate-manifest is required; the gate must have passed on the exact commit (ADR 0028 section 3)`);
  let manifest;
  let bytes;
  try {
    bytes = fs.readFileSync(file);
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    // guard:governed-push-safety
    fail(`promote ${edge}: gate manifest unreadable: ${error.message}`);
  }
  // guard:governed-push-safety
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA) fail(`promote ${edge}: gate manifest schema must be ${MANIFEST_SCHEMA}`);
  // guard:governed-push-safety
  if (manifest.edge !== edge) fail(`promote ${edge}: gate manifest is for edge ${manifest.edge}`);
  // guard:governed-push-safety
  if (manifest.commit !== commit) fail(`promote ${edge}: gate manifest is for commit ${manifest.commit}, not ${commit}`);
  // guard:governed-push-safety
  if (manifest.tree !== tree) fail(`promote ${edge}: gate manifest tree does not match commit tree (stale tree)`);
  const policySha = sha256Hex(Buffer.from(policyText));
  // guard:governed-push-safety
  if (manifest.policy_sha256 !== policySha) fail(`promote ${edge}: gate manifest policy digest does not match the policy at this commit (older or different policy)`);
  const required = requiredGatesFromPolicy(policyText, edge, fail);
  const gates = manifest.gates && typeof manifest.gates === "object" ? manifest.gates : {};
  const missing = required.filter((name) => !(name in gates));
  // guard:governed-push-safety
  if (missing.length > 0) fail(`promote ${edge}: gate manifest is missing required gates: ${missing.join(", ")}`);
  const red = required.filter((name) => gates[name] !== "pass");
  // guard:governed-push-safety
  if (red.length > 0) {
    fail(`promote ${edge}: red gate (${red.map((name) => `${name}=${gates[name]}`).join(", ")}); promotion refuses on a red gate and the red-baseline exception for promotions is still open (ADR 0028 open question 7)`);
  }
  const sha = sha256Hex(bytes);
  // guard:governed-push-safety
  if (!journal.some((event) => isProducerEventFor(event, { edge, commit, tree, policySha, sha }))) {
    fail(`promote ${edge}: gate manifest has no journaled producer event for this edge, commit, tree and policy with sha256 ${sha}; a hand-edited, reordered or hand-written manifest is refused (COORD-1043, ADR 0028 section 3)`);
  }
  return { sha256: sha, gates: required, qualification_sha256: manifest.qualification_sha256 };
}

// Release edges need explicit human-admin approval recorded for this commit and edition
// (ADR 0028 section 4; a standing approval is not enough). The approval file is written by the
// human admin; this verb only checks it and never creates it.
function readReleaseApproval(file, edge, commit, edition, approvalState, options, deps, readJournal, fail) {
  // guard:integration-authority
  if (!file) fail(`promote ${edge}: release edge needs human-admin approval for this commit and edition (--approval, ADR 0028 section 4)`);
  let approval;
  try {
    approval = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // guard:integration-authority
    fail(`promote ${edge}: approval file unreadable: ${error.message}`);
  }
  // guard:integration-authority
  if (!approval || typeof approval.approver !== "string" || approval.approver.trim() === "") {
    fail(`promote ${edge}: approval must name the human-admin approver`);
  }
  // guard:integration-authority
  if (approval.edition !== edition) fail(`promote ${edge}: approval is for edition ${approval.edition}, not ${edition}`);
  // guard:integration-authority
  if (approval.commit !== commit) fail(`promote ${edge}: approval is for commit ${approval.commit}, not ${commit} (approval is per commit and edition)`);
  const metadata = { approver: approval.approver, approved_at: approval.approved_at || null, approval_ref: approval.approval_ref || null };
  const reason = metadata.approval_ref || `release promotion ${edge}`;
  if (options.dryRun) {
    const requirement = approvalVerifier.approvalRequirement({ verb: "promote", ticket: commit, reason, row: { ...approvalState, ...metadata } });
    return { ...metadata, signed_approval: requirement };
  }
  // ADR 0031: the JSON file preserves the human's descriptive approval record,
  // but it is not authority. The signed request binds the exact release edge,
  // commit/tree, pre-promotion target, policy and passing gate manifest.
  if (typeof deps.appendGovernanceEvent !== "function") fail(`promote ${edge}: a signed approval must be journaled before release promotion`);
  const verified = approvalVerifier.requireHumanAdminApprovalForState({
    verb: "promote",
    ticket: commit,
    reason,
    state: { ...approvalState, ...metadata },
    appendGovernanceEvent: deps.appendGovernanceEvent,
    recordUsed: (recordId) => readJournal().some((event) => event.approval_record === recordId),
    fail,
    approvalClient: deps.approvalClient,
  });
  return { ...metadata, human_admin_session: verified.session_id, approval_record: verified.record_id, approval_verified: `key_id=${verified.key_id}`, subject_sha256: verified.subject_sha256 };
}

// guard:integration-authority
function assertIntegrationAuthority(deps, edge, fail) {
  const caller = deps.resolveCaller ? deps.resolveCaller() : null;
  const record = deps.readRecord ? deps.readRecord() : null;
  const holder = record && record.holder;
  // guard:integration-authority
  if (!holder || !holder.handle) fail(`promote ${edge}: no integration-authority holder in this domain (GOVERNANCE 11.0, ADR 0028 section 4)`);
  // guard:integration-authority
  if (!caller || caller.handle !== holder.handle) {
    fail(`promote ${edge}: only the integration-authority holder (${holder.handle}) may promote (GOVERNANCE 11.0, ADR 0028 section 4)`);
  }
  return { handle: caller.handle, session_id: caller.session_id || null };
}

function defaultTagName(edition, commit) {
  return `cut/${edition}/${commit.slice(0, 12)}`;
}

// Runs the promotion. `deps` is injectable so fixtures can run without a governed runtime:
//   repo                       the git repository to promote in (default: cwd)
//   resolveCaller, readRecord  integration-authority reader
//   appendGovernanceEvent      journal appender (required for a real promotion)
//   readJournal                journal reader; the gate manifest must match a journaled producer event (COORD-1043)
//   fail                       governed refusal (default: throw PromoteRefusal)
function runPromote(args, deps = {}) {
  const fail = deps.fail || throwRefusal;
  const flags = parseFlags(args, fail);
  const repo = deps.repo || process.cwd();
  const edge = `${flags.from}->${flags.to}`;
  const spec = EDGES[edge];
  // guard:governed-push-safety
  if (flags.from === flags.to || !spec) {
    const hint = RELEASE_BRANCH[flags.to] ? " Release branches are fed only from main." : "";
    fail(`promote: edge ${edge} is not an allowed edge (ADR 0028 section 2: dev->staging, staging->main, main->concord-public-release, main->concord-enterprise-release).${hint}`);
  }
  // guard:governed-push-safety
  if (spec.release && RELEASE_BRANCH[flags.to] !== spec.edition) {
    fail(`promote: edge ${edge} does not match the release branch ${flags.to}`);
  }

  // Integration authority: the holder promotes (ADR 0028 section 4).
  const actor = assertIntegrationAuthority(deps, edge, fail);

  // Fetch so remote-tracking refs are current; this changes only remote-tracking refs.
  git(repo, ["fetch", "--quiet", flags.remote]);

  const fromTip = remoteTip(repo, flags.remote, flags.from);
  // guard:governed-push-safety
  if (!fromTip) fail(`promote ${edge}: source branch ${flags.from} does not exist on ${flags.remote}`);
  const targetBefore = remoteTip(repo, flags.remote, flags.to);
  // guard:governed-push-safety
  if (!targetBefore) {
    fail(`promote ${edge}: target branch ${flags.to} does not exist on ${flags.remote}; creating it is a separate human-admin step (ADR 0028 section 8)`);
  }

  const commit = revParse(repo, flags.commit);
  // guard:governed-push-safety
  if (!commit) fail(`promote ${edge}: commit ${flags.commit} does not resolve`);
  // guard:governed-push-safety
  if (!isAncestor(repo, commit, fromTip)) {
    fail(`promote ${edge}: commit ${commit} is not on ${flags.from} (${fromTip})`);
  }
  // guard:governed-push-safety
  if (commit === targetBefore) fail(`promote ${edge}: ${flags.to} is already at ${commit}`);
  // Fast-forward only (ADR 0028 section 5): the target must already be an ancestor of the commit.
  // guard:governed-push-safety
  if (!isAncestor(repo, targetBefore, commit)) {
    fail(`promote ${edge}: non-fast-forward. ${flags.to} (${targetBefore}) is not an ancestor of ${commit}; promotion never merges, rebases or forces (ADR 0028 section 5)`);
  }
  const distance = Number(git(repo, ["rev-list", "--count", `${targetBefore}..${commit}`]));
  const tree = git(repo, ["rev-parse", `${commit}^{tree}`]);

  // The policy in force at the promoted commit, not the working copy.
  let policyText;
  try {
    // Raw blob bytes: the digest must cover the exact file, so no trimming here.
    policyText = execFileSync("git", ["show", `${commit}:${POLICY_PATH}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // guard:governed-push-safety
    fail(`promote ${edge}: ${POLICY_PATH} is absent at ${commit}; the gate policy cannot be bound`);
  }
  // COORD-1043: the producer events. With no reader injected the list is empty and every manifest is refused.
  const readJournal = () => deps.readJournal ? deps.readJournal() : [];
  const gate = readGateManifest(flags.gateManifest, edge, commit, tree, policyText, fail, readJournal());

  const defaultTag = spec.release ? defaultTagName(spec.edition, commit) : null;
  if (gate.qualification_sha256 && (!/^[0-9a-f]{64}$/.test(gate.qualification_sha256) ||
      spec.edition !== "community" || (flags.tag && flags.tag !== defaultTag))) {
    fail(`promote ${edge}: Community qualification requires a valid digest and canonical provenance tag ${defaultTag}`);
  }

  let approval = null;
  if (spec.release) approval = readReleaseApproval(flags.approval, edge, commit, spec.edition, {
    from: flags.from, to: flags.to, commit, tree, edition: spec.edition, target_before: targetBefore,
    policy_sha256: sha256Hex(Buffer.from(policyText)), gate_manifest_sha256: gate.sha256, gates: gate.gates,
    ...(gate.qualification_sha256 ? { qualification_sha256: gate.qualification_sha256 } : {}),
  }, flags, deps, readJournal, fail);

  const tag = spec.release ? (flags.tag || defaultTag) : null;
  // guard:governed-push-safety
  if (tag && gitOk(repo, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) {
    fail(`promote ${edge}: provenance tag ${tag} already exists`);
  }

  const plan = {
    edge,
    from: flags.from,
    to: flags.to,
    commit,
    tree,
    target_before: targetBefore,
    fast_forward_distance: distance,
    gate: { gates: gate.gates, manifest_sha256: gate.sha256,
      ...(gate.qualification_sha256 ? { qualification_sha256: gate.qualification_sha256 } : {}) },
    release: spec.release ? { edition: spec.edition, tag, approval } : null,
    remote: flags.remote,
  };

  if (flags.dryRun) return { dry_run: true, promoted: false, plan };

  // guard:governed-push-safety
  if (!deps.appendGovernanceEvent) fail(`promote ${edge}: no journal appender; a promotion must be journaled`);

  // Non-forced push: git also refuses a non-fast-forward, so this is a second, independent check.
  git(repo, ["push", "--quiet", flags.remote, `${commit}:refs/heads/${flags.to}`]);

  if (tag) {
    const message = [`release provenance ${spec.edition}: donor ${commit}, tree ${tree}`];
    if (gate.qualification_sha256) {
      message.push(`Qualification-SHA256: ${gate.qualification_sha256}\nGate-Manifest-SHA256: ${gate.sha256}\nPromotion-Approval-Subject-SHA256: ${approval.subject_sha256}`);
    }
    git(repo, ["tag", "-a", tag, ...message.flatMap((part) => ["-m", part]), commit]);
    git(repo, ["push", "--quiet", flags.remote, `refs/tags/${tag}`]);
  }

  const journalEvent = {
    ts: new Date().toISOString(),
    command: "promote",
    ticket: null,
    before_status: null,
    after_status: null,
    identity: actor,
    result: "promoted",
    details: {
      edge,
      from: flags.from,
      to: flags.to,
      commit,
      tree,
      target_before: targetBefore,
      fast_forward_distance: distance,
      gate_manifest_sha256: gate.sha256,
      ...(gate.qualification_sha256 ? { qualification_sha256: gate.qualification_sha256 } : {}),
      gates: gate.gates,
      release: plan.release,
      adr_ref: "ADR-0028",
    },
    changed_paths: [],
  };
  deps.appendGovernanceEvent(journalEvent);

  return { dry_run: false, promoted: true, plan, journal: { command: "promote", result: "promoted" } };
}


// COORD-1036 / ADR 0028: the producer of the gate manifest that runPromote verifies. For an edge and a
// commit it runs the gates that the commit's own promotion_edges names, inside a detached temporary
// worktree of that commit, and writes promotion-gate-manifest/1 with each gate's real result. A gate the
// producer has no runner for is refused and never recorded as passing. A red gate is recorded as "fail".
// Fixtures inject gateRuns and nodeBinDir; the production table below is the only place gate names
// meet real commands.
const GATE_RUNS = Object.freeze({
  "full-suite-node22": { lane: "node22", shardedPromotion: true },
  "full-suite-sharded-node22": { lane: "node22", shardedPromotion: true },
  "full-suite-node24": { lane: "node24", shardedPromotion: true },
  "coverage-ratchet": { derivedFrom: "full-suite-node22" },
  // COORD-1044: the release-edge gates. Each runs the existing release script for its gate against the
  // commit (coord/engine/scripts/release-gates.js is the runner table; it reports pass only when that script passes).
  "community-cut-build": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "community-cut-build"] },
  "donor-hygiene-scan": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "donor-hygiene-scan"] },
  "release-secret-scan": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "release-secret-scan"] },
  "dual-release-verify": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "dual-release-verify"] },
  "install-canaries-npm-sea": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "install-canaries-npm-sea"] },
  "enterprise-cut-build": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "enterprise-cut-build"] },
  "enterprise-qualification": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "enterprise-qualification"] },
  "enterprise-ref-scan": { lane: "node22", argv: ["coord/engine/scripts/release-gates.js", "enterprise-ref-scan"] },
});
const SHARED_NODE_BIN = Object.freeze({ node22: "/mnt/disk/shared/node/v22/bin", node24: "/mnt/disk/shared/node/v24/bin" });
const GATE_TIMEOUT_MS = 3600 * 1000;
const RELEASE_GATE_CLI = "coord/engine/scripts/release-gates.js";

function releaseGateCachePath(spec, reportDir) {
  return spec && Array.isArray(spec.argv) && spec.argv[0] === RELEASE_GATE_CLI
    ? path.join(path.dirname(reportDir), "release-gate-cuts")
    : null;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Runs one gate in cwd with its lane's Node first on PATH. The gate passes only with exit 0 and a report
// whose result is "pass"; the ratchet is read from the report when the gate measures coverage.
function runGateCommand(spec, { cwd, reportDir, nodeBinDir, gate }) {
  const binDir = nodeBinDir[spec.lane];
  const node = path.join(binDir, "node");
  const env = { ...scrubIdentityEnv(process.env), PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}` };
  // Release cuts are expensive and reused by several sequential gate subprocesses
  // in this one manifest run. Keep their cache under the producer's fresh temp
  // workdir so another invocation cannot authorize reuse from a writable old cache.
  const releaseCache = releaseGateCachePath(spec, reportDir);
  if (releaseCache) env.COORD_RELEASE_GATE_CACHE = releaseCache;
  const version = spawnSync(node, ["--version"], { cwd, env, encoding: "utf8" });
  const output = path.join(reportDir, gate);
  const report = spec.shardedPromotion
    ? path.join(output, "test-policy-report.json")
    : path.join(reportDir, `${gate}.json`);
  const argv = spec.shardedPromotion
    ? ["coord/scripts/governance.js", "test-policy", "run", "--stage", "promotion",
      "--head", git(cwd, ["rev-parse", "HEAD"]), "--shards", "auto", "--out", output]
    : [...spec.argv, "--report", report];
  const startedAt = process.hrtime.bigint();
  const run = spawnSync(node, argv, { cwd, env, stdio: "inherit", timeout: GATE_TIMEOUT_MS, killSignal: "SIGKILL" });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const parsed = readJsonFile(report);
  const runner = spec.shardedPromotion ? readJsonFile(path.join(output, "runner-report.json")) : parsed;
  const pass = run.status === 0 && parsed?.result === "pass"
    && (!spec.shardedPromotion || (parsed.qualification === "donor receipt verified"
      && runner?.engine_coverage?.ratchet?.result === "pass"));
  return {
    lane: spec.lane,
    node_version: version.status === 0 ? version.stdout.trim() : null,
    exit_code: run.status,
    pass,
    diagnostic: pass
      ? null
      : parsed && parsed.detail
        ? parsed.detail
        : run.error
          ? run.error.message
          : run.signal
            ? `gate process terminated by ${run.signal}`
            : `gate exited ${run.status}`,
    ...(parsed?.qualification_receipt ? { qualification_receipt: parsed.qualification_receipt } : {}),
    ratchet: runner?.engine_coverage?.ratchet?.result ?? null,
    duration_ms: Number(durationMs.toFixed(3)),
  };
}

// opts: { edge, commit, out, dryRun }. deps: { repo, fail, gateRuns, nodeBinDir }.
// Dry run resolves the edge, commit, tree, policy digest and gate lanes, and runs nothing.
function produceGateManifest(opts = {}, deps = {}) {
  const fail = deps.fail || throwRefusal;
  const { edge, commit: requestedCommit, out, dryRun = false } = opts;
  const repo = deps.repo || process.cwd();
  const runs = deps.gateRuns || GATE_RUNS;
  const nodeBinDir = deps.nodeBinDir || SHARED_NODE_BIN;
  // guard:governed-push-safety
  if (!edge) fail("promote-manifest: --edge is required");
  // guard:governed-push-safety
  if (!Object.hasOwn(EDGES, edge)) fail(`promote-manifest: edge ${edge} is not an allowed edge (ADR 0028 section 2)`);
  // guard:governed-push-safety
  if (!requestedCommit) fail("promote-manifest: --commit is required");
  // guard:governed-push-safety
  if (!dryRun && !out) fail("promote-manifest: --out is required (a dry run writes nothing)");
  let commit = null;
  try {
    commit = revParse(repo, requestedCommit);
  } catch {
    commit = null;
  }
  // guard:governed-push-safety
  if (!commit) fail(`promote-manifest ${edge}: commit ${requestedCommit} does not resolve`);
  const tree = git(repo, ["rev-parse", `${commit}^{tree}`]);
  let policyText;
  try {
    policyText = execFileSync("git", ["show", `${commit}:${POLICY_PATH}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // guard:governed-push-safety
    fail(`promote-manifest ${edge}: ${POLICY_PATH} is absent at ${commit}; the gate policy cannot be bound`);
  }
  const required = requiredGatesFromPolicy(policyText, edge, fail);
  const unrunnable = required.filter((gate) => !runs[gate]);
  // guard:governed-push-safety
  if (unrunnable.length > 0) {
    fail(`promote-manifest ${edge}: no runner for gate(s) ${unrunnable.join(", ")}; this verb never records a gate it did not run as passing`);
  }
  // guard:governed-push-safety
  for (const gate of required) {
    const source = runs[gate].derivedFrom;
    if (source && !required.includes(source)) fail(`promote-manifest ${edge}: gate ${gate} is measured by ${source}, which the edge does not name`);
  }
  const laneOf = (gate) => runs[gate].lane || runs[runs[gate].derivedFrom].lane;
  const plan = { edge, commit, tree, policy_sha256: sha256Hex(Buffer.from(policyText)), gates: required.map((gate) => ({ gate, lane: laneOf(gate) })) };
  if (dryRun) return { dry_run: true, produced: false, plan };
  // guard:governed-push-safety
  if (!deps.appendGovernanceEvent) fail(`promote-manifest ${edge}: no journal appender; a produced manifest must be journaled so promote can bind it (COORD-1043)`);

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-promote-gates-"));
  const worktree = path.join(workdir, "tree");
  const reportDir = path.join(workdir, "reports");
  fs.mkdirSync(reportDir);
  git(repo, ["worktree", "add", "--detach", "--quiet", worktree, commit]);
  try {
    // guard:governed-push-safety
    if (git(worktree, ["rev-parse", "HEAD^{tree}"]) !== tree) fail(`promote-manifest ${edge}: checked-out tree does not match ${tree}`);
    const outcome = {};
    for (const gate of required) {
      if (!runs[gate].derivedFrom) outcome[gate] = runGateCommand(runs[gate], { cwd: worktree, reportDir, nodeBinDir, gate });
    }
    const gates = {};
    for (const gate of required) {
      const source = runs[gate].derivedFrom;
      if (source) {
        const measured = outcome[source];
        outcome[gate] = { lane: laneOf(gate), pass: Boolean(measured && measured.pass && measured.ratchet === "pass") };
      }
      gates[gate] = outcome[gate].pass ? "pass" : "fail";
    }
    const manifest = { schema: MANIFEST_SCHEMA, edge, commit, tree, policy_sha256: plan.policy_sha256, gates };
    let qualificationFile;
    const qualification = outcome["dual-release-verify"]?.qualification_receipt;
    const cache = releaseGateCachePath(runs["dual-release-verify"], reportDir);
    if (EDGES[edge].edition === "community" && outcome["dual-release-verify"]?.pass && cache) {
      if (!qualification || typeof qualification.path !== "string") {
        fail(`promote-manifest ${edge}: passing dual release gate did not report its qualification receipt`);
      }
      const file = path.resolve(qualification.path);
      if (!file.startsWith(path.resolve(cache) + path.sep) ||
          !fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() ||
          !fs.realpathSync(file).startsWith(fs.realpathSync(cache) + path.sep)) {
        fail(`promote-manifest ${edge}: qualification receipt must come from this invocation's release gate cache`);
      }
      const receipt = fs.readFileSync(file);
      if (sha256Hex(receipt) !== qualification.sha256) {
        fail(`promote-manifest ${edge}: qualification receipt changed after dual verification`);
      }
      manifest.qualification_sha256 = qualification.sha256;
      qualificationFile = `${path.resolve(out)}.qualification-${qualification.sha256}.json`;
      fs.mkdirSync(path.dirname(qualificationFile), { recursive: true });
      try {
        fs.writeFileSync(qualificationFile, receipt, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST" || sha256Hex(fs.readFileSync(qualificationFile)) !== qualification.sha256) throw error;
      }
    }
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    // COORD-1043: journal the sha256 of the exact bytes before the file exists, so promote can bind them.
    deps.appendGovernanceEvent({
      ts: new Date().toISOString(),
      command: PRODUCER_COMMAND,
      ticket: null,
      before_status: null,
      after_status: null,
      identity: null,
      result: "produced",
      details: { edge, commit, tree, policy_sha256: plan.policy_sha256, manifest_sha256: sha256Hex(bytes), gates,
        ...(manifest.qualification_sha256 ? { qualification_sha256: manifest.qualification_sha256 } : {}), adr_ref: "ADR-0028" },
      changed_paths: [],
    });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), bytes);
    const red = Object.keys(gates).filter((gate) => gates[gate] !== "pass");
    return { dry_run: false, produced: true, manifest_file: path.resolve(out), manifest, red, runs: outcome, plan, ...(qualificationFile ? { qualification_file: qualificationFile } : {}) };
  } finally {
    try {
      git(repo, ["worktree", "remove", "--force", worktree]);
    } catch {
      // The directory is removed below; the prune clears the stale registration.
    }
    fs.rmSync(workdir, { recursive: true, force: true });
    git(repo, ["worktree", "prune"]);
  }
}

module.exports = {
  EDGES,
  GATE_RUNS,
  MANIFEST_SCHEMA,
  POLICY_PATH,
  PromoteRefusal,
  parseFlags,
  produceGateManifest,
  runPromote,
  sha256Hex,
};
