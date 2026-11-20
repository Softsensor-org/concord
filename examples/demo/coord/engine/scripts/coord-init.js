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
const crypto = require("node:crypto");

const { buildStarterBoard, buildStarterPrompts } = require("./coord-init-starter-board.js");
const createCoordInitWizard = require("./coord-init-wizard.js");
const { governedCoordinationStateExists, coordinationStatePathsFor, formatJournalLostOverExistingStateMessage } = require("./journal-loss-guard.js");

// create-concord's install ownership manifest (coord-relative): the record of
// the exact bytes a reviewed install wrote.
const INSTALL_OWNERSHIP_FILE = ".concord-install-ownership.json";

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

    // Model-ticket prompts are part of a fresh adoption ladder. They are
    // created only when absent, so upgrades never clobber an adopter's work.
    for (const [id, body] of Object.entries(buildStarterPrompts())) {
      add(`coord/prompts/tickets/${id}.md`, body, "starter prompt already present");
    }

    // 3. product spec stubs.
    for (const stub of PRODUCT_SPEC_STUBS) {
      add(stub.rel, stub.body, "spec stub already present");
    }

    return actions;
  }

  // The engine's own coord root when `targetRoot` is this engine's workspace,
  // else null. Compares REAL paths so a symlinked cwd (e.g. macOS /var ->
  // /private/var) does not misread the engine's own workspace as foreign.
  function ownEngineCoordRoot(targetRoot) {
    const real = (p) => {
      try {
        return nodeFs.realpathSync(p);
      } catch {
        return nodePath.resolve(p);
      }
    };
    const engineCoordRoot = real(nodePath.resolve(__dirname, "..", ".."));
    return real(nodePath.resolve(targetRoot, "coord")) === engineCoordRoot ? engineCoordRoot : null;
  }

  // COORD-835: the decision records (ADRs, README index) a create-concord
  // install shipped are template content, not pre-existing state, but only
  // byte-for-byte as its ownership manifest recorded them. Without a readable
  // manifest nothing is exempt.
  function shippedDecisionRecordCheck(engineCoordRoot) {
    const manifestPath = nodePath.join(engineCoordRoot, INSTALL_OWNERSHIP_FILE);
    let owned;
    try {
      owned = JSON.parse(fs.readFileSync(manifestPath, "utf8")).files;
    } catch {
      return () => false;
    }
    if (!owned || typeof owned !== "object") return () => false;
    const workspaceRoot = nodePath.dirname(engineCoordRoot);
    return (filePath) => {
      const record = owned[nodePath.relative(workspaceRoot, filePath).split(nodePath.sep).join("/")];
      return Boolean(record) && record.digest === crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    };
  }

  // COORD-835: governed coordination state (board rows, plan records, prompts,
  // rendered views, decision records) at the engine's coord root, read through
  // the injected fs BEFORE init writes anything.
  function coordinationStateExistsAt(engineCoordRoot) {
    const paths = require("../../paths.js").createCoordPaths({ coordDir: engineCoordRoot, forceProjectConfig: true });
    return governedCoordinationStateExists(coordinationStatePathsFor(paths), fs,
      { isShippedDecisionRecord: shippedDecisionRecordCheck(engineCoordRoot) });
  }

  // COORD-835: read-only — does this engine's journal already carry a snapshot
  // baseline? Same predicate `ensureGovernanceJournalBaseline` no-ops on, under
  // the journal reader's own parse rule (coord/engine/scripts/journal.js readGovernanceEventLog /
  // readLatestGovernanceEvent): only ONE torn final line is tolerated (a crash
  // mid-append), falling back to the entry before it; any earlier unparseable
  // line makes the journal unreadable, which is no valid baseline. Read through
  // the injected fs, before init writes anything.
  function journalBaselineExists(engineCoordRoot) {
    const logPath = require("../../paths.js").createCoordPaths({ coordDir: engineCoordRoot, forceProjectConfig: true }).governanceEventLogPath;
    if (!fs.existsSync(logPath)) return false;
    const lines = String(fs.readFileSync(logPath, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean);
    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      try {
        events.push(JSON.parse(lines[index]));
      } catch {
        if (index !== lines.length - 1) return false;
      }
    }
    const latest = events[events.length - 1];
    return Boolean(latest && (latest.snapshot_digest || latest.snapshot));
  }

  // COORD-478: anchor the governance-journal genesis for the starter board init
  // just created. In-process (no subprocess — the COORD-477 guarantee holds) and
  // idempotent (`ensureGovernanceJournalBaseline` no-ops once a snapshot
  // baseline exists). Only runs when THIS engine instance is the target's own
  // vendored engine; a fail here warns rather than failing the bootstrap.
  // COORD-835: when coordination state existed before init recreated the board,
  // the journal refuses a genesis over it (a lost journal and board over live
  // state); init then refuses too and names the packet-bound reconcile.
  // Returns false only for that refusal. `run` already refuses that case before
  // writing anything; this backstop covers a baseline lost between the two.
  function anchorStarterBoardJournalGenesis(engineCoordRoot, stateExisted) {
    if (!engineCoordRoot) {
      log("  note    journal genesis not anchored (init targeted a root outside this engine's workspace; the target's own vendored engine anchors on its first init)");
      return true;
    }
    try {
      // A newly created board needs its projections before its genesis snapshot.
      // Preserve no-clobber semantics if an adopter already has any view bytes.
      // Pre-existing state never gets a genesis from init, so nothing to render.
      const paths = require("../../paths.js").createCoordPaths({ coordDir: engineCoordRoot, forceProjectConfig: true });
      const outputs = [paths.renderedTasksMdPath, paths.renderedPromptIndexMdPath,
        paths.tasksMdPath, paths.promptIndexMdPath, paths.planPath];
      if (!stateExisted && outputs.every((file) => !nodeFs.existsSync(file))) {
        require("../../board/board.js").renderBoardArtifacts();
      }
      const anchor =
        deps.anchorJournalBaseline ||
        ((options) => require(require("../../paths.js").resolveEngineModule(nodePath.resolve(__dirname, "..", ".."), "scripts/lifecycle.js")).ensureGovernanceJournalBaseline("coord-init-starter-board", options));
      anchor({ stateExisted });
      log("  anchor  coord/.runtime/governance-events.ndjson  (journal genesis for the starter board)");
    } catch (error) {
      const message = error && error.message ? error.message : error;
      if (stateExisted) {
        // guard:journal-genesis
        log("  refuse  journal genesis NOT anchored: governed coordination state existed before init recreated the board.");
        log(`          ${message}`);
        return false;
      }
      log(`  warn    could not anchor the journal genesis: ${message}`);
      log("          run `coord/scripts/gov doctor` before the first governed mutation.");
    }
    return true;
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

    const boardCreated = created.some((a) => a.rel === "coord/board/tasks.json");
    const engineCoordRoot = boardCreated ? ownEngineCoordRoot(targetRoot) : null;
    const stateExisted = engineCoordRoot !== null && coordinationStateExistsAt(engineCoordRoot);
    // COORD-835: coordination state predates init and no journal baseline
    // covers it (a lost journal and board over live state). Refuse BEFORE any
    // write or planned-file listing, in a dry run too, so the packet-bound
    // reconcile reviews what survived rather than an empty starter board init
    // would otherwise lay over it.
    if (stateExisted && !journalBaselineExists(engineCoordRoot)) {
      // guard:journal-genesis
      log("  refuse  journal genesis NOT anchored: governed coordination state existed before init and no journal baseline covers it.");
      log(`          ${formatJournalLostOverExistingStateMessage()}`);
      log("");
      log(`Refused: no files written (${created.length} planned${opts.dryRun ? ", dry run" : ""}).`);
      return { ok: false, code: 1, actions, targetRoot };
    }

    for (const action of actions) {
      if (action.action === "create") {
        log(`  create  ${action.rel}`);
      } else {
        log(`  skip    ${action.rel}  (${action.reason})`);
      }
    }

    let genesisAnchored = true;
    if (!opts.dryRun) {
      for (const action of created) {
        const abs = nodePath.join(targetRoot, action.rel);
        fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, action.content);
      }
      // COORD-478: init just CREATED the starter board (rows without a journal).
      // Without a journal genesis, the first governed mutation on this fresh
      // artifact is refused by the COORD-273 lost-journal seal (board rows +
      // absent journal reads as tamper). Init is the one writer that KNOWS this
      // state is a fresh bootstrap, so it anchors the genesis for the board it
      // itself wrote. Guarded to this engine's own workspace: `init --dir` at a
      // foreign root must not anchor a foreign engine's journal.
      if (boardCreated) {
        genesisAnchored = anchorStarterBoardJournalGenesis(engineCoordRoot, stateExisted);
      }
    }

    log("");
    if (created.length === 0) {
      log("Already initialized — nothing to do.");
    } else if (opts.dryRun) {
      log(`Would create ${created.length} file(s), skip ${skipped.length}.`);
    } else {
      log(`Created ${created.length} file(s), skipped ${skipped.length}.`);
      // COORD-835: no next-step advice over a refused genesis; the refusal named it.
      if (!genesisAnchored) return { ok: false, code: 1, actions, targetRoot };
      log("");
      log("Next: edit coord/project.config.js with your repo map, then run");
      log("`coord/scripts/gov start <ticket>` to begin governed work.");
    }

    return { ok: true, code: 0, actions, targetRoot };
  }

  // create-concord's transactional installer may supply a one-use, in-memory
  // callback after it has verified a fresh plan preimage and installed the
  // plan-owned starter board. This is deliberately not a CLI flag, environment
  // token, manifest credential, or persisted exemption: ordinary `coord init`
  // cannot authorize a baseline over existing coordination state.
  function anchorInstalledWorkspaceJournalGenesis() {
    if (typeof deps.anchorInstalledWorkspaceJournalGenesis !== "function") {
      throw new Error("installer journal-genesis authority was not supplied");
    }
    const anchored = deps.anchorInstalledWorkspaceJournalGenesis();
    if (anchored !== true) throw new Error("installer could not establish the fresh workspace journal genesis");
    return true;
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

  return { parseArgs, plan, run, printUsage, anchorInstalledWorkspaceJournalGenesis };
};
