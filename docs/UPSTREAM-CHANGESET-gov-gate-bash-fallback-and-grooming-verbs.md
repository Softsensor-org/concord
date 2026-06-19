# Upstream change-set: gov gate bash fallback · set-priority / set-type grooming verbs

Origin: validated locally in the HOS deployment of this template during a 23-ticket
governed wave. Both changes remove friction that bit the deployment on essentially
every ticket. Both are additive — the existing npm-gate path and its tests are
untouched, and the grooming verbs are new dispatch cases — so the governance suite
stays green (400 baseline + 9 new tests, 0 fail).

Target: `coord/scripts/governance.js` (+ `coord/scripts/governance.test.js`).
Branch: `feat/coord-gov-gate-bash-fallback-and-grooming-verbs` off `main`.

---

## A. `set-priority` / `set-type` grooming verbs

**Problem.** There was no gov verb to reprioritize or retype a ticket. Pri/Type are
non-lifecycle backlog columns, but `TASKS.md` is a *rendered view* of canonical board
state — a hand-edit to either column is clobbered by the next board write. So they must
be mutated through gov, and previously could not be at all.

**Change.** Add two verbs modeled exactly on `setFollowupRelation`
(`withGovernanceMutation` → `readBoard` → `getTicketRef` → mutate → `withCoordStateLock`
{ `writeBoard`; `runBoardSync({ ignoreActiveTicketLockErrors: true })` }). Both validate
against a fixed allow-list, refuse terminal-status (`done`/`superseded`) tickets, and
no-op when the value is already set.

- `setTicketPriority(ticketId, options)` — allow-list `["P0","P1","P2","P3"]`, reads
  `--pri`. Dispatch: `case "set-priority": return setTicketPriority(args[0], parseFlags(args.slice(1)));`
- `setTicketType(ticketId, options)` — allow-list
  `["feature","bug","chore","task","spike","refactor","docs","test"]`, reads `--type`.
  Dispatch: `case "set-type": return setTicketType(args[0], parseFlags(args.slice(1)));`

Both dispatch cases are added right after `case "set-followup-relation":`. `parseFlags`
already mapped `--pri`→`options.pri` and `--type`→`options.type` (open-followup uses
them), so no flag changes were needed. Two usage lines were added after the
`set-followup-relation` usage line. The verbs route through `dispatchCommand`, so (like
`setFollowupRelation`) they are not added to `__testing`.

**Test note.** Six tests (extending the existing `withRegisterPromptHarness`, which now
takes additive `status`/`type`/`pri` options defaulting to today's values): set-priority
changes Pri on a todo ticket, rejects an invalid `--pri`, refuses a `done` ticket; set-type
analogous with a `superseded` ticket.

---

## B. `gov gate` bash fallback (run `scripts/gate.sh` when no npm gate script)

**Problem.** `runCleanCheckoutGate` resolved the gate command via `resolveGateScript`,
which hard-`fail()`s when the repo has no `gate:<lane>` package.json script. Many real
repos gate via `bash scripts/gate.sh <lane>` and expose **no** npm gate script — so
`gov gate` was unusable for them. This bit the HOS deployment on every ticket; agents had
to run `scripts/gate.sh ci` by hand plus `gov add-repo-gate`.

**Change (additive — the npm-script path is unchanged).**

- New `resolveGateInvocation(repoRoot, lane, source, branch)` wraps `resolveGateScript`:
  it FIRST tries the existing npm-script resolution and returns `{ kind: "script", script }`
  when a `gate:*` script matches (today's behavior, byte-for-byte). It catches the
  `GovernanceError` that `resolveGateScript` throws when no script matches and, only if
  `scripts/gate.sh` exists in the repo, returns `{ kind: "bash", command: "bash",
  args: ["scripts/gate.sh", lane] }`. If neither exists, the original error is re-thrown.
  `resolveGateScript` itself is left intact (its matrix tests at ~line 2540 depend on the
  hard fail).
- In `runCleanCheckoutGate`, after install, the gate is run via the resolver: `kind:"bash"`
  → `spawnSync("bash", ["scripts/gate.sh", lane], { cwd: tmpWorktree, stdio: "inherit",
  timeout: 300_000 })`; `kind:"script"` → the existing
  `pkgManager.bin pkgManager.runScriptArgs(script)` call, unchanged. `exitCode` is taken
  from the spawn result for both paths, and the pass/fail decision keys off `exitCode`.
- **Artifact synthesis.** A bash gate may not emit `artifacts/gates/<lane>.latest.json`.
  When the bash path ran and no artifact file was found, a minimal authoritative artifact
  is synthesized (`lane`, `result`/`status` from `exitCode`, `git.{branch,commit}`,
  `clean_checkout`, `authority.status:"authoritative"` with reason
  `"governed clean-checkout materialization (bash scripts/gate.sh)"`, `gate_runner:
  "scripts/gate.sh"`, `synthesized: true`). It then flows through the **existing**
  `if (gateArtifact)` annotate/write block, so the canonical artifact provenance and the
  recorded summary are produced identically to the npm path.

**Test note.** Three `resolveGateInvocation` tests (resolver exported via `__testing`):
returns `{kind:"script"}` when a `gate:<lane>` script exists (existing fixture style);
returns `{kind:"bash"}` when no gate script exists but a `scripts/gate.sh` is present in
the repoRoot fixture; still throws the original unsupported-lane error when neither exists.

---

**Verification.** `node -c coord/scripts/governance.js` (syntax) and
`node --test coord/scripts/governance.test.js` → 409 pass / 0 fail (400 baseline + 9 new).
