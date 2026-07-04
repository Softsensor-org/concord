"use strict";

// COORD-435: direct coverage for tree-mutation-safety.js — the git-tree scope
// guard that keeps a governed mutation from touching files outside its ticket
// scope. Previously exercised only via its 3 callers.

const test = require("node:test");
const assert = require("node:assert");
const tms = require("./tree-mutation-safety.js");

test("COORD-435: parsePorcelainStatusPaths strips the status prefix and drops blanks", () => {
  const out = [
    " M coord/scripts/lifecycle.js",
    "?? coord/scripts/new.js",
    "A  coord/board/tasks.json",
    "",
  ].join("\n");
  const paths = tms.parsePorcelainStatusPaths(out);
  // The parser dedups and sorts the paths.
  assert.deepEqual(paths, [
    "coord/board/tasks.json",
    "coord/scripts/lifecycle.js",
    "coord/scripts/new.js",
  ]);
});

test("COORD-435: pathMatchesScope matches an in-scope path and rejects an out-of-scope one", () => {
  const scope = ["coord/scripts/lifecycle.js", "coord/board/"];
  assert.equal(tms.pathMatchesScope("coord/scripts/lifecycle.js", scope), true);
  assert.equal(tms.pathMatchesScope("coord/scripts/other.js", scope), false);
});

test("COORD-435: dirtyPathsOutsideScope returns only the paths outside the allowed scope", () => {
  const gitTry = () => ({
    status: 0,
    stdout: " M coord/scripts/lifecycle.js\n M coord/scripts/rogue.js\n",
  });
  const outside = tms.dirtyPathsOutsideScope({
    gitTry,
    repoRoot: "/repo",
    allowedPaths: ["coord/scripts/lifecycle.js"],
  });
  assert.deepEqual(outside, ["coord/scripts/rogue.js"]);
});

test("COORD-435: dirtyPathsOutsideScope is safe when git is unavailable or errors", () => {
  assert.deepEqual(tms.dirtyPathsOutsideScope({ gitTry: undefined }), []);
  assert.deepEqual(
    tms.dirtyPathsOutsideScope({ gitTry: () => ({ status: 1, stdout: "" }), repoRoot: "/r", allowedPaths: [] }),
    []
  );
});
