"use strict";

// COORD-281: the lifecycle CLI presentation + thin read-only command-wrapper
// surface, extracted from lifecycle.js to bring the composition root back under
// the arch monolith/size LOC budget. ONE cohesive boundary: functions that ONLY
// validate args, delegate to a (lazily required) standalone engine, and EMIT
// output — they carry NO governance-mutation logic and reach NO governance
// internals. Everything external is INJECTED via the createLifecycleHelp factory:
//   - printHelp / buildInitiateSummary / printInitiate (help text + session primer)
//   - recall / insights / coverage-rollup / prework / closeout-summary /
//     learned-rule / sign-journal (thin CLI wrappers over their own engines)
//
// BOUNDARY: the only injected collaborators are the GovernanceError `fail`
// thrower, ensureCurrentAgentIdentity (primer identity read), the GovernanceError
// class, the live mutable `state` (path config; injected BY REFERENCE so test
// path overrides propagate), and COORD_DIR. fs/path are node builtins required
// directly. lifecycle.js wires this factory and destructures the returned
// functions back into scope so the `commands` dispatch table and the `__testing`
// facade (buildInitiateSummary) resolve exactly as before the move.
//
// NOTE: the moved function declarations live at column 0 inside the factory body
// (not re-indented) so their template-literal help text stays BYTE-IDENTICAL to
// the pre-extraction output. Indentation inside a function body is not required.

module.exports = function createLifecycleHelp(deps = {}) {
  const fs = require("fs");
  const path = require("path");
  const {
    fail,
    ensureCurrentAgentIdentity,
    GovernanceError,
    state,
    COORD_DIR,
  } = deps;

function printHelp(options = {}) {
  if (!options.all) {
    console.log(`Governance helper CLI

Preferred workflow:
  coord/scripts/gov initiate
  coord/scripts/gov pick [all] --mode <backend|frontend|design|general> --limit 3
  coord/scripts/gov agentid [--assign | --owner <handle|simple-id>]
  coord/scripts/gov claim [<ticket-id>]
  coord/scripts/gov resume <ticket-id>
  coord/scripts/gov file-ticket --repo <code> --type <type> --pri <P#> --description "<text>"   # file a backlog ticket — the safe one-liner (atomic, lock-held, journaled; NO prompt/parent required; add --with-prompt when start-ready prompt coverage is desired)
  coord/scripts/gov start <ticket-id>
  coord/scripts/gov block <ticket-id> --reason "<why work is paused>"
  coord/scripts/gov unblock <ticket-id>
  coord/scripts/gov commit <ticket-id> --message "Ticket commit message"
  coord/scripts/gov submit <ticket-id> [--fill]
  coord/scripts/gov guided-closeout <ticket-id> [--json] [--write]
  coord/scripts/gov publishability-check <ticket-id> [--json] [--files <path[,path]>]
  coord/scripts/gov finalize <ticket-id> --no-pr [--already-landed] --landed "<evidence>" [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  coord/scripts/gov land <ticket-id> [--method <merge|squash|rebase>] [--delete-branch] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  coord/scripts/gov supersede <ticket-id> [--reason "<why>"] [--consolidated-into <ticket-id>]

If review/governance state needs repair:
  coord/scripts/gov explain <ticket-id>
  coord/scripts/gov resume <ticket-id>
  coord/scripts/gov recover <ticket-id>
  coord/scripts/gov unstart <ticket-id>   # guarded same-owner wrong-start revert: doing -> todo, fails closed on review/landing/plan/workspace evidence
  coord/scripts/gov reconcile [<ticket-id>] --reason "<why the current drift is being accepted>"
  coord/scripts/gov open-followup [<new-ticket-id>|--prefix <PREFIX>] --depends-on <ticket-id> --repo <repo-code> --type <type> --pri <priority> --description <text> [--relation <blocking|related|closeout-blocker>]
  coord/scripts/gov file-ticket [<new-ticket-id>|--prefix <PREFIX>] --repo <repo-code> --type <type> --pri <priority> --description <text> [--status <todo|proposed>] [--depends-on <ticket-id>] [--prompt <path>] [--with-prompt] [--prompt-template ticket] [--owner <handle>]   # alias: gov new. Low-ceremony backlog create through the locked transaction — NO mandatory prompt coverage, NO forced parent dependency (the differentiator from open-followup). Add --with-prompt to create/register coord/prompts/tickets/<ID>.md atomically in the same journaled mutation. Status=todo (or proposed for quarantined machine-proposed debt), Owner=unassigned by default; ID reserved under the lock.
  coord/scripts/gov next-id <PREFIX>   # print the next free PREFIX-N ticket id
  coord/scripts/gov split-ticket <parent-ticket-id> --into <repo-codes> [--prefix <PREFIX>]   # one auto-allocated related followup per repo
  coord/scripts/gov set-followup-relation <ticket-id> [--depends-on <ticket-id>] --relation <blocking|related|closeout-blocker|independent>
  coord/scripts/gov set-priority <ticket-id> --pri <P0|P1|P2|P3>   # reprioritize a non-terminal ticket through gov (TASKS.md is a rendered view)
  coord/scripts/gov set-type <ticket-id> --type <feature|bug|chore|task|spike|refactor|docs|test>   # retype a non-terminal ticket through gov
  coord/scripts/gov approve <ticket-id>   # human-only: promote a quarantined "proposed" ticket to todo (proposed -> todo), one journal event
  coord/scripts/gov reject <ticket-id> --reason "<why>"   # human-only: decline a "proposed" ticket (proposed -> superseded), reason recorded + journaled
  coord/scripts/gov repair <ticket-id> --summary <text> --severity <HIGH|MED|LOW> --qref <Lxx>

Clean-checkout gate execution:
  coord/scripts/gov gate <repo-code|repo-name> --lane <default|full|ci> [--branch <ref>] [--source <local|hook|ci>]
  coord/scripts/gov governance-tier [--json] [--tier <lite|standard|full>]

Code-quality automation (COORD-083):
  coord/scripts/gov quality-scan [--apply] [--root <dir>] [--severity-floor warn|fail] [--cap <n>] [--depends-on <ticket>] [--repo <code>] [--prefix <PREFIX>]
      (runs the arch-checks library over <root>, dedups findings against open board tickets, and DRY-RUNS by default; --apply files governed follow-ups via open-followup. A per-run cap prevents board flooding. Schedulable via cron/CI — see coord/product/QUALITY_AUTOMATION.md)

Structured plan helpers:
  coord/scripts/gov add-review-cycle <ticket-id> --lens <name> --diff <text> --risk <text> --risk <text> --findings <text> --verification <cmd> --verdict <pass|fail> [--replace-review-cycle <N>]
  coord/scripts/gov set-review-cycles <ticket-id> --review-cycle "<structured cycle>" [--review-cycle "<structured cycle>" ...]
  coord/scripts/gov set-requirement-closure <ticket-id> --ticket-ask <text> --implemented <text> [--not-implemented <text>] [--deferred-to <text>] --closeout-verdict <complete|incomplete> [--supersede]
  coord/scripts/gov add-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  coord/scripts/gov drop-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  coord/scripts/gov add-repo-gate <ticket-id> (--command <cmd> [--note <text>] [--result <pass|fail>] [--base-result <pass|fail>] [--audit <summary>] | --not-required)
  coord/scripts/gov retire-stale-drift-notes [--dry-run]

Token-economics (TOKEN_ECONOMICS.md):
  coord/scripts/gov record-cost <ticket-id> --model <m> --input-tokens <n> --output-tokens <n> [--agent <h>] [--usd <amount>] [--phase start|implement|review|land]
      (append-only cost.observed journal event; if --usd omitted, estimates from coord/product/model-prices.json. Evidence, not a gate.)
  coord/scripts/gov cost [--ticket <id>] [--by ticket|agent|model] [--json]
      (read-only aggregate of the cost ledger: totals + breakdown; --json is deterministic/hash-stable; empty ledger -> zeros)
  coord/scripts/gov precheck <ticket-id> [--json] [--record]
      (cheap read-only probes -> verdict already-satisfied|partial|not-started|unknown; exit 0/10/20/30; NO required LLM call.
       Declare probes in coord/prompts/tickets/<ID>.precheck.json or a fenced 'precheck' JSON block in the prompt: types grep|test|file-exists, each with expect.
       No probes declared -> unknown, never a false satisfied. --record writes an auditable journal note.)
  coord/scripts/gov context-pack <ticket-id> [--json | --md]
      (deterministic, hash-stable per-ticket context pack: STABLE shared-preamble pointers (place in a prompt-cache prefix)
       + TICKET-SPECIFIC files/acceptance-criteria/spec-sections and prior feature-proofs+invariants intersecting the ticket files.
       Degrades gracefully when there are no prior proofs.)
  coord/scripts/gov gate-plan <ticket-id> [--files <path> ...] [--map <path>] [--risk-class <R0|R1|R2|R3|R4>] [--full] [--write] [--json | --md]
      (deterministic gate receipt: resolves track/lane/risk, affected-target slice or full fallback, selected/skipped gates,
       and required evidence. Dry-run by default; --write records the receipt in the canonical plan record and does not run gates.)
  coord/scripts/gov insights [--json]
      (COORD-147 strategic execution-insight report mined from REAL history (journal + board + plan records):
       repeated-failure-themes, architectural-debt-by-subsystem, churn-instead-of-value, gate/review/recovery health BY REPO.
       RECOMMENDS ONLY — mutates/gates nothing; every claim is source-cited (ticket ids + event_hash + chain_head); thin signal flagged.
       Deterministic (identical history -> identical report). --json emits the structured report; default emits the readable text report.)
  coord/scripts/gov tier <ticket-id>
      (resolves the ticket tier (explicit board Tier column, else derived from Pri, else standard), the suggested model class,
       and the tier-appropriate required evidence depth. Tier policy is data-driven in coord/product/tier-policy.json.
       Relax-only safety: standard/absent and critical keep TODAY's flat minimums byte-identical; only lower tiers relax.)
  coord/scripts/gov plan-waves [--status todo] [--repo <code>] [--json]
      (conflict-free parallel schedule: wave N = tickets sharing no declared file AND with all dependsOn satisfied by earlier waves/done.
       No-files tickets are treated as potentially-conflicting (scheduled alone); repo-X tickets can parallelize only with safe declared coord code/doc files and remain sequential for global coordination state.
       Deterministic (stable sort by ID); names per-ticket satisfied deps and lists any excluded ticket — no silent drops.)
  coord/scripts/gov sequencer-plan [--status review,doing] [--repo <code>] [--json]
      (read-only contention-triggered land-sequencer planner: groups active/review tickets that overlap by declared files,
       active dependency edges, missing file surfaces, or repo-X global-state risk. Disjoint tickets stay outside the queue;
       risky/unknown groups fall back to full-gate recommendations. Deterministic; mutates nothing.)
  coord/scripts/gov merge-queue [--status review,doing] [--repo <code>] [--json] [--record]
      (operational contention queue inspector/recorder: materializes sequencer-plan groups into deterministic queue state
       under coord/.runtime/merge-queue.json when --record is supplied. Ambiguous ordering is blocked; disjoint/single-agent
       land/finalize remains unchanged.)
  coord/scripts/gov dispatch-plan [--status todo] [--repo <code>] [--wave N] [--json | --md]
      (ONE deterministic dispatch manifest composing the levers: plan-waves schedule + per-ticket precheck verdict ->
       action skip (already-satisfied; includes the exact governed finalize-already-satisfied command) or spawn (everything else
       — unknown/no-probes NEVER yields a false skip); resolved tier -> suggested model class + tier-appropriate evidence depth;
       context-pack with its STABLE cacheable-prefix vs ticket-specific split preserved (--md emits a contextPackRef pointer).
       Read-only/additive; hash-stable (identical board -> byte-identical --json manifest).)

Observability (ENT-005):
  coord/scripts/gov otlp-export [--output <path> | --stdout] [--endpoint <url>]
      (emits the durable journal as OpenTelemetry OTLP/JSON: tickets-as-traces, lifecycle-verbs-as-spans,
       cost/tier/attribution as span attributes; non-ticket events as log records. Zero-dep + deterministic
       (identical journal -> byte-identical output). Default sink is stdout; --output writes a file; --endpoint
       opt-in POSTs to an HTTP OTLP endpoint (OFF by default, degrades gracefully, no network otherwise).
       READ-ONLY: never mutates the journal/board. Renders a fleet dashboard in Datadog/Grafana from journal export alone.)

Runtime lock repair:
  coord/scripts/gov runtime-lock-status
  coord/scripts/gov break-runtime-lock --yes
  coord/scripts/gov break-runtime-lock --yes --force-live  # human-admin break-glass only
  coord/scripts/gov clean-runtime [--yes] [--force] [--include-ticket-state]

Deterministic regen of canonical derived artifacts:
  coord/scripts/gov sync [--commit "<message>"]
      (regenerates rendered/TASKS.md, rendered/PROMPT_INDEX.md, PLAN.md and reports drift;
       with --commit, creates a single commit limited to those paths — never sweeps with git add -A)

Useful inspection:
  coord/scripts/gov initiate
  coord/scripts/gov agentid [--assign | --owner <handle|simple-id>]
  coord/scripts/gov claim <ticket-id>
  coord/scripts/gov agent-status
  coord/scripts/gov ticket <ticket-id>
  coord/scripts/gov recent [<ticket-id>] --limit 10 [--full]
  coord/scripts/gov explain <ticket-id>
  coord/scripts/gov counts
  coord/scripts/gov doctor [--fix | --repair-all [--confirm]] [--ticket <ticket-id>]
  coord/scripts/gov conform [--json] [--attest] [--verify-attestation <file>]
  coord/scripts/gov repair-chain [--confirm --reason "<why>"] [--json]
  coord/scripts/gov verify-engine [--pin] [--json]
  coord/scripts/gov audit-landings [--repo <repo-code>] [--ticket <ticket-id>] [--write]

Notes:
  - "start" requires a claimed owner context (or explicit --owner) before ticket mutations begin.
  - "agentid" reports the current window's agent id when claimed, returns assignment guidance when unclaimed, and can assign explicitly via --assign or --owner.
  - "claim" is different from "start": it binds the current session to an agent, and only takes over an existing ticket owner/lock when --force is explicit.
  - "set-waiver" records machine-readable prompt-coverage waivers in board state; free-text QUESTIONS.md notes are optional narrative context, not the start gate authority.
  - "resume" is the preferred same-owner session handoff for an already-started doing/review ticket; it rebinds the governed ticket lock into the current claimed session.
  - "commit" stages and commits inside the governed worktree for a doing ticket.
  - "submit" creates a PR when needed, records it, and moves the ticket to review after repo-gate, feature-proof, and structured self-review checks pass.
  - "finalize" is the shortcut for the common no-PR local-review closeout path; it moves to review and marks done once landing evidence is provided. Use --already-landed only to repair a no-PR ticket that was merged to dev before move-review. If the repo has a remote, prefer PR-backed landing unless no-PR is intentional.
  - "land" merges the PR, records source-vs-landed provenance, removes the clean canonical ticket worktree, closes the ticket, and appends the standard governance closeout note.
  - "supersede" moves any ticket to superseded, removes active lock/worktree residue, and preserves its historical evidence without reopening it later. Pass --reason "<why>" and/or --consolidated-into <ticket-id> to record inline supersession provenance on the board row (Supersede Reason / Superseded By) so a retired ticket is never left without a reason or replacement pointer. It is not a substitute for review/done closeout when the work already landed on dev.
  - "recent" / "explain" / "recover" read from the append-only governance journal and are the supported way to diagnose or repair live drift.
  - "conform" is a read-only journal hash-chain self-verify: it verifies every event's prev_event_hash link end-to-end and prints the chain head plus a pass/fail verdict (--json for machine output). A broken link means the journal was reordered, tampered, or had an event dropped; legacy pre-chain events validate as accepted-but-unverified. "doctor" runs the same chain check board-wide and fails on a broken link. ENT-010: "conform --attest" ALSO emits a signed (local ed25519 keypair) conformance attestation over the engine-integrity inputs (engine version, TEMPLATE_SYNC_MANIFEST.json fingerprint, gate config + latest gate-artifact result/coverage/audit, RELEASE_PROVENANCE donor SHA when present, and the journal chain head) under coord/.runtime/attestations/ (private signing key stays gitignored under coord/.runtime/conformance-keys/). "conform --verify-attestation <file>" re-derives the live inputs, recomputes the digest, checks the signature, and flags drift/tamper. This is the Community per-team self-verify; the signed attestation is the exact input a future central re-hash service (ENT-007) would re-compute.
  - "repair-chain" (COORD-124) is a GUARDED, AUDITABLE repair for a journal hash-chain broken by crossed prev_event_hash links (e.g. two governed agents appending concurrently). With NO flags it is a DRY-RUN: it reports the broken links that WOULD be re-linked (offending indices/ids + claimed-vs-expected prev-hash) and writes NOTHING; it no-ops cleanly when the chain is already valid. With "--confirm --reason \"<why>\"" it APPLIES: it backs the pre-repair journal up to a timestamped .pre-repair-<ts> sidecar (gitignored off-chain evidence), appends an explicit on-chain "chain-repair" marker capturing the broken-link evidence + the human reason + actor + ts, and re-stamps prev_event_hash for every chained event from the first broken link forward (reusing the canonical hasher) so the chain is GENUINELY re-linked — after which "conform" PASSES and the verified chain permanently contains the marker (repair is visible, never silent). The marker does NOT relax the verifier: a chain broken WITHOUT a recorded repair still FAILS conform, so this cannot be used to launder tampering. (--json for machine output.)
  - "verify-engine" (ENT-011, Community per-team) PINS the engine surface to a known-good version and DETECTS drift from it WITHOUT signing (signing is the Enterprise half, ENT-008). "verify-engine --pin" snapshots the current surface (TEMPLATE_SYNC_MANIFEST manifest_version + its sha256 fingerprint, reusing ENT-010's conformance fingerprint, plus a per-file checksum snapshot of the exact-match engine files) into coord/engine-pin.json — the ONLY mutation. "verify-engine" (no flag) is READ-ONLY: it re-derives the live surface and reports IN-SYNC or DRIFTED with the offending file paths / whether the manifest fingerprint changed (--json for machine output). This is COMPLEMENTARY to check-template-sync: check-template-sync verifies internal manifest-vs-files consistency, while verify-engine verifies drift from a FROZEN pinned version (re-pin after an intentional engine bump).
  - "recent" omits full snapshot payloads by default; pass --full when you need the materialized snapshot body.
  - "gate" materializes a temporary clean worktree from the target repo's branch, runs the requested gate lane inside it, records branch and commit provenance in the artifact, and prevents branch-ref-only evidence from being treated as tested content. The worktree is removed after the run.
  - structured plan helpers exist for the strict fields so different agents do not have to hand-format fragile 'update-plan' strings for review cycles, requirement closure, feature proof, or repo gates.
  - runtime lock repair is explicit: use 'runtime-lock-status' to inspect the current holder and 'break-runtime-lock --yes' when interrupted governance left 'coord/.runtime/governance.lock' wedged.
  - "clean-runtime" is the supported safe replacement for ad hoc 'git clean/reset' inside coord: it enumerates only regenerable runtime scratch under coord/.runtime and deletes NOTHING without --yes; it never removes locks/, plans/ (ticket-local state), session files, the governance journal/snapshots, or any git-tracked board/docs; ticket-local state needs --include-ticket-state AND --yes; it refuses on rollback drift unless --force.
  - "doctor --repair-all" is the operator-grade recovery wrapper. With no confirmation it is a DRY-RUN: it prints the composed repair plan and writes nothing. With "--confirm" it delegates to the same deterministic repair surface as "doctor --fix" (non-doing locks, stale locks 24h+, malformed locks on doing tickets, coord orphan worktrees, missing governed plan stubs, gate-proc orphans, and stale drift-note retirement) while preserving the existing unsafe-tree refusal. Journal hash-chain repair remains explicit via "repair-chain --confirm --reason".
  - "fleet-golden-path" is the read-only operator wrapper for multi-agent rollout: identity binding, prompt coverage, worktree start, prework context/gate receipts, closeout evidence commands, integration, and dry-run recovery.
  - "doctor --fix" applies deterministic repairs: non-doing locks, stale locks (24h+), malformed locks (missing required fields on doing tickets), coord orphan worktrees, missing governed plan stubs, and retirement of stale governance drift-note rows whose "since" timestamp predates the current journal baseline snapshot.
  - "retire-stale-drift-notes" is the standalone admin form of that retirement step; it marks drift-note QUESTIONS.md rows resolved with an audit note once a later journaled baseline snapshot has absorbed the reported drift. Pass --dry-run to preview.
  - "add-repo-gate" accepts --result <pass|fail> and --base-result <pass|fail> to attribute a failing gate to new-on-ticket vs pre-existing-on-base vs fixed-on-ticket; attribution is encoded as an annotation on the recorded repo_gates entry. --audit <summary> records the dependency/security audit signal (QGATE-002) as an audit=... annotation on the same entry.
  - Closed tickets are not reopened; use "open-followup" for post-close findings.
  - Run "node coord/scripts/governance.js help --all" for advanced/admin commands.
`);
    return;
  }
  console.log(`Governance helper CLI

Usage:
  node coord/scripts/governance.js initiate
  node coord/scripts/governance.js agentid [--assign | --owner <handle|simple-id>]
  node coord/scripts/governance.js claim [<ticket-id>] [--owner <handle|simple-id>] [--handoff [--reason <text>]] [--human-admin-override "<reason>"]
      (same-owner recovery of a live lease: --handoff; cross-owner takeover: --human-admin-override "<reason>"; bare --force is a deprecated legacy alias only)
  node coord/scripts/governance.js resume <ticket-id>
  node coord/scripts/governance.js agents list
  node coord/scripts/governance.js agents register [--handle <handle>] [--id <simple-id>] [--provider <provider>] [--lane <lane>] [--default-repo <repo-code>] [--notes <text>]
  node coord/scripts/governance.js agents disable <handle|simple-id>
  node coord/scripts/governance.js agents enable <handle|simple-id>
  node coord/scripts/governance.js agent-claim <handle|simple-id> [--session-label <label>] [--host <host>] [--cwd <path>] [--force]
  node coord/scripts/governance.js agent-release <handle|simple-id|session-id> [--force]
  node coord/scripts/governance.js agent-rebind --fresh [--session-label <label>] [--host <host>] [--cwd <path>]
  node coord/scripts/governance.js rebuild-board <ticket-id> | --all
  node coord/scripts/governance.js agent-status [<handle|simple-id>]
  node coord/scripts/governance.js pick [all] [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js start <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>]
  node coord/scripts/governance.js unstart <ticket-id> [--owner <owner>]
  node coord/scripts/governance.js block <ticket-id> [--owner <owner>] --reason <text>
  node coord/scripts/governance.js unblock <ticket-id> [--owner <owner>]
  node coord/scripts/governance.js plan <ticket-id> [--seed] [update-plan flags...]
  node coord/scripts/governance.js gate-plan <ticket-id> [--files <path> ...] [--map <path>] [--risk-class <R0|R1|R2|R3|R4>] [--full] [--write] [--json | --md]
  node coord/scripts/governance.js commit <ticket-id> --message <text> [--all] [--files <path> ...] [--owner <owner>]
  node coord/scripts/governance.js submit <ticket-id> [--pr <ref> ...] [--base <branch>] [--title <text> --body <text> | --fill] [--draft]
  node coord/scripts/governance.js review <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js land <ticket-id> [--pr <ref> ...] [--landed <evidence> ...] [--method <merge|squash|rebase>] [--delete-branch] [--admin] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js finalize <ticket-id> [--no-pr] [--already-landed] [--pr <ref> ...] [--landed <evidence> ...] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js supersede <ticket-id> [--reason <text>]
  node coord/scripts/governance.js finish <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js close <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js repair <ticket-id> [--owner <owner>] --summary <text> --severity <HIGH|MED|LOW> --qref <Lxx>
  node coord/scripts/governance.js backfill-plan-records [--from <ticket-id>] [--status <review|done>] [--limit <n>]
  node coord/scripts/governance.js counts
  node coord/scripts/governance.js board-state
  node coord/scripts/governance.js recent [<ticket-id>] [--limit <n>] [--full]
  node coord/scripts/governance.js explain <ticket-id>
  node coord/scripts/governance.js recover <ticket-id>
  node coord/scripts/governance.js reconcile [<ticket-id>] --reason <text>
  node coord/scripts/governance.js list [--status <status>] [--repo <repo>] [--owner <owner>] [--pri <priority>]
  node coord/scripts/governance.js recommend [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js next-ticket [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js run-ticket-cycle <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>]
  node coord/scripts/governance.js fleet-golden-path [<ticket-id>] [--json]
  node coord/scripts/governance.js guided-closeout <ticket-id> [--json] [--write]
  node coord/scripts/governance.js governance-tier [--json] [--tier <lite|standard|full>]
  node coord/scripts/governance.js publishability-check <ticket-id> [--json] [--files <path[,path]>]
  node coord/scripts/governance.js doctor [--fix | --repair-all [--confirm]] [--ticket <ticket-id>]
  node coord/scripts/governance.js audit-landings [--repo <repo-code>] [--ticket <ticket-id>] [--write]
  node coord/scripts/governance.js ticket <ticket-id>
  node coord/scripts/governance.js pr-view <ticket-id|pr-url>
  node coord/scripts/governance.js pr-create <ticket-id> [--base <branch>] [--title <text> --body <text> | --fill] [--draft]
  node coord/scripts/governance.js pr-merge <ticket-id|pr-url> [--method <merge|squash|rebase>] [--delete-branch] [--admin]
  node coord/scripts/governance.js mark-done <ticket-id> [--landed <evidence> ...] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js finish-ticket <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js move-review <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js reopen-ticket <ticket-id>   # deprecated compatibility alias; now errors with guidance
  node coord/scripts/governance.js return-doing <ticket-id> [--owner <owner>] --summary <text> --severity <HIGH|MED|LOW> --qref <Lxx>
  node coord/scripts/governance.js start-ticket <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>]
  node coord/scripts/governance.js commit-ticket <ticket-id> --message <text> [--all] [--files <path> ...] [--owner <owner>]
  node coord/scripts/governance.js open-followup [<new-ticket-id>|--prefix <PREFIX>] --depends-on <ticket-id> --repo <repo-code> --type <type> --pri <priority> --description <text> [--relation <blocking|related|closeout-blocker>]
  node coord/scripts/governance.js file-ticket [<new-ticket-id>|--prefix <PREFIX>] --repo <repo-code> --type <type> --pri <priority> --description <text> [--depends-on <ticket-id>] [--prompt <path>] [--with-prompt] [--prompt-template ticket] [--owner <handle>]   # alias: new
  node coord/scripts/governance.js next-id <PREFIX>
  node coord/scripts/governance.js split-ticket <parent-ticket-id> --into <repo-codes> [--prefix <PREFIX>]
  node coord/scripts/governance.js set-followup-relation <ticket-id> [--depends-on <ticket-id>] --relation <blocking|related|closeout-blocker|independent>
  node coord/scripts/governance.js set-waiver <ticket-id> --reason <text> [--clear]
  node coord/scripts/governance.js register-prompt <ticket-id> [<path>] [--path <path>] [--create] [--template ticket] [--force] [--replace]
  node coord/scripts/governance.js set-pr <ticket-id> --pr <ref> [--pr <ref> ...]
  node coord/scripts/governance.js add-finding <ticket-id> --severity <HIGH|MED|LOW> --summary <text> --qref <Lxx> [--round <n>]
  node coord/scripts/governance.js update-finding <ticket-id> --id <finding-id> --status <resolved|deferred|consolidated> [--deferred-to <ticket>] [--consolidated-into <ticket>]
  node coord/scripts/governance.js log-question --from <agent> --to <target> --question <text> --answer <text> --resolved <yes|no|n/a>
  node coord/scripts/governance.js heartbeat <ticket-id>
  node coord/scripts/governance.js update-plan <ticket-id> [--summary <text>] [--verify <cmd>] [--files <path>] [--security <yes|no>] [--startup <completed>] [--traceability <verified|closing-gap|exempt>] [--baseline <text>] [--invariant <text>] [--closure <text>] [--feature-proof <text>] [--repo-gate <text>] [--rollback <text>] [--closeout-method <pr|no_pr|fulfilled_by>] [--closeout-base-ref <ref>] [--provenance-note <text>] [--review-profile <standard|bounded_repair>] [--review-cycle <text>] [--replace-review-cycle <N> --review-cycle <text>] [--drop-review-cycle <N>]
  node coord/scripts/governance.js add-review-cycle <ticket-id> --lens <name> --diff <text> --risk <text> --risk <text> --findings <text> --verification <cmd> --verdict <pass|fail> [--replace-review-cycle <N>]
  node coord/scripts/governance.js set-review-cycles <ticket-id> --review-cycle "<structured cycle>" [--review-cycle "<structured cycle>" ...]
  node coord/scripts/governance.js set-requirement-closure <ticket-id> --ticket-ask <text> --implemented <text> [--not-implemented <text>] [--deferred-to <text>] --closeout-verdict <complete|incomplete> [--supersede]
  node coord/scripts/governance.js add-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  node coord/scripts/governance.js drop-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  node coord/scripts/governance.js add-repo-gate <ticket-id> (--command <cmd> [--note <text>] [--result <pass|fail>] [--base-result <pass|fail>] | --not-required)
  node coord/scripts/governance.js retire-stale-drift-notes [--dry-run]
  node coord/scripts/governance.js release-lock <ticket-id> [--force]
  node coord/scripts/governance.js lock-abandon <ticket-id> --human-admin-override "<reason>"
  node coord/scripts/governance.js runtime-lock-status
  node coord/scripts/governance.js break-runtime-lock --yes [--force-live]
  node coord/scripts/governance.js clean-runtime [--yes] [--force] [--include-ticket-state]
  node coord/scripts/governance.js audit-worktrees
  node coord/scripts/governance.js cleanup-helpers <repo-code|repo-name> --yes [--delete-branch]
  node coord/scripts/governance.js gate <repo-code|repo-name> --lane <default|full|ci> [--branch <ref>] [--source <local|hook|ci>]
  node coord/scripts/governance.js cleanup-worktree <repo-code|repo-name> <ticket-id|path> --yes [--delete-branch]

Notes:
  - "initiate" is the session-start primer: it prints the current claim state, the do-not-edit rules, and the supported lifecycle commands for this board.
  - "agentid" reports the current window/thread identity when already claimed, returns structured assignment guidance when unclaimed, and can assign explicitly via --assign or --owner.
  - "claim" binds the current thread/session to an agent identity; with a ticket-id it only takes over another active owner/lock when --force is explicit.
  - "resume" is the preferred same-owner session rebind for an already-started doing/review ticket and avoids the common "claim --owner" vs ticket-lock confusion.
  - agent ownership is registry-backed and tied to the current governance board; mutating commands require explicit claim or --owner before lock/worktree mutation.
  - the same claimed agent identity may work across backend, frontend, and coord repos that share this board without changing names.
  - "pick" / "start" / "submit" / "land" / "repair" are the preferred top-level workflow verbs.
  - "unstart" is the guarded same-owner wrong-start exception: it reverts a doing/blocked ticket to todo and clears the owner, lock, and clean worktree. It fails closed once the ticket has accrued review, landing, plan, or workspace evidence that must remain auditable — use "move-review" or "supersede" instead. Foreign-owner cleanup stays an admin path ("lock-abandon").
  - "lock-abandon" is the foreign-owner admin counterpart of "unstart": with --human-admin-override "<reason>" it returns a stale foreign-locked doing ticket to todo and clears the owner, lock, and clean worktree. It rejects a ticket the current session owns (use "unstart") and fails closed on accrued review/landing/plan/workspace evidence (use "supersede" or "reconcile"). The override authorizes touching foreign ticket state, not destroying auditable work.
  - "block" / "unblock" toggle a doing ticket between "doing" and "doing (blocked: <reason>)" for the same owner; both are journaled lifecycle transitions and require the ticket to already be doing.
  - "pick" without arguments ranks work only for the current agent/session; "pick all" looks at idle active agent sessions and returns one option per agent.
  - "mark-done" is a guarded review -> done transition and re-checks review-plan gates, merged/manual landing evidence, source-vs-landed provenance, canonical-branch landing ancestry, feature-proof audit, clean worktree closeout, and any declared closeout-blocker follow-up tickets.
  - "recommend" / "next-ticket" ranks the best next open tickets from the canonical board.
  - "run-ticket-cycle" scaffolds the governed planner -> worker -> reviewer -> closer flow for one ticket.
  - "fleet-golden-path" prints the read-only multi-agent operator path: identity binding, prompt coverage, isolated worktree start, gate/context prework, closeout evidence wrappers, integration, and dry-run recovery.
  - "guided-closeout" prints exact closeout gaps and ready-to-paste remediation commands before submit/finalize; --write stores a runtime receipt for handoff.
  - "governance-tier" reports the active progressive-disclosure tier. Existing repos default to full so current behavior is unchanged.
  - "publishability-check" tells closeout whether touched canonical/docs/release/engine surfaces need template-sync, prodloc, leak-scan, or dual-release evidence.
  - "doctor" runs board validation plus extra governance audits; --fix applies only deterministic repairs and then prints what changed. --repair-all is dry-run by default and requires --confirm before delegating to those deterministic repairs.
  - "audit-landings" classifies done backend/frontend landing records into explicit, fulfilled-by, legacy, and unknown buckets, and can backfill provenance_status plus commit_sha for legacy records that already resolve cleanly to a landed dev ancestor.
  - active doing-ticket lock/worktree drift is reported by "doctor" but does not block unrelated governed lifecycle mutations.
  - governed lifecycle mutations are journaled under coord/.runtime; unrelated provenance drift is logged to coord/QUESTIONS.md for orchestrator follow-up instead of blocking agents, while duplicate claim conflicts and direct write conflicts still fail closed.
  - the journal keeps compact event rows plus a latest-snapshot checkpoint; use "recent --full" only when you need the materialized snapshot body.
  - "pr-view" / "pr-create" / "pr-merge" keep GitHub PR actions inside the same guarded governance CLI; PR creation now requires a clean committed governed worktree.
  - "commit" / "commit-ticket" stage and create a non-interactive commit inside the governed worktree for a doing backend/frontend ticket. Repo X (coord-only) tickets do not have a product worktree; for those, use targeted "git add <files>" / "git commit" directly while keeping "coord/scripts/gov" for lifecycle/plan/review/closeout mutations.
  - "submit" creates a PR when needed, records it, and moves the ticket to review after repo-gate, requirement-closure evidence, feature-proof evidence, and structured self-review checks pass.
  - "finalize" is the governed shortcut for local-review / no-PR closeout when you already have landing evidence; --already-landed is the repair path for a no-PR ticket that reached dev before move-review. Once a repo has a configured remote, prefer PR-backed landing unless no-PR is an intentional exception.
  - "land" merges the PR, records source-vs-landed provenance, removes the clean canonical ticket worktree, closes the ticket, and appends the standard governance closeout note.
  - "move-review" performs the guarded doing -> review closeout, requires recorded repo gates plus explicit ask-vs-implementation closure evidence, feature-proof evidence, and structured self-review evidence (critical invariants, 4 cycles, distinct deep-review lenses for product repos), and releases the lock. If --pr is omitted, it reuses existing pr_index or resolves a single branch PR. For no-PR tickets already landed on dev, use finalize --no-pr --already-landed instead of supersede.
  - "reopen" is a deprecated compatibility alias and now errors with guidance; closed tickets require follow-up tickets instead of reopen.
  - "finish-ticket" chains set-pr -> move-review -> mark-done when the gates pass. If --pr is omitted, it reuses existing pr_index or resolves a single branch PR.
  - "return-doing" performs the guarded review -> doing transition, records a new finding, reacquires the lock, preserves the canonical plan record, and resets only the round-specific self-review evidence that must be refreshed.
  - "start-ticket" requires canonical plan state with startup/traceability attestations (and baseline reproduction for test tickets), then updates the board, creates a lock, and creates a canonical worktree.
  - "set-waiver" records structured prompt-coverage waivers in board state so start gating does not depend on free-text QUESTIONS.md scans.
  - "register-prompt --create" writes the canonical prompt file and prompt_index mapping in one governed mutation; without --create it still requires the prompt file to exist first.
  - "backfill-plan-records" synthesizes canonical per-ticket plan records for historical governed tickets that predate the new plan store, using surviving PLAN.md blocks when present and board lifecycle evidence otherwise.
  - "cleanup-helpers" removes helper/temp worktrees that are not canonical ticket worktrees.
  - "cleanup-worktree" is destructive and requires --yes.
  - "clean-runtime" is the supported safe alternative to ad hoc 'git clean/reset' for coord: dry-run by default, requires --yes to delete, only touches regenerable runtime scratch under coord/.runtime, never touches ticket-local state (locks/, plans/), session files, the journal/snapshots, or git-tracked board/docs, and refuses on rollback drift unless --force.
`);
}

function buildInitiateSummary() {
  let claimStatus = "- No active claimed agent session is bound to this thread yet.";
  try {
    const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    claimStatus =
      `- Current claimed session: ${identity.agent.handle} (${identity.agent.id})` +
      `${identity.session?.session_id ? ` via ${identity.session.session_id}` : ""}.`;
  } catch (error) {
    if (!(error instanceof GovernanceError)) {
      throw error;
    }
  }

  return [
    "Governance Session Primer",
    "",
    "Current session:",
    claimStatus,
    "",
    "Rules:",
    "- Use `coord/scripts/gov ...` for lifecycle mutations. Do not directly edit `coord/board/tasks.json`, `coord/PLAN.md`, `coord/.runtime/plans/*.json` (plan shards; legacy `coord/board/plans/*.json` is read-only compat), `coord/.runtime/agents.json`, `coord/agents.json`, lock files, or session files.",
    "- Start each session by claiming an owner with `coord/scripts/gov claim --owner <handle|simple-id>`, or use `coord/scripts/gov resume <ticket-id>` when you are re-entering an active ticket.",
    "- Normal flow is `pick` -> `plan --seed` or `start` -> `update-plan` -> `commit` -> `submit` -> `finalize` or `land`.",
    "- `coord/scripts/gov plan <ticket-id>` shows canonical plan readiness; `plan <ticket-id> --seed` creates the startup-ready plan state used by start. `start` auto-seeds the same fields, so `--seed` is mainly for previewing plan readiness before claiming.",
    "- Use `coord/scripts/gov update-plan <ticket-id> ...` (or `plan` with the same flags) for startup attestations, baseline evidence, invariants, requirement closure, repo gates, and review cycles. Do not patch plan JSON or PLAN.md by hand.",
    "- When governance blocks you, use `coord/scripts/gov explain <ticket-id>`, `coord/scripts/gov recent <ticket-id>`, and `coord/scripts/gov recover <ticket-id>` before considering any manual repair.",
    "",
    "Common commands:",
    "- `coord/scripts/gov pick --mode general --limit 3`",
    "- `coord/scripts/gov claim --owner <handle|simple-id>`",
    "- `coord/scripts/gov resume <ticket-id>`",
    "- `coord/scripts/gov explain <ticket-id>`",
    "- `coord/scripts/gov doctor`",
  ].join("\n");
}

function printInitiate(options = {}) {
  if (Object.keys(options).length > 0) {
    fail("initiate does not take options. Run it with no arguments to print the governance primer for this session.");
  }
  console.log(buildInitiateSummary());
}

// COORD-141: `gov recall "<query>"` — Phase 1 deterministic memory recall.
// Thin CLI wrapper over the standalone recall engine (coord/scripts/recall.js):
// id/path -> BM25 -> provenance weighting, source-cited, permission-aware via
// ENT-012 (best-effort; community-cut safe). The query is the leading
// positional arg(s); --role <role> opts into RBAC redaction; --json emits the
// raw §7 contract. The engine is required lazily so the rest of lifecycle.js
// stays independent of the memory layer.
function recallCommand(query, options = {}) {
  const recallEngine = require("./recall.js");
  const text = query == null ? "" : String(query);
  if (!text.trim()) {
    fail('recall requires a query: coord/scripts/gov recall "<query>" [--role <role>] [--json]');
  }
  const result = recallEngine.recall(text, { role: options.role || null });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`Q: ${result.query}`);
  console.log("");
  console.log(result.answer);
  console.log("");
  console.log(`confidence=${result.confidence} staleness=${result.staleness}`);
  console.log("");
  console.log("Sources:");
  for (const s of result.sources) {
    console.log(
      `  - [${s.type}] ${s.id || ""} ${s.path || ""} ` +
        `verified=${s.verified} event_hash=${(s.event_hash || "").slice(0, 12)} ` +
        `chain_head=${(s.chain_head || "").slice(0, 12)}`
    );
  }
  return result;
}

// COORD-147: `gov insights` — Strategic execution-insight reports. Thin CLI
// wrapper over the standalone generator (coord/scripts/insight-reports.js). It
// RECOMMENDS only: a pure read over the journal + board + plan records that
// mutates/gates nothing and emits only source-cited claims. --json emits the
// structured report; default emits the readable text report. The engine is
// required lazily so the rest of lifecycle.js stays independent of the memory
// layer.
function insightsCommand(options = {}) {
  const engine = require("./insight-reports.js");
  const report = engine.generateReport({ now: new Date().toISOString() });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(engine.renderText(report));
  return report;
}

// COORD-243: `gov coverage-rollup [--json] [--dry-run]` — the DO layer of the
// coverage-maturity DETECT/DO/TRIGGER split. SEPARATE from `gov doctor` (doctor
// only DETECTS): this verb DOES the minutes-scale work. It reads the REAL
// artifacts the governed lane already produces — the per-commit coverage gate
// signals recorded in plan records (QGATE-003) + the `gov insights` gate/recovery
// health rollup — and refreshes coord/TEST_MATURITY.md's `Last updated`, the
// gate-health-derived rows, and a History entry. IDEMPOTENT: re-running on
// unchanged inputs leaves the file byte-identical. `--dry-run` computes without
// writing. The TRIGGER (cadence) lives in coverage-rollup-cron.js + the runbook.
function coverageRollupCommand(options = {}) {
  const engine = require("./coverage-maturity.js");
  const result = engine.rollup({
    now: new Date().toISOString(),
    write: !options.dryRun,
  });
  if (options.json) {
    console.log(JSON.stringify({
      output: result.outputPath,
      changed: result.changed,
      dry_run: Boolean(options.dryRun),
      inputs: result.inputs,
    }, null, 2));
    return result;
  }
  const verb = options.dryRun ? "would refresh" : result.changed ? "refreshed" : "no change (idempotent)";
  console.log(
    `coverage-rollup: ${verb} coord/TEST_MATURITY.md — ` +
    `gate ${result.inputs.gate.failing_cycles}/${result.inputs.gate.total_cycles} review cycles failing, ` +
    `${result.inputs.recovery_events} recovery events` +
    (result.inputs.coverage ? `, coverage ${result.inputs.coverage.result}` : "") +
    (result.inputs.mutation ? `, mutation ${result.inputs.mutation.result}` : "") +
    "."
  );
  return result;
}

// COORD-148: `gov prework <ticket> [--scope "<text>"] [--role <role>] [--json]`
// — the [Memory] Solving pre-work CONTEXT PACK. Thin CLI wrapper over the
// standalone generator (coord/scripts/prework-pack.js). It RECOMMENDS only: a
// pure read over governed memory (journal + board + plan records + decision
// records + indexed files) that surfaces, BEFORE an agent starts, the relevant
// prior work + already-failed approaches in the touched area + a recommended
// safe decomposition / test selection — every item source-cited, mutating and
// gating nothing. Complements `gov explain` start-readiness (advisory input the
// agent reads at work-start). Composes recall.js / decision-extractor.js /
// insight-reports.js; required lazily so lifecycle.js stays independent of the
// memory layer. The leading positional is the ticket id (optional when --scope
// supplies a free-text area); --scope adds free text; --role opts into ENT-012
// redaction; --json emits the structured pack.
function preworkCommand(ticketId, options = {}) {
  const engine = require("./prework-pack.js");
  const scope = options.scope || null;
  if ((ticketId == null || String(ticketId).trim() === "") && !scope) {
    fail(
      'prework requires a ticket id or --scope: coord/scripts/gov prework <ticket-id> [--scope "<text>"] [--json]'
    );
  }
  const pack = engine.buildPack({
    ticketId: ticketId && String(ticketId).trim() ? String(ticketId).trim() : null,
    scope,
    role: options.role || null,
    now: new Date().toISOString(),
  });
  if (options.json) {
    console.log(JSON.stringify(pack, null, 2));
    return pack;
  }
  console.log(engine.renderText(pack));
  return pack;
}

// COORD-149: `gov closeout-summary <ticket> [--json]` — the [Memory] Solving
// auto evidence-backed CLOSEOUT SUMMARY. Thin CLI wrapper over the standalone
// generator (coord/scripts/closeout-summary.js). It REPORTS only: a pure read
// over the closing/landed ticket's REAL artifacts (its plan record, journal
// events, board row, and any anchoring conformance attestation) that produces a
// source-cited summary — what was asked + delivered, the evidence trail
// (repo-gate results, review cycles, source commit(s)/landing record,
// attestation), and key decisions + deferrals — every claim pinning event_hash +
// chain_head. It does NOT close, gate, finalize, or mutate the ticket: closeout
// stays governed by the normal finalize lane; this is an evidence artifact, not an
// authority. Composes decision-extractor.js + insight-reports.js; required lazily
// so lifecycle.js stays independent of the memory layer. --json emits the
// structured summary; default emits the readable text summary.
function closeoutSummaryCommand(ticketId, options = {}) {
  const engine = require("./closeout-summary.js");
  if (ticketId == null || String(ticketId).trim() === "") {
    fail(
      "closeout-summary requires a ticket id: coord/scripts/gov closeout-summary <ticket-id> [--json]"
    );
  }
  const summary = engine.buildSummary({
    ticketId: String(ticketId).trim(),
    now: new Date().toISOString(),
  });
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  console.log(engine.renderText(summary));
  return summary;
}

// COORD-145: `gov learned-rule capture|list|promote` — governed procedural-
// memory promotion. Thin CLI wrapper over the standalone engine
// (coord/scripts/learned-rule-promotion.js). It RECOMMENDS / ROUTES only: a
// learned behavioral rule is CAPTURED as a candidate (the only write is an
// append to the derived, gitignored candidates queue), then PROMOTED into a
// governed-change SPEC routed to the FULL reviewed lane (asserted via the
// COORD-166 isProceduralDocPath). It NEVER edits a procedural file — the
// procedural surface (.claude/, AGENTS.md, CLAUDE.md, GOVERNANCE.md) changes
// ONLY through the reviewed/landed lifecycle. Every candidate carries §7
// citations (no uncited rule). The engine is required lazily so the rest of
// lifecycle.js stays independent of the memory layer.
function learnedRuleCommand(sub, args = []) {
  const engine = require("./learned-rule-promotion.js");
  if (!sub || !["capture", "list", "promote"].includes(sub)) {
    fail(
      'learned-rule requires a subcommand: capture | list | promote. ' +
        'e.g. coord/scripts/gov learned-rule promote <PRC-id> [--json]'
    );
  }
  return engine.runCli([sub, ...args]);
}

// COORD-146: `gov sign-journal sign|verify` — [Memory] cross-cutting per-event /
// batch signing for memory NON-REPUDIATION (folded into the KMS / key-custody
// roadmap). Thin CLI wrapper over the standalone engine
// (coord/scripts/journal-signing.js). It EXTENDS — never replaces — the existing
// hash-chain + single chain-head attestation: it ed25519-signs ONE Merkle batch
// over the per-event leaf hashes (the same canonical event_hash the journal +
// decision-extractor already cite), binding the merkle_root to the journal
// chain_head, so any individual event's non-repudiation is provable via a compact
// Merkle inclusion proof WITHOUT a signature per line. Backward compatible:
// read-only over the journal, writes only its own signed-batch artifact under the
// gitignored coord/.runtime/ tree, never mutates events, never weakens
// verifyGovernanceChain. The signing key SOURCE is pluggable (a key provider) so
// an adopter backs it with a KMS/HSM; coord ships only the local-key default
// (private key gitignored) and does NOT reimplement a KMS (explicit non-goal).
//
//   sign   [--out <file>]              — sign the current journal as one batch,
//                                        write the signed-batch artifact (default
//                                        under coord/.runtime/journal-signatures/).
//   verify <batch-file> [--event <hash>] — verify the batch (signature + merkle_root
//                                        rebuild + chain-head bind to the live
//                                        journal); with --event, ALSO prove that
//                                        event's per-event non-repudiation
//                                        (signature valid + Merkle inclusion).
// The engine is required lazily so the rest of lifecycle.js stays independent of
// the memory layer.
function signJournalCommand(sub, options = {}) {
  const engine = require("./journal-signing.js");
  if (!sub || !["sign", "verify"].includes(sub)) {
    fail(
      "sign-journal requires a subcommand: sign | verify. " +
        'e.g. coord/scripts/gov sign-journal sign [--out <file>] | ' +
        "coord/scripts/gov sign-journal verify <batch-file> [--event <hash>]"
    );
  }

  const journalPath = state.GOVERNANCE_EVENT_LOG_PATH;
  const events = engine.readJournalEvents(journalPath);
  const liveChainHead = engine.chainHeadOf(events);
  const liveEventHashes = events.map((e) => engine.eventHashFromLine(e.line));

  if (sub === "sign") {
    const { batch, tree } = engine.buildSignedBatch({
      events,
      coordDir: COORD_DIR,
    });
    const dir = path.join(state.RUNTIME_DIR, "journal-signatures");
    fs.mkdirSync(dir, { recursive: true });
    const tag = (batch.subject.chain_head || "no-chain-head").slice(0, 16);
    const outPath =
      options.out || path.join(dir, `${tag}.${batch.subject_digest.slice(0, 12)}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(batch, null, 2) + "\n");
    const result = {
      status: "signed",
      path: outPath,
      event_count: batch.subject.event_count,
      merkle_root: batch.subject.merkle_root,
      chain_head: batch.subject.chain_head,
      subject_digest: batch.subject_digest,
      // The root must round-trip from any leaf's inclusion proof.
      merkle_levels: tree.levels.length,
    };
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("Journal batch signed:");
      console.log(`  path:        ${result.path}`);
      console.log(`  events:      ${result.event_count}`);
      console.log(`  merkle_root: ${result.merkle_root}`);
      console.log(`  chain_head:  ${result.chain_head || "(empty journal)"}`);
      console.log(`  digest:      ${result.subject_digest}`);
    }
    return result;
  }

  // verify
  const batchFile = options.file;
  if (!batchFile) {
    fail(
      "sign-journal verify requires a batch file: " +
        "coord/scripts/gov sign-journal verify <batch-file> [--event <hash>]"
    );
  }
  if (!fs.existsSync(batchFile)) {
    fail(`Signed-batch file not found: ${batchFile}`);
  }
  let batch = null;
  try {
    batch = JSON.parse(fs.readFileSync(batchFile, "utf8"));
  } catch (error) {
    fail(`Signed-batch file is not valid JSON: ${batchFile} (${error.message})`);
  }

  const report = engine.verifySignedBatch(batch, {
    liveChainHead,
    liveEventHashes,
  });

  // Optional per-event non-repudiation proof.
  let eventReport = null;
  if (options.event) {
    const targetHash = String(options.event);
    const index = (Array.isArray(batch.event_hashes) ? batch.event_hashes : []).indexOf(
      targetHash
    );
    if (index < 0) {
      eventReport = {
        ok: false,
        event_hash: targetHash,
        included: false,
        problems: [
          { code: "event_not_in_batch", detail: "event hash is not among the batch event_hashes" },
        ],
      };
    } else {
      const tree = engine.buildMerkleTree(batch.event_hashes);
      const proof = engine.buildInclusionProof(tree, index);
      eventReport = engine.verifyEventInclusion(batch, targetHash, proof);
    }
  }

  const result = {
    status: report.ok ? "valid" : report.verdict,
    verdict: report.verdict,
    batch_ok: report.ok,
    signature_valid: report.signature_valid,
    merkle_root_matches: report.merkle_root_matches,
    chain_head_matches: report.chain_head_matches,
    event_count: report.event_count,
    problems: report.problems,
    event_inclusion: eventReport,
  };
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Journal batch verification: ${report.ok ? "VALID" : report.verdict.toUpperCase()}`);
    console.log(`  signature valid:    ${report.signature_valid}`);
    console.log(`  merkle_root match:  ${report.merkle_root_matches}`);
    console.log(`  chain_head bind:    ${report.chain_head_matches}`);
    console.log(`  events:             ${report.event_count}`);
    if (report.problems.length > 0) {
      console.log(`  problems (${report.problems.length}):`);
      for (const p of report.problems) {
        console.log(`    - ${p.code}: ${p.detail}`);
      }
    }
    if (eventReport) {
      console.log(`  event ${String(options.event).slice(0, 12)} non-repudiation: ${eventReport.ok ? "PROVEN" : "FAILED"}`);
      console.log(`    included under signed root: ${eventReport.included}`);
      if (eventReport.problems && eventReport.problems.length > 0) {
        for (const p of eventReport.problems) {
          console.log(`    - ${p.code}: ${p.detail}`);
        }
      }
    }
  }
  if (!report.ok || (eventReport && !eventReport.ok)) {
    fail(
      `Journal batch verification FAILED: verdict=${report.verdict}` +
        (eventReport && !eventReport.ok ? ", event non-repudiation could not be proven" : "") +
        ". The signed batch was tampered with, is stale, or the event is not provably included."
    );
  }
  return result;
}

return {
  printHelp,
  buildInitiateSummary,
  printInitiate,
  recallCommand,
  insightsCommand,
  coverageRollupCommand,
  preworkCommand,
  closeoutSummaryCommand,
  learnedRuleCommand,
  signJournalCommand,
};
};
