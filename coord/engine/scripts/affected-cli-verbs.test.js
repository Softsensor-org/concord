"use strict";

// COORD-1031 (d): CLI-verb-to-module edges. A suite that spawns the CLI (`gov <verb>`) is selected
// when a module that the verb's route reaches changes, derived from cli.js's route table.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const graphLib = require("./affected-graph.js");
const cv = require("./affected-cli-verbs.js");
const { ROWS } = require("./command-declaration.js");

const CLI = "coord/engine/scripts/cli.js";
const LIFECYCLE = "coord/engine/scripts/lifecycle.js";
const TRANSITIONS = "coord/engine/scripts/ticket-transitions.js";
const OTHER = "coord/engine/scripts/other-module.js";
const SPAWNER = "coord/engine/scripts/spawns-cli.test.js";
const UNRELATED = "coord/engine/scripts/unrelated.test.js";

// A tiny tree: cli.js routes "start" through lifecycle.js (which loads ticket-transitions.js) and
// "explain" through other-module.js. Neither test file names a module; they only spawn the CLI.
const FILES = [CLI, LIFECYCLE, TRANSITIONS, OTHER, SPAWNER, UNRELATED];
const SOURCES = new Map([
  [CLI, [
    'const lifecycle = require("./lifecycle.js");',
    'const { explainNote } = require("./other-module.js");',
    'const ROUTE_HANDLERS = Object.freeze({',
    '  "start": (command, args) => lifecycle.startTicket(args[0]),',
    '  "explain": (command, args) => explainNote(args[0]),',
    '});',
  ].join("\n")],
  [LIFECYCLE, 'const transitions = require("./ticket-transitions.js");\nmodule.exports = { startTicket: (id) => transitions.start(id) };'],
  [TRANSITIONS, "module.exports = { start: () => 1 };"],
  [OTHER, "module.exports = { explainNote: () => 2 };"],
  [SPAWNER, 'const { spawnSync } = require("node:child_process");\nspawnSync(process.execPath, ["coord/scripts/governance.js", "start", "COORD-1"]);'],
  [UNRELATED, 'const { spawnSync } = require("node:child_process");\nspawnSync(process.execPath, ["coord/scripts/governance.js", "counts"]);'],
]);
const ROWS_T = [
  { spelling: "start", handler: "start" },
  { spelling: "explain", handler: "explain" },
  { spelling: "counts", handler: "counts" },
];
// `counts` has no arm in SOURCES below, so it falls back to cli.js (the unparsed-arm case).

function graph(cliRows = ROWS_T) {
  return graphLib.buildGraph({ root: "/nonexistent", files: FILES, sources: SOURCES, cliRows });
}

test("COORD-1031 (d): a CLI-spawning suite is selected by a change to a module its verb's route reaches", () => {
  const g = graph();
  const picked = graphLib.dependentsOf(g, [TRANSITIONS]);
  assert.ok(picked.has(SPAWNER), "spawns start, which reaches ticket-transitions.js through lifecycle.js");
});

test("COORD-1031 (d): every arm also reaches cli.js (the dispatcher), so the edge is sound but not verb-precise", () => {
  // A module under cli.js's import closure reaches every arm through cli.js, so the CLI-spawning
  // suite of an unrelated verb is selected too. This is the cost of soundness: the dispatcher is
  // one shared surface, and the selection never misses a verb whose route reaches the change.
  const picked = graphLib.dependentsOf(graph(), [TRANSITIONS]);
  assert.ok(picked.has(UNRELATED));
});

test("COORD-1031 (d): without the verb edges the CLI-only suite is not reached (the seeded gap)", () => {
  const g = graph([]);
  const picked = graphLib.dependentsOf(g, [TRANSITIONS]);
  assert.equal(picked.has(SPAWNER), false);
});

test("COORD-1031 (d): every arm reaches cli.js itself, so a change to the dispatcher selects every verb's suites", () => {
  const picked = graphLib.dependentsOf(graph(), [CLI]);
  assert.ok(picked.has(SPAWNER));
  assert.ok(picked.has(UNRELATED));
});

test("COORD-1031 (d): an unparsed arm falls back to cli.js, so a verb is never dropped", () => {
  const g = graph([{ spelling: "ghost", handler: "ghost" }]);
  const node = cv.nodeOf("ghost");
  assert.deepEqual([...g.edges.get(node)], [CLI]);
  const sourceOnly = graphLib.buildGraph({
    root: "/nonexistent", files: [], sources: new Map([[CLI, SOURCES.get(CLI)]]),
    cliRows: [{ spelling: "ghost", handler: "ghost" }],
  });
  assert.deepEqual([...sourceOnly.reverse.get(CLI)], [node], "the dispatcher remains reachable from a source-only graph");
});

test("COORD-1031 (d): the route arms and their top-level declarations are read from cli.js", () => {
  const arms = cv.routeArms(SOURCES.get(CLI));
  assert.deepEqual([...arms.keys()].sort(), ["explain", "start"]);
  const chunks = cv.topLevelChunks(SOURCES.get(CLI));
  assert.ok(chunks.has("lifecycle"));
  const noIdentifiers = new Map([["result", "42"]]);
  assert.deepEqual(cv.reachedCliText("0", noIdentifiers), ["0"]);
  assert.deepEqual(cv.reachedCliText("result", noIdentifiers), ["result", "42"]);
});

test("COORD-1031 (d): the real cli.js routes are present for every declared handler", () => {
  const repo = path.resolve(__dirname, "..", "..", "..");
  const fs = require("node:fs");
  const { stripComments } = require("./comment-lexer.js");
  const code = stripComments(fs.readFileSync(path.join(repo, CLI), "utf8"));
  const arms = cv.routeArms(code);
  const missing = [...new Set(ROWS.map((r) => r.handler))].filter((h) => !arms.has(h));
  assert.deepEqual(missing, [], "every declared handler has an arm; a missing one falls back to cli.js");
});
