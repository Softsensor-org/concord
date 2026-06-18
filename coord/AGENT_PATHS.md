# Agent Paths

Version: 0.1-draft
Updated: 2026-04-14

Layer label: `practical-guide`

Use this file for:
- choosing the native path for Codex, Claude, or Gemini
- day-to-day operator guidance about which UX layer to use
- practical handoff guidance between agent-native paths

This file translates policy into workflow. It is not the canonical source for enforcement rules.

This file explains how different agents use the same governance core without confusion.

## Operator Default

The canonical human-facing verb set lives in `coord/VERB_CONTRACT.md`.
`coord/scripts/agent` now exposes that small facade as a thin adapter over the governed CLI.

Agents should still choose one native path per session and converge through the same governed CLI or MCP core. The facade reduces the human-facing surface; it does not replace native agent UX or the underlying governance engine.

## Shared Core

Every agent shares the same governed source of truth. The canonical file map for that shared core lives in `coord/GOVERNANCE.md` Section 2 (`Canonical Files`), and this guide intentionally references that table instead of restating it here.

Shared execution surfaces remain the same for every agent:
- `coord/scripts/gov ...`
- the `governance` MCP server in `.mcp.json`

The board, locks, plan records, review evidence, and landing rules are identical for all agents.

## Comparative Strengths

The purpose of multiple agents is to draw on their different strengths, not to force them into identical workflows.
Concrete provider-strength data, current routing baselines, and refresh inputs live in `coord/AGENT_CAPABILITY_REGISTRY.md`; this guide relies on that registry rather than restating the current Claude, Codex, and Gemini comparison here.

## Pick One Native Path Per Session

At session start, each agent should choose its native entry path and stay on that path for the duration of the session.

### Codex Native Path

Use this when the primary agent is Codex.

- Read `CODEX.md`, `AGENTS.md`, and `coord/GOVERNANCE.md`
- Prefer `coord/scripts/agent` for the six primary verbs
- Prefer the governance MCP server when available
- Fallback to `coord/scripts/gov ...` for raw governance commands
- Treat `.claude/commands/*` as Claude-specific wrappers, not Codex-native commands

Typical flow:

```bash
coord/scripts/agent next
coord/scripts/agent do <ticket-id>
```

Use the shared CLI or governance MCP for advanced, admin, repair, and explicit lifecycle commands such as `claim`, `explain`, `start`, `submit`, `land`, `doctor`, and related actions.

### Claude Native Path

Use this when the primary agent is Claude Code.

- Read `CLAUDE.md`
- Prefer `coord/scripts/agent` for the six primary verbs when shell usage is appropriate
- Use `.claude/commands/*` slash commands as the native UX layer
- Those commands still resolve to the same shared governance core

Typical flow:

```text
/initiate
/planner <ticket>
/code-writer <ticket>
```

### Gemini Native Path

Use this when the primary agent is Gemini.

- Read `GEMINI.md`, `AGENTS.md`, and `coord/GOVERNANCE.md`
- Prefer `coord/scripts/agent` for the six primary verbs
- Use the governance MCP server or `coord/scripts/gov ...`
- Do not assume Claude slash commands are Gemini-native

Typical flow:

```bash
coord/scripts/agent next
coord/scripts/agent do <ticket-id>
```

## Handoffs

Cross-agent handoff is allowed, but the handoff must be explicit.

Rules:
- the neutral facade now owns the basic operator workflow, and agent-native paths execute beneath it
- use `coord/scripts/gov resume <ticket-id>` when continuing the same ticket in a new clean session
- use `coord/scripts/gov claim <ticket-id> --transfer-to <owner> --human-admin-override "<reason>"` only for deliberate takeover or recovery
- do not mix multiple agent UX layers inside one active session unless the handoff is explicit and clean

## Practical Rule

Different agents may choose different native paths. They must still converge on the same shared governance state, the same facade contract, and the same recovery rules.
