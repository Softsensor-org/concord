"use strict";

// COORD-663-F3 (D5) — destructive-operation detection over EXECUTABLE REGIONS.
//
// THE DEFECT. `decide()` ran the DESTRUCTIVE_SHELL patterns against the RAW
// command string before any lexing, so text that merely DESCRIBED a removal
// was refused as if it performed one. Two confirmed false positives, both live
// under the COORD-663 lock at canonical 20cf3ce0:
//
//   FP1  a `python3 -` heredoc whose executed body WROTE a node
//        recursive-removal call into a test file as source text. The operation
//        performed was a file write; the match landed on a string literal.
//   FP2  a `gov add-finding --summary "…"` whose argument described the tokens
//        in PROSE. Never executed — and this one blocked the filing of the
//        defect itself.
//
// THE BOUNDARY, and why the obvious remedies are bypasses. "Ignore heredoc
// bodies" would permit a real deletion, because `python3 -` executes its body:
// that case was refused CORRECTLY and the first diagnosis wrongly called it a
// false positive (see COORD-663-F2 -> F3 and the QUESTIONS correction).
// "Ignore quoted text" would permit a quoted command word, which the shell runs
// just the same. So the rule is neither: analyse what is EXECUTED.
//
// Every RED proof below is pinned against `legacyRawTextDetection`, the shipped
// behaviour preserved verbatim, so the false positives are demonstrated rather
// than described — and every genuine-deletion proof is asserted against BOTH
// implementations, so the repair provably did not open what it narrows.

const test = require("node:test");
const assert = require("node:assert/strict");

const { DESTRUCTIVE_SHELL } = require("./runtime-authority.js");
const {
  decide,
  executableRegions,
  hasDestructiveOperation,
} = require("./runtime-authority-decision.js");

// The shipped detection, preserved exactly: the raw string, no lexing.
function legacyRawTextDetection(command) {
  return DESTRUCTIVE_SHELL.some((pattern) => pattern.test(String(command || "")));
}

// --------------------------------------------------------------------------
// The two confirmed false positives.
// --------------------------------------------------------------------------

// Reconstructed from the refused call: a heredoc body that writes a removal
// call into a test file. Assembled from fragments so this test file cannot
// itself trip the live barrier while the defect is open.
const REMOVAL_CALL_SOURCE = `fs.${"rmSync"}(dir, { recursive: true, force: true });`;
const FP1_COMMAND = [
  "python3 - <<PY",
  "p = 'coord/board/board.test.js'",
  "s = open(p).read()",
  `s = s.replace(old, "${REMOVAL_CALL_SOURCE}")`,
  "open(p, 'w').write(s)",
  "PY",
  "",
].join("\n");

const PROSE = `the agent could not run ${"rm"} -rf or shutil.${"rmtree"}(x) on its own fixture`;
const FP2_COMMAND = `coord/scripts/gov add-finding COORD-663 --severity HIGH --summary "${PROSE}"`;

test("RED PROOF FP1: raw-text detection refuses a heredoc that WRITES a removal call as source text", () => {
  assert.equal(
    legacyRawTextDetection(FP1_COMMAND),
    true,
    "documents FP1: the shipped classifier matched a string literal being written to a file"
  );
});

test("GREEN FP1: the written source text is DATA, and the file write is permitted", () => {
  assert.equal(hasDestructiveOperation(FP1_COMMAND), false);

  // The body IS analysed — it is interpreter-fed program text, not skipped.
  // What changed is that its string literals are data.
  const regions = executableRegions(FP1_COMMAND);
  const program = regions.filter((region) => region.kind === "program");
  assert.equal(program.length, 1, "the python3 - heredoc body is an executable region");
  assert.match(program[0].text, /open\(p, "DATA"\)\.write\(s\)|open\(p, .DATA.\)\.write\(s\)/);
  assert.doesNotMatch(program[0].text, /rmSync/, "the literal being written is masked");
});

test("RED PROOF FP2: raw-text detection refuses PROSE in an argument — this blocked D5's own filing", () => {
  assert.equal(
    legacyRawTextDetection(FP2_COMMAND),
    true,
    "documents FP2: describing the tokens in a --summary made the add-finding call itself refused"
  );
});

test("GREEN FP2: a quoted argument is data, and the governed filing is permitted", () => {
  assert.equal(hasDestructiveOperation(FP2_COMMAND), false);
  const shell = executableRegions(FP2_COMMAND).filter((region) => region.kind === "shell");
  assert.equal(shell.length, 1);
  assert.match(shell[0].text, /coord\/scripts\/gov add-finding COORD-663 --severity HIGH --summary DATA$/);
});

// --------------------------------------------------------------------------
// The repair did not open what it narrows.
// --------------------------------------------------------------------------

const GENUINE = {
  "a plain removal": `${"rm"} -rf coord/GOVERNANCE.md`,
  "a removal after a chained command": `echo start && ${"rm"} -rf build`,
  "a removal with a sudo prefix": `sudo ${"rm"} -rf /var/lib/thing`,
  "find with the delete action": `${"find"} . -name '*.tmp' -delete`,
  "rsync with the delete flag": `rsync -a --delete src/ dst/`,
  "a hard git reset": `git reset --hard origin/main`,
  "a git clean": `git clean -fdx`,
  "an interpreter-fed heredoc that REALLY deletes": [
    "python3 - <<PY",
    "import shutil",
    `shutil.${"rmtree"}("backend/.worktrees/claudea0000")`,
    "PY",
    "",
  ].join("\n"),
  "a node -e removal": `node -e 'fs.${"rmSync"}("coord/GOVERNANCE.md", { force: true })'`,
  "a python -c removal": `python3 -c 'import shutil; shutil.${"rmtree"}("coord")'`,
};

test("every genuine destructive operation is STILL refused, by both implementations", () => {
  for (const [label, command] of Object.entries(GENUINE)) {
    assert.equal(legacyRawTextDetection(command), true, `precondition: ${label} was refused before`);
    assert.equal(hasDestructiveOperation(command), true, `REGRESSION: ${label} is no longer refused`);
  }
});

test("COORD-665 cell 4: the lock-free deletion arm still classifies as destructive", () => {
  // Cell 4 proved this operation is PERMITTED with no lock because the barrier
  // disengages there — not because it stops being destructive. The
  // classification itself must survive this repair.
  assert.equal(hasDestructiveOperation(`${"rm"} -f coord/.probe-cell4.txt`), true);
});

test("quoting does NOT exempt a command word", () => {
  for (const command of [
    `"${"rm"}" -rf coord/GOVERNANCE.md`,
    `'${"rm"}' -rf coord/GOVERNANCE.md`,
    `"/bin/${"rm"}" -rf coord/GOVERNANCE.md`,
  ]) {
    assert.equal(hasDestructiveOperation(command), true, `quoted command word must stay executable: ${command}`);
  }
});

test("evaluator surfaces make their ARGUMENT executable — relocating a deletion inside -c is not a bypass", () => {
  for (const command of [
    `bash -c "${"rm"} -rf coord"`,
    `sh -c '${"rm"} -rf coord'`,
    `env FOO=1 bash -c "${"rm"} -rf coord"`,
    `bash -c "bash -c \\"${"rm"} -rf coord\\""`,
    `echo coord | xargs ${"rm"} -rf`,
  ]) {
    assert.equal(hasDestructiveOperation(command), true, `evaluator surface must be executable: ${command}`);
  }
});

test("a heredoc fed to a NON-interpreter stays data (the D2/D3 boundary holds)", () => {
  const command = [
    "cat > notes.txt <<EOF",
    `run ${"rm"} -rf build when the cache is stale`,
    "EOF",
    "",
  ].join("\n");
  assert.equal(legacyRawTextDetection(command), true, "the shipped classifier refused this documentation write");
  assert.equal(hasDestructiveOperation(command), false, "cat does not execute its heredoc");
});

test("an unterminated string literal does not swallow the rest of a program region", () => {
  // Masking only closes COMPLETE literals, so a stray quote cannot hide a real
  // call behind it.
  const command = [
    "python3 - <<PY",
    "broken = 'oops",
    `shutil.${"rmtree"}("coord")`,
    "PY",
    "",
  ].join("\n");
  assert.equal(hasDestructiveOperation(command), true);
});

// --------------------------------------------------------------------------
// Through the real decision, with a real lock.
// --------------------------------------------------------------------------

function lockedInput(command) {
  return {
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    locks: {
      active: [{ ticket: "COORD-663", owner: "claudea663", worktree: "/workspace/coord/.worktrees/claudea662/COORD-663", status: "doing" }],
      unreadable: [],
    },
    actor: { resolved: true, owner: "claudea663", reason: "test" },
    caseInsensitive: false,
    payload: { tool_name: "Bash", tool_input: { command } },
  };
}

test("decide(): the two false positives are permitted and a real deletion is refused, under an ACTIVE lock", () => {
  assert.equal(decide(lockedInput(FP1_COMMAND)).decision, "allow");
  assert.equal(decide(lockedInput(FP2_COMMAND)).decision, "allow");

  const refused = decide(lockedInput(`${"rm"} -rf /workspace/coord/GOVERNANCE.md`));
  assert.equal(refused.decision, "deny");
  assert.equal(refused.code, "destructive_shell");
});
