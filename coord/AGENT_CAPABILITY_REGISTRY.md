# Agent Capability Registry

Version: 1.0-template
Updated: 2026-04-14

Status: canonical schema and starter registry

Layer label: `data-file`

Use this file for:
- current capability data and routing evidence
- local-environment scan results
- comparative-strength refresh inputs and starter registry rows

This file informs dispatch. It does not define enforcement policy or target-state architecture.

## Purpose

This registry captures the current comparative strengths of the available agent ecosystems so governance can route work intelligently instead of treating all agents as interchangeable.

The aim is not "multi-agent for its own sake." The aim is to draw the best from each agent family when a ticket would benefit from it.

Review status:

- Local environment reviewed: `2026-04-13`
- Official ecosystem reviewed: `2026-04-13`

## Canonical Registry Shape

This file is the canonical schema for comparative-strength routing in the template. A valid registry revision keeps these blocks in sync:

1. metadata header
2. evidence inputs and refresh triggers
3. declared capability-key enum
4. starter registry rows for each shipped agent family
5. routing matrix derived from those starter rows

Each starter registry row must provide these fields:

- `agent`
- `native_path`
- `capability_keys`
- `current_template_strengths`
- `current_template_risks_costs`
- `local_tools_present`
- `evidence_basis`
- `default_routing_notes`

Derived projects may add project-local evidence, but they should preserve the required row fields and capability-key enum unless a governed schema change explicitly updates both.

## Declared Capability Key Enum

Only these capability keys are canonical in this file today:

| Capability key | Meaning |
|---|---|
| `design_workflow_audit` | Design-heavy architecture, workflow definition, audit framing, and review-oriented planning |
| `implementation_runtime` | Shell-driven implementation, runtime edits, and mechanical repo work |
| `research_synthesis` | Broad document comparison, research-heavy synthesis, and large-context reads |
| `governance_repair` | Board, lock, session, and governance-runtime diagnostics or repair work |
| `wrapper_surface_design` | Wrapper UX, command-surface parity, and operator-path design |
| `seo_data_ingestion` | Workflow-pack domain capability for parsing audit exports and normalizing URL rows |
| `seo_strategy_triage` | Workflow-pack domain capability for separating current commercial SEO work from expected utility noise |
| `seo_content_strategy` | Workflow-pack domain capability for improving page usefulness, intent fit, and internal link strategy |
| `commerce_admin_ops` | Workflow-pack domain capability for safe commerce-admin reads/writes with before/read-back/live evidence |
| `theme_seo_runtime` | Workflow-pack domain capability for theme/runtime SEO code changes routed through the product repo |
| `live_seo_qa` | Workflow-pack domain capability for verifying rendered HTML, indexability, metadata, schema, and links |
| `browser_search_console_ops` | Workflow-pack domain capability for browser/tool-mediated URL inspection and recrawl request work |
| `analytics_monitoring` | Workflow-pack domain capability for monitoring movement after fixes and comparing fresh analytics/export evidence |

If a new key is needed, update the enum, the starter rows, and the routing matrix in the same governed change. Do not smuggle a new key into prose without declaring it here.

Workflow-pack domain keys are requirements that a project may attach to tickets.
The template does not claim that every shipped agent family has those domain
skills by default. A derived project should add project-local evidence rows when
it has proved which operators or agents can satisfy them.

## What The Registry Tracks

For each agent family, record:

- native entry path
- available local tools
- MCP coverage
- wrappers, skills, plugins, or subagent support
- research and context strengths
- known failure modes or operational costs
- current routing guidance by ticket profile
- evidence from project-local outcomes

## Inputs

### 1. Local Environment Scan

Capture what is actually available in the current project environment:

- installed MCP servers
- available wrappers and slash commands
- available skills and plugins
- shell and sandbox limits
- browser or headless tooling
- repo-local helper scripts and gate runners

### 2. Official Ecosystem Scan

Capture material changes from official vendor surfaces:

- Claude / Anthropic docs and releases
- Codex / OpenAI docs and releases
- Gemini / Google docs and releases

This is not a marketing feed. Only record changes that materially affect dispatch or operator workflow.

### 3. Project-Local Outcome Evidence

Capture what actually happens in the project:

- land success and repair rate
- review quality
- gate quality
- ticket class fit
- recovery friction

`TODO(phase-4)`: once the template records normalized per-agent outcome metrics, add a durable starter evidence block here for landed-ticket and repair-history data instead of only describing the evidence class.

## Refresh Triggers

Refresh this registry when:

- a major tool or MCP integration is added or removed
- a provider materially changes capabilities
- repeated ticket outcomes show the current routing assumptions are wrong
- governance wrapper design changes the effective tool surface

## Update Contract

Use this table as the canonical edit contract for the registry.

| Change type | Who may propose it | Required evidence | Approving owner |
|---|---|---|---|
| Refresh an existing starter row | Any governed agent working an explicit registry, sync, or policy-maintenance ticket | Updated local-path evidence and/or official-source notes with refreshed review date | Owner of the explicit registry or sync ticket recorded in `coord/board/tasks.json` |
| Add or remove a capability key | Owner of the explicit registry or policy ticket, or a delegated agent working inside that ticket | Why the current enum is insufficient, updated starter rows, and updated routing matrix in the same change | Owner of the explicit registry or policy ticket recorded in `coord/board/tasks.json` |
| Change default routing guidance | Any governed agent on an explicit routing or policy ticket | Local tool-surface evidence plus official-vendor or project-outcome evidence showing the old route is no longer the best default | Owner of the explicit routing or policy ticket recorded in `coord/board/tasks.json` |
| Add project-local outcome claims | Any governed agent with landed-ticket or review evidence on an explicit registry/evidence ticket | Concrete ticket IDs, findings, or repair history; avoid anecdotal claims without traceable evidence | Owner of the explicit registry or evidence ticket recorded in `coord/board/tasks.json` |

Resolve the approving owner mechanically through the governed ticket that carries the registry change. In template operations, use `coord/scripts/gov ticket <ticket-id>` or `coord/board/tasks.json` rather than free-text maintainer labels.

Additional contract rules:

- Do not add session-only tools, personal plugins, or unshipped local customizations to the template starter rows.
- Do not claim runtime enforcement or automation that the shared governance core does not implement today.
- Schema and enum changes are data-contract changes, not casual prose edits; route them through governed review even when the file itself is Markdown.

## Dispatch Rule

Governance should route tickets using:

1. ticket profile
2. local environment availability
3. current official ecosystem capability
4. project-local outcome evidence

Human override remains allowed, but the system should have a default strategy that is explicit and reviewable.

## Current Template Environment Snapshot

This section records what `coord-template` itself ships today. Do not substitute session-only tools or personal plugins here.

### Shared Governance Surfaces

- Thin neutral facade: `coord/scripts/agent`
- Raw governance CLI: `coord/scripts/gov`
- Governance MCP server: `coord/scripts/governance-mcp.js`
- Governance runtime: `coord/scripts/governance.js`
- Shared MCP config in `.mcp.json`:
  - `governance`
  - `codetree`
  - `sentry` (configured surface; credentials are placeholders by default)
  - `datadog` (configured surface; credentials are placeholders by default)

### Claude Surface

- Present:
  - `CLAUDE.md`
  - `.claude/commands/*.md` (18 command files)
  - `.claude/settings.json`
  - `.claude/skills/*` (5 starter skills)
- Not currently present in the template scaffold:
  - `.claude/agents/*.md`

### Codex Surface

- Present:
  - `CODEX.md`
  - `coord/scripts/agent`
  - `coord/scripts/gov`
  - governance MCP via `.mcp.json`
- Not currently present in the template scaffold:
  - `plugins/governance/`
  - project-local Codex command/plugin pack

### Gemini Surface

- Present:
  - `GEMINI.md`
  - `coord/scripts/agent`
  - `coord/scripts/gov`
  - governance MCP via `.mcp.json`
- Not currently present in the template scaffold:
  - repo-native Gemini wrapper layer beyond the root shim

## Official Ecosystem Notes

Only material, primary-source capability notes belong here.

Reviewed on `2026-04-13`:

- Claude Code official docs say Claude supports project/user subagents with separate context windows and tool scoping, and MCP integration with local/project/user scope plus MCP prompts as slash commands.
  - Sources:
    - https://docs.anthropic.com/en/docs/claude-code/sub-agents
    - https://docs.anthropic.com/en/docs/claude-code/mcp
- OpenAI official docs say Codex supports MCP configuration in the CLI/IDE and OpenAI’s docs MCP server, and OpenAI’s Codex product supports background parallel cloud delegation.
  - Sources:
    - https://platform.openai.com/docs/docs-mcp
    - https://platform.openai.com/docs/codex
- Google official docs say Gemini CLI is a terminal agent using a ReAct loop with built-in tools plus local or remote MCP servers, and Google documents web search / fetch and MCP as first-class parts of the CLI surface.
  - Sources:
    - https://cloud.google.com/gemini/docs/codeassist/gemini-cli
    - https://github.com/google-gemini/gemini-cli

## Current Routing Matrix

This is the current template baseline for comparative-strength dispatch.

| Capability key | Ticket profile | Default route | Why | Fallbacks / limits |
|---|---|---|---|---|
| `design_workflow_audit` | Design-heavy architecture, workflow definition, audit framing | Claude | Template ships the richest native wrapper layer under `.claude/commands/*`, plus starter skills and settings | If Claude-specific wrappers are unavailable or drifted, fall back to the neutral facade and shared governance CLI/MCP |
| `implementation_runtime` | Implementation-heavy repo work, shell-driven refactors, governance runtime edits | Codex | Template already exposes a strong terminal-native path through `CODEX.md`, `coord/scripts/agent`, `coord/scripts/gov`, and governance MCP | Do not assume a project Codex plugin exists; it does not ship in the template today |
| `research_synthesis` | Large document comparison, research-heavy synthesis, broad context reads | Gemini | Official Gemini CLI emphasizes large-context and research-friendly terminal workflows with MCP, web search, and web fetch | Template does not ship a Gemini-native wrapper layer beyond `GEMINI.md`; use the neutral facade and shared governance surfaces |
| `governance_repair` | Governance repair, board inspection, lock/session diagnostics | Current active agent via `coord/scripts/agent` or `coord/scripts/gov` | The critical capability here is the shared governance core, not provider-native UX | Bias toward the most direct CLI/MCP path; do not force multi-agent routing for repair work |
| `wrapper_surface_design` | Wrapper-parity or tool-surface design changes | Claude | Claude is the template default when the work is deciding wrapper/command UX and operator-path design | Use Codex when the wrapper change is primarily shared CLI/runtime implementation after the UX contract is settled; keep native ecosystems separate and converge only through the governed core |
| `seo_data_ingestion` | Site SEO audit/source ingestion | Project-local capable operator or agent | Requires source-system and URL-normalization knowledge beyond the template baseline | Require source freshness evidence and register updates |
| `seo_strategy_triage` | Site SEO issue classification and prioritization | Project-local capable operator or agent | Requires business/site context and expected-noise policy judgment | Require expected-noise and commercial-priority evidence |
| `seo_content_strategy` | Content quality and internal-link batches | Project-local capable operator or agent | Requires search-intent and content judgment beyond generic implementation | Require before/after evidence and monitoring state |
| `commerce_admin_ops` | Commerce-admin SEO edits, redirects, metadata, or content fields | Human-approved project-local operator | May mutate a live business platform | Require before snapshot, dry-run/read-back where available, live verification, and rollback note |
| `theme_seo_runtime` | Theme/template/runtime SEO fixes | Development-track capable agent/operator | Code changes must use the product repo lifecycle, not coord notes | Require repo ticket, QA, commit, deploy decision, and live verification |
| `live_seo_qa` | Live URL checks, rendered metadata, schema, links, robots/canonical | Project-local capable operator or agent | Browser and network access vary by environment | Require timestamped live evidence and caveats |
| `browser_search_console_ops` | URL inspection or recrawl request work | Human-approved browser/tool operator | Logged-in tools and browser sessions are local and permission-sensitive | Record requested vs blocked-browser status and next check date |
| `analytics_monitoring` | Fresh-export movement review and business decision support | Project-local analytics-capable operator or agent | Requires source-of-truth and reconciliation judgment | Require reconciliation labels, raw evidence path, and decision supported/blocked |

## Fallback Rules

- Route by the best currently available surface, not by hypothetical future tooling.
- If the required local wrapper or plugin is absent in the template, do not route as if it exists.
- The neutral facade and governance core are the compatibility floor for all three agent families.
- Multi-agent execution is optional. Use one agent when one agent is enough.
- Human override is always allowed, but the override should be explicit when it departs from the default routing matrix.

## Starter Registry Rows

| Agent | Native Path | Capability Keys | Current Template Strengths | Current Template Risks / Costs | Local Tools Present? | Evidence Basis | Default Routing Notes |
|------|-------------|-----------------|----------------------------|--------------------------------|----------------------|----------------|-----------------------|
| Claude | `CLAUDE.md` + `.claude/commands/*` | `design_workflow_audit`, `wrapper_surface_design` | Richest repo-native wrapper layer, guided flows, starter skill pack, strong design/review shell | Wrapper drift can hide governance truth if slash commands diverge from shared core behavior | Yes: `CLAUDE.md`, 18 command files, `.claude/settings.json`, 5 starter skills, shared MCP config | Template-local wrapper inventory plus Anthropic subagent/MCP docs reviewed `2026-04-13` | Prefer for design-heavy, review-heavy, and wrapper-centric tickets |
| Codex | `CODEX.md` + `coord/scripts/agent` / governance MCP / CLI | `implementation_runtime`, `governance_repair`, `wrapper_surface_design` | Direct terminal-native flow, thin facade, strong fit for runtime and repo-mechanical work | No project-local Codex plugin is shipped in the template today; do not assume one | Yes: `CODEX.md`, `coord/scripts/agent`, `coord/scripts/gov`, governance MCP, shared MCP config | Template-local CLI/MCP inventory plus OpenAI Codex/MCP docs reviewed `2026-04-13` | Prefer for implementation-heavy and runtime-oriented tickets; for wrapper-surface work, use as the implementation fallback after the default Claude-side UX contract is set |
| Gemini | `GEMINI.md` + `coord/scripts/agent` / governance MCP / CLI | `research_synthesis` | Strong large-context and research-oriented official CLI surface, clean fit for comparative reads and synthesis | Template does not ship a native Gemini wrapper layer beyond the root shim | Yes: `GEMINI.md`, `coord/scripts/agent`, `coord/scripts/gov`, governance MCP, shared MCP config | Template-local neutral-surface inventory plus Google Gemini CLI docs reviewed `2026-04-13` | Prefer for research-heavy, synthesis-heavy, or broad document-comparison tickets |

These rows are the template baseline, not final per-project truth. Derived projects should refine them with project-local evidence instead of replacing the registry structure.

## Practical Rule

If only one agent is needed, choose the best one. If multiple agents help, keep governance unified and agent-native execution separate.
