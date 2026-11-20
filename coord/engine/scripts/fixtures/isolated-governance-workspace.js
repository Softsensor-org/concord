"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function createIsolatedGovernanceWorkspace({ sourceCoord = path.resolve(__dirname, "../../.."), prefix = "coord-gov-fixture-" } = {}) {
  const { resolveEngineModule } = require(path.join(sourceCoord, "paths.js"));
  // Git reports canonical paths even when TMPDIR is reached through a symlink.
  // Keep fixture paths on that same canonical root so relative governed paths
  // never escape via `../../...` when the host uses a symlinked scratch dir.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const coord = path.join(root, "coord");
  fs.mkdirSync(coord);
  fs.cpSync(path.join(sourceCoord, "engine"), path.join(coord, "engine"), { recursive: true });
  for (const name of ["scripts", "board", "paths.js", "GOVERNANCE.md", "AGENTS.md", "product", "schemas", "docs", "agents.json", "gates", "TEMPLATE_SYNC_MANIFEST.json", "engine-pin.json", ".gitignore"]) {
    const source = path.join(sourceCoord, name);
    if (!fs.existsSync(source)) continue;
    const options = name === "docs" ? {
      recursive: true,
      filter: (entry) => !path.relative(source, entry).split(path.sep).join("/").startsWith("decisions/"),
    } : { recursive: true };
    fs.cpSync(source, path.join(coord, name), options);
  }
  fs.mkdirSync(path.join(coord, "docs", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(coord, "project.config.js"), 'module.exports={repos:{B:{path:"backend",integrationBranch:"dev"}}};\n');
  fs.writeFileSync(path.join(coord, "board", "tasks.json"), JSON.stringify({ version: 1,
    metadata: { title: "Isolated governance fixture", last_updated: "2026-01-01", canonical_references: [], preamble: [] },
    sections: [{ kind: "table", level: 2, heading: "Tickets", separator_before: false,
      columns: ["ID", "Repo", "Type", "Pri", "Status", "Owner", "Description", "Depends On"], rows: [] }],
    prompt_index: {}, pr_index: {}, landing_index: {}, review_findings: {}, followup_exceptions: {},
  }, null, 2));
  fs.writeFileSync(path.join(coord, "PLAN.md"), "");
  fs.writeFileSync(path.join(coord, "QUESTIONS.md"), "# Questions\n");
  fs.mkdirSync(path.join(root, "backend"));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return String(result.stdout || "").trim();
  };
  git("init", "-b", "dev");
  git("config", "user.email", "coord-gov-fixture@example.invalid");
  git("config", "user.name", "Governance Fixture");
  git("add", ".");
  git("commit", "-m", "Seed isolated coord governance fixture");
  const governance = require(resolveEngineModule(coord, "scripts/governance.js"));
  const env = { COORD_PROVIDER: "codex", COORD_INSTANCE_ID: path.basename(root), CODEX_THREAD_ID: `thread-${path.basename(root)}` };
  return {
    root,
    coord,
    governance,
    env,
    invoke(args) { return governance.executeCommand(args, { cwd: root, env }); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

module.exports = { createIsolatedGovernanceWorkspace };
