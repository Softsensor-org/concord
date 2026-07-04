const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __testing,
  createTempGitRepoWithOrigin,
} = require("./governance-test-utils.js");

// COORD-099 (governance.test residual split, slice 4): prompt-coverage
// behavior. Every subject here is DEFINED in prompt-coverage.js (the
// createPromptCoverage factory) — the module that owns prompt parsing, waiver
// reads, and precondition resolution:
//   - parsePromptLikelyFiles / parsePromptPreconditions
//   - classifyPreconditionArtifact / verifyPromptPreconditions
//   - hasPromptWaiver / buildPromptWaiverCommand
// Subjects are exercised through the fully-wired governance facade (`__testing`)
// exactly as governance.test.js did, so behavior is byte-identical — only the
// home moved. The register-prompt VERB and start-gate (assertPromptPrecondition
// Resolve) integration tests stay in governance.test.js: those drive the
// governance facade end-to-end (executeCommand / path-seam rebinding /
// GovernanceError), not the parsing units owned here.

test("hasPromptWaiver reads machine-readable waiver records from board state", () => {
  const board = {
    waiver_index: {
      "DEBT-046": {
        code: "prompt_coverage",
        reason: "Direct human instruction approved without prompt remap.",
        recorded_at: "2026-03-30T12:00:00.000Z",
        recorded_by: "codexa00",
      },
    },
  };

  assert.equal(__testing.hasPromptWaiver(board, "DEBT-046"), true);
  assert.equal(__testing.hasPromptWaiver(board, "DEBT-999"), false);
  assert.equal(
    __testing.buildPromptWaiverCommand("DEBT-046"),
    'coord/scripts/gov set-waiver DEBT-046 --reason "<why prompt coverage waiver is accepted>"'
  );
});

test("COORD-009: parsePromptLikelyFiles extracts the Likely Files section, ignoring annotations and TODO stubs", () => {
  const prompt = [
    "# SEC-010: harden session handling.",
    "",
    "## Context",
    "Some context paragraph mentioning `src/red-herring.ts` in prose.",
    "",
    "## Likely Files",
    "",
    "- `src/auth/session.ts`",
    "- `src/auth/token.ts` — the token mint path",
    "* services/api/middleware/auth.ts",
    "1. `src/auth/index.ts`",
    "- TODO: add more as discovered",
    "- (none)",
    "",
    "## Verification",
    "- `node --test`",
  ].join("\n");
  const parsed = __testing.parsePromptLikelyFiles(prompt);
  assert.deepEqual(parsed, [
    "src/auth/session.ts",
    "src/auth/token.ts",
    "services/api/middleware/auth.ts",
    "src/auth/index.ts",
  ]);
  // A prompt with no Likely Files section seeds nothing.
  assert.deepEqual(
    __testing.parsePromptLikelyFiles("# T\n\n## Context\nNothing here.\n"),
    []
  );
  // Non-string / empty input is tolerated.
  assert.deepEqual(__testing.parsePromptLikelyFiles(null), []);
  assert.deepEqual(__testing.parsePromptLikelyFiles(""), []);
});

test("COORD-008: parsePromptPreconditions extracts the optional section, ignoring everything else", () => {
  const prompt = [
    "# TICKET-1: do a thing",
    "",
    "## Context",
    "Some prose with a `## Preconditions` mention that is not a heading.",
    "",
    "## Preconditions",
    "- path:apps/ui/lib/floor.ts",
    "- `/floor-workscreen`",
    "- symbol:apps/ui/screens/Call.tsx#CallCenterWorkscreen — the gated screen",
    "- TODO: placeholder line that must be ignored",
    "",
    "## Likely Files",
    "- apps/ui/screens/NewThing.tsx",
  ].join("\n");
  const preconditions = __testing.parsePromptPreconditions(prompt);
  assert.deepEqual(preconditions, [
    "path:apps/ui/lib/floor.ts",
    "/floor-workscreen",
    "symbol:apps/ui/screens/Call.tsx#CallCenterWorkscreen",
  ]);
});

test("COORD-008: a prompt with no Preconditions section declares nothing (back-compat)", () => {
  const prompt = [
    "# TICKET-2",
    "## Context",
    "no preconditions here",
    "## Likely Files",
    "- a.ts",
  ].join("\n");
  assert.deepEqual(__testing.parsePromptPreconditions(prompt), []);
});

test("COORD-008: classifyPreconditionArtifact distinguishes paths, routes, and symbols", () => {
  assert.equal(__testing.classifyPreconditionArtifact("path:a/b.ts").kind, "path");
  assert.equal(__testing.classifyPreconditionArtifact("route:/x").kind, "literal");
  const sym = __testing.classifyPreconditionArtifact("symbol:a/b.ts#Foo");
  assert.equal(sym.kind, "symbol");
  assert.equal(sym.path, "a/b.ts");
  assert.equal(sym.symbol, "Foo");
  // Bare tokens: a leading slash is a route literal, a path-like token is a path.
  assert.equal(__testing.classifyPreconditionArtifact("/floor-workscreen").kind, "literal");
  assert.equal(__testing.classifyPreconditionArtifact("apps/ui/lib/floor.ts").kind, "path");
  // A bare symbol name with no separator greps as a literal.
  assert.equal(__testing.classifyPreconditionArtifact("CallCenterWorkscreen").kind, "literal");
  // A malformed symbol entry is invalid.
  assert.equal(__testing.classifyPreconditionArtifact("symbol:nohash").kind, "invalid");
});

test("COORD-008: verifyPromptPreconditions passes when declared artifacts resolve on the integration ref", () => {
  const repo = createTempGitRepoWithOrigin("ebmr-coord008-ok-", {
    "src/floor.ts": "export const floorWorkscreen = '/floor-workscreen';\n",
    "src/screens/Call.tsx": "export function CallCenterWorkscreen() { return null; }\n",
  });
  const report = __testing.verifyPromptPreconditions(repo.repoRoot, "dev", [
    "path:src/floor.ts",
    "/floor-workscreen",
    "symbol:src/screens/Call.tsx#CallCenterWorkscreen",
  ]);
  assert.equal(report.ok, true, `expected all preconditions to resolve; unresolved=${JSON.stringify(report.unresolved)}`);
  assert.equal(report.unresolved.length, 0);
  assert.equal(report.verified.length, 3);
});

test("COORD-008: verifyPromptPreconditions fails when a declared artifact resolves in no branch", () => {
  const repo = createTempGitRepoWithOrigin("ebmr-coord008-stale-", {
    "src/existing.ts": "export const ok = true;\n",
  });
  const report = __testing.verifyPromptPreconditions(repo.repoRoot, "dev", [
    "path:src/existing.ts",
    "path:src/screens/CallCenterWorkscreen.tsx",
    "/floor-workscreen",
  ]);
  assert.equal(report.ok, false);
  const unresolvedRaw = report.unresolved.map((u) => u.raw).sort();
  assert.deepEqual(unresolvedRaw, ["/floor-workscreen", "path:src/screens/CallCenterWorkscreen.tsx"]);
  // The artifact that DOES exist is still reported as verified.
  assert.deepEqual(report.verified.map((v) => v.raw), ["path:src/existing.ts"]);
});

test("COORD-008: verifyPromptPreconditions with an empty precondition list is a no-op pass", () => {
  const repo = createTempGitRepoWithOrigin("ebmr-coord008-empty-", { "a.txt": "x\n" });
  const report = __testing.verifyPromptPreconditions(repo.repoRoot, "dev", []);
  assert.equal(report.ok, true);
  assert.equal(report.unresolved.length, 0);
});

// ===========================================================================
// COORD-100 (governance.test residual split, capstone): relocated single-module
// behavior tests reaching the fully-wired `__testing` facade (byte-identical).
// ===========================================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withCanonicalTicketPrompt, withRegisterPromptHarness } = require("./governance-test-utils.js");


// ---------------------------------------------------------------------------
// COORD-023: prompt registration ergonomics — register-prompt verb + start
// auto-discover of an on-disk prompt.
// ---------------------------------------------------------------------------

// Fixture-self-contained canonical-prompt provisioning. These tests exercise the
// real on-disk prompt resolution (COORD_DIR/prompts/tickets/<id>.md), which the
// public-release builder strips (it deletes coord/prompts/tickets/*.md and resets
// the board). Rather than depend on a specific donor prompt that may not exist in
// a built/adopter checkout, write the canonical prompt on disk if it is missing
// and remove only what we created — so the coverage runs identically in the donor
// (file already present → no-op) and in a stripped public artifact (created
// transiently). Self-contained: no reliance on which donor tickets happen to ship.

test("COORD-023: defaultTicketPromptRelPath / ticketPromptRelPathExists resolve the canonical on-disk prompt", () => {
  // Self-contained: ensure COORD-023's canonical prompt exists on disk; a bogus id does not.
  withCanonicalTicketPrompt("COORD-023", "# COORD-023 fixture prompt\n", () => {
    const rel = __testing.defaultTicketPromptRelPath("COORD-023");
    assert.equal(rel, "coord/prompts/tickets/COORD-023.md");
    assert.equal(__testing.ticketPromptRelPathExists(rel), true);
    assert.equal(
      __testing.ticketPromptRelPathExists(__testing.defaultTicketPromptRelPath("COORD-999-NOPE")),
      false,
    );
  });
});


test("COORD-023: ensurePromptCoverageOrDiscover registers an on-disk prompt and reports false when neither exists", () => {
  // Discovery path: an unregistered ticket whose canonical prompt exists on
  // disk (COORD-024) is auto-registered and returns true.
  withRegisterPromptHarness("coord023-discover-yes-", { ticketId: "COORD-024" }, ({ readBoard }) => {
    const promptAbs = path.join(__testing.paths.PROMPTS_DIR, "tickets", "COORD-024.md");
    fs.mkdirSync(path.dirname(promptAbs), { recursive: true });
    fs.writeFileSync(promptAbs, "# COORD-024 fixture prompt\n", "utf8");
      const board = readBoard();
      const discovered = __testing.ensurePromptCoverageOrDiscover(board, "COORD-024");
      assert.equal(discovered, true, "an on-disk prompt must be discovered");
      assert.equal(board.prompt_index["COORD-024"].endsWith("/prompts/tickets/COORD-024.md"), true);
  });

  // No prompt_index, no waiver, no on-disk file -> false (the original error stands).
  withRegisterPromptHarness("coord023-discover-no-", { ticketId: "GHOST-001" }, ({ readBoard }) => {
    const board = readBoard();
    assert.equal(__testing.ensurePromptCoverageOrDiscover(board, "GHOST-001"), false);
  });

  // Already registered -> true without touching disk.
  withRegisterPromptHarness("coord023-discover-have-", { ticketId: "IMP-700", promptRegistered: "coord/prompts/implementer.md" }, ({ readBoard }) => {
    const board = readBoard();
    assert.equal(__testing.ensurePromptCoverageOrDiscover(board, "IMP-700"), true);
    assert.equal(board.prompt_index["IMP-700"], "coord/prompts/implementer.md");
  });
});

function readLastJournalEvent(logPath) {
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test("COORD-350: register-prompt --create creates a missing canonical prompt and mapping atomically", () => {
  withRegisterPromptHarness("coord350-create-", { ticketId: "IMP-701" }, ({ readBoard }) => {
    const promptPath = path.join(__testing.paths.PROMPTS_DIR, "tickets", "IMP-701.md");
    const result = __testing.registerPrompt("IMP-701", { create: true, path: promptPath });
    const board = readBoard();
    const promptRel = board.prompt_index["IMP-701"];

    assert.equal(result.created, true);
    assert.equal(promptRel.endsWith("/prompts/tickets/IMP-701.md"), true);
    assert.equal(fs.existsSync(path.resolve(__dirname, "..", "..", promptRel)), true);

    const event = readLastJournalEvent(__testing.paths.GOVERNANCE_EVENT_LOG_PATH);
    assert.equal(event.command, "register-prompt");
    assert.equal(event.result, "succeeded");
    assert.ok(
      event.changed_paths.some((p) => String(p).endsWith("/prompts/tickets/IMP-701.md")),
      "created prompt file is inside the journaled mutation snapshot"
    );

    // A second governed command should be idempotent and should not require a
    // manual reconcile after the create/register command.
    const again = __testing.registerPrompt("IMP-701", {});
    assert.equal(again, undefined);
  });
});

test("COORD-350: register-prompt without --create still fails closed on a missing file", () => {
  withRegisterPromptHarness("coord350-missing-", { ticketId: "IMP-702" }, () => {
    assert.throws(
      () => __testing.registerPrompt("IMP-702", {}),
      (err) => err instanceof Error && /prompt file not found/.test(err.message)
    );
  });
});

test("COORD-350: register-prompt --create fails closed on duplicate mapping unless forced", () => {
  withRegisterPromptHarness(
    "coord350-duplicate-",
    { ticketId: "IMP-703", promptRegistered: "coord/prompts/old.md" },
    ({ readBoard }) => {
      const promptPath = path.join(__testing.paths.PROMPTS_DIR, "tickets", "IMP-703.md");
      assert.throws(
        () => __testing.registerPrompt("IMP-703", { create: true, path: promptPath }),
        (err) => err instanceof Error && /already registered to coord\/prompts\/old\.md/.test(err.message)
      );

      const forced = __testing.registerPrompt("IMP-703", { create: true, path: promptPath, force: true });
      const board = readBoard();
      assert.equal(forced.created, true);
      assert.equal(board.prompt_index["IMP-703"].endsWith("/prompts/tickets/IMP-703.md"), true);
    }
  );
});
