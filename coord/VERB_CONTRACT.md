# Neutral Verb Contract

Version: 0.1-draft
Updated: 2026-04-14

Status: forward contract with a thin current implementation at `coord/scripts/agent`

Layer label: `forward-contract`

Use this file for:
- what each operator verb is supposed to mean
- which facade verbs are primary versus internal
- the stable mapping expectations between facade, CLI, and MCP

If this file conflicts with `coord/GOVERNANCE.md` on current enforced behavior, `coord/GOVERNANCE.md` wins.

## Purpose

This file defines the small human-facing command surface that sits above the governed CLI and MCP core.

The goal is:

- humans use a tiny set of verbs
- governance owns lifecycle and correctness
- agents keep their native tools and execution style

## Human-Facing Verbs

The default operator surface is:

- `agent next`
- `agent do <ticket>`
- `agent review <ticket>`
- `agent resume <ticket>`
- `agent land <ticket>`
- `agent check`

These are the commands humans should normally need.

Current implementation note:

- `coord/scripts/agent` now exists as a thin adapter over `coord/scripts/gov`
- the facade handles simple orchestration such as ticket status probing, governed `start` or `resume`, and `explain`
- it does not replace agent-native UX layers or the underlying governance core

## Internal Facade Verbs

The facade may expose lower-level subcommands for wrappers, agents, or testing:

- `agent do prepare <ticket>`
- `agent do submit <ticket>`
- `agent review prepare <ticket>`
- `agent review record <ticket>`
- `agent status`
- `agent test`
- `agent recover`

These are internal or advanced surfaces, not the primary operator story.

## Contract Per Verb

Each section below lists the target-state contract for the verb. Bullets marked *(target)* describe behaviors this file commits the facade to eventually deliver; today's thin adapter satisfies the un-marked bullets only. The "Still deferred" list in Current Mapping is the authoritative inventory of which target behaviors have not yet shipped.

### `agent next`

- returns the next governed ticket or a structured explanation of why nothing is ready
- may orchestrate health checks, counts, and pick logic internally
- must not require the human to reason about raw lock or board state

### `agent do <ticket>`

- resolves readiness, dependencies, and blockers
- creates or refreshes the governed execution context
- dispatches work through the current agent path *(target: selects the best agent path using `coord/AGENT_CAPABILITY_REGISTRY.md`; today the path is the caller's native session)*
- returns an explain payload the caller can use to plan work *(target: returns or records a structured mandate and evidence requirements)*

### `agent review <ticket>`

- prepares review context through `coord/scripts/gov explain <ticket>`
- is expected to route review work through the capability registry once that dispatch ships *(target)*
- is expected to record structured review findings back into governed state *(target: implemented via structured review-record subcommands — currently deferred)*

### `agent resume <ticket>`

- re-enters the governed context for a ticket already in flight
- uses the shared session and lock rules, not provider-specific heuristics

### `agent land <ticket>`

- performs governed closeout and landing checks
- must respect ticket ownership, review requirements, and landing evidence rules

### `agent check`

- reports ticket-scoped governance health by default
- should not hard-block on unrelated foreign state unless strict/global mode is explicitly requested

## Mapping Rule

The facade is orchestration only. It must not duplicate lifecycle logic from the governance core.

The mapping is:

- facade verbs orchestrate
- MCP and CLI adapt transport
- governance core mutates state

## Current Mapping

Current implementation in `coord/scripts/agent`:

- `agent next` -> `coord/scripts/gov pick --mode general --limit 1` by default
- `agent do <ticket>` / `agent do prepare <ticket>` -> `ticket`, then `start` for `todo`/`deferred`, `resume` for `doing`/`review`, then `explain`
- `agent do submit <ticket>` -> `coord/scripts/gov submit <ticket> ...`
- `agent review <ticket>` / `agent review prepare <ticket>` -> `coord/scripts/gov explain <ticket>`
- `agent resume <ticket>` -> `coord/scripts/gov resume <ticket>`, then `explain`
- `agent land <ticket>` -> `coord/scripts/gov land <ticket> ...`, or `finalize` when the no-PR flags are supplied
- `agent check [<ticket>]` -> `coord/scripts/gov doctor [--ticket <ticket>]`

Still deferred:

- capability-registry-driven automatic dispatch
- structured review-record subcommands
- richer prepare/submit mandate exchange beyond the current thin adapter

## Non-Goals

- do not replace `coord/scripts/gov` for admin, CI, or break-glass repair
- do not make `agent do` pretend coding is deterministic
- do not flatten Claude, Codex, and Gemini into one workflow model
