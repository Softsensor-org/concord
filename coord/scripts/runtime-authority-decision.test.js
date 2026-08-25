"use strict";

// COORD-645 — proofs for the runtime authority write barrier's decision core.
//
// Every guard below is demonstrated FAILING on an injected violation. The
// headline case is the literal 2026-08-04 incident, and it is proved twice:
// once against `legacyCwdScopedDecision` (a faithful re-implementation of the
// SHIPPED findLock/exit(0) logic) which PERMITS it — the red proof, pinned so
// the regression cannot silently return — and once against `decide`, which
// refuses it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const {
  classifyTarget,
  decide,
  effectiveThreadId,
  enumerateLocks,
  extractCall,
  hasShellComposition,
  isGovernedTransaction,
  lexShell,
  resolveActor,
  shellWriteTargets,
  targetPaths,
} = require("./runtime-authority-decision.js");

const HOOK = path.join(__dirname, "runtime-authority-hook.js");

// --------------------------------------------------------------------------
// The shipped (defective) logic, preserved verbatim in behaviour so the red
// proof is a real comparison rather than a description of one.
//   findLock: only a lock whose worktree CONTAINS process.cwd() is considered.
//   no match: bare process.exit(0) — permit unconditionally.
// --------------------------------------------------------------------------
function legacyCwdScopedDecision({ cwd, locks }) {
  const lock = (locks.active || []).find(
    (entry) => cwd === entry.worktree || cwd.startsWith(`${entry.worktree}${path.sep}`)
  );
  if (!lock) return { decision: "allow", code: "legacy_no_cwd_lock" };
  return { decision: "evaluated", lock };
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-645-")));
  fs.mkdirSync(path.join(root, "coord", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", ".runtime", "locks"), { recursive: true });
  fs.mkdirSync(path.join(root, "coord", "board"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord", "scripts", "governed-workspace-recovery.js"), "// canonical\n");
  fs.writeFileSync(path.join(root, "coord", "board", "tasks.json"), "[]\n");
  return root;
}

function makeWorktree(root, owner, ticket) {
  const worktree = path.join(root, "coord", ".worktrees", owner, ticket);
  fs.mkdirSync(path.join(worktree, "coord", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "coord", "scripts", "governed-workspace-recovery.js"), "// worktree\n");
  return worktree;
}

function lockFor(ticket, owner, worktree, extra = {}) {
  return { ticket, owner, worktree, status: "doing", identity_model: null, legacy_session_id: null, ...extra };
}

function baseInput(root, overrides = {}) {
  return {
    cwd: root,
    workspaceRoot: root,
    locks: { active: [], unreadable: [] },
    actor: { resolved: false, owner: null, reason: "no durable governance identity" },
    realpath: fs.realpathSync,
    caseInsensitive: false,
    payload: {},
    ...overrides,
  };
}

function editPayload(filePath) {
  return { tool_name: "Edit", tool_input: { file_path: filePath, old_string: "a", new_string: "b" } };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// 1. The 2026-08-04 reproduction — red against the shipped logic, green now.
// --------------------------------------------------------------------------

test("RED PROOF: the shipped cwd-scoped logic PERMITS the 2026-08-04 canonical edit", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };

  // The parent orchestrator sat in the CANONICAL root, not in any worktree.
  const legacy = legacyCwdScopedDecision({ cwd: root, locks });
  assert.equal(
    legacy.decision,
    "allow",
    "documents the defect: no lock matches the canonical cwd, so the shipped hook exits 0 and permits the write"
  );
  cleanup(root);
});

test("GREEN: the same 2026-08-04 canonical edit is now REFUSED", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };

  for (const target of [
    path.join(root, "coord", "scripts", "governed-workspace-recovery.js"),
    path.join(root, "coord", "scripts", "governed-workspace-recovery.test.js"),
  ]) {
    const verdict = decide(baseInput(root, { locks, payload: editPayload(target) }));
    assert.equal(verdict.decision, "deny", `expected refusal for ${target}`);
    assert.equal(verdict.code, "canonical_write_refused");
    assert.match(verdict.reason, /COORD-635:claudea635/);
    assert.match(verdict.reason, /gov start/);
  }

  // The canonical file is untouched: the refusal happens BEFORE any write, so
  // asserting "it threw" is not enough — the state must still be intact.
  assert.equal(
    fs.readFileSync(path.join(root, "coord", "scripts", "governed-workspace-recovery.js"), "utf8"),
    "// canonical\n"
  );
  cleanup(root);
});

// --------------------------------------------------------------------------
// 2. Unresolvable identity refuses instead of permitting.
// --------------------------------------------------------------------------

test("unresolvable identity + active lock + canonical governed write => REFUSE", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea700", "COORD-700");
  const locks = { active: [lockFor("COORD-700", "claudea700", worktree)], unreadable: [] };
  const verdict = decide(
    baseInput(root, {
      locks,
      actor: { resolved: false, owner: null, reason: "no durable governance identity" },
      payload: editPayload(path.join(root, "coord", "board", "tasks.json")),
    })
  );
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason, /unresolved session/);
  cleanup(root);
});

test("a lock that cannot be PARSED still counts as active (absence of evidence is not permission)", () => {
  const root = makeWorkspace();
  const verdict = decide(
    baseInput(root, {
      locks: { active: [], unreadable: ["COORD-701.lock"] },
      payload: editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")),
    })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "canonical_write_refused");
  cleanup(root);
});

test("a foreign RESOLVED session is refused and named", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const verdict = decide(
    baseInput(root, {
      locks,
      actor: { resolved: true, owner: "claudea999", source: "identity-v2-lease" },
      payload: editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")),
    })
  );
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason, /owner claudea999/);
  cleanup(root);
});

test("even the LOCK HOLDER may not write to the canonical tree; it is told where to write", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const verdict = decide(
    baseInput(root, {
      locks,
      actor: { resolved: true, owner: "claudea635", source: "identity-v2-lease" },
      payload: editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")),
    })
  );
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason, new RegExp(`write inside your ticket worktree ${worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  cleanup(root);
});

// --------------------------------------------------------------------------
// 3. NOT A BLANKET REFUSAL.
// --------------------------------------------------------------------------

test("NO ACTIVE LOCK: canonical writes, shell writes and deletes are all permitted", () => {
  const root = makeWorkspace();
  const input = baseInput(root, { locks: { active: [], unreadable: [] } });
  for (const payload of [
    editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")),
    { tool_name: "Write", tool_input: { file_path: path.join(root, "coord", "board", "tasks.json"), content: "[]" } },
    { tool_name: "Bash", tool_input: { command: `echo x > ${path.join(root, "coord", "board", "tasks.json")}` } },
    { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
  ]) {
    const verdict = decide({ ...input, payload });
    assert.equal(verdict.decision, "allow", `expected allow with no active lock: ${JSON.stringify(payload)}`);
    assert.equal(verdict.code, "no_active_lock");
  }
  cleanup(root);
});

test("the BOUND session writing inside its own worktree is permitted", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const verdict = decide(
    baseInput(root, {
      cwd: worktree,
      locks,
      actor: { resolved: true, owner: "claudea635", source: "identity-v2-lease" },
      payload: editPayload(path.join(worktree, "coord", "scripts", "governed-workspace-recovery.js")),
    })
  );
  assert.equal(verdict.decision, "allow", verdict.reason || "");
  assert.equal(verdict.ticket, "COORD-635");
  cleanup(root);
});

test("GAP NOT ENFORCEMENT (COORD-645-F2, accepted limitation tracked by COORD-648): in-worktree ownership is UNENFORCED — an unresolved actor's write is PERMITTED", () => {
  // This test does NOT assert correct behaviour, and this permit is NOT a
  // check that passed — it is the absence of a check. It is pinned so the gap
  // cannot narrow or widen silently, and so nobody reads the surrounding suite
  // as covering in-worktree ownership.
  //
  // Accepted by human-admin scope decision: a PreToolUse hook has no
  // trustworthy authentication channel, so there is nothing to enforce with
  // here (see the TRUST MODEL block in runtime-authority-decision.js). Denying
  // would deny the legitimate owner's own work. COORD-648 (spike, outside the
  // release chain) tracks acquiring such a channel and carries the adversarial
  // acceptance test. What COORD-645 DOES deliver is asserted elsewhere in this
  // file: identity-independent canonical-tree refusal, and refusal of an actor
  // the trusted registry positively disowns.
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const verdict = decide(
    baseInput(root, { cwd: root, locks, payload: editPayload(path.join(worktree, "coord", "scripts", "governed-workspace-recovery.js")) })
  );
  assert.equal(verdict.decision, "allow", "UNENFORCED SURFACE (COORD-648), not an authorization");
  assert.equal(verdict.actor_resolved, false);

  // The delivered protections still hold for this same unresolved actor, which
  // is what makes the limitation survivable: it cannot reach canonical state.
  assert.equal(
    decide(baseInput(root, { cwd: root, locks, payload: editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")) })).code,
    "canonical_write_refused"
  );
  cleanup(root);
});

test("DELIVERED (COORD-645-F2): an actor the TRUSTED registry positively DISOWNS is refused, even inside a worktree", () => {
  // Where trusted state DOES speak, it is obeyed. This is the in-worktree
  // protection COORD-645 actually delivers, and it needs no forgery-proof
  // channel: the registry (written only by gov, under lock, journaled) says
  // this instance holds no owner lease.
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const actor = resolveActor({
    env: { COORD_PROVIDER: "claude-code", COORD_INSTANCE_ID: "inst-1" },
    identityRegistry: {
      instances: [{ instance_id: "inst-1", owner: "claudea635", status: "revoked" }],
      leases: { claudea635: { instance_id: "inst-1" } },
    },
  });
  assert.equal(actor.contradicted, true);
  const verdict = decide(
    baseInput(root, { locks, actor, payload: editPayload(path.join(worktree, "coord", "scripts", "governed-workspace-recovery.js")) })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "contradicted_worktree_write");
  cleanup(root);
});

test("COORD-645-F2: a MISSING identity registry is not treated as contradiction (adopters are not locked out)", () => {
  const actor = resolveActor({ env: { COORD_PROVIDER: "claude-code", COORD_INSTANCE_ID: "inst-1" }, identityRegistry: null });
  assert.equal(actor.resolved, false);
  assert.equal(actor.contradicted, false, "no readable trusted state => no positive statement either way");
});

test("TRUST MODEL: self-asserted identity can only TIGHTEN, never widen authority", () => {
  // The environment is actor-controlled, so the barrier must never GRANT on it.
  // Forging a favourable identity must not turn any refusal into a permission.
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const canonical = editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js"));
  const shell = { tool_name: "Bash", tool_input: { command: `echo x > ${path.join(root, "coord", "board", "tasks.json")}` } };

  for (const payload of [canonical, shell]) {
    const unknown = decide(baseInput(root, { locks, payload }));
    // Every identity an actor could assert for itself, including the lock owner's.
    for (const actor of [
      { resolved: true, contradicted: false, owner: "claudea635", source: "identity-v2-lease" },
      { resolved: true, contradicted: false, owner: "claudea999", source: "agent-session" },
      { resolved: false, contradicted: true, owner: null, reason: "disowned" },
      { resolved: false, contradicted: false, owner: null, reason: "absent" },
    ]) {
      const claimed = decide(baseInput(root, { locks, actor, payload }));
      assert.equal(unknown.decision, "deny", "baseline must be a refusal");
      assert.equal(claimed.decision, "deny", `asserting owner=${actor.owner} must not unlock this write`);
    }
  }
  cleanup(root);
});

test("writes OUTSIDE the workspace (scratch, other repos) are out of scope", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const verdict = decide(baseInput(root, { locks, payload: editPayload(path.join(os.tmpdir(), "scratch-note.md")) }));
  assert.equal(verdict.decision, "allow", verdict.reason || "");
  cleanup(root);
});

test("canonical build/dependency output carries no governance authority", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  for (const target of [
    path.join(root, "node_modules", "left-pad", "index.js"),
    path.join(root, "dist", "bundle.js"),
  ]) {
    assert.equal(decide(baseInput(root, { locks, payload: editPayload(target) })).decision, "allow", target);
  }
  cleanup(root);
});

// --------------------------------------------------------------------------
// 4. Existing worktree confinement remains intact.
// --------------------------------------------------------------------------

test("worktree confinement: acting from one worktree, writing into another is refused", () => {
  const root = makeWorkspace();
  const mine = makeWorktree(root, "claudea635", "COORD-635");
  const theirs = makeWorktree(root, "claudea700", "COORD-700");
  const locks = {
    active: [lockFor("COORD-635", "claudea635", mine), lockFor("COORD-700", "claudea700", theirs)],
    unreadable: [],
  };
  const verdict = decide(
    baseInput(root, { cwd: mine, locks, payload: editPayload(path.join(theirs, "coord", "scripts", "governed-workspace-recovery.js")) })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "cross_worktree_write");
  cleanup(root);
});

test("worktree confinement: acting from a worktree, writing outside the workspace is refused", () => {
  const root = makeWorkspace();
  const mine = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", mine)], unreadable: [] };
  const verdict = decide(baseInput(root, { cwd: mine, locks, payload: editPayload(path.join(os.tmpdir(), "exfil.txt")) }));
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "write_outside_ticket_authority");
  cleanup(root);
});

test("OPPORTUNISTIC ONLY: a session that HAPPENS to resolve as a foreign owner is refused inside another ticket's worktree", () => {
  // Not enforcement of in-worktree ownership (COORD-645-F2 / COORD-648): an
  // actor that asserts no identity resolves to nothing and is permitted. This
  // refusal exists only when corroborating evidence is volunteered.
  const root = makeWorkspace();
  const theirs = makeWorktree(root, "claudea700", "COORD-700");
  const locks = { active: [lockFor("COORD-700", "claudea700", theirs)], unreadable: [] };
  const verdict = decide(
    baseInput(root, {
      locks,
      actor: { resolved: true, owner: "claudea635", source: "identity-v2-lease" },
      payload: editPayload(path.join(theirs, "coord", "scripts", "governed-workspace-recovery.js")),
    })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "foreign_worktree_write");
  cleanup(root);
});

// --------------------------------------------------------------------------
// 5. Symlink / path-normalization bypasses (COORD-625/635 discipline).
// --------------------------------------------------------------------------

test("a symlink inside a worktree cannot launder a canonical write", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const link = path.join(worktree, "escape");
  fs.symlinkSync(path.join(root, "coord", "scripts"), link, "dir");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };

  const verdict = decide(
    baseInput(root, { cwd: worktree, locks, payload: editPayload(path.join(link, "governed-workspace-recovery.js")) })
  );
  assert.equal(verdict.decision, "deny", "the link RESOLVES into the canonical tree");
  assert.equal(verdict.code, "canonical_write_refused");
  assert.equal(
    fs.readFileSync(path.join(root, "coord", "scripts", "governed-workspace-recovery.js"), "utf8"),
    "// canonical\n",
    "canonical state intact"
  );
  cleanup(root);
});

test("a symlink to a not-yet-existing file under a linked directory is still classified", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  fs.symlinkSync(path.join(root, "coord", "scripts"), path.join(worktree, "escape"), "dir");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const verdict = decide(
    baseInput(root, {
      cwd: worktree,
      locks,
      payload: { tool_name: "Write", tool_input: { file_path: path.join(worktree, "escape", "brand-new-file.js"), content: "x" } },
    })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "canonical_write_refused");
  cleanup(root);
});

test("`..` traversal out of a worktree is refused", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const verdict = decide(
    baseInput(root, {
      cwd: worktree,
      locks,
      payload: editPayload("../../../../coord/scripts/governed-workspace-recovery.js"),
    })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "canonical_write_refused");
  cleanup(root);
});

test("case-fold aliases cannot bypass classification on a case-insensitive filesystem", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const aliased = path.join(root, "COORD", "SCRIPTS", "governed-workspace-recovery.js");
  assert.equal(
    decide(baseInput(root, { locks, caseInsensitive: true, realpath: undefined, payload: editPayload(aliased) })).code,
    "canonical_write_refused"
  );
  cleanup(root);
});

test("classifyTarget takes the most restrictive verdict across written and resolved paths", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  fs.symlinkSync(path.join(root, "coord", "scripts"), path.join(worktree, "escape"), "dir");
  const classified = classifyTarget(path.join(worktree, "escape", "x.js"), {
    cwd: worktree,
    workspaceRoot: root,
    locks: [lockFor("COORD-635", "claudea635", worktree)],
    realpath: fs.realpathSync,
    caseInsensitive: false,
  });
  assert.equal(classified.kind, "canonical-governed");
  cleanup(root);
});

// --------------------------------------------------------------------------
// 6. Payload-shape fail-open (the silently inert barrier).
// --------------------------------------------------------------------------

test("a bare tool_input object (the shape Claude Code actually pipes in) is still classified", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  // No tool_name, no tool_input wrapper — exactly what `printf '%s' "$TOOL_INPUT"`
  // delivers. The previous code read call.input/call.tool_input only, found
  // nothing, extracted zero paths and allowed the write.
  const payload = { file_path: path.join(root, "coord", "scripts", "governed-workspace-recovery.js"), old_string: "a", new_string: "b" };
  assert.deepEqual(targetPaths(extractCall(payload).input), [payload.file_path]);
  assert.equal(decide(baseInput(root, { locks, payload })).code, "canonical_write_refused");
  cleanup(root);
});

test("extractCall accepts nested, bare and mixed payload shapes", () => {
  assert.equal(extractCall({ tool_name: "Edit", tool_input: { file_path: "/a" } }).input.file_path, "/a");
  assert.equal(extractCall({ file_path: "/a" }).input.file_path, "/a");
  assert.equal(extractCall({ tool: "Bash", input: { command: "ls" } }).input.command, "ls");
  assert.deepEqual(extractCall(null), { tool: "", input: {} });
});

test("multi-edit and apply_patch payloads surface every path they touch", () => {
  assert.deepEqual(
    targetPaths({ edits: [{ file_path: "/a" }, { file_path: "/b" }] }),
    ["/a", "/b"]
  );
  assert.deepEqual(
    targetPaths({ patch: "*** Update File: coord/scripts/x.js\n*** Add File: coord/scripts/y.js\n" }),
    ["coord/scripts/x.js", "coord/scripts/y.js"]
  );
});

// --------------------------------------------------------------------------
// 7. Shell writes vs sanctioned governed transactions.
// --------------------------------------------------------------------------

test("COORD-645-F1: a governed invocation appearing ANYWHERE in a command exempts nothing", () => {
  // RED before the repair: `isGovernedTransaction` matched the gov invocation as
  // a SUBSTRING and the match exempted the ENTIRE compound command, so all of
  // these returned allow/shell_permitted. Admin reproduced the first one.
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const governance = path.join(root, "coord", "GOVERNANCE.md");
  fs.writeFileSync(governance, "# governance\n");
  const board = path.join(root, "coord", "board", "tasks.json");

  const bypasses = [
    `coord/scripts/gov explain COORD-645; echo compromised > ${governance}`,
    `coord/scripts/gov explain X && echo x > ${board}`,
    `coord/scripts/gov explain X || echo x > ${board}`,
    `coord/scripts/gov explain X | tee ${governance}`,
    `coord/scripts/gov explain X\necho x > ${governance}`,
    `echo "$(coord/scripts/gov explain X)" > ${governance}`,
    "echo `coord/scripts/gov explain X` > " + governance,
    `echo "coord/scripts/gov " > ${governance}`,
    `true; echo x > ${governance} # coord/scripts/gov explain X`,
    `coord/scripts/gov explain X > ${governance}`, // even a REAL gov command may not redirect into canonical state
    `echo x > "${governance}"`, // the quoted target the old regex could not see
    `echo x >> ${board}`,
    `sed -i s/a/b/ ${governance}`,
    `printf x | tee -a ${governance}`,
  ];
  for (const command of bypasses) {
    const verdict = decide(baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command } } }));
    assert.equal(verdict.decision, "deny", `bypass still permitted: ${JSON.stringify(command)}`);
  }
  assert.equal(fs.readFileSync(governance, "utf8"), "# governance\n", "canonical state intact");
  cleanup(root);
});

test("COORD-645-F1: isGovernedTransaction recognises only the COMPLETE command", () => {
  for (const command of [
    "coord/scripts/gov submit COORD-645",
    "./coord/scripts/gov start X",
    "/abs/path/coord/scripts/gov start X",
    "node coord/scripts/governance.js explain X",
    "env -u COORD_SESSION_ID coord/scripts/gov start X",
    "COORD_SESSION_ID=x coord/scripts/gov start X",
    'coord/scripts/gov update-plan X --summary "a > b"',
  ]) {
    assert.equal(isGovernedTransaction(command), true, `expected governed: ${command}`);
  }
  for (const command of [
    "coord/scripts/gov explain X; rm -rf /",
    "coord/scripts/gov explain X && echo x",
    "coord/scripts/gov explain X | tee f",
    "coord/scripts/gov explain X\necho x",
    "echo $(coord/scripts/gov explain X)",
    "echo `coord/scripts/gov explain X`",
    'echo "coord/scripts/gov "',
    "true; coord/scripts/gov explain X",
    "echo coord/scripts/gov",
    "bash -c 'coord/scripts/gov explain X'",
    "node coord/scripts/gov",
    "",
  ]) {
    assert.equal(isGovernedTransaction(command), false, `expected NOT governed: ${JSON.stringify(command)}`);
  }
});

test("COORD-645-F1: the lexer distinguishes real operators from quoted text", () => {
  assert.equal(hasShellComposition(lexShell("echo 'a; b'")), false, "single quotes suppress everything");
  assert.equal(hasShellComposition(lexShell('echo "a; b"')), false, "; inside double quotes is literal");
  assert.equal(hasShellComposition(lexShell('echo "$(id)"')), true, "$( ) expands inside double quotes");
  assert.equal(hasShellComposition(lexShell("echo '$(id)'")), true === false, "$( ) is literal in single quotes");
  assert.equal(hasShellComposition(lexShell("a && b")), true);
  assert.equal(hasShellComposition(lexShell("a\nb")), true);
  assert.deepEqual(shellWriteTargets('echo x > "coord/G.md"'), ["coord/G.md"]);
  assert.deepEqual(shellWriteTargets('gov x --summary "a > b"'), [], "a quoted > is not a redirect");
  assert.deepEqual(shellWriteTargets("cmd 2>&1 > out.txt"), ["out.txt"]);
});

test("an arbitrary shell write to canonical governance state is refused; gov is not", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  const board = path.join(root, "coord", "board", "tasks.json");

  const refused = decide(baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command: `echo '[]' > ${board}` } } }));
  assert.equal(refused.decision, "deny");
  assert.equal(refused.code, "shell_canonical_write");
  assert.equal(fs.readFileSync(board, "utf8"), "[]\n", "board untouched");

  for (const command of [
    "coord/scripts/gov submit COORD-645",
    "coord/scripts/gov commit COORD-645 --message x",
    "node coord/scripts/governance.js code-index --git",
    "npm test --prefix coord",
    "git status --short",
    `node --test ${path.join(worktree, "coord", "scripts", "runtime-authority-decision.test.js")}`,
    "grep -rn foo coord/scripts > /tmp/out.txt",
    `echo hi > ${path.join(worktree, "notes.txt")}`,
  ]) {
    const verdict = decide(baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command } } }));
    assert.equal(verdict.decision, "allow", `expected allow: ${command} (${verdict.reason})`);
  }
  cleanup(root);
});

test("shellWriteTargets / isGovernedTransaction are narrow by construction", () => {
  assert.deepEqual(shellWriteTargets("echo x > coord/board/tasks.json"), ["coord/board/tasks.json"]);
  assert.deepEqual(shellWriteTargets("cmd 2>&1 | tee coord/x.log"), ["coord/x.log"]);
  assert.deepEqual(shellWriteTargets("ls -la"), []);
  assert.deepEqual(shellWriteTargets("cmd > /dev/null 2>&1"), []);
  assert.equal(isGovernedTransaction("coord/scripts/gov start COORD-1"), true);
  assert.equal(isGovernedTransaction("node coord/scripts/governance.js explain COORD-1"), true);
  assert.equal(isGovernedTransaction("echo governance > coord/board/tasks.json"), false);
});

test("destructive shell is refused while governed work is in flight", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = { active: [lockFor("COORD-635", "claudea635", worktree)], unreadable: [] };
  for (const command of ["rm -rf coord", "git reset --hard origin/main", "find . -name '*.js' -delete"]) {
    const verdict = decide(baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command } } }));
    assert.equal(verdict.decision, "deny", command);
    assert.equal(verdict.code, "destructive_shell");
  }
  cleanup(root);
});

// --------------------------------------------------------------------------
// 8. Identity resolution derives from ground truth.
// --------------------------------------------------------------------------

test("identity v2: the owner LEASE holder resolves; a non-holder does not", () => {
  const env = { COORD_PROVIDER: "claude-code", COORD_INSTANCE_ID: "inst-1", COORD_PROVIDER_SESSION_ID: "s-1" };
  const registry = {
    instances: [{ instance_id: "inst-1", owner: "claudea635", status: "active" }],
    leases: { claudea635: { instance_id: "inst-1" } },
  };
  assert.deepEqual(
    (({ resolved, owner, source }) => ({ resolved, owner, source }))(resolveActor({ env, identityRegistry: registry })),
    { resolved: true, owner: "claudea635", source: "identity-v2-lease" }
  );

  const movedOn = { instances: registry.instances, leases: { claudea635: { instance_id: "inst-2" } } };
  const stale = resolveActor({ env, identityRegistry: movedOn });
  assert.equal(stale.resolved, false);
  assert.match(stale.reason, /does not hold the owner lease/);

  const revoked = {
    instances: [{ instance_id: "inst-1", owner: "claudea635", status: "revoked" }],
    leases: { claudea635: { instance_id: "inst-1" } },
  };
  assert.equal(resolveActor({ env, identityRegistry: revoked }).resolved, false);
});

test("registered-agent-session fallback resolves a HANDLE, keyed on the effective thread id", () => {
  const sessions = [
    { status: "active", thread_id: "t-1", handle: "claudea635", board_path: "/b/tasks.json" },
    { status: "expired", thread_id: "t-2", handle: "claudea700", board_path: "/b/tasks.json" },
  ];
  assert.equal(
    resolveActor({ env: { COORD_SESSION_ID: "t-1" }, agentSessions: sessions, boardPath: "/b/tasks.json" }).owner,
    "claudea635"
  );
  assert.equal(resolveActor({ env: { COORD_SESSION_ID: "t-2" }, agentSessions: sessions }).resolved, false);
  assert.equal(resolveActor({ env: {}, agentSessions: sessions }).resolved, false);
});

test("legacy lock session_id / thread_id are NEVER authority", () => {
  // A lock still carrying the pre-v2 session binding must not authorize an
  // actor merely because the environment echoes that session id back.
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const locks = {
    active: [lockFor("COORD-635", "claudea635", worktree, { legacy_session_id: "a635-legacy" })],
    unreadable: [],
  };
  const actor = resolveActor({
    env: { COORD_SESSION_ID: "a635-legacy" },
    agentSessions: [],
    identityRegistry: null,
  });
  assert.equal(actor.resolved, false, "matching the lock's legacy session_id confers nothing");
  assert.equal(
    decide(baseInput(root, { locks, actor, payload: editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")) })).decision,
    "deny"
  );
  cleanup(root);
});

test("effectiveThreadId prefers the explicit orchestrator override", () => {
  assert.equal(effectiveThreadId({ COORD_SESSION_ID: "a", CLAUDE_CODE_SESSION_ID: "b" }), "a");
  assert.equal(effectiveThreadId({ CLAUDE_CODE_SESSION_ID: "b" }), "b");
  assert.equal(effectiveThreadId({}), "");
});

// --------------------------------------------------------------------------
// 9. Lock enumeration is cwd-independent and complete.
// --------------------------------------------------------------------------

test("enumerateLocks returns EVERY active lock and reports unreadable ones", () => {
  const { active, unreadable } = enumerateLocks([
    { name: "A-1.lock", text: JSON.stringify({ ticket: "A-1", owner: "x", status: "doing", worktree: "/w/a" }) },
    { name: "A-2.lock", text: JSON.stringify({ ticket: "A-2", owner: "y", status: "doing", worktree: "/w/b" }) },
    { name: "A-3.lock", text: JSON.stringify({ ticket: "A-3", owner: "z", status: "review", worktree: "/w/c" }) },
    { name: "A-4.lock", text: "{ truncated" },
    { name: "notes.txt", text: "ignored" },
  ]);
  assert.deepEqual(active.map((l) => l.ticket), ["A-1", "A-2"]);
  assert.deepEqual(unreadable, ["A-4.lock"]);
});

// --------------------------------------------------------------------------
// 10. The wired wrapper honours the decision (exit codes), run out-of-process.
// --------------------------------------------------------------------------

function runHook(root, payload, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      COORD_CANONICAL_DIR: path.join(root, "coord"),
      COORD_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: "",
      COORD_PROVIDER: "",
      COORD_INSTANCE_ID: "",
      TOOL_INPUT: "",
      ...env,
    },
    input: JSON.stringify(payload),
  });
}

// COORD-660 — the wrapper's PAYLOAD ACQUISITION, not its decision core.
//
// Every wrapper test above uses spawnSync, which pre-buffers `input` into the
// pipe before the child runs. The wrapper's old reader —
// `fs.readFileSync(0, "utf8")` inside a bare try/catch, with the parsed stdin
// spread LAST so it could override the environment — therefore always
// succeeded here while losing the payload against a harness that writes stdin
// after spawn. Same seam, same class as COORD-660's protected-branch guard.
function runHookDelayed(root, payload, { delayMs = 0, env = {}, attachStdin = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: root,
      encoding: "utf8",
      stdio: [attachStdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        COORD_CANONICAL_DIR: path.join(root, "coord"),
        COORD_SESSION_ID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "",
        COORD_PROVIDER: "",
        COORD_INSTANCE_ID: "",
        TOOL_INPUT: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    let timer = null;
    if (attachStdin) {
      timer = setTimeout(() => {
        try {
          if (payload) child.stdin.write(JSON.stringify(payload));
          child.stdin.end();
        } catch {
          /* child already exited */
        }
      }, delayMs);
    }
    child.on("exit", (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("wrapper COORD-660: a canonical write is still DENIED however late stdin arrives", async () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  fs.writeFileSync(
    path.join(root, "coord", ".runtime", "locks", "COORD-635.lock"),
    JSON.stringify({ ticket: "COORD-635", owner: "claudea635", status: "doing", worktree, session_id: "a635-legacy" })
  );
  const target = path.join(root, "coord", "scripts", "governed-workspace-recovery.js");
  for (const delayMs of [0, 100, 300, 800]) {
    const res = await runHookDelayed(root, editPayload(target), { delayMs });
    assert.equal(res.status, 2, `delay=${delayMs}ms must still DENY (stderr: ${res.stderr})`);
    assert.match(res.stderr, /CONCORD DENY/);
  }
  cleanup(root);
});

test("wrapper COORD-663: an unobtainable payload while a lock is active is a CLASSIFIED REFUSAL, never no_write_target", async () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  fs.writeFileSync(
    path.join(root, "coord", ".runtime", "locks", "COORD-635.lock"),
    JSON.stringify({ ticket: "COORD-635", owner: "claudea635", status: "doing", worktree, session_id: "a635-legacy" })
  );
  const res = await runHookDelayed(root, null, { delayMs: 0 });
  // COORD-660 asserted `status === 0` plus a `CONCORD BARRIER INERT` warning
  // here, and said why: while `.claude/settings.json` piped an unset
  // `$TOOL_INPUT` over fd 0 the payload was unobtainable on EVERY call, so
  // refusing was a workspace lockout rather than a control. COORD-663 repairs
  // that wiring in the same change, so the refusal is now the correct verdict
  // and the permit is the fail-open. Absence of evidence is not permission.
  assert.equal(res.status, 2, "an uninspected call inside the authority boundary must be REFUSED");
  assert.match(res.stderr, /CONCORD DENY \[payload_unavailable\]/, "the refusal must be classified, not generic");
  assert.doesNotMatch(res.stderr, /no_write_target/, "an empty payload must never be reported as having no write target");
  assert.match(res.stderr, /settings\.json/, "and must name the actual repair");
  assert.match(res.stderr, /OUT-OF-BAND RECOVERY/, "a refusal that blocks its own remedy must name an out-of-band one");
  const ledger = path.join(root, "coord", ".runtime", "action-ledgers", "_authority-barrier.ndjson");
  const record = JSON.parse(fs.readFileSync(ledger, "utf8").trim().split("\n").pop());
  assert.equal(record.code, "payload_unavailable", "the audit record must carry the classification");
  assert.equal(record.decision, "deny", "the audit record must say the call was refused, not 'unenforced'");
  cleanup(root);
});

test("wrapper COORD-663: an unobtainable payload with NO active lock stays permissive", async () => {
  // The refusal above is scoped to the authority boundary. Bootstrap, adoption
  // and read-only use happen with no governed work in flight, and a barrier
  // that refuses those gets disabled — a disabled barrier protects nothing.
  const root = makeWorkspace();
  const res = await runHookDelayed(root, null, { delayMs: 0 });
  assert.equal(res.status, 0, "with no active lock there is no boundary to enforce");
  assert.doesNotMatch(res.stderr, /CONCORD DENY/);
  cleanup(root);
});

test("wrapper COORD-660: a sufficient env payload short-circuits stdin entirely", async () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  fs.writeFileSync(
    path.join(root, "coord", ".runtime", "locks", "COORD-635.lock"),
    JSON.stringify({ ticket: "COORD-635", owner: "claudea635", status: "doing", worktree, session_id: "a635-legacy" })
  );
  const target = path.join(root, "coord", "scripts", "governed-workspace-recovery.js");
  // Two children started together, both with an stdin pipe that is NEVER
  // written and never closed. They differ only in whether the environment
  // payload already answers. An ORDERING claim, not an elapsed-time threshold:
  // load slows both children equally, so the verdict cannot move with it.
  const control = runHookDelayed(root, null, { delayMs: 60000 });
  let controlSettled = false;
  control.then(() => {
    controlSettled = true;
  });

  const res = await runHookDelayed(root, null, {
    delayMs: 60000,
    env: { TOOL_INPUT: JSON.stringify(editPayload(target)) },
  });
  assert.equal(res.status, 2, `the env payload alone must still deny (stderr: ${res.stderr})`);
  assert.match(res.stderr, /CONCORD DENY/);
  assert.equal(
    controlSettled,
    false,
    "env sufficiency must not wait on stdin: the lazy child must finish while an " +
      "otherwise identical child that has to consult fd 0 is still waiting"
  );
  await control;
  cleanup(root);
});

test("wrapper COORD-660: the ENVIRONMENT payload wins over stdin, not the other way round", async () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  fs.writeFileSync(
    path.join(root, "coord", ".runtime", "locks", "COORD-635.lock"),
    JSON.stringify({ ticket: "COORD-635", owner: "claudea635", status: "doing", worktree, session_id: "a635-legacy" })
  );
  const canonical = path.join(root, "coord", "scripts", "governed-workspace-recovery.js");
  const inWorktree = path.join(worktree, "coord", "scripts", "governed-workspace-recovery.js");
  // stdin claims a harmless in-worktree target; the environment names the
  // canonical one. Previously stdin was spread last and would have won.
  const res = await runHookDelayed(root, editPayload(inWorktree), {
    delayMs: 0,
    env: { TOOL_INPUT: JSON.stringify(editPayload(canonical)) },
  });
  assert.equal(res.status, 2, `env precedence must hold (stderr: ${res.stderr})`);
  cleanup(root);
});

test("wrapper: canonical write with an active lock exits 2 and explains; without a lock exits 0", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  const lockPath = path.join(root, "coord", ".runtime", "locks", "COORD-635.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ ticket: "COORD-635", owner: "claudea635", status: "doing", worktree, session_id: "a635-legacy" })
  );

  const denied = runHook(root, editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")));
  assert.equal(denied.status, 2, denied.stderr || denied.stdout);
  assert.match(denied.stderr, /CONCORD DENY/);
  assert.match(denied.stderr, /COORD-635/);

  const allowedInWorktree = runHook(root, editPayload(path.join(worktree, "coord", "scripts", "governed-workspace-recovery.js")));
  assert.equal(allowedInWorktree.status, 0, allowedInWorktree.stderr);

  fs.rmSync(lockPath);
  const noLock = runHook(root, editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")));
  assert.equal(noLock.status, 0, noLock.stderr);
  cleanup(root);
});

test("wrapper: governed CLI command TEXT is classified as permitted (classification only — executes nothing)", () => {
  // COORD-645-F3: this test is named for exactly what it does. It proves the
  // barrier does not reject the SHAPE of governed lifecycle commands. It does
  // NOT prove a lifecycle completes — that is the real end-to-end test below,
  // which executes the commands and asserts the resulting state.
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea634", "COORD-645");
  fs.writeFileSync(
    path.join(root, "coord", ".runtime", "locks", "COORD-645.lock"),
    JSON.stringify({ ticket: "COORD-645", owner: "claudea634", status: "doing", worktree })
  );
  for (const payload of [
    { tool_name: "Bash", tool_input: { command: "coord/scripts/gov agentid --assign" } },
    { tool_name: "Bash", tool_input: { command: "coord/scripts/gov start COORD-645" } },
    { tool_name: "Bash", tool_input: { command: 'coord/scripts/gov update-plan COORD-645 --summary "repair the barrier"' } },
    { tool_name: "Write", tool_input: { file_path: path.join(worktree, "coord", "scripts", "new-file.js"), content: "x" } },
    { tool_name: "Bash", tool_input: { command: "coord/scripts/gov submit COORD-645" } },
    { tool_name: "Bash", tool_input: { command: "env -u COORD_SESSION_ID npm test --prefix coord" } },
    { tool_name: "Bash", tool_input: { command: "bash coord/scripts/check-template-sync.sh" } },
  ]) {
    const res = runHook(root, payload);
    assert.equal(res.status, 0, `classified as blocked: ${JSON.stringify(payload.tool_input)} -> ${res.stderr}`);
  }
  cleanup(root);
});

test("wrapper: a denial is journaled to the action ledger", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea635", "COORD-635");
  fs.writeFileSync(
    path.join(root, "coord", ".runtime", "locks", "COORD-635.lock"),
    JSON.stringify({ ticket: "COORD-635", owner: "claudea635", status: "doing", worktree })
  );
  const denied = runHook(root, editPayload(path.join(root, "coord", "scripts", "governed-workspace-recovery.js")));
  assert.equal(denied.status, 2);
  const ledgerDir = path.join(root, "coord", ".runtime", "action-ledgers");
  const files = fs.readdirSync(ledgerDir);
  assert.ok(files.length > 0, "a refusal must leave an audit record");
  const body = files.map((f) => fs.readFileSync(path.join(ledgerDir, f), "utf8")).join("");
  assert.match(body, /canonical_write_refused/);
  cleanup(root);
});

// --------------------------------------------------------------------------
// COORD-663-F1 — the three false positives COORD-665 made operational.
//
// D1  shell variables were not expanded before path classification, so an
//     in-worktree write to "$w/probe.txt" was refused against the literal path
//     <workspace>/$w/probe.txt — a path that can never exist — while the same
//     write spelled literally succeeded.
// D2  heredoc BODIES were lexed as shell syntax, so `cat > path <<EOF` whose
//     body contained prose was refused against the target "Stop", a word taken
//     out of an English sentence.
// D3  the same cause on a READ-ONLY command: `python3 - "$f" <<PY` merely
//     reading a file was refused as shell_canonical_write against "=", lifted
//     from a `>=` in the Python body.
//
// All three failed CLOSED — no canonical byte was ever at risk — but two of
// them refused commands that write nothing at all. Each is pinned RED against
// the old classification and GREEN against the new one, and every repair is
// paired with a proof that it did not open the guard it narrows.
// --------------------------------------------------------------------------

// The pre-repair classification, preserved in behaviour: no variable
// expansion, and heredoc bodies lexed as syntax. Used to prove the false
// positives were real rather than described.
function legacyShellClassification(command, root) {
  const tokens = lexShellLegacy(command);
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type === "op" && (tokens[i].value === ">" || tokens[i].value === ">>")) {
      const next = tokens[i + 1];
      if (next && next.type === "word" && next.value.trim()) found.push(next.value.trim());
    }
  }
  return found.map((raw) => classifyTarget(raw, { cwd: root, workspaceRoot: root, locks: [], caseInsensitive: false }));
}

// lexShell as it was before this repair: `<` and `>` are single-char operators
// and nothing knows what a heredoc is.
function lexShellLegacy(command) {
  const s = String(command || "");
  const out = [];
  let word = null;
  const flush = () => {
    if (word !== null) out.push({ type: "word", value: word });
    word = null;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const end = s.indexOf(c, i + 1);
      word = (word || "") + (end < 0 ? s.slice(i + 1) : s.slice(i + 1, end));
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      i += 1;
      continue;
    }
    if (s.slice(i, i + 2) === ">>") {
      flush();
      out.push({ type: "op", value: ">>" });
      i += 2;
      continue;
    }
    if (";&|\n\r`><".includes(c)) {
      flush();
      out.push({ type: "op", value: c });
      i += 1;
      continue;
    }
    word = (word || "") + c;
    i += 1;
  }
  flush();
  return out;
}

test("RED PROOF D1: the old classification refused an in-worktree write spelled with a variable", () => {
  const root = makeWorkspace();
  const classifications = legacyShellClassification('echo probe > "$w/.cell3-probe.txt"', root);
  assert.equal(classifications.length, 1);
  assert.equal(
    classifications[0].kind,
    "canonical-governed",
    "documents D1: the literal path <workspace>/$w/... classifies as a canonical governed write"
  );
  cleanup(root);
});

test("GREEN D1: a write target whose variable cannot be resolved is permitted and RECORDED", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea663", "COORD-663");
  const locks = { active: [lockFor("COORD-663", "claudea663", worktree)], unreadable: [] };

  const verdict = decide(
    baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command: 'echo probe > "$w/.cell3-probe.txt"' } } })
  );
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.code, "shell_permitted");
  assert.deepEqual(
    verdict.unresolved_write_targets,
    ["$w/.cell3-probe.txt"],
    "an unenforced target must be reported, never silently dropped (COORD-480)"
  );
  cleanup(root);
});

test("D1 did not open the guard: the same write spelled LITERALLY is still refused", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea663", "COORD-663");
  const locks = { active: [lockFor("COORD-663", "claudea663", worktree)], unreadable: [] };

  const verdict = decide(
    baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command: "echo x > coord/GOVERNANCE.md" } } })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "shell_canonical_write");
  cleanup(root);
});

test("D1 fail-closed: a variable under a LITERALLY NAMED governed directory is refused whatever it holds", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea663", "COORD-663");
  const locks = { active: [lockFor("COORD-663", "claudea663", worktree)], unreadable: [] };

  const verdict = decide(
    baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command: 'echo x > "coord/$name"' } } })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "shell_canonical_write");
  assert.equal(verdict.target, "coord/$name");
  assert.match(verdict.reason, /classified by the path it can denote/);
  cleanup(root);
});

test("D1: a resolvable variable is classified by what it RESOLVES to", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea663", "COORD-663");
  const locks = { active: [lockFor("COORD-663", "claudea663", worktree)], unreadable: [] };

  // From the environment.
  const viaEnv = decide(
    baseInput(root, {
      locks,
      env: { w: "coord" },
      payload: { tool_name: "Bash", tool_input: { command: 'echo x > "$w/GOVERNANCE.md"' } },
    })
  );
  assert.equal(viaEnv.decision, "deny");
  assert.equal(viaEnv.code, "shell_canonical_write");

  // And from the command's own assignment.
  const viaAssignment = decide(
    baseInput(root, {
      locks,
      payload: { tool_name: "Bash", tool_input: { command: 'w=coord && echo x > "$w/GOVERNANCE.md"' } },
    })
  );
  assert.equal(viaAssignment.decision, "deny");
  assert.equal(viaAssignment.code, "shell_canonical_write");
  cleanup(root);
});

test("D1: a LATER assignment cannot launder an earlier one, in either order", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea663", "COORD-663");
  const locks = { active: [lockFor("COORD-663", "claudea663", worktree)], unreadable: [] };

  for (const command of [
    'w=coord && w=/tmp && echo x > "$w/GOVERNANCE.md"',
    'w=/tmp && w=coord && echo x > "$w/GOVERNANCE.md"',
  ]) {
    const verdict = decide(baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command } } }));
    assert.equal(verdict.decision, "deny", `expected refusal for ${command}`);
    assert.equal(verdict.code, "shell_canonical_write");
  }
  cleanup(root);
});

test("D1 trust model: the ENVIRONMENT can only add refusals, never remove one", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea663", "COORD-663");
  const locks = { active: [lockFor("COORD-663", "claudea663", worktree)], unreadable: [] };

  // The actor controls its own environment, so it can claim the variable
  // escapes the governed directory. The literal prefix still refuses.
  const verdict = decide(
    baseInput(root, {
      locks,
      env: { name: "../../../tmp/elsewhere" },
      payload: { tool_name: "Bash", tool_input: { command: 'echo x > "coord/$name"' } },
    })
  );
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.code, "shell_canonical_write");
  cleanup(root);
});

test("RED PROOF D2/D3: the old lexer lifted write targets out of heredoc BODIES", () => {
  const root = makeWorkspace();

  const prose = legacyShellClassification("cat > /tmp/out <<EOF\ndrain the queue > Stop when empty\nEOF\n", root);
  assert.ok(
    prose.some((entry) => entry.target === "Stop"),
    'documents D2: the word "Stop" was lifted out of an English sentence in the body'
  );

  const python = legacyShellClassification('python3 - "$f" <<PY\nif a >= b:\n    pass\nPY\n', root);
  assert.ok(
    python.some((entry) => entry.target === "="),
    'documents D3: "=" was lifted out of a `>=` comparison in a body that writes nothing'
  );
  cleanup(root);
});

test("GREEN D2: a heredoc body contributes NO write targets", () => {
  assert.deepEqual(
    shellWriteTargets('cat > "$w/notes.txt" <<EOF\ndrain the queue > Stop when empty\nEOF\n'),
    ["$w/notes.txt"],
    "only the real redirect on the opener line is a target"
  );
  assert.ok(
    !lexShell("cat > /tmp/out <<EOF\ndrain the queue > Stop when empty\nEOF\n").some((token) => token.value === "Stop"),
    "no token at all may come from a body"
  );
});

test("GREEN D3: a read-only heredoc command has no write targets and is permitted", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea663", "COORD-663");
  const locks = { active: [lockFor("COORD-663", "claudea663", worktree)], unreadable: [] };

  const command = 'python3 - "$f" <<PY\nif a >= b:\n    print(a > b)\nPY\n';
  assert.deepEqual(shellWriteTargets(command), []);

  const verdict = decide(baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command } } }));
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.code, "shell_permitted");
  assert.equal(verdict.unresolved_write_targets, undefined, "a command with no write target has nothing to report");
  cleanup(root);
});

test("D2 did not open the guard: a REAL redirect on the heredoc opener line is still refused", () => {
  const root = makeWorkspace();
  const worktree = makeWorktree(root, "claudea663", "COORD-663");
  const locks = { active: [lockFor("COORD-663", "claudea663", worktree)], unreadable: [] };

  for (const command of [
    "cat <<EOF > coord/GOVERNANCE.md\nowned\nEOF\n",
    "cat > coord/GOVERNANCE.md <<'EOF'\nowned\nEOF\n",
    "cat <<-EOF >> coord/GOVERNANCE.md\n\towned\n\tEOF\n",
  ]) {
    const verdict = decide(baseInput(root, { locks, payload: { tool_name: "Bash", tool_input: { command } } }));
    assert.equal(verdict.decision, "deny", `expected refusal for ${JSON.stringify(command)}`);
    assert.equal(verdict.code, "shell_canonical_write");
  }
  cleanup(root);
});

test("D2 boundary: an UNTERMINATED heredoc body is consumed, not re-lexed as syntax", () => {
  assert.deepEqual(
    shellWriteTargets("cat > /tmp/out <<EOF\nnothing here > coord/GOVERNANCE.md\n"),
    ["/tmp/out"],
    "an unterminated body runs to end of input, exactly as the shell treats it"
  );
});

test("D2 boundary: a herestring feeds stdin and names no write target", () => {
  assert.deepEqual(shellWriteTargets('grep x <<< "a > coord/GOVERNANCE.md"'), []);
});

test("D2 boundary: TWO heredocs on one line are both consumed, and later syntax still lexes", () => {
  assert.deepEqual(
    shellWriteTargets("diff <(cat <<A\na > X\nA\n) <(cat <<B\nb > Y\nB\n) > coord/report.txt"),
    ["coord/report.txt"]
  );
});
