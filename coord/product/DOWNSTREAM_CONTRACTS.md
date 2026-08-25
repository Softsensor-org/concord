# Concord Downstream Contracts

Status: canonical baseline
Updated: 2026-07-29

## Contract map

| Contract | Provider | Consumers | Compatibility rule |
| --- | --- | --- | --- |
| Governance policy | `coord/GOVERNANCE.md` | agents, CLI, MCP, cockpit, CI | Higher-authority policy wins; implementation must enforce documented legal transitions. |
| Board schema/state | `coord/board/tasks.schema.json`, `tasks.json` | lifecycle, renderer, cockpit, reporting | Writers validate before persistence; derived views do not invent state. |
| Plan schema/state | `coord/board/plan.schema.json`, canonical plan records | gates, closeout, cockpit, compatibility `PLAN.md` | Schema, writer, runtime validator, renderer, and gate readers accept the same shape. |
| Repo registry | `coord/project.config.js`, `coord/paths.js` | worktrees, git, gates, cockpit, requirements | Unknown/out-of-bound paths fail visibly; no silent directory substitution. |
| Neutral verb surface | `coord/VERB_CONTRACT.md`, command registry | agent facade, humans, wrappers | Facade orchestrates; core owns lifecycle semantics. |
| CLI command contract | command/flag/value schemas | `gov`, help, emitted remediation, tests | One machine source; every documented command parses. |
| MCP tool contract | governance MCP server | Codex, Claude, Gemini, other MCP clients | JSON-RPC and negotiated MCP lifecycle over specification-compliant transport; stdout purity. |
| Journal/snapshot contract | `journal.js`, state IO | doctor, conform, recovery, sync | Append-only hash chain, durable writes, explicit repair markers, fail-closed provenance. |
| Owner/lock contract | governance session and lock services | lifecycle, recovery, orchestrator, MCP heartbeat | Owner lease is authority; doing-form work retains one protected canonical lock. |
| Requirements registry | `REQUIREMENTS_REGISTRY_SCHEMA.md`, importer | traceability, gates, cockpit, review packs | Stable IDs and source hashes; malformed input is an explicit finding/error. |
| Knowledge claims | ADR 0004, memory/discovery protocols | context packs, planners, reviewers | Retrieval is advisory; only eligible promoted claims constrain work. |
| Gate evidence | gate plans/runs and feature proofs | review, land, conform | Evidence binds to the tested commit/tree and named command/lane. |
| Cockpit read model | coord-ui models/routes | human operators | Read-only by default; display provenance and uncertainty, never substitute plausible data. |
| Release artifact | release builders/verifiers | installers, npm/binary users, downstream projects | Verify final transformed bytes; every advertised entrypoint exists in the cut. |
| Template sync / engine pin | manifest and pin files | downstream upgrades, release validation | Intentional engine changes update both integrity surfaces; downstream drift is detectable. |

## CLI and help

The public contract includes command names, aliases, positional arguments,
flags, JSON field names, accepted enum literals, defaults, mutation/read-only
classification, exit behavior, and remediation text. Human help and MCP schemas
are renderings of that contract, not separately maintained specifications.

Current gap: COORD-572.

## MCP transport

The governance MCP server is a typed adapter over the same lifecycle core. It
must complete initialize, initialized notification handling, tool discovery,
and calls using standard newline-delimited UTF-8 JSON-RPC on stdio (or an
official SDK transport). Logging belongs on stderr and no non-protocol text may
reach stdout.

Implemented: newline-delimited UTF-8 JSON-RPC framing with spawned-server
interoperability smokes (COORD-482 closed the prior `Content-Length` gap).
Claude project approval of the MCP server remains a separate concern from
transport/initialization success — see `coord/scripts/README.md` (Startup
Notes) for the troubleshooting split.

## Board, plans, and derived views

`coord/board/tasks.json`, the governed journal/snapshots, and canonical plan
records are authority surfaces. Rendered task/prompt/plan documents and cockpit
models are read projections. A projection may summarize or normalize only when
it preserves every legal status and communicates hidden/unavailable rows.

Current plan parity gap: COORD-571. Current cockpit truth gap: COORD-543.

## Product repo contract

Each registered repo exposes:

- repo code and absolute resolved root;
- integration/start base policy;
- ticket-prefix mapping;
- gate command and lanes;
- optional cross-repo contract source/generated paths.

Concord may coordinate those repos but cannot move product behavior into
`coord/`. Backend/frontend ownership in the donor is a default, not a universal
topology.

## External services

| External system | Allowed role | Required evidence/failure behavior |
| --- | --- | --- |
| Git | branch/worktree/commit authority | Exact source and landed commits; conflicts leave board state unadvanced. |
| GitHub | PR metadata and merge side effect | Verify URL/repo/base/head; journal successful side effects and retry idempotently. |
| CI | independent gate executor | Run repository/release contracts against named commits; absence of CI must not be presented as automated assurance. |
| OIDC/SSO | trusted human identity source | Claims are verified at the edge and mapped to deny-by-default roles. |
| Public registry/release host | artifact distribution | Published bytes match verified cut provenance. |

## Compatibility rules

1. Existing downstream config seams are preserved when engine internals change.
2. Aliases are supported only when they map unambiguously to one canonical verb.
3. Legacy state readers may migrate data, but new writes use the current schema.
4. A compatibility fallback must never silently replace one authority object
   with a different object merely to return a plausible result.
5. Breaking contract changes require an ADR or explicit migration decision and
     tests for both donor and downstream artifact behavior.
