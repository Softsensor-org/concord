# Governance Architecture

Layer label: `architecture-reference`

Use this file for:
- current layering and design intent
- rationale for facade / CLI / MCP / core separation
- follow-on architecture direction for the remaining lifecycle/test split

If this file conflicts with `coord/GOVERNANCE.md` on current enforced behavior, `coord/GOVERNANCE.md` wins.

## Philosophy

The human should interact through a very small command surface. Governance should harmonize the strengths of Claude, Codex, and Gemini on top of a shared lifecycle core, not flatten them into the same worker.

## Principles

- **Human layer is simple** — the operator surface should stay as small as the facade contract defined in `coord/VERB_CONTRACT.md`
- **Agents are strategic, not equal** — Claude, Codex, and Gemini have different strengths, ecosystems, and constraints; governance should route work to the best current fit
- **Engine owns correctness** — state transitions, locking, validation, journal, recovery
- **Agent owns cognition** — code writing, review judgment, design decisions
- **Facade owns UX** — thin verbs that humans and agents both use
- **CLI and MCP harmonize the core** — `coord/scripts/gov` remains the admin/debug adapter, MCP remains the typed agent interface, and both must converge on the same governed core
- **Native ecosystems stay native** — Claude keeps slash commands, skills, and subagents; Codex keeps plugins and parallel execution; Gemini keeps large-context and research strengths

## Layers

```
┌─────────────────────────────────────────────────────┐
│  Human                                                │
│  Small operator surface (see coord/VERB_CONTRACT.md) │
├─────────────────────────────────────────────────────┤
│  Neutral facade: coord/scripts/agent                 │
│  Small operator surface. Routes to agent-native      │
│  execution and shared governance lifecycle.          │
├─────────────────────────────────────────────────────┤
│  Agent-native execution                              │
│  Claude wrappers, Codex shims, Gemini shims,         │
│  prompts, skills, plugins, subagents, web tools      │
├─────────────────────────────────────────────────────┤
│  MCP server: coord/scripts/governance-mcp.js         │
│  Primary typed agent interface.                       │
├─────────────────────────────────────────────────────┤
│  CLI: coord/scripts/gov                              │
│  Thin admin/debug adapter. Humans, CI, break-glass.  │
├─────────────────────────────────────────────────────┤
│  Core modules: coord/scripts/*.js                    │
│  Source of truth for mutations, locking, journal,     │
│  validation, recovery, derived-state rendering.       │
└─────────────────────────────────────────────────────┘
```

## Current Implementation Boundary

This document separates the current implementation boundary from the remaining
target direction. The current split is intentionally flat under `coord/scripts/`
so the public entry points and downstream byte-sync rules stay stable while the
large lifecycle module is reduced.

Today:

- `coord/scripts/agent` exists as a thin shell facade over the current governed CLI
- `coord/scripts/governance.js` is a compatibility shim that keeps the shebang,
  public facade, and `require.main` guard
- `coord/scripts/cli.js` owns command routing, CLI flag parsing, `main()`, and
  `executeCommand()`
- the shared governed lifecycle is split across flat CommonJS modules:
  - `coord/scripts/governance-context.js` — `GovernanceError`, mutable runtime
    path state, path accessors, and shared lock-depth counters
  - `coord/scripts/state-io.js` — canonical reads/writes, atomic writes,
    snapshots, and sync-delta helpers
  - `coord/scripts/governance-board-state.js` — board reads/writes, row lookup,
    waiver/index helpers, sync triggers, and simple status/index reducers
  - `coord/scripts/journal.js` — governance event log reads/writes, replay, and
    journal repair primitives
  - `coord/scripts/plan-records.js` — plan record parsing, rendering, and IO
  - `coord/scripts/landing-gh.js` — GitHub PR transport and retry helpers
  - `coord/scripts/token-economics.js` — cost ledger, precheck, context-pack,
    plan-waves, and dispatch-plan helpers
  - `coord/scripts/followups.js` — follow-up exception/relation helpers
  - `coord/scripts/governance-session.js` — agent/session registry, provider
    thread identity, session tokens, liveness, and lock identity helpers
  - `coord/scripts/verb-parity.js` — documented verb/flag parity scanners
  - `coord/scripts/prompt-coverage.js` — prompt registration, likely-file
    seeding, and precondition checks
  - `coord/scripts/governance-validation.js` — readiness, review-plan,
    feature-proof, testing-infrastructure, and landing validation helpers
  - `coord/scripts/lifecycle.js` — remaining lifecycle orchestration hub
  - `coord/scripts/governance-mcp.js` — typed MCP adapter over the public facade
  - `coord/board/board.js` — board schema validation and rendered board outputs
- operators can enter through `coord/scripts/agent`, native agent paths, or raw `coord/scripts/gov`

So the immediate contract is:

- the operator model is defined now
- the thin facade exists now
- dispatch, mandate exchange, and deeper lifecycle extraction remain follow-on
  implementation work

The current mutable process state is intentionally centralized in
`governance-context.js` as `ctx.state`. That singleton is migration scaffolding:
it prevents stale cross-module copies of path and lock-depth variables while the
old monolith is split. The long-term direction is still explicit configuration
passed into module factories, but the singleton is the safer compatibility bridge
until all readers have moved behind module boundaries.

## Operator Model

The target operator experience is intentionally small. The canonical facade verbs are defined once in `coord/VERB_CONTRACT.md`; this document describes how that surface fits into the layered design.

Everything else is either:

- an internal facade subcommand such as `agent do prepare` / `agent do submit`
- a native agent wrapper such as Claude slash commands
- a low-level governance command under `coord/scripts/gov`

**Rule:** raw `coord/scripts/gov` commands remain available for admin, CI, break-glass repair, and deep inspection. They are not the preferred human-facing workflow.

## Comparative-Advantage Dispatch

Governance should pick the best currently-available agent path for the ticket instead of assuming one agent should do all work.

Dispatch should consider three inputs:

1. **Ticket requirements**
   - repo, type, priority, cross-repo span, expected file breadth, review depth, test burden, and recovery risk
2. **Local environment scan**
   - available MCP servers
   - available skills, plugins, wrappers, and subagent support
   - sandbox and shell constraints
   - browser or headless tooling
   - repo-local helpers and test runners
3. **External ecosystem scan**
   - current official capabilities from Claude, Codex, and Gemini docs and releases
   - newly-added features that materially change dispatch value

The engine should harmonize on top of those inputs:

- choose the agent path that best fits the ticket
- preserve the shared governed lifecycle regardless of agent
- allow human override when necessary
- learn from outcomes instead of freezing a static dispatch table forever

**Important:** if only one agent is needed, the system should still choose the best one. Multi-agent capability is not the goal by itself; drawing the best from each ecosystem is the goal.

## Capability Registry And Refresh Loop

The template should maintain one capability registry for the current project at [AGENT_CAPABILITY_REGISTRY.md](AGENT_CAPABILITY_REGISTRY.md).
This architecture file defines the dispatch mechanism only; concrete current-strength claims and routing baselines belong in the registry, not here.

That registry should track, per agent family:

- current strengths
- current weaknesses and failure modes
- available local tools and wrappers
- available MCP servers, plugins, and skills
- context and research strengths
- governance reliability signals from real project outcomes
- dispatch recommendations by work profile

Refresh inputs should come from:

- local environment scans at project setup and when tools change
- official vendor documentation and release notes when capabilities change materially
- project-local evidence from landed tickets, reviews, and recovery incidents

The registry is a governance asset, not prompt folklore. Dispatch and wrapper design should reference it.

## Canonical State Model

Do not invent a new store. Use `coord/GOVERNANCE.md` Section 2 (`Canonical Files`) as the single owner-file table for shared governance documents and rendered artifacts, and treat this architecture section as the write-model companion for canonical state stores and runtime artifacts rather than a second competing inventory.

In practice, that means:

- governance commands write canonical state first, then render derived views
- board state and per-ticket plan state are canonical and engine-written
- rendered ledgers stay derived and should not be edited independently
- runtime session state is advisory only; it does not outrank a valid ticket lock plus canonical board state

**Rule:** A governance command writes canonical state (journal + plan JSON + board JSON) once, then renders derived views. No command should independently mutate PLAN.md or rendered files.

When runtime session state conflicts with canonical ticket state:
- the canonical ticket lock and board state outrank `.runtime/agent_sessions.json`
- pure runtime session churn should not by itself be treated as governed ticket drift

## Mandate Contract

`agent do prepare <ticket>` returns a **mandate** — governed facts plus dispatch constraints. The agent operates within mandate scope.

```json
{
  "ticket": { "id": "FE-142", "repo": "F", "status": "doing", "type": "feature", "description": "..." },
  "dispatch": {
    "agent_type": "code-writer",
    "secondary_skills": ["api-contract-alignment"],
    "mandate_scope": {
      "files_in_scope": ["packages/app-bootstrap/src/index.ts"],
      "files_read_only": ["packages/contracts/http/src/index.ts"],
      "constraints": [
        "Must preserve the existing contract shape",
        "Must not invent payload fields",
        "Must record evidence required by the ticket"
      ]
    },
    "evidence_required": {
      "invariants_min": 2,
      "review_cycles": 4,
      "feature_proof": true,
      "test_dimensions": ["unit", "contract", "error-path"]
    }
  },
  "dependencies": [{ "id": "FE-003", "status": "done" }],
  "worktree": "/path/to/.worktrees/agent/FE-142",
  "branch": "agent/claudea11-fe-142-...",
  "donor": { "exists": true, "index_path": "coord/DONOR_SOURCE_INDEX.md", "donor_files": ["..."] },
  "plan": { "exists": true, "path": "coord/active/FE-142.md" },
  "baseline": { "recorded": true },
  "repo_state": { "dev_head": "abc123", "rebased": true },
  "relevant_files": ["packages/app-bootstrap/src/index.ts"],
  "test_maturity": { "dimensions_covered": ["unit", "contract"], "gaps": ["edge-case", "error-path"] }
}
```

The agent owns implementation judgment inside this mandate. Governance owns the mandate, lifecycle, and evidence gates.

## `do prepare` Output Contract

`agent do prepare <ticket>` returns governed facts plus dispatch constraints.

```json
{
  "ticket": { "id": "FE-142", "repo": "F", "status": "doing", "description": "..." },
  "dispatch": { "agent_type": "code-writer", "secondary_skills": ["api-contract-alignment"] },
  "dependencies": [{ "id": "FE-003", "status": "done" }],
  "worktree": "/path/to/.worktrees/agent/FE-142",
  "branch": "agent/claudea11-fe-142-...",
  "donor": { "exists": true, "index_path": "coord/DONOR_SOURCE_INDEX.md", "donor_files": ["..."] },
  "plan": { "exists": true, "path": "coord/active/FE-142.md" },
  "baseline": { "recorded": true },
  "repo_state": { "dev_head": "abc123", "rebased": true },
  "relevant_files": ["packages/app-bootstrap/src/index.ts"],
  "test_maturity": { "dimensions_covered": ["unit", "contract"], "gaps": ["edge-case", "error-path"] }
}
```

The agent reads this, decides the approach, writes code, runs tests, and then calls `do submit`.

`agent do submit <ticket>` accepts structured evidence:

```json
{
  "invariants": ["...", "..."],
  "requirement_closure": { "ticket_ask": "...", "implemented": "...", "closeout_verdict": "complete" },
  "review_cycles": [
    { "lens": "...", "diff": "...", "risks": "..., ...", "findings": "...", "verification": "...", "verdict": "pass" }
  ],
  "feature_proofs": [{ "type": "path", "value": "packages/..." }],
  "repo_gate": { "command": "...", "result": "..." }
}
```

Engine validates, records, submits. Agent doesn't format CLI flags.

## How It Works

```
Human: agent do FE-142

Governance:
  ├── checks readiness, deps, blockers
  ├── consults the capability registry
  ├── picks the best current agent path
  ├── builds the mandate
  └── dispatches execution

Agent path:
  ├── uses its native tools, skills, plugins, MCP servers, and wrappers
  ├── stays inside governed scope
  └── returns evidence

Governance:
  ├── validates evidence and review requirements
  └── moves state through review and landing
```

**What the human sees:** the small command surface defined in `coord/VERB_CONTRACT.md`.

**What governance enforces:** lifecycle, readiness, evidence, review, test, and recovery rules.

**What agents keep:** their native ecosystems and comparative strengths.

## Critical Constraints

1. **MCP is better transport, not a fix.** If the engine still mutates board, PLAN.md, QUESTIONS.md, and session files separately, drift continues regardless of interface.
2. **The real gap is atomicity.** Most QUESTIONS.md drift is "unjournaled governed-state drift" — the write model allows partial mutations across files. Fix the write model first.
3. **Do not delete the CLI.** Humans, CI, break-glass repair, and local inspection need it. Make it thin, keep it.
4. **Do not make `do` pretend to be deterministic.** Coding and review are judgment-heavy. Engine owns prepare/validate/record/submit/land. Agent owns implementation and evaluation.
5. **Prompts should never enforce governance.** If a prompt says "remember to do X," that rule belongs in the engine.
6. **Derived files should be derived.** PLAN.md and machine-generated QUESTIONS.md rows should come from canonical state, not be independently mutated.
7. **Optimize for failure recovery.** Recovery is the dominant pain. Reliable recover/resume/reconcile/rebind matters more than prettier commands.
8. **Test against real incidents.** Turn recurring QUESTIONS.md drift patterns into regression cases.
9. **Do not invent a new store.** Event journal = audit. Per-ticket JSON = current state. Markdown = derived views.
10. **`do prepare` returns a mandate, not a suggested implementation.** The engine does not re-implement planning judgment.
11. **Governance should route to strengths, not flatten tools.** The comparative advantage of Claude, Codex, and Gemini is an input to dispatch, not noise to be normalized away.

## Execution Plan

### Phase 1: Lock the Public Contract

Define the stable neutral UX before touching internals.

- Human-facing verbs: the canonical facade contract in `coord/VERB_CONTRACT.md`
- Internal facade verbs: the internal and advanced subcommands defined in `coord/VERB_CONTRACT.md`
- `do prepare` and `do submit` payload contracts (as specified above)
- Explicit statement: `do` and `review` are guided workflows, not full automation
- Write the verb contract to `coord/VERB_CONTRACT.md`
- Define the capability-registry contract in `coord/AGENT_CAPABILITY_REGISTRY.md`

**Acceptance:** One written verb contract. One written capability-registry contract. Exact mapping from neutral verbs to low-level gov operations. Current Claude wrappers keep working.

### Phase 2: Extract Core + Immediate Bookkeeping Wins

Refactor the remaining lifecycle hub into cohesive core modules **while
delivering GOV-001 improvements:**

Current structure:
```
coord/scripts/governance-context.js  — errors, path state, lock counters, defaultFail
coord/scripts/git-ops.js             — shared raw git invocation (gitTry/runGit/gitOutput)
coord/scripts/state-io.js            — canonical IO and atomic writes
coord/scripts/governance-board-state.js — board IO, lookup, index reducers
coord/scripts/journal.js             — append-only event journal
coord/scripts/plan-records.js        — per-ticket plan record model
coord/scripts/landing-gh.js          — GitHub transport
coord/scripts/token-economics.js     — cost/context/dispatch helpers
coord/scripts/followups.js           — follow-up relation helpers
coord/scripts/governance-session.js  — identity, liveness, session tokens
coord/scripts/verb-parity.js         — doc-to-command drift checks
coord/scripts/prompt-coverage.js     — prompt registration/preconditions
coord/scripts/governance-validation.js — readiness/review/closeout checks
coord/scripts/lifecycle-utils.js     — pure dependency-free helpers
coord/scripts/repo-registry.js       — repo-code resolution
coord/scripts/lifecycle-flags.js     — CLI flag parsing (parseLifecycleFlags)
coord/scripts/worktree-ops.js        — git primitives + worktree lifecycle (incl. closed-ticket workspace cleanup)
coord/scripts/governance-repair.js   — read-only doctor report/classification helpers
coord/scripts/pr-ops.js              — GitHub PR operations (view/create/merge)
coord/scripts/runtime-cleanup.js     — runtime lock status/break, rollback drift, clean-runtime scratch
coord/scripts/gate-runtime.js        — gate script/invocation/artifact-dir resolution + clean-checkout gate (EXECUTION)
coord/scripts/gate-proc-registry.js  — gate PROCESS-orphan containment + provenance-scoped reaper (COORD-092): pidfile registry under coord/.runtime/gate-procs/, detectOrphans (read-only; wired into doctor-report) + reapOrphans (mutating; wired into doctor-recovery --fix and the gov reap-gate-procs verb); scoped strictly by recorded PID + /proc start-time (PID-reuse guard) — never a process-name scan
coord/scripts/gates.js               — repo-gate ATTRIBUTION + board-record surface: add-repo-gate verb + classifyGateAttribution + formatRepoGateEntry (DI factory; injects updatePlanBlock)
coord/scripts/landing-audit.js       — landing provenance/AUDIT surface: collectLandingAuditReport/applyLandingAuditBackfill/formatLandingAuditSummary + testing-infra/feature-proof landing audits + landing-RECORD writers (ensureLandingRecord/persistMergedPrLandingSnapshot) (DI factory; injects classifyLandingRecord/derive*Audit/requiresLandingGovernance from governance-validation; verifyPrEvidence stays in landing-gh.js)
coord/scripts/questions.js           — QUESTIONS.md parse/classify, orchestrator-queue reads, explain-questions guidance, log-question + row append/remove
coord/scripts/plan-command.js        — gov plan/update-plan + plan-block verbs (review cycles, closure, feature proofs), start-seed + plan status/next-command payloads
coord/scripts/ticket-transitions.js  — ticket state machine: start/submit/move-review/return-doing/mark-done/block/unblock/supersede + applyMarkDone/persistReturnDoingState primitives (DI factory)
coord/scripts/closeout.js            — ticket closeout/land: finalize/land/finishTicket/prepareDoneCloseout + closeout plan-update builders; injects the transition surface (DI factory)
coord/scripts/doctor-recovery.js     — MUTATING governance repair/recovery: doctorFix (doctor --fix), reconcileGovernance, recoverTicket + session-mirror rebuild helper (DI factory)
coord/scripts/doctor-report.js       — READ-ONLY governance doctor REPORTING: resolveDoctorScope/resolveDoctorOwnerScope, the read-only doctor() report + buildCanonicalDerivedDriftError; injects doctorFix for --fix delegation (DI factory)
coord/scripts/ticket-guidance.js     — OPERATOR-GUIDANCE surface: buildTicketNextCommands (per-status next-command planner), explainTicket (read-only ticket explanation report), runTicketCycle (recommended planner/worker/reviewer/closer cycle); read-only, injects readiness/board/lock/plan deps (DI factory)
coord/scripts/agent-commands.js      — AGENT-COMMAND / claim-orchestration surface: agents list/register/enable/disable, agentid resolve+format, claim/claimTicket/claimAgent/claimAgentSession, resume, release, rebind, the human-admin override resolver, detectCwdTicketClaimHazard and the agent-status report builder; the command layer ABOVE governance-session.js (injects the session engine, board readers, mutation/lock wrappers, journal appender) (DI factory)
coord/scripts/landing-resolution.js  — landing COMMIT-RESOLUTION surface: extractCommitShas, refreshLandingBaseRef, resolveLandingBaseRef/resolvePrLandingBaseRef, pickBestLandingCommit, resolveSourceCommitSha, resolveFulfilledByLandingCommit, resolveLandingCommitSha; owns git-ancestry/base-ref/source-commit resolution ONLY (injects resolveCommitishInRepo/fetchRepoRef/isCommitAncestorOfRef + repo registry + ghPrView/mergeUniqueRefs/toArray from landing-gh.js; TRANSPORT stays in landing-gh.js, AUDIT stays in landing-audit.js); wired after landing-gh.js, before createLandingAudit (DI factory)
coord/scripts/board-rebuild.js       — board-rebuild-from-journal surface: rebuildBoardFromJournal, terminalJournalStatusForTicket, collectTicketsWithJournalDrift; replays the governance event journal to repair board/tasks.json rows that drifted from the journal's terminal succeeded event (GOV-012); writes the board only inside the injected withGovernanceMutation envelope (injects readGovernanceEventLog/readBoard/getTicketRef/writeBoard/fail); wired after createJournal + createGovernanceBoardState (DI factory; COORD-091)
coord/scripts/conformance-verbs.js   — ENT conformance / engine-integrity CLI verb surface: conform (ENT-002 journal hash-chain self-verify + ENT-010 signed attestation emit/verify) and verifyEngine (ENT-011 engine version-pin + drift-check); pure presentation glue over the injected createConformanceAttestation/createEnginePin factories (injects coordDir/verifyGovernanceChain/fail + the two factory creators, returns conform/verifyEngine for the commands map + cli.js cases); READ-ONLY except conform --attest's gitignored attestation + verify-engine --pin's coord/engine-pin.json; extracted from lifecycle.js to hold the 5000 ceiling by EXTRACTION (DI factory; COORD-107)
coord/scripts/lifecycle.js           — orchestration hub: factory wiring + residual lifecycle surface
coord/scripts/cli.js                 — CLI routing and executeCommand()
coord/scripts/governance.js          — public compatibility facade
```

Note: COORD-054 (B7) extracted `pr-ops.js`. COORD-061 (Wave 2) then extracted the
ticket state-machine transitions (start/submit/move-review/return-doing/mark-done/
block/unblock/supersede) into `ticket-transitions.js` as a DI factory. COORD-062
(Wave 2) extracted the closeout/land path (finalize/land/finishTicket/
prepareDoneCloseout plus the closeout plan-update builders) into `closeout.js` as a
DI factory. closeout injects the ticket-transitions surface (moveReview/markDone/
applyMarkDone) and provides prepareDoneCloseout back to transitions via a deferred
wrapper, so its factory is wired in `lifecycle.js` AFTER createTicketTransitions.
COORD-063 (Wave 2, final slice) extracted the MUTATING governance repair/recovery
surface (doctorFix behind `doctor --fix`, reconcileGovernance, recoverTicket, plus
the private session-mirror rebuild helper) into `doctor-recovery.js` as a DI factory.
COORD-085 (Wave 4 slice 1) then completed the report-vs-repair boundary by extracting
the READ-ONLY `doctor` diagnostic report/scan (resolveDoctorScope/resolveDoctorOwnerScope,
the read-only `doctor()` report, and the `buildCanonicalDerivedDriftError` report builder)
into `doctor-report.js` as a DI factory. The report factory is wired in `lifecycle.js`
AFTER createDoctorRecovery and injects the injected-back `doctorFix` so the read-only
`doctor()` still delegates to the MUTATING repair only on `--fix` (the documented
report<->repair cyclic seam, resolved via deferred `(...args) => fn(...args)` wrappers).

COORD-092 added the THIRD leg of orphan governance — gate-spawned PROCESS orphans —
alongside the existing disk-orphan cleanup (`worktree-ops.js` `auditCoordWorktrees` +
the `doctor --fix` worktree reaping) and session-stub reaping
(`reapIdleAutoClaimedProviderStubs`). Heavy gate lanes (full/ci) can spawn runtime
children (vite, chromium/playwright, node workers); on clean exit they are torn down,
but on crash / OOM-kill they orphan and accumulate until the host exhausts RAM.
`gate-proc-registry.js` adds: (1) SPAWN-SIDE containment — the template `*/scripts/gate.sh`
launch heavy children in a tracked process group (`setsid`) and record a pidfile entry
under `coord/.runtime/gate-procs/<gate-run-id>.json` (gate-run-id, owning ticket/repo/lane,
child PIDs/PGID, each PID's `/proc` start-time fingerprint, created-at); a `trap EXIT`
tears the groups down + removes the entry on NORMAL completion so a clean run never leaks.
(2) DETECT — `detectOrphans` surfaces a warning-class diagnostic in the read-only
`doctor` report (like orphan worktrees) for entries whose owning gate-run is gone or whose
owning ticket is no longer doing. (3) REAP — `reapOrphans` (the `doctor --fix` repair pass
and the `gov reap-gate-procs` verb) kills ONLY recorded PIDs whose owner is gone, AND only
after a PID-REUSE GUARD confirms the live PID's `/proc` start-time still byte-matches the
recorded one, then removes the entry. NON-NEGOTIABLE SAFETY: provenance-scoped strictly by
recorded PID + start-time, structurally incapable of touching a process coord did not
record (never a process-name heuristic). LANE-DISCIPLINE POSTURE (documented, not enforced):
heavy lanes carry the resource-heavy steps and SHOULD NOT be run concurrently on a
memory-constrained host; the default lane stays the lean local check. There is deliberately
NO scheduler / resource-aware lease/broker (declined in the COORD-075..082 lane-control
decision) — this is containment + recovery, not admission control.

COORD-086 (Wave 4 slice 2) extracted the OPERATOR-GUIDANCE surface (buildTicketNextCommands,
explainTicket, runTicketCycle) into `ticket-guidance.js` as a DI factory. These are read-only
guidance behaviors — they read board/lock/plan/readiness state and emit guidance JSON, never
mutating governance state — so every cross-module primitive (board readers, readiness/blocker
collectors, lock/identity helpers, the shared buildPostCloseFollowupCommand owned by lifecycle)
is injected via deferred `(...args) => fn(...args)` wrappers. The factory binds are
re-destructured back into lifecycle so the cli.js dispatch, commands map and `__testing` facade
keys (buildTicketNextCommands/explainTicket) are unchanged.
COORD-087 (Wave 4 slice 3, the largest slice) extracted the AGENT-COMMAND / claim-orchestration
surface (the agents list/register/enable/disable verbs, the agentid resolver +
payload formatting, the claim/claimTicket/claimAgent/claimAgentSession cluster,
resumeTicket, releaseAgent, rebindAgent, resolveHumanAdminOverride, detectCwdTicketClaimHazard
and the agent-status report builder) into `agent-commands.js` as a DI factory. This is the
COMMAND LAYER that sits ABOVE the lower-level session engine in `governance-session.js`: the
session engine (registry/session readers+writers, identity resolution, owner-lease semantics,
lock rebinding) STAYS where it is and is INJECTED, never re-implemented or duplicated. The
board-state readers, the mutation/lock wrappers, the journal event appender and the ticket-status
helpers are injected too; findLockForTicket/getLockFiles (defined later in lifecycle) and the
journal/board factory binds are injected as deferred `(...args) => fn(...args)` wrappers so wiring
order never matters at call time. The factory is wired in `lifecycle.js` AFTER createGovernanceSession
(and after createTicketGuidance) so its session/identity deps are live. The PROVIDER_REGISTRY metadata
is now exported from the governance-session factory and injected through. The factory binds are
re-destructured back into lifecycle so the cli.js dispatch, commands map and `__testing` facade keys
(agentsCommand/claim/claimAgent/printCurrentAgentId/rebindAgent/releaseAgent/resumeTicket/
showAgentStatus/resolveCurrentAgentId/detectCwdTicketClaimHazard/claimTicket/resolveHumanAdminOverride/
buildAgentStatusPayload/isNoActiveClaimedSessionError) are unchanged. The deep command-layer behavior
tests (claim transfer, the same-owner other-thread owner-lease gate, agentid payloads, agent-status
release candidates, the cwd-claim hazard, rebind --fresh) moved to `agent-commands.test.js`; the
session-engine behavior tests (identity-v2 env-channel, owner-lease registry internals) stay with
governance.test.js / governance-session coverage.

COORD-088 (Wave 4, slice 4) extracted the landing COMMIT-RESOLUTION surface
(`extractCommitShas`, `refreshLandingBaseRef`, `resolveLandingBaseRef`/`resolvePrLandingBaseRef`,
`pickBestLandingCommit`, `resolveSourceCommitSha`, `resolveFulfilledByLandingCommit`,
`resolveLandingCommitSha`) out of `lifecycle.js` into `landing-resolution.js` as a DI factory. The
boundary is RESOLUTION ONLY: it decides which commit SHA a landing points at and which base ref
ancestry is measured against. GitHub PR TRANSPORT stays in `landing-gh.js` (the ONE GH read it needs,
`ghPrView`, plus `mergeUniqueRefs`/`toArray`, is INJECTED, never re-implemented) and landing
AUDIT/record behavior stays in `landing-audit.js` (COORD-070). The git-ancestry helpers
(`resolveCommitishInRepo`/`fetchRepoRef`/`isCommitAncestorOfRef`), the repo registry, and the ticket
git-context helpers (`resolveTicketGitContext`/`resolveLockHead`, injected as deferred wrappers) are
injected. The commit-subject affiliation helpers (`readCommitSubject`/`commitSubjectAffiliatesWithTicket`)
deliberately STAY in `lifecycle.js`: they are review-state verification helpers (used by
assertCommittedWorkAheadOfBase), not commit-resolution, and no function in the resolution module calls
them. The factory is wired in `lifecycle.js` AFTER `landing-gh.js` and BEFORE `createLandingAudit`,
because the audit factory consumes `resolveLandingBaseRef`/`resolveLandingCommitSha`/
`resolveSourceCommitSha`/`resolveFulfilledByLandingCommit`/`extractCommitShas`. The factory binds are
re-destructured back into lifecycle so the dispatch / `__testing` facade keys
(`resolveLandingBaseRef`/`resolvePrLandingBaseRef`/`resolveSourceCommitSha`) and the validation/audit
factory injections are unchanged. The deep base-ref / ancestry / commit-sha-extraction resolution
behavior tests moved to `landing-resolution.test.js`; the landing AUDIT/integrity tests
(assertLandingIntegrity, audit-report) stay with governance.test.js.

COORD-091 (Wave 4 residual) extracts the board-rebuild-from-journal surface
(`rebuildBoardFromJournal` + its `terminalJournalStatusForTicket` /
`collectTicketsWithJournalDrift` helpers) out of `lifecycle.js` into
`board-rebuild.js` as a DI factory. The boundary is journal-replay REPAIR only:
it reads the governance event journal + board and rewrites drifted Status/Owner
rows back to each ticket's terminal succeeded event, writing the board solely
inside the injected `withGovernanceMutation` envelope. It owns no wiring —
`readGovernanceEventLog`/`readBoard`/`getTicketRef`/`writeBoard`/`fail` are all
injected, so the factory is wired in `lifecycle.js` AFTER `createJournal`
(producing `readGovernanceEventLog`/`withGovernanceMutation`) and
`createGovernanceBoardState`. The factory binds are re-destructured back into
lifecycle so the dispatch / `commands` / `__testing` facade keys and `cli.js`'s
`rebuild-board` route are unchanged; the four GOV-012 behavior tests moved to
`board-rebuild.test.js` (reaching the surface through the `governance.js`
`__testing` facade). Because `lifecycle.js` is the governance COMPOSITION ROOT —
~30 DI factories wired together plus the dispatch + `__testing` facade — and the
residual is irreducible factory-wiring rather than an extractable cohesive
cluster, the `arch-checks` `size` check carries a justified per-file budget
override (`checks.size.perFile["lifecycle.js"] = 5000`). That 5000 is an HONEST
ceiling, not a silence switch: when the ENT conformance/observability verbs
re-crossed it (5036 LOC), COORD-107 held the budget at 5000 and got back under
it by EXTRACTION — moving the `conform`/`verify-engine` verb surface into
`conformance-verbs.js` (lifecycle.js 5036 -> 4911) rather than bumping the
number. This keeps the signal meaningful (real growth still trips it); the hard
`monolith` ceiling ignores `perFile`. (The `countLoc` heuristic also mis-handles unbalanced `/*`
inside string/regex literals, so the raw reported LOC for such files is noisy —
the override insulates the budget from that too.)

Wave 3 (module-boundary consolidation — NOT a lifecycle.js de-monolith; the logic
was already separated, this gave each already-decoupled surface its own dedicated
home) is COMPLETE:
```
coord/scripts/gates.js                   — repo-gate attribution/board-record (DONE: COORD-069)
coord/scripts/landing-audit.js           — landing provenance audits (DONE: COORD-070)
```
COORD-069 (Wave 3, slice A) extracted the repo-gate ATTRIBUTION / board-record
surface (`addRepoGateCommand`, `classifyGateAttribution`, `formatRepoGateEntry`)
out of `plan-command.js` into a dedicated `gates.js` DI factory; `updatePlanBlock`
is injected back from plan-command so gate entries still land in canonical plan
state, and `createGates` is wired in `lifecycle.js` AFTER `createPlanCommand`. The
gate EXECUTION surface (`gate-runtime.js`, COORD-058) stays separate — the
execution/attribution split is preserved. (`buildFeatureProofEntriesFromOptions`
stays in plan-command.js; it serves the feature-proof verbs and has no gate
coupling.) COORD-070 (Wave 3, slice B) then consolidated the landing-provenance/
audit surface — the audit-report cluster (`collectLandingAuditReport`,
`applyLandingAuditBackfill`, `formatLandingAuditSummary`,
`collectLandingAuditCandidates`, `summarizeLandingAuditEntries`), the
testing-infra/feature-proof landing audits (`ensureTestingInfrastructureLandingAudit`,
`ensureFeatureProofLandingAudit`), and the landing-RECORD writers
(`ensureLandingRecord`, `persistMergedPrLandingSnapshot`) — out of
`governance-validation.js` + `lifecycle.js` into a dedicated `landing-audit.js` DI
factory. The validation surface still consumed broadly (`classifyLandingRecord`,
`deriveTestingInfrastructureAudit`, `deriveFeatureProofAudit`,
`requiresLandingGovernance`) stays in `governance-validation.js` and is injected
back; `collectLandingAuditCandidates` is injected back to `classifyLandingRecord`
via a deferred wrapper. `verifyPrEvidence` stays in `landing-gh.js` (GH-specific PR
evidence verification) — the land path and `closeout.js` keep calling it directly.
`createLandingAudit` is wired in `lifecycle.js` AFTER `createGovernanceValidation`.

Deliver in this slice:
- `gov start` auto-seeds missing plan state (GOV-001 #1)
- `gov start` optionally fetches/rebases origin/dev (GOV-001 #7)
- Ticket-scoped validation isolation (GOV-001 #3)
- Gate failure attribution (new-on-ticket vs pre-existing-on-base) (GOV-001 #4)
- `gov agentid` (alias: `whoami`) and rebinding ergonomics (GOV-001 #5)
- Stale drift-note auto-cleanup (GOV-001 #6)
- Parity harness from day one (old CLI snapshot vs new adapter snapshot)

**Phase gate:** For every extraction slice: old behavior snapshot, new behavior snapshot, parity diff = zero or explicitly approved.

**Acceptance:** CLI and MCP call core directly (no subprocess). One mutation
path. `gov start` requires zero pre-seeding. Existing governance tests pass
against the adapters. `lifecycle.js` no longer acts as the effective monolith.

### Phase 3: Neutral Agent Facade

Build `coord/scripts/agent` to implement the public and internal facade contract defined in `coord/VERB_CONTRACT.md`.

- the primary operator verbs stay thin orchestration wrappers over pick/doctor/closeout flows
- `agent test` → gate + maturity
- `agent do prepare <ticket>` → governed start-or-resume, auto-seed, rebase, collect context → return structured brief
- `agent do submit <ticket>` → accept evidence JSON, validate, submit
- `agent review prepare <ticket>` → fetch diff, plan, requirements → return review brief
- `agent review record <ticket>` → write structured findings

Same verbs exposed as MCP tool aliases.

**Acceptance:** Facade contains orchestration only, not duplicate governance logic. Agent-neutral and stable. Raw `gov` remains the admin/debug path, not the default operator path.

### Phase 4: Canonical State + Derived Rendering

Implement the state model:

- Event journal = append-only audit log (already exists)
- Per-ticket plan JSON = materialized current state (already exists, make it single source)
- PLAN.md = derived from plan JSONs (stop independent mutation)
- QUESTIONS.md machine rows = derived from journal (human rows stay authored)
- Define what remains human-authored vs machine-derived

**Acceptance:** Most governance commands write canonical state once then render. Drift checks become rarer. Recovery is journal-based.

### Phase 5: Migration + Backport to acme-ops

- Current-state converter for existing acme-ops plan records
- Compatibility readers for the transition period
- One-way migration (no dual-read)
- Repair tooling for partially migrated tickets
- Validate against acme-ops's 84 open tickets and accumulated state

**Acceptance:** acme-ops runs on new core with zero governance regressions. Existing plan records, sessions, and QUESTIONS.md convert cleanly.

### Phase 6: Prompt Slimming + Wrapper Alignment

- Claude `/do` becomes ~30 lines: call `agent do prepare`, guide coding, call `agent do submit`
- Codex gets the same verbs via MCP or a Codex-native wrapper
- Gemini gets the same verbs via MCP or a Gemini-native wrapper
- Remove all governance enforcement prose from prompts
- Prompts only describe: what to explore, how to design, what to test, how to evaluate

**Acceptance:** Prompts are short and tool-agnostic. No lifecycle prose. Behavior identical regardless of agent frontend.

### Phase 7: Regression Harness from Real Incidents

- Command parity tests: CLI vs MCP vs agent facade
- State-transition tests
- Lock/session/rebind tests (including ppid-scoped identity)
- Derived-render consistency tests
- Recovery/reconcile tests
- Regression tests from real QUESTIONS.md drift incidents
- Adapter conformance: `next` means the same thing in every frontend

**Acceptance:** Every GOV-001 bug class gets a regression test. Every facade verb has CLI and MCP coverage.

## Ticket Breakdown by Risk Domain

| Domain | Scope | Parallel? |
|--------|-------|-----------|
| **State model** | Canonical store decision, derived rendering, PLAN.md as derived view | Blocks facade + migration |
| **Core extraction** | Reduce lifecycle.js into flat core modules + adapters | In progress |
| **Start-path improvements** | Auto-seed, auto-rebase, plan state validation | Fold into core extraction |
| **Submit/land-path improvements** | Structured evidence payload, ticket-scoped validation | Fold into core extraction |
| **Capability registry** | Current strengths, tools, constraints, and dispatch guidance for Claude/Codex/Gemini | Starts immediately, informs facade |
| **Adapter parity** | CLI adapter, MCP adapter, parity test harness | Follows core extraction |
| **Facade verbs** | See `coord/VERB_CONTRACT.md` | Follows adapter parity |
| **Drift-note rendering** | Machine QUESTIONS.md rows from journal | Follows state model |
| **Session identity** | ppid-scoped tokens, liveness checks, rebind safety | Implemented; module extraction remains |
| **Migration tooling** | acme-ops state converter, compatibility readers | Follows state model |
| **Prompt slimming** | Rewrite prompts as thin wrappers | Follows facade |
| **Regression harness** | QUESTIONS.md incident → test cases | Can start anytime |

## Rollout Order

1. Implement in coord-template first
2. Validate with template tests and one synthetic project bootstrap
3. Backport core + adapters into acme-ops
4. Migrate acme-ops state
5. Migrate Claude prompts to wrappers
6. Add Codex-native and Gemini-native wrappers
7. Deprecate prompt-heavy workflows only after parity is proven

## Non-Goals

- Do not delete the CLI
- Do not make `do` or `review` fake full automation
- Do not keep governance logic duplicated in prompts after the refactor
- Do not invent a new state store format — evolve the existing ones
- Do not make `do prepare` return suggested approaches — it returns governed facts only

## Current State vs Target

| Aspect | Current | Target |
|--------|---------|--------|
| Human interface | Raw `gov` and tool-specific wrappers | Small neutral facade with 5-6 commands |
| Lifecycle logic location | flat `coord/scripts/*` modules; `lifecycle.js` still large | cohesive core modules with a small lifecycle hub |
| Agent interface | Bash commands in prompts | MCP tools + agent facade |
| CLI role | Primary for everything | Admin/debug/CI only |
| MCP role | Thin subprocess wrapper | Primary agent API, calls core directly |
| Prompt size | 100-200 lines per skill | 20-30 lines (judgment only) |
| Drift risk | High — agents skip prose steps | Low — engine enforces |
| Dispatch strategy | Implicit and tool-biased | Capability registry + comparative-strength routing |
| Multi-agent parity | Claude has rich skills, Codex/Gemini get prose | All agents use same facade/MCP verbs while keeping native ecosystems |
| State mutation | Multi-file independent writes | Single canonical write → derived renders |
| Recovery | Patch several files | Journal-based rebuild |
