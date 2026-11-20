"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("COORD-647: actual UI reader derives display totals without changing stored review evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord647-ui-"));
  const coord = path.join(root, "coord");
  try {
    for (const dir of ["scripts", "engine/scripts", "board", ".runtime/plans"]) fs.mkdirSync(path.join(coord, dir), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "coord-ui-path-boundary.js"), path.join(coord, "engine/scripts/coord-ui-path-boundary.js"));
    // Next-command routing is unrelated to review display and stays a fixture dependency.
    fs.writeFileSync(path.join(coord, "scripts/governance.js"), "module.exports={__testing:{buildTicketNextCommands:()=>[]}};\n");
    const board = path.join(coord, "board/tasks.json");
    fs.writeFileSync(board, JSON.stringify({ sections: [{ kind: "table", rows: [{ ID: "FIX-647", Repo: "X", Type: "bug", Pri: "P2", Status: "review", Owner: "fixture" }] }] }));
    const recordPath = path.join(coord, ".runtime/plans/FIX-647.json");
    const reader = path.join(root, "read.mjs");
    const modulePath = path.resolve(__dirname, "../../../frontend/apps/coord-ui/lib/ticket-explain.ts");
    fs.writeFileSync(reader, `import { loadTicketExplain } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(loadTicketExplain('FIX-647').reviewCycles));\n`);
    const stored = [];
    for (let n = 0; n <= 5; n += 1) {
      if (n) stored.push({ cycle: n, total: Math.max(3, n), lens: `lens ${n}`, risks: ["risk a", "risk b"], findings: "retained finding", verification: "retained verification", verdict: "pass" });
      fs.writeFileSync(recordPath, JSON.stringify({ self_review_cycles: stored }) + "\n");
      const before = [board, recordPath].map(p => fs.readFileSync(p, "utf8"));
      const result = spawnSync(process.execPath, ["--experimental-strip-types", "--loader", path.join(__dirname, "__fixtures__/typescript-ui-loader.mjs"), reader], { cwd: root, env: { ...process.env, COORD_DIR: coord }, encoding: "utf8" });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr);
      const view = JSON.parse(result.stdout.trim());
      assert.deepEqual(view, stored.map(c => ({ ...c, total: n })), "the actual UI projection must use the current cycle count");
      assert.deepEqual([board, recordPath].map(p => fs.readFileSync(p, "utf8")), before);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
