"use strict";

const fs = require("node:fs");
const path = require("node:path");

const wizard = require("./coord-init-wizard.js");
const { suggestPresetFromSignals } = require("./track-presets.js");

function parseArgs(argv = []) {
  const opts = { dryRun: true, write: false, force: false, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--write") {
      opts.write = true;
      opts.dryRun = false;
    } else if (arg === "--force") opts.force = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!opts.repo) opts.repo = arg;
    else throw new Error(`onboard: unexpected argument ${arg}`);
  }
  return opts;
}

function defaultRepoAnswers(targetRoot, preset) {
  return {
    coordTicketPrefix: "COORD",
    repos: [{
      code: "A",
      path: ".",
      integrationBranch: "main",
      testCommand: fs.existsSync(path.join(targetRoot, "package.json")) ? "npm test" : "coord/scripts/gov conform",
      ticketPrefixes: preset.prefixes.slice(0, 2),
    }],
    profile: "solo-dev",
    phase: "prototype",
    tracks: preset.tracks,
    gates: preset.gates,
  };
}

function buildOnboardPlan(targetRoot, options = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  const shape = wizard.detectRepoShape(root, [{ code: "A", path: "." }], options.fs || fs, path);
  const preset = options.preset || suggestPresetFromSignals(shape.signals);
  const answers = defaultRepoAnswers(root, preset);
  const setup = wizard.generateSetupDecisionArtifact(answers, { targetRoot: root, shape });
  const starterTickets = [
    { type: "chore", title: "Confirm Concord repo map and ticket prefixes" },
    { type: "test", title: "Record first local gate baseline" },
    { type: "docs", title: "Add first requirements or URS baseline pointer" },
  ];
  return {
    kind: "concord.onboard_plan",
    schema_version: 1,
    target_root: root,
    mode: options.write ? "write" : "dry-run",
    shape,
    preset,
    project_config_preview: wizard.generateProjectConfig(answers),
    setup_decisions: JSON.parse(setup),
    starter_tickets: starterTickets,
    next_steps: [
      "Review coord/project.config.js and coord/setup.decisions.json.",
      "Run coord doctor --dir <repo>.",
      "Commit setup artifacts through the governed lane.",
      "File the starter tickets only after repo owners confirm the preset.",
    ],
  };
}

function writeOnboardArtifacts(plan, options = {}) {
  const coordDir = path.join(plan.target_root, "coord");
  fs.mkdirSync(coordDir, { recursive: true });
  const files = [
    ["project.config.js", plan.project_config_preview],
    ["setup.decisions.json", `${JSON.stringify(plan.setup_decisions, null, 2)}\n`],
  ];
  const written = [];
  for (const [name, content] of files) {
    const filePath = path.join(coordDir, name);
    if (fs.existsSync(filePath) && !options.force) {
      throw new Error(`onboard: refusing to overwrite ${filePath}; pass --force after review`);
    }
    fs.writeFileSync(filePath, content, "utf8");
    written.push(path.relative(plan.target_root, filePath).replace(/\\/g, "/"));
  }
  return written;
}

function renderOnboardPlan(plan) {
  const lines = [
    "# Concord Onboarding Plan",
    "",
    `Target: ${plan.target_root}`,
    `Mode: ${plan.mode}`,
    `Preset: ${plan.preset.id}`,
    "",
    "## Signals",
    ...(plan.shape.signals.length ? plan.shape.signals.map((s) => `- ${s}`) : ["- none"]),
    "",
    "## Starter Tickets",
    ...plan.starter_tickets.map((ticket) => `- ${ticket.type}: ${ticket.title}`),
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
      log("Usage: coord onboard <repo-path> [--dry-run] [--write] [--force]");
      return { code: opts.repo ? 0 : 1 };
    }
    const plan = buildOnboardPlan(opts.repo, opts);
    const written = opts.write ? writeOnboardArtifacts(plan, opts) : [];
    const report = { ...plan, written };
    log(opts.json ? JSON.stringify(report, null, 2) : renderOnboardPlan(report));
    return { code: 0, report };
  } catch (error) {
    log(error.message);
    return { code: 1 };
  }
}

module.exports = {
  buildOnboardPlan,
  parseArgs,
  renderOnboardPlan,
  run,
  writeOnboardArtifacts,
};
