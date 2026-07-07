"use strict";

// COORD-150: `coord init --wizard` — interactive (and flag-driven /
// --non-interactive for tests) SCAFFOLDER that GENERATES the config-as-code an
// adopter then reviews and COMMITS through the normal governed lane.
//
// STANCE (coord/docs/MEMORY_ARCHITECTURE.md sec 12): this is a scaffolder like
// `create-next-app`, NOT a live mutator and NOT a hosted runtime admin console.
// The wizard asks the setup questions (repo map, ticket prefixes, integration
// branch, gate options, tracks) and EMITS `coord/project.config.js` for the user
// to review + commit. Its output is FILES-TO-COMMIT, not applied runtime state:
// it never touches the board, the journal, locks, or any live process, and it
// never edits engine files.
//
// Safety model — same NO-CLOBBER contract as `coord init`:
//   - It never silently overwrites an existing config. When the target config
//     already exists, the default plan is "skip" and the wizard prints the diff
//     it WOULD apply; a write only happens when the operator confirms
//     (--confirm / interactive "yes") or asks to regenerate (--force).
//   - --dry-run (and the default no-confirm path on an existing file) writes
//     nothing — it prints the plan only. Idempotent: re-running with the same
//     answers yields the same file, and re-running without --force/--confirm on
//     an existing file is a no-op.
//
// Determinism: `generateProjectConfig(answers)` is a PURE function (answers ->
// config-as-code string). The same answers always produce byte-identical
// output, which is what the tests assert.
//
// DI-factory convention (matches coord-init.js): tests inject fs/log/cwd.

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const createAdoptionProfileRegistry = require("./adoption-profile-registry.js");
const phaseModel = require("./governance-phase-model.js");

// ---------------------------------------------------------------------------
// Pure config-as-code generator.
// ---------------------------------------------------------------------------

const SINGLE_UPPER = /^[A-Z]$/;
const CONFIG_REL = "coord/project.config.js";
const SETUP_DECISIONS_REL = "coord/setup.decisions.json";

// Normalize a raw answers object into a validated, defaulted shape. Throws on
// the few inputs that would generate a structurally invalid config (so the
// wizard fails loud at generation time rather than emitting a broken seam).
function normalizeAnswers(answers = {}) {
  const coordTicketPrefix =
    typeof answers.coordTicketPrefix === "string" && answers.coordTicketPrefix.trim()
      ? answers.coordTicketPrefix.trim()
      : "COORD";

  const rawRepos = Array.isArray(answers.repos) ? answers.repos : [];
  if (rawRepos.length === 0) {
    throw new Error("wizard: at least one repo is required (answers.repos was empty)");
  }

  const seenCodes = new Set();
  const repos = rawRepos.map((repo, i) => {
    const code = String(repo.code || "").toUpperCase();
    if (!SINGLE_UPPER.test(code)) {
      throw new Error(`wizard: repo[${i}].code must be a single uppercase letter (got ${JSON.stringify(repo.code)})`);
    }
    if (code === "X") {
      throw new Error('wizard: "X" is reserved for coord/cross-repo work and must not appear in repos');
    }
    if (seenCodes.has(code)) {
      throw new Error(`wizard: duplicate repo code ${code}`);
    }
    seenCodes.add(code);

    const path = String(repo.path || "").trim();
    if (!path) {
      throw new Error(`wizard: repo ${code} requires a path`);
    }
    return {
      code,
      path,
      integrationBranch:
        typeof repo.integrationBranch === "string" && repo.integrationBranch.trim()
          ? repo.integrationBranch.trim()
          : "main",
      testCommand:
        typeof repo.testCommand === "string" && repo.testCommand.trim()
          ? repo.testCommand.trim()
          : "npm test",
      ticketPrefixes: Array.isArray(repo.ticketPrefixes)
        ? repo.ticketPrefixes.map((p) => String(p).trim()).filter(Boolean)
        : [],
    };
  });

  const profile =
    typeof answers.profile === "string" && answers.profile.trim()
      ? answers.profile.trim()
      : null;
  const phase =
    typeof answers.phase === "string" && answers.phase.trim()
      ? answers.phase.trim()
      : null;
  const tracks = Array.isArray(answers.tracks)
    ? Array.from(new Set(answers.tracks.map((t) => String(t).trim()).filter(Boolean))).sort()
    : [];
  const gates = Array.isArray(answers.gates)
    ? Array.from(new Set(answers.gates.map((g) => String(g).trim()).filter(Boolean))).sort()
    : [];

  return { coordTicketPrefix, repos, profile, phase, tracks, gates };
}

function jsArrayLiteral(items) {
  return `[${items.map((p) => JSON.stringify(p)).join(", ")}]`;
}

// Pure: validated answers -> project.config.js source string. Deterministic.
function generateProjectConfig(answers = {}) {
  const cfg = normalizeAnswers(answers);

  const repoBlocks = cfg.repos
    .map(
      (r) => `    ${r.code}: {
      path: ${JSON.stringify(r.path)},
      integrationBranch: ${JSON.stringify(r.integrationBranch)},
      origin: null,
      legacyAliases: [],
      ticketPrefixes: ${jsArrayLiteral(r.ticketPrefixes)},
      testCommand: ${JSON.stringify(r.testCommand)},
    },`
    )
    .join("\n");

  return `// coord/project.config.js — project-owned config seam.
//
// GENERATED by \`coord init --wizard\` (a scaffolder, not a live mutator). This is
// config-as-code: review it, then COMMIT it through the normal governed lane.
// Engine files (paths.js, scripts/*, board/board.js, schemas) are engine-managed
// and must not be hand-edited.
//
// Rules:
//   - Each repo code is a single uppercase letter.
//   - "X" is reserved for cross-repo / coord-only work and MUST NOT appear here.
//   - \`path\` is relative to the project root (one level above coordDir).
//   - \`integrationBranch\` is the per-repo integration base.
module.exports = {
  coordTicketPrefix: ${JSON.stringify(cfg.coordTicketPrefix)},
  repos: {
${repoBlocks}
  },
  requirements: {
    path: "product/REQUIREMENTS.md",
  },
};
`;
}

function detectRepoShape(targetRoot, repos, fs = nodeFs, path = nodePath) {
  const exists = (rel) => fs.existsSync(path.join(targetRoot, rel));
  const readJson = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(targetRoot, rel), "utf8"));
    } catch {
      return null;
    }
  };
  const signals = [];
  const add = (condition, signal) => {
    if (condition) signals.push(signal);
  };
  add(exists("package.json"), "node");
  add(exists("pnpm-lock.yaml"), "pnpm");
  add(exists("yarn.lock"), "yarn");
  add(exists("pyproject.toml") || exists("requirements.txt"), "python");
  add(exists("go.mod"), "go");
  add(exists("Cargo.toml"), "rust");
  add(exists("Dockerfile") || exists("docker-compose.yml"), "containerized");
  add(exists(".github/workflows"), "github-actions");
  add(exists("helm") || exists("k8s") || exists("terraform"), "deployment-infra");
  add(exists("coord/GOVERNANCE.md"), "existing-concord-governance");
  add(exists("coord/board/tasks.json"), "existing-concord-board");
  add(
    exists("coord/product/REQUIREMENTS.md") || exists("REQUIREMENTS.md") || exists("PRD.md") || exists("URS.md"),
    "requirements-source"
  );

  const pkg = readJson("package.json");
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === "object"
    ? Object.keys(pkg.scripts).sort()
    : [];
  const repoPaths = repos.map((repo) => repo.path);
  return {
    root: targetRoot,
    repo_count: repos.length,
    repo_paths: repoPaths,
    shape: repos.length > 1 ? "multi-repo" : "single-repo",
    signals: Array.from(new Set(signals)).sort(),
    package_scripts: scripts,
  };
}

function inferProfile(shape, answers, registry) {
  if (answers.profile) return answers.profile;
  const signals = new Set(shape.signals);
  if (signals.has("deployment-infra")) return "enterprise";
  if (signals.has("requirements-source")) return shape.repo_count > 1 ? "product-engineering" : "small-team";
  if (shape.repo_count > 1) return "product-engineering";
  if (signals.has("node") || signals.has("python") || signals.has("go") || signals.has("rust")) return "solo-dev";
  return registry.defaultProfile || "solo-dev";
}

function inferPhase(shape, profileId, answers) {
  if (answers.phase) return answers.phase;
  const signals = new Set(shape.signals);
  const scripts = new Set(shape.package_scripts);
  const hasTests = scripts.has("test") || scripts.has("test:unit") || scripts.has("test:ci");
  if (profileId === "regulated") return "regulated-production";
  if (profileId === "enterprise" || signals.has("deployment-infra")) return "production";
  if (signals.has("requirements-source") && hasTests) return "pilot";
  if (hasTests || signals.has("node") || signals.has("python") || signals.has("go") || signals.has("rust")) return "prototype";
  return "exploration";
}

function defaultGates(repos, phase, answers) {
  const gates = new Set(answers.gates);
  for (const repo of repos) {
    if (repo.testCommand) gates.add(`${repo.code}: ${repo.testCommand}`);
  }
  if (["pilot", "production", "regulated-production"].includes(phase)) {
    gates.add("requirements baseline");
  }
  if (["production", "regulated-production"].includes(phase)) {
    gates.add("release/deploy receipt");
  }
  return Array.from(gates).sort();
}

function setupNextSteps(profile, phase) {
  const steps = [
    `review ${CONFIG_REL}`,
    `review ${SETUP_DECISIONS_REL}`,
    "commit setup artifacts through the governed lane",
    "run coord doctor --dir .",
    "replace scaffolded repo paths and ticket prefixes with project-owned values",
  ];
  if (profile && profile.required_evidence && profile.required_evidence.length > 0) {
    steps.push(`confirm evidence expectations: ${profile.required_evidence.join(", ")}`);
  }
  if (phase && phase.required_evidence && phase.required_evidence.length > 0) {
    steps.push(`confirm phase gates: ${phase.required_evidence.join(", ")}`);
  }
  return steps;
}

function generateSetupDecisionArtifact(answers = {}, context = {}) {
  const cfg = normalizeAnswers(answers);
  const fs = context.fs || nodeFs;
  const path = context.path || nodePath;
  const targetRoot = context.targetRoot || process.cwd();
  const registry = context.profileRegistry || createAdoptionProfileRegistry({ strict: true });
  const shape = context.shape || detectRepoShape(targetRoot, cfg.repos, fs, path);
  const profileId = inferProfile(shape, cfg, registry);
  const profile = registry.resolveProfile(profileId);
  if (!profile || profile.id !== profileId) {
    throw new Error(`wizard: unknown adoption profile ${JSON.stringify(profileId)}`);
  }
  const phaseId = inferPhase(shape, profile.id, cfg);
  const phase = phaseModel.phaseDetails(phaseId);
  if (!phase || phase.id !== phaseId) {
    throw new Error(`wizard: unknown governance phase ${JSON.stringify(phaseId)}`);
  }
  const tracks = cfg.tracks.length > 0
    ? cfg.tracks
    : Array.from(new Set(profile.recommended_tracks || [])).sort();
  const gates = defaultGates(cfg.repos, phase.id, cfg);
  const artifact = {
    kind: "concord.setup_decisions",
    schema_version: 1,
    generated_by: "coord init --wizard",
    target_root: targetRoot,
    decisions: {
      coord_ticket_prefix: cfg.coordTicketPrefix,
      adoption_profile: {
        id: profile.id,
        label: profile.label,
        default_lane: profile.default_lane,
      },
      governance_phase: {
        id: phase.id,
        label: phase.label,
      },
      tracks,
      gates,
    },
    detected_shape: shape,
    repos: cfg.repos,
    next_steps: setupNextSteps(profile, phase),
    safety: {
      no_clobber: true,
      writes_runtime_state: false,
      writes_board_or_journal: false,
    },
  };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Argv parsing (flag-driven / --non-interactive for tests + CI).
// ---------------------------------------------------------------------------

// Parse the wizard argv slice (everything after `coord init --wizard`).
// Repo answers are supplied non-interactively via repeated --repo flags:
//   --repo CODE:path[:integrationBranch[:testCommand[:prefix1|prefix2]]]
function parseArgs(args = []) {
  const parsed = {
    dir: null,
    dryRun: false,
    confirm: false,
    force: false,
    nonInteractive: false,
    help: false,
    coordTicketPrefix: null,
    repos: [],
    profile: null,
    phase: null,
    tracks: [],
    gates: [],
    setupDecisionsRel: SETUP_DECISIONS_REL,
    unknown: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const takeValue = () => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      const next = args[i + 1];
      i += 1;
      return next != null ? next : null;
    };
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--confirm") parsed.confirm = true;
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--non-interactive") parsed.nonInteractive = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--dir" || arg.startsWith("--dir=")) parsed.dir = takeValue();
    else if (arg === "--coord-prefix" || arg.startsWith("--coord-prefix="))
      parsed.coordTicketPrefix = takeValue();
    else if (arg === "--profile" || arg === "--adoption-profile" || arg.startsWith("--profile=") || arg.startsWith("--adoption-profile="))
      parsed.profile = takeValue();
    else if (arg === "--phase" || arg.startsWith("--phase="))
      parsed.phase = takeValue();
    else if (arg === "--track" || arg.startsWith("--track=")) {
      const spec = takeValue();
      if (spec) parsed.tracks.push(...String(spec).split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg === "--gate" || arg.startsWith("--gate=")) {
      const spec = takeValue();
      if (spec) parsed.gates.push(...String(spec).split(",").map((s) => s.trim()).filter(Boolean));
    }
    else if (arg === "--repo" || arg.startsWith("--repo=")) {
      const spec = takeValue();
      if (spec) parsed.repos.push(parseRepoSpec(spec));
    } else parsed.unknown.push(arg);
  }
  return parsed;
}

// CODE:path[:integrationBranch[:testCommand[:prefixA|prefixB]]]
function parseRepoSpec(spec) {
  const [code, path, integrationBranch, testCommand, prefixes] = String(spec).split(":");
  return {
    code,
    path,
    integrationBranch,
    testCommand,
    ticketPrefixes: prefixes ? prefixes.split("|").filter(Boolean) : [],
  };
}

// ---------------------------------------------------------------------------
// Planner + runner (no-clobber, write-on-confirm).
// ---------------------------------------------------------------------------

module.exports = function createCoordInitWizard(deps = {}) {
  const fs = deps.fs || nodeFs;
  const log = deps.log || ((line) => console.log(line));
  const cwd = deps.cwd || (() => process.cwd());
  const profileRegistry = deps.profileRegistry || createAdoptionProfileRegistry({ strict: deps.strictProfiles !== false });

  function planFile(targetRoot, rel, content, opts) {
    const abs = nodePath.join(targetRoot, rel);
    const exists = fs.existsSync(abs);

    if (!exists) {
      return { action: "create", rel, abs, content, existing: null };
    }

    const existing = fs.readFileSync(abs, "utf8");
    if (existing === content) {
      return { action: "skip", rel, abs, content, existing, reason: "identical" };
    }
    // Differs. Only write when the operator explicitly confirms/forces; never
    // silently clobber an edited config.
    if (opts.confirm || opts.force) {
      return { action: "update", rel, abs, content, existing };
    }
    return { action: "skip", rel, abs, content, existing, reason: "exists-no-confirm" };
  }

  // Pure-ish planner: decide create vs. update vs. skip against the target.
  // Returns a config plan plus a setup-decision artifact plan.
  function plan(targetRoot, answers, opts) {
    const cfg = normalizeAnswers(answers);
    const configContent = generateProjectConfig(cfg);
    const configAbs = nodePath.join(targetRoot, CONFIG_REL);
    const shape = detectRepoShape(targetRoot, cfg.repos, fs, nodePath);
    const decisionContent = generateSetupDecisionArtifact(cfg, {
      fs,
      path: nodePath,
      targetRoot,
      profileRegistry,
      shape,
      hasExistingConfig: fs.existsSync(configAbs),
    });
    const config = planFile(targetRoot, CONFIG_REL, configContent, opts);
    const setupDecisions = planFile(targetRoot, opts.setupDecisionsRel || SETUP_DECISIONS_REL, decisionContent, opts);
    return { action: config.action, config, setupDecisions, files: [config, setupDecisions] };
  }

  // Minimal line diff for the printed plan (no deps): show added/removed lines.
  function renderDiff(existing, next) {
    const a = (existing || "").split("\n");
    const b = next.split("\n");
    const bSet = new Set(b);
    const aSet = new Set(a);
    const out = [];
    for (const line of a) if (!bSet.has(line)) out.push(`  - ${line}`);
    for (const line of b) if (!aSet.has(line)) out.push(`  + ${line}`);
    return out;
  }

  function run(args = []) {
    const opts = parseArgs(args);
    if (opts.help) {
      printUsage();
      return { ok: true, code: 0 };
    }
    if (opts.unknown.length > 0) {
      log(`coord init --wizard: unexpected argument(s): ${opts.unknown.join(", ")}`);
      log("Run `coord init --wizard --help` for usage.");
      return { ok: false, code: 1 };
    }

    const targetRoot = opts.dir ? nodePath.resolve(cwd(), opts.dir) : nodePath.resolve(cwd());

    const answers = {
      coordTicketPrefix: opts.coordTicketPrefix,
      repos: opts.repos,
      profile: opts.profile,
      phase: opts.phase,
      tracks: opts.tracks,
      gates: opts.gates,
    };
    let planned;
    try {
      planned = plan(targetRoot, answers, opts);
    } catch (err) {
      log(`coord init --wizard: ${err.message}`);
      return { ok: false, code: 1 };
    }

    log(`coord init --wizard — target: ${nodePath.join(targetRoot, CONFIG_REL)}`);
    if (opts.dryRun) log("(dry run — no files will be written)");
    log("");

    for (const filePlan of planned.files) {
      if (filePlan.action === "create") {
        log(`  create  ${filePlan.rel}`);
      } else if (filePlan.action === "update") {
        log(`  update  ${filePlan.rel}  (regenerating from answers)`);
        for (const line of renderDiff(filePlan.existing, filePlan.content)) log(line);
      } else if (filePlan.reason === "identical") {
        log(`  skip    ${filePlan.rel}  (already matches the generated artifact)`);
      } else {
        log(`  skip    ${filePlan.rel}  (exists and differs — pass --confirm to regenerate)`);
        log("");
        log("Proposed changes (not applied):");
        for (const line of renderDiff(filePlan.existing, filePlan.content)) log(line);
      }
    }

    const blockedByNoClobber = planned.files.some((filePlan) => filePlan.reason === "exists-no-confirm");
    const writableFiles = blockedByNoClobber
      ? []
      : planned.files.filter((filePlan) => filePlan.action === "create" || filePlan.action === "update");
    const willWrite = !opts.dryRun && writableFiles.length > 0;
    if (willWrite) {
      for (const filePlan of writableFiles) {
        fs.mkdirSync(nodePath.dirname(filePlan.abs), { recursive: true });
        fs.writeFileSync(filePlan.abs, filePlan.content);
      }
    }

    log("");
    if (planned.files.every((filePlan) => filePlan.action === "skip" && filePlan.reason === "identical")) {
      log("Setup artifacts already up to date — nothing to do.");
    } else if (blockedByNoClobber) {
      log("No changes written (no-clobber). Review the proposed changes above,");
      log("then re-run with --confirm to regenerate setup artifacts.");
    } else if (opts.dryRun) {
      log("Would write the setup artifacts listed above.");
    } else {
      log(`Wrote ${writableFiles.map((filePlan) => filePlan.rel).join(", ")}.`);
      log("");
      log("This is config-as-code. Next: review the files, run `coord doctor`, then COMMIT them through");
      log("the governed lane (e.g. `git add coord/project.config.js coord/setup.decisions.json` + your normal");
      log("governed commit). The wizard applied NO runtime state.");
    }

    return {
      ok: true,
      code: 0,
      action: planned.action,
      targetRoot,
      content: planned.config.content,
      setupDecisions: planned.setupDecisions.content,
      files: planned.files.map((filePlan) => ({
        rel: filePlan.rel,
        action: filePlan.action,
        reason: filePlan.reason || null,
      })),
    };
  }

  function printUsage() {
    log("Usage: coord init --wizard [options]");
    log("");
    log("Interactive scaffolder that GENERATES coord/project.config.js (config-as-code)");
    log("for you to review and commit. Not a live mutator — applies no runtime state.");
    log("");
    log("Non-interactive (flag-driven) options:");
    log("  --repo CODE:path[:branch[:testCmd[:prefixA|prefixB]]]   Add a repo (repeatable)");
    log("  --coord-prefix <PREFIX>   Coord/cross-repo ticket prefix (default COORD)");
    log("  --profile <id>            Adoption profile (default: inferred)");
    log("  --phase <id>              Governance phase (default: inferred)");
    log("  --track <id[,id]>         Suggested track(s); repeatable");
    log("  --gate <label[,label]>    Suggested setup gate(s); repeatable");
    log("  --dir <path>              Target repo root (default: cwd)");
    log("  --confirm                 Regenerate even if config exists and differs");
    log("  --force                   Alias of --confirm (regenerate)");
    log("  --dry-run                 Print the plan; write nothing");
    log("  --non-interactive         Flag-driven mode (no prompts)");
    log("  -h, --help                Show this help");
  }

  return { parseArgs, parseRepoSpec, generateProjectConfig, generateSetupDecisionArtifact, normalizeAnswers, plan, run, printUsage };
};

// Re-export the pure generator at module scope for direct unit testing.
module.exports.generateProjectConfig = generateProjectConfig;
module.exports.generateSetupDecisionArtifact = generateSetupDecisionArtifact;
module.exports.normalizeAnswers = normalizeAnswers;
module.exports.detectRepoShape = detectRepoShape;
