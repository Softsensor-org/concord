"use strict";

// COORD-116: `coord init` — idempotent zero→governed-board bootstrap for a
// TARGET repo. This is the PRODUCT-facing bootstrap (distinct from the per-ticket
// `gov` engine lifecycle verbs): it takes a repo that has the coord engine files
// copied in but is not yet configured, and scaffolds the minimal project-owned
// seams so the board + governance can run.
//
// Safety model: NO-CLOBBER. init never overwrites an existing file. Every action
// is either "create" (file absent) or "skip" (file present). There is therefore
// no --force; re-running on an already-initialized repo is a no-op that exits 0.
// --dry-run prints the plan and writes nothing.
//
// Single source of truth: the starter board shape is imported from
// ./coord-init-starter-board.js, which is the SAME shape the public release
// builder's clean-board step (release/build-public-release.sh step 6) produces,
// so `coord init` and the release cut agree on what a clean starter board is.
//
// DI-factory convention (matches conformance-verbs.js / engine-pin.js):
//   module.exports = function createCoordInit(deps = {}) { ... }
// so tests can inject fs/log/cwd without touching the real repo.

const nodeFs = require("node:fs");
const nodePath = require("node:path");

const { buildStarterBoard } = require("./coord-init-starter-board.js");
const createCoordInitWizard = require("./coord-init-wizard.js");

// Minimal project.config.js scaffold. Mirrors the documented two-repo default
// shape (see coord/project.config.js) but trimmed to the seam an adopter must
// edit. Kept deliberately small + commented so `coord init` lands something an
// adopter can read and replace, not a full engine config dump.
function projectConfigTemplate() {
  return `// coord/project.config.js — project-owned config seam.
//
// This is the only seam a project edits to bind coord to its repo layout.
// Engine files (paths.js, scripts/*, board/board.js, schemas) are
// engine-managed and must not be hand-edited.
//
// Scaffolded by \`coord init\`. Replace the example repo map with your own:
//   - Each repo code is a single uppercase letter.
//   - "X" is reserved for cross-repo / coord-only work and MUST NOT appear here.
//   - \`path\` is relative to the project root (one level above coordDir).
//   - \`integrationBranch\` is the per-repo integration base; the scaffolded
//     default is "main" (omit the key to fall back to the engine default "dev").
module.exports = {
  coordTicketPrefix: "COORD",
  repos: {
    B: {
      path: "backend",
      integrationBranch: "main",
      origin: null,
      legacyAliases: [],
      ticketPrefixes: [],
      testCommand: "npm test",
    },
    F: {
      path: "frontend",
      integrationBranch: "main",
      origin: null,
      legacyAliases: [],
      ticketPrefixes: [],
      testCommand: "npm test",
    },
  },
};
`;
}

// Product spec stubs ensured present (created only if missing). The release
// builder resets these same three to adopter stubs (step 4); init seeds the
// same stub text so a freshly-initialized repo and a freshly-cut release agree.
const PRODUCT_SPEC_STUBS = [
  {
    rel: "coord/product/REQUIREMENTS.md",
    body:
      "# Product Requirements\n\n" +
      "Replace this stub with your project's requirements (URS / functional /\n" +
      "non-functional). Keep requirement IDs stable so tickets, plan-record\n" +
      "requirement-closure, and `/traceability` can reference them.\n",
  },
  {
    rel: "coord/product/ARCHITECTURE.md",
    body:
      "# Architecture\n\n" +
      "Replace this stub with your system's architecture: components and\n" +
      "boundaries, data flow, runtime/ownership model, and integration points.\n",
  },
  {
    rel: "coord/product/MVP_AND_PHASE_MATRIX.md",
    body:
      "# MVP and Phase Matrix\n\n" +
      "Replace this stub with your delivery phases and the MVP cut — what ships\n" +
      "first versus what is deferred, and the gate between phases.\n",
  },
];

module.exports = function createCoordInit(deps = {}) {
  const fs = deps.fs || nodeFs;
  const log = deps.log || ((line) => console.log(line));
  const cwd = deps.cwd || (() => process.cwd());

  // Parse the init-specific argv slice (everything after `coord init`).
  function parseArgs(args = []) {
    const parsed = { dir: null, dryRun: false, help: false, unknown: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--dry-run") {
        parsed.dryRun = true;
      } else if (arg === "-h" || arg === "--help") {
        parsed.help = true;
      } else if (arg === "--dir") {
        parsed.dir = args[i + 1] || null;
        i += 1;
      } else if (arg.startsWith("--dir=")) {
        parsed.dir = arg.slice("--dir=".length);
      } else {
        parsed.unknown.push(arg);
      }
    }
    return parsed;
  }

  // Pure-ish planner: compute what init WOULD do against the target tree.
  // Returns an ordered list of { action: "create"|"skip", rel, abs, reason,
  // content }. No writes happen here.
  function plan(targetRoot) {
    const actions = [];

    const exists = (rel) => fs.existsSync(nodePath.join(targetRoot, rel));
    const add = (rel, content, presentReason) => {
      if (exists(rel)) {
        actions.push({ action: "skip", rel, reason: presentReason });
      } else {
        actions.push({ action: "create", rel, content });
      }
    };

    // 1. project.config.js seam.
    add(
      "coord/project.config.js",
      projectConfigTemplate(),
      "already configured"
    );

    // 2. starter board — only if absent. A populated board is never touched.
    add(
      "coord/board/tasks.json",
      JSON.stringify(buildStarterBoard(), null, 2) + "\n",
      "board already present (not overwritten)"
    );

    // 3. product spec stubs.
    for (const stub of PRODUCT_SPEC_STUBS) {
      add(stub.rel, stub.body, "spec stub already present");
    }

    return actions;
  }

  // Apply (or, in dry-run, just report) the plan. Idempotent + no-clobber:
  // "create" entries write the file (creating parent dirs); "skip" entries
  // touch nothing.
  function run(args = []) {
    // COORD-150: `coord init --wizard` delegates to the interactive config-as-code
    // scaffolder (coord-init-wizard.js). The default `coord init` path below stays
    // the idempotent no-clobber bootstrap. The wizard GENERATES config for review;
    // it applies no runtime state.
    if (args.includes("--wizard")) {
      const wizardArgs = args.filter((a) => a !== "--wizard");
      return createCoordInitWizard(deps).run(wizardArgs);
    }

    const opts = parseArgs(args);
    if (opts.help) {
      printUsage();
      return { ok: true, code: 0, actions: [] };
    }
    if (opts.unknown.length > 0) {
      log(`coord init: unexpected argument(s): ${opts.unknown.join(", ")}`);
      log("Run `coord init --help` for usage.");
      return { ok: false, code: 1, actions: [] };
    }

    const targetRoot = opts.dir
      ? nodePath.resolve(cwd(), opts.dir)
      : nodePath.resolve(cwd());

    const actions = plan(targetRoot);
    const created = actions.filter((a) => a.action === "create");
    const skipped = actions.filter((a) => a.action === "skip");

    log(`coord init — target: ${targetRoot}`);
    if (opts.dryRun) {
      log("(dry run — no files will be written)");
    }
    log("");

    for (const action of actions) {
      if (action.action === "create") {
        log(`  create  ${action.rel}`);
      } else {
        log(`  skip    ${action.rel}  (${action.reason})`);
      }
    }

    if (!opts.dryRun) {
      for (const action of created) {
        const abs = nodePath.join(targetRoot, action.rel);
        fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, action.content);
      }
    }

    log("");
    if (created.length === 0) {
      log("Already initialized — nothing to do.");
    } else if (opts.dryRun) {
      log(`Would create ${created.length} file(s), skip ${skipped.length}.`);
    } else {
      log(`Created ${created.length} file(s), skipped ${skipped.length}.`);
      log("");
      log("Next: edit coord/project.config.js with your repo map, then run");
      log("`coord/scripts/gov start <ticket>` to begin governed work.");
    }

    return { ok: true, code: 0, actions, targetRoot };
  }

  function printUsage() {
    log("Usage: coord init [--dir <path>] [--dry-run] [--wizard]");
    log("");
    log("Bootstrap a repo into a governed-board layout (idempotent, no-clobber).");
    log("");
    log("Options:");
    log("  --dir <path>   Target repo root. Defaults to the current directory.");
    log("  --dry-run      Print the plan without writing any files.");
    log("  --wizard       Interactive config-as-code scaffolder: GENERATES");
    log("                 coord/project.config.js for you to review + commit.");
    log("                 Run `coord init --wizard --help` for wizard options.");
    log("  -h, --help     Show this help text.");
  }

  return { parseArgs, plan, run, printUsage };
};
