"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const wizard = require("./coord-init-wizard.js");
const { suggestPresetFromSignals } = require("./track-presets.js");

const TARGET_ROOT = Symbol("concord.onboard.target_root");
const ONBOARD_RECEIPT_REL = "coord/onboarding.receipt.json";
const ONBOARD_CONTEXT_REL = "coord/onboarding.context.json";
const CONTEXT_SENSITIVITY = new Set(["public", "internal", "confidential", "restricted"]);
const SENSITIVE_METADATA = /(secret|password|passwd|token|credential|private[_ -]?key|api[_ -]?key|bearer\s)/i;
const PACKAGE_MARKERS = Object.freeze([
  ["package.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
]);
const AGENT_SHIMS = Object.freeze(["AGENTS.md", "CLAUDE.md", "CODEX.md", "GEMINI.md"]);
const REQUIREMENT_POINTERS = Object.freeze(["REQUIREMENTS.md", "PRD.md", "URS.md", "docs/REQUIREMENTS.md"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
}

// COORD-477: read-only classification of the onboarding target's Git state so
// the plan can carry bootstrap-pending next steps for an unborn repository
// instead of leaving the adopter to hit generic drift errors later.
// COORD-631/ADR-0008: the classified directory is `coord/` — the independent
// control-plane repository — NOT the workspace container, which is never a Git
// repository at all. The container's own state is reported separately as
// evidence so migration advice can name it without ever acting on it.
// Metadata-only git plumbing reads; never a mutation, never file contents.
function detectCoordGitState(workspaceRoot, runGit = null) {
  const run = runGit || ((args) => spawnSync("git", args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }));
  const coordDir = path.resolve(workspaceRoot, "coord");
  const container = path.resolve(workspaceRoot);
  const containerTop = run(["-C", container, "rev-parse", "--show-toplevel"]);
  const containerIsRepo = Boolean(containerTop && containerTop.status === 0 &&
    path.resolve(String(containerTop.stdout || "").trim()) === container);
  const base = { coord_dir: coordDir, container, container_is_git_repository: containerIsRepo };
  // Probe the nearest existing directory, so a not-yet-created coord/ inside a
  // legacy container repository still classifies as "ancestor" rather than
  // "outside" (same discipline as the installer's captureRootGitState).
  const probe = fs.existsSync(coordDir) ? coordDir : container;
  const top = run(["-C", probe, "rev-parse", "--show-toplevel"]);
  if (!top || top.status !== 0) return { ...base, state: "outside", root: null };
  const gitRoot = path.resolve(String(top.stdout || "").trim());
  // coord/ sits inside SOME OTHER repository (the container, or an ancestor of
  // it). That is never bootstrap-pending: the answer is a reviewed migration to
  // an independent coord/.git, never initializing or committing what is there.
  if (gitRoot !== coordDir) return { ...base, state: "ancestor", root: gitRoot };
  const head = run(["-C", gitRoot, "rev-parse", "--verify", "HEAD"]);
  return { ...base, state: head && head.status === 0 ? "established" : "unborn", root: gitRoot };
}

function parseArgs(argv = []) {
  const opts = {
    dryRun: true,
    write: false,
    force: false,
    repo: null,
    approve: null,
    approveStarters: false,
    contextPack: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--write") {
      opts.write = true;
      opts.dryRun = false;
    } else if (arg === "--force") opts.force = true;
    else if (arg === "--approve-starters") opts.approveStarters = true;
    else if (arg === "--approve" || arg.startsWith("--approve=")) {
      opts.approve = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!opts.approve) throw new Error("onboard: --approve requires the reviewed plan digest");
    } else if (arg === "--context-pack" || arg.startsWith("--context-pack=")) {
      opts.contextPack = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!opts.contextPack) throw new Error("onboard: --context-pack requires a JSON file");
    }
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!opts.repo) opts.repo = arg;
    else throw new Error(`onboard: unexpected argument ${arg}`);
  }
  return opts;
}

// COORD-624: Concord is a SIBLING of the product repositories it governs, so
// onboarding a workspace discovers the sibling repositories and records each by
// its RELATIVE sibling path. Discovery is metadata-only (directory names + `.git`
// presence): the repositories are recorded, never initialized, onboarded or
// written to. Repo codes are the first free uppercase letter of the directory
// name ("X" stays reserved for coord/cross-repo work).
const SIBLING_SKIP = new Set(["coord", "node_modules", ".git", ".claude", ".github", ".worktrees", ".runtime"]);

function discoverSiblingRepos(targetRoot, fsImpl = fs) {
  let entries;
  try { entries = fsImpl.readdirSync(targetRoot, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && !SIBLING_SKIP.has(entry.name) && !entry.name.startsWith("."))
    .filter((entry) => fsImpl.existsSync(path.join(targetRoot, entry.name, ".git")))
    .map((entry) => entry.name)
    .sort();
}

function assignRepoCodes(names) {
  const used = new Set(["X"]);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWZ".split("");
  return names.map((name) => {
    const preferred = (name.match(/[A-Za-z]/) || ["R"])[0].toUpperCase();
    let code = !used.has(preferred) ? preferred : alphabet.find((letter) => !used.has(letter));
    if (!code) code = preferred; // exhausted: fall back (validation reports the clash)
    used.add(code);
    return { code, name };
  });
}

function defaultGitRunner(args) {
  return spawnSync("git", args, {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
}

function gitOk(result) {
  return Boolean(result) && result.status === 0;
}

function gitText(result) {
  return String((result && result.stdout) || "").trim();
}

function summarizeDirtyState(raw) {
  const byCode = {};
  for (const record of String(raw || "").split("\0").filter(Boolean)) {
    const code = record.slice(0, 2).replace(/\s/g, "_");
    byCode[code] = (byCode[code] || 0) + 1;
  }
  return {
    dirty: Object.keys(byCode).length > 0,
    entries: Object.values(byCode).reduce((sum, count) => sum + count, 0),
    by_code: Object.fromEntries(Object.entries(byCode).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function readPackageScriptNames(repoRoot, fsImpl = fs) {
  const packagePath = path.join(repoRoot, "package.json");
  if (!fsImpl.existsSync(packagePath)) return [];
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(packagePath, "utf8"));
    return Object.keys(parsed && typeof parsed.scripts === "object" ? parsed.scripts : {})
      .filter((name) => name === "test" || name.startsWith("test:"))
      .sort();
  } catch {
    return [];
  }
}

// COORD-479: discovery is a closed metadata allowlist. In particular, this
// function never walks arbitrary source, never asks Git for remotes or config,
// and never retains path-bearing porcelain output. The only file content it
// opens is package.json, solely to retain TEST SCRIPT NAMES (not bodies).
function discoverRepoMetadata(targetRoot, repoName, options = {}) {
  const fsImpl = options.fs || fs;
  const runGit = options.runGit || defaultGitRunner;
  const repoRoot = path.join(targetRoot, repoName);
  const headResult = runGit(["-C", repoRoot, "rev-parse", "--verify", "HEAD"]);
  const branchResult = runGit(["-C", repoRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const statusResult = runGit(["-C", repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  const hasMain = gitOk(runGit(["-C", repoRoot, "show-ref", "--verify", "--quiet", "refs/heads/main"]));
  const hasDev = gitOk(runGit(["-C", repoRoot, "show-ref", "--verify", "--quiet", "refs/heads/dev"]));
  const branch = gitOk(branchResult) ? gitText(branchResult) : null;
  const integrationBranch = hasMain ? "main" : (hasDev ? "dev" : (branch || "main"));
  const packageManagers = Array.from(new Set(PACKAGE_MARKERS
    .filter(([marker]) => fsImpl.existsSync(path.join(repoRoot, marker)))
    .map(([, manager]) => manager))).sort();
  return {
    path: repoName,
    git: {
      head: gitOk(headResult) ? gitText(headResult) : null,
      branch,
      integration_branch: integrationBranch,
      dirty_summary: gitOk(statusResult)
        ? summarizeDirtyState(statusResult.stdout)
        : { dirty: null, entries: null, by_code: {} },
    },
    package_managers: packageManagers,
    declared_test_scripts: readPackageScriptNames(repoRoot, fsImpl),
    agent_shims: AGENT_SHIMS.filter((name) => fsImpl.existsSync(path.join(repoRoot, name))),
    requirement_pointers: REQUIREMENT_POINTERS.filter((name) => fsImpl.existsSync(path.join(repoRoot, name))),
  };
}

function safeShapeFromMetadata(metadata) {
  const signals = new Set();
  const scripts = new Set();
  for (const repo of metadata) {
    for (const manager of repo.package_managers) {
      if (["npm", "pnpm", "yarn", "bun"].includes(manager)) signals.add("node");
      else signals.add(manager);
    }
    if (repo.requirement_pointers.length > 0) signals.add("requirements-source");
    for (const script of repo.declared_test_scripts) scripts.add(script);
  }
  return {
    root: ".",
    repo_count: metadata.length,
    repo_paths: metadata.map((repo) => repo.path),
    shape: metadata.length > 1 ? "multi-repo" : "single-repo",
    signals: [...signals].sort(),
    package_scripts: [...scripts].sort(),
  };
}

function defaultTestCommand(repo) {
  const script = repo?.declared_test_scripts?.includes("test")
    ? "test"
    : repo?.declared_test_scripts?.[0];
  if (!script) return "coord/scripts/gov conform";
  const manager = ["pnpm", "yarn", "bun", "npm"].find((name) => repo.package_managers.includes(name)) || "npm";
  return script === "test" ? `${manager} test` : `${manager} run ${script}`;
}

function defaultRepoAnswers(targetRoot, preset, siblings = [], metadata = [], fsImpl = fs) {
  const byPath = new Map(metadata.map((repo) => [repo.path, repo]));
  const repos = siblings.length
    ? assignRepoCodes(siblings).map(({ code, name }) => ({
      code,
      // RELATIVE sibling path — resolved against the workspace root, which is
      // one level above coord/. Never "." and never an absolute path.
      path: name,
      integrationBranch: byPath.get(name)?.git?.integration_branch || "main",
      testCommand: defaultTestCommand(byPath.get(name)),
      ticketPrefixes: preset.prefixes.slice(0, 2),
    }))
    : [];
  return {
    coordTicketPrefix: "COORD",
    repos,
    profile: null,
    phase: null,
    tier: siblings.length > 1 ? "standard" : "lite",
    tracks: preset.tracks,
    gates: preset.gates,
  };
}

function assertSafeReference(value, label) {
  const text = String(value || "").trim();
  const segments = text.replace(/\\/g, "/").split("/");
  if (!text || text.length > 500 || path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) ||
      segments.includes("..") || /^file:/i.test(text) || /[\u0000-\u001f\u007f]/.test(text) ||
      /:\/\/[^/\s@]+@/.test(text) || SENSITIVE_METADATA.test(text)) {
    throw new Error(`onboard: context pack ${label} is missing or unsafe; use a short non-secret, non-absolute citation reference`);
  }
  return text;
}

function normalizeContextPack(targetRoot, inputPath, fsImpl = fs) {
  if (!inputPath) return null;
  const absolute = path.resolve(targetRoot, inputPath);
  const inputName = path.basename(absolute);
  if (/^\.env(?:\.|$)/i.test(inputName) || SENSITIVE_METADATA.test(inputName)) {
    throw new Error("onboard: context pack path is classified as sensitive and was not read");
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(absolute, "utf8");
  } catch {
    throw new Error("onboard: context pack could not be read");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("onboard: context pack must be valid JSON");
  }
  const sensitivity = String(parsed.sensitivity || "").trim().toLowerCase();
  if (!CONTEXT_SENSITIVITY.has(sensitivity)) {
    throw new Error("onboard: context pack sensitivity must be public, internal, confidential, or restricted");
  }
  const freshness = assertSafeReference(parsed.freshness, "freshness");
  const sourceRef = assertSafeReference(
    (parsed.source && (parsed.source.ref || parsed.source.id)) || parsed.source_ref || path.basename(absolute),
    "source",
  );
  if (!Array.isArray(parsed.citations) || parsed.citations.length === 0) {
    throw new Error("onboard: context pack requires at least one citation");
  }
  const citations = parsed.citations.map((citation, index) => {
    const item = typeof citation === "string" ? { ref: citation } : (citation || {});
    return {
      id: assertSafeReference(item.id || `citation-${index + 1}`, `citation ${index + 1} id`),
      ref: assertSafeReference(item.ref || item.uri || item.source, `citation ${index + 1} ref`),
    };
  });
  return {
    kind: "concord.onboarding_context_reference",
    schema_version: 1,
    authority: "advisory",
    promotion_status: "unpromoted",
    source: { ref: sourceRef },
    freshness,
    sensitivity,
    citations,
    content_digest: digest(raw),
  };
}

function sanitizeCoordGit(coordGit) {
  return {
    state: coordGit.state,
    coord_dir: "coord",
    container: ".",
    container_is_git_repository: coordGit.container_is_git_repository,
    root: coordGit.state === "established" || coordGit.state === "unborn"
      ? "coord"
      : (coordGit.state === "ancestor" ? "external-ancestor" : null),
  };
}

function starterTicketSpecs(preset) {
  return [
    { repo: "X", type: "chore", pri: "P2", title: "Confirm Concord repo map and ticket prefixes" },
    { repo: "X", type: "test", pri: "P2", title: "Record first local gate baseline" },
    { repo: "X", type: "docs", pri: "P2", title: "Add first requirements or URS baseline pointer" },
  ].map((ticket) => ({
    ...ticket,
    status: "proposed",
    proposal_key: digest({ preset: preset.id, ...ticket }).slice(0, 20),
  }));
}

function buildOnboardPlan(targetRoot, options = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  const fsImpl = options.fs || fs;
  const siblings = discoverSiblingRepos(root, fsImpl);
  if (!siblings.length) {
    // COORD-624: onboarding maps a WORKSPACE to its sibling product
    // repositories. With none present there is nothing to map, and inventing a
    // `path: "."` entry would re-create the very topology this ticket removes
    // (Concord governing the directory it is installed in).
    throw new Error(
      `onboard: no sibling product repositories found in ${root}.\n` +
      "  Concord governs product repositories that sit BESIDE coord/ in the workspace:\n" +
      "      project-workspace/\n" +
      "      |-- coord/        <- the control plane (here)\n" +
      "      |-- repo-one/     <- an independent product Git repository\n" +
      "      `-- repo-two/\n" +
      "  Clone or move your repositories into this workspace and re-run `coord onboard . --write`.\n" +
      "  Onboarding only RECORDS them in coord/project.config.js — it never initializes, onboards\n" +
      "  or writes into a product repository."
    );
  }
  const repoMetadata = siblings.map((name) => discoverRepoMetadata(root, name, options));
  const shape = safeShapeFromMetadata(repoMetadata);
  const preset = options.preset || suggestPresetFromSignals(shape.signals);
  const provisional = defaultRepoAnswers(root, preset, siblings, repoMetadata, fsImpl);
  const firstSetup = JSON.parse(wizard.generateSetupDecisionArtifact(provisional, { targetRoot: ".", shape }));
  const answers = {
    ...provisional,
    profile: firstSetup.decisions.adoption_profile.id,
    phase: firstSetup.decisions.governance_phase.id,
    tracks: firstSetup.decisions.tracks,
    gates: firstSetup.decisions.gates,
  };
  const setup = JSON.parse(wizard.generateSetupDecisionArtifact(answers, { targetRoot: ".", shape }));
  const starterTickets = starterTicketSpecs(preset);
  const rawCoordGit = detectCoordGitState(root, options.runGit);
  const coordGit = sanitizeCoordGit(rawCoordGit);
  const contextPack = normalizeContextPack(root, options.contextPack, fsImpl);
  const nextSteps = [
    `Review coord/project.config.js: ${siblings.length} sibling product repository/ies were RECORDED by relative path (${siblings.join(", ")}). None was initialized, onboarded or written to.`,
    "Run coord doctor --dir <repo>.",
    "Commit setup artifacts through the governed lane.",
    "File the starter tickets only after repo owners confirm the preset.",
  ];
  if (coordGit.state === "unborn") {
    // COORD-477: bootstrap-pending — governed work needs a first baseline
    // commit; staging stays an exact allowlist, never `git add .` / `-A`.
    // COORD-631: the directory named here is coord/, never the container.
    nextSteps.unshift(
      "coord is bootstrap-pending (control-plane Git repository with no commits): stage the installer's exact allowlist (--git-stage) and create the baseline commit (--git-baseline-commit), or commit the reviewed staged files manually from inside coord/ — never `git add .` / `git add -A`. `coord/scripts/gov doctor` prints the exact steps."
    );
  } else if (coordGit.state === "ancestor") {
    // COORD-631/ADR-0008: coord/ is tracked by some OTHER repository. Never
    // advise (or perform) initializing or committing the container; the only
    // correct move is an explicit, reviewed migration to an independent
    // coord/.git.
    nextSteps.unshift(
      "coord is inside an external ancestor Git repository, not an independent control-plane repository. ADR-0008: the workspace container is never a Git repository and is never initialized, relocated or removed automatically. Migrating an existing parent-Git installation to an independent coord/.git is an explicit, reviewed, backed-up human action."
    );
  }
  const plan = {
    kind: "concord.onboard_plan",
    schema_version: 2,
    target_root: ".",
    mode: "preview",
    topology: "sibling-workspace",
    sibling_product_repositories: siblings,
    product_repositories_written: false,
    shape,
    preset,
    coord_git: coordGit,
    workspace_container_git: {
      path: ".",
      is_git_repository: coordGit.container_is_git_repository,
      never_initialized: "the workspace container is never a Git repository — absence is the control, not consent (ADR-0008)",
    },
    discovery: {
      metadata_allowlist: [
        "repository boundary",
        "Git HEAD and branch",
        "redacted dirty-state counts",
        "package-manager markers",
        "declared test script names",
        "agent shim presence",
        "known requirement pointers",
      ],
      repositories: repoMetadata,
      explicitly_excluded: [
        ".env* and ignored sensitive paths",
        "credentials, key material, and credential helpers",
        "remote URLs and Git configuration",
        "arbitrary source contents and raw command output",
      ],
    },
    decisions: {
      repos: answers.repos,
      governance_tier: answers.tier,
      adoption_profile: answers.profile,
      governance_phase: answers.phase,
      tracks: answers.tracks,
      gates: answers.gates,
      setup: setup.decisions,
    },
    project_config_preview: wizard.generateProjectConfig(answers),
    setup_decisions: setup,
    context_pack: contextPack,
    starter_tickets: starterTickets,
    next_steps: nextSteps,
    safety: {
      dry_run_write_free: true,
      product_repositories_written: false,
      private_absolute_paths_persisted: false,
      raw_source_or_git_output_persisted: false,
      starter_ticket_status: "proposed-only-after-explicit-approval",
    },
  };
  plan.plan_digest = digest(plan);
  Object.defineProperty(plan, TARGET_ROOT, { value: root, enumerable: false });
  return plan;
}

function onboardingApproval(plan, options = {}) {
  if (options.approve) {
    if (options.approve !== plan.plan_digest) {
      throw new Error(`onboard: reviewed plan digest does not match; expected ${plan.plan_digest}`);
    }
    return { kind: "reviewed_onboard_plan", digest: plan.plan_digest };
  }
  const installDigest = String(options.installPlanDigest || "").trim();
  const expectedOnboardDigest = String(options.expectedOnboardPlanDigest || "").trim();
  if (/^[a-f0-9]{64}$/i.test(installDigest) && expectedOnboardDigest === plan.plan_digest) {
    return { kind: "reviewed_install_plan", digest: installDigest, onboard_plan_digest: plan.plan_digest };
  }
  throw new Error(
    `onboard: apply requires explicit approval. Review the dry-run plan and retry with --approve ${plan.plan_digest}`,
  );
}

function statFile(filePath, fsImpl = fs) {
  try {
    const stat = fsImpl.lstatSync(filePath);
    if (!stat.isFile()) throw new Error(`onboard: refusing non-file coordination target ${path.basename(filePath)}`);
    return { bytes: fsImpl.readFileSync(filePath), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function atomicWrite(filePath, bytes, mode, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.onboard-tmp-${process.pid}-${digest(filePath).slice(0, 8)}`;
  try {
    fsImpl.writeFileSync(temp, bytes, { mode });
    fsImpl.renameSync(temp, filePath);
    fsImpl.chmodSync(filePath, mode);
  } finally {
    try { fsImpl.rmSync(temp, { force: true }); } catch { /* preserve the original write error */ }
  }
}

function sameFileState(left, right) {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.bytes.equals(right.bytes);
}

function receiptFor(plan, approval, proposalResults = []) {
  const governedFiles = [
    ["coord/project.config.js", plan.project_config_preview],
    ["coord/setup.decisions.json", `${JSON.stringify(plan.setup_decisions, null, 2)}\n`],
    ...(plan.context_pack ? [[ONBOARD_CONTEXT_REL, `${JSON.stringify(plan.context_pack, null, 2)}\n`]] : []),
  ];
  return {
    kind: "concord.onboarding_receipt",
    schema_version: 1,
    status: "applied",
    plan_digest: plan.plan_digest,
    approval,
    inputs: {
      repository_count: plan.discovery.repositories.length,
      context_pack: plan.context_pack
        ? {
          source: plan.context_pack.source,
          freshness: plan.context_pack.freshness,
          sensitivity: plan.context_pack.sensitivity,
          citations: plan.context_pack.citations,
          content_digest: plan.context_pack.content_digest,
          authority: "advisory",
        }
        : null,
    },
    decisions: plan.decisions,
    files: governedFiles.map(([relative, content]) => ({ path: relative, digest: digest(content) })),
    proposed_tickets: proposalResults,
    privacy: {
      source_excerpts: false,
      secret_values: false,
      private_absolute_paths: false,
      raw_git_metadata: false,
    },
  };
}

// The approved coordination-file set is one rollback-capable transaction. All
// collisions are preflighted before the first write; every prior byte and mode
// is snapshotted; and any failure restores the exact pre-state in reverse.
function writeOnboardArtifacts(plan, options = {}) {
  const fsImpl = options.fs || fs;
  const root = plan[TARGET_ROOT] || path.resolve(options.targetRoot || process.cwd());
  const approval = onboardingApproval(plan, options);
  const priorReceiptPath = path.join(root, ONBOARD_RECEIPT_REL);
  let priorProposalResults = [];
  try {
    const priorReceipt = JSON.parse(fsImpl.readFileSync(priorReceiptPath, "utf8"));
    if (priorReceipt.plan_digest === plan.plan_digest && Array.isArray(priorReceipt.proposed_tickets)) {
      priorProposalResults = priorReceipt.proposed_tickets;
    }
  } catch { /* first apply or an independently invalid receipt; normal preflight handles its bytes */ }
  const receipt = receiptFor(plan, approval, priorProposalResults);
  const files = [
    ["coord/project.config.js", plan.project_config_preview, 0o644],
    ["coord/setup.decisions.json", `${JSON.stringify(plan.setup_decisions, null, 2)}\n`, 0o644],
    ...(plan.context_pack ? [[ONBOARD_CONTEXT_REL, `${JSON.stringify(plan.context_pack, null, 2)}\n`, 0o600]] : []),
    [ONBOARD_RECEIPT_REL, `${JSON.stringify(receipt, null, 2)}\n`, 0o600],
  ];
  const snapshots = new Map();
  for (const [relative, content] of files) {
    const absolute = path.join(root, relative);
    const prior = statFile(absolute, fsImpl);
    snapshots.set(relative, prior);
    if (prior && !prior.bytes.equals(Buffer.from(content)) && !options.force) {
      throw new Error(`onboard: refusing to overwrite ${relative}; pass --force only after reviewing this exact plan digest`);
    }
  }

  const written = [];
  const touched = [];
  try {
    for (const [relative, content, mode] of files) {
      const prior = snapshots.get(relative);
      if (prior && prior.bytes.equals(Buffer.from(content)) && prior.mode === mode) continue;
      if (!sameFileState(statFile(path.join(root, relative), fsImpl), prior)) {
        throw new Error(`onboard: ${relative} changed after the reviewed preflight; zero additional files were written`);
      }
      if (options.injectFailureAt === relative) {
        const injected = new Error(`onboard: injected failure at ${relative}`);
        injected.code = "ONBOARD_INJECTED_FAILURE";
        throw injected;
      }
      touched.push(relative);
      atomicWrite(path.join(root, relative), content, mode, fsImpl);
      written.push(relative);
    }
    return { written, receipt, approval };
  } catch (error) {
    const rollbackErrors = [];
    for (const relative of [...touched].reverse()) {
      const prior = snapshots.get(relative);
      const absolute = path.join(root, relative);
      try {
        if (!prior) fsImpl.rmSync(absolute, { force: true });
        else atomicWrite(absolute, prior.bytes, prior.mode, fsImpl);
      } catch (rollbackError) {
        rollbackErrors.push(`${relative}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      error.message += `; rollback anomalies: ${rollbackErrors.join(", ")}`;
    }
    throw error;
  }
}

function existingProposalIds(root, plan, fsImpl = fs) {
  const boardPath = path.join(root, "coord", "board", "tasks.json");
  const receiptPath = path.join(root, ONBOARD_RECEIPT_REL);
  let board;
  try { board = JSON.parse(fsImpl.readFileSync(boardPath, "utf8")); } catch { return new Map(); }
  let priorByKey = new Map();
  try {
    const receipt = JSON.parse(fsImpl.readFileSync(receiptPath, "utf8"));
    if (receipt.plan_digest === plan.plan_digest && Array.isArray(receipt.proposed_tickets)) {
      priorByKey = new Map(receipt.proposed_tickets.map((entry) => [entry.proposal_key, entry]));
    }
  } catch { /* a board marker is still sufficient to prevent duplicate intake */ }
  const found = new Map();
  for (const section of board.sections || []) {
    for (const row of section.rows || []) {
      const match = String(row.Description || "").match(/\[onboarding:([a-f0-9]{20})\]/i);
      if (match) {
        const prior = priorByKey.get(match[1]);
        found.set(match[1], prior && prior.ticket_id === row.ID && prior.status !== "failed"
          ? prior
          : { proposal_key: match[1], ticket_id: row.ID, status: "already_present" });
      }
    }
  }
  return found;
}

function defaultFileProposedTicket(root, ticket, options = {}) {
  const gov = path.join(root, "coord", "scripts", "governance.js");
  const description = `[onboarding:${ticket.proposal_key}] ${ticket.title}. ` +
    `Derived from reviewed onboarding plan ${options.planDigest}; verify before approval or scheduling.`;
  const result = spawnSync(process.execPath, [
    gov, "file-ticket",
    "--repo", ticket.repo,
    "--type", ticket.type,
    "--pri", ticket.pri,
    "--status", "proposed",
    "--description", description,
  ], {
    cwd: root,
    encoding: "utf8",
    env: options.env || process.env,
  });
  if (!result || result.status !== 0) {
    throw new Error("onboard: governed proposed-ticket intake failed; inspect the governance journal before retrying");
  }
  const match = String(result.stdout || "").match(/Filed ticket\s+([A-Z]+-\d+)/);
  if (!match) throw new Error("onboard: governed proposed-ticket intake returned no ticket id");
  return match[1];
}

function fileApprovedStarterTickets(plan, options = {}) {
  if (!options.approveStarters) return [];
  const fsImpl = options.fs || fs;
  const root = plan[TARGET_ROOT] || path.resolve(options.targetRoot || process.cwd());
  const existing = existingProposalIds(root, plan, fsImpl);
  const fileTicket = options.fileProposedTicket || ((ticket) => defaultFileProposedTicket(root, ticket, {
    planDigest: plan.plan_digest,
    env: options.env,
  }));
  const results = [];
  for (const ticket of plan.starter_tickets) {
    if (existing.has(ticket.proposal_key)) {
      results.push(existing.get(ticket.proposal_key));
    } else {
      try {
        const ticketId = fileTicket(ticket);
        results.push({ proposal_key: ticket.proposal_key, ticket_id: ticketId, status: "proposed" });
      } catch (error) {
        results.push({ proposal_key: ticket.proposal_key, ticket_id: null, status: "failed" });
        if (typeof options.onResult === "function") options.onResult([...results]);
        error.proposalResults = results;
        throw error;
      }
    }
    if (typeof options.onResult === "function") options.onResult([...results]);
  }
  return results;
}

function updateOnboardingReceipt(plan, applyResult, proposalResults, options = {}) {
  const fsImpl = options.fs || fs;
  const root = plan[TARGET_ROOT] || path.resolve(options.targetRoot || process.cwd());
  const receipt = receiptFor(plan, applyResult.approval, proposalResults);
  const absolute = path.join(root, ONBOARD_RECEIPT_REL);
  const next = `${JSON.stringify(receipt, null, 2)}\n`;
  const prior = statFile(absolute, fsImpl);
  if (!prior || !prior.bytes.equals(Buffer.from(next)) || prior.mode !== 0o600) {
    atomicWrite(absolute, next, 0o600, fsImpl);
    if (!applyResult.written.includes(ONBOARD_RECEIPT_REL)) applyResult.written.push(ONBOARD_RECEIPT_REL);
  }
  applyResult.receipt = receipt;
  return applyResult;
}

function renderOnboardPlan(plan) {
  const lines = [
    "# Concord Onboarding Plan",
    "",
    `Target: ${plan.target_root} (private absolute path intentionally omitted)`,
    `Mode: ${plan.mode}`,
    `Preset: ${plan.preset.id}`,
    `Plan digest: ${plan.plan_digest}`,
    "",
    "## Signals",
    ...(plan.shape.signals.length ? plan.shape.signals.map((s) => `- ${s}`) : ["- none"]),
    "",
    "## Starter Tickets",
    ...plan.starter_tickets.map((ticket) => `- ${ticket.status} ${ticket.type}: ${ticket.title}`),
    "",
    "## Next Steps",
    ...plan.next_steps.map((step) => `- ${step}`),
  ];
  return `${lines.join("\n")}\n`;
}

function run(argv = [], deps = {}) {
  const log = deps.log || ((line) => console.log(line));
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help || !opts.repo) {
      log("Usage: coord onboard <workspace-path> [--dry-run] [--json] [--context-pack <json>] [--write --approve <plan-digest>] [--approve-starters] [--force]");
      return { code: opts.repo ? 0 : 1 };
    }
    const plan = buildOnboardPlan(opts.repo, { ...opts, fs: deps.fs || fs, runGit: deps.runGit });
    let applyResult = { written: [], receipt: null };
    if (opts.write) {
      const env = deps.env || process.env;
      applyResult = writeOnboardArtifacts(plan, {
        ...opts,
        fs: deps.fs || fs,
        env,
        installPlanDigest: env.CONCORD_INSTALL_PLAN_DIGEST,
        expectedOnboardPlanDigest: env.CONCORD_ONBOARD_PLAN_DIGEST,
        injectFailureAt: deps.injectFailureAt,
      });
      try {
        const proposalResults = fileApprovedStarterTickets(plan, {
          ...opts,
          fs: deps.fs || fs,
          env,
          fileProposedTicket: deps.fileProposedTicket,
          onResult: (results) => updateOnboardingReceipt(plan, applyResult, results, { fs: deps.fs || fs }),
        });
        applyResult = updateOnboardingReceipt(plan, applyResult, proposalResults, { fs: deps.fs || fs });
      } catch (error) {
        updateOnboardingReceipt(plan, applyResult, error.proposalResults || [], { fs: deps.fs || fs });
        throw error;
      }
    }
    const report = { ...plan, execution_mode: opts.write ? "apply" : "preview", written: applyResult.written, receipt: applyResult.receipt };
    log(opts.json ? JSON.stringify(report, null, 2) : renderOnboardPlan(report));
    return { code: 0, report };
  } catch (error) {
    log(error.message);
    return { code: 1 };
  }
}

module.exports = {
  assignRepoCodes,
  buildOnboardPlan,
  detectCoordGitState,
  discoverRepoMetadata,
  discoverSiblingRepos,
  fileApprovedStarterTickets,
  normalizeContextPack,
  onboardingApproval,
  parseArgs,
  renderOnboardPlan,
  summarizeDirtyState,
  updateOnboardingReceipt,
  run,
  writeOnboardArtifacts,
  ONBOARD_CONTEXT_REL,
  ONBOARD_RECEIPT_REL,
};
