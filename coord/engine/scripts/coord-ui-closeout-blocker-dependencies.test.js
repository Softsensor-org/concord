"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("COORD-694: closeout-blocker edges point from child to parent without blocking child start", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord694-ui-"));
  const coord = path.join(root, "coord");
  try {
    for (const dir of ["scripts", "engine/scripts", "board", ".runtime/plans"]) {
      fs.mkdirSync(path.join(coord, dir), { recursive: true });
    }
    fs.copyFileSync(
      path.join(__dirname, "coord-ui-path-boundary.js"),
      path.join(coord, "engine/scripts/coord-ui-path-boundary.js")
    );
    fs.writeFileSync(
      path.join(coord, "scripts/governance.js"),
      "module.exports={__testing:{buildTicketNextCommands:()=>[]}};\n"
    );
    const rows = [
      { ID: "PARENT-694", Repo: "X", Type: "bug", Pri: "P1", Status: "todo", "Depends On": "" },
      { ID: "CHILD-694", Repo: "X", Type: "bug", Pri: "P1", Status: "todo", "Depends On": "PARENT-694, CONTROL-694" },
      { ID: "CONTROL-694", Repo: "X", Type: "bug", Pri: "P2", Status: "todo", "Depends On": "" }
    ];
    const board = path.join(coord, "board/tasks.json");
    fs.writeFileSync(
      board,
      JSON.stringify({
        sections: [{ kind: "table", rows }],
        followup_exceptions: {
          "CHILD-694": { type: "closeout-blocker", parent: "PARENT-694" }
        }
      })
    );
    for (const row of rows) {
      fs.writeFileSync(path.join(coord, `.runtime/plans/${row.ID}.json`), "{}\n");
    }

    const modulePath = path.resolve(__dirname, "../../../frontend/apps/coord-ui/lib/ticket-explain.ts");
    const reader = path.join(root, "read.mjs");
    fs.writeFileSync(
      reader,
      `import { loadTicketExplain } from ${JSON.stringify(modulePath)};\n` +
        `console.log(JSON.stringify(Object.fromEntries(['PARENT-694','CHILD-694','CONTROL-694'].map(id => [id, loadTicketExplain(id)]))));\n`
    );
    const readViews = () => {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--loader", path.join(__dirname, "__fixtures__/typescript-ui-loader.mjs"), reader],
        { cwd: root, env: { ...process.env, COORD_DIR: coord }, encoding: "utf8" }
      );
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim());
    };
    const views = readViews();

    assert.deepEqual(views["PARENT-694"].dependencies.detail, [
      { id: "CHILD-694", status: "todo", blocking: true, relation: "closeout-blocker" }
    ]);
    assert.equal(views["PARENT-694"].dependencies.headline, "Closeout waits for CHILD-694");
    assert.equal(views["PARENT-694"].startReadiness.level, "ready");

    assert.deepEqual(views["CHILD-694"].dependencies.detail, [
      { id: "CONTROL-694", status: "todo", blocking: true, relation: "dependency" }
    ]);
    assert.deepEqual(views["CHILD-694"].startReadiness.detail, ["Unresolved dependency blockers"]);

    assert.deepEqual(views["CONTROL-694"].dependencies.detail, []);
    assert.equal(views["CONTROL-694"].startReadiness.level, "ready");

    rows[1].Status = "done";
    fs.writeFileSync(board, JSON.stringify({
      sections: [{ kind: "table", rows }],
      followup_exceptions: {
        "CHILD-694": { type: "closeout-blocker", parent: "PARENT-694" }
      }
    }));
    const closedViews = readViews();
    assert.deepEqual(closedViews["PARENT-694"].dependencies.detail, [
      { id: "CHILD-694", status: "done", blocking: false, relation: "closeout-blocker" }
    ]);
    assert.equal(closedViews["PARENT-694"].dependencies.headline, "All closeout blockers closed");

    const ticketPage = fs.readFileSync(
      path.resolve(__dirname, "../../../frontend/apps/coord-ui/app/ticket/[id]/page.tsx"),
      "utf8"
    );
    assert.match(ticketPage, /' · closeout blocker'/);
    assert.match(ticketPage, /' · closeout clear'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
