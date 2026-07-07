# Policy Enforcement Matrix

Status terms:

- **enforced**: a command, validator, lifecycle check, or test blocks failure.
- **warning-first**: the system emits explicit guidance, but broad blocking is
  limited to high-risk cases.
- **advisory**: documented guidance or generated context, not a blocker.
- **design-only**: architectural intent without a shipped command path.
- **planned**: accepted roadmap item without implementation.

| Policy Surface | Status | Consuming Command/Gate/Test |
|---|---|---|
| Testing lanes and affected-target fallback | enforced | `coord/scripts/affected-targets.js`, `coord/scripts/gate-plan.js`, `coord/gates/affected-targets.json`, `node --test coord/scripts/affected-targets.test.js coord/scripts/gate-plan.test.js` |
| Gate-plan receipt | warning-first with high-risk blocking | `gov gate-plan <ticket> --write`, `collectGatePlanReadinessIssues` in review/closeout readiness |
| Multi-track gate procs | enforced where invoked | `content-gate.js`, `infra-gate.js`, `analytics-gate.js`, `data-contract-gate.js` |
| Track evidence policy | warning-first with risk-class blockers | `coord/gates/track-evidence-policy.json`, `track-evidence-policy.js`, gate-plan evidence issues |
| Server bootstrap/backfill high-risk declarations | enforced for declared high-risk classes | `track-evidence-policy.js`, `collectGatePlanReadinessIssues`, `bootstrap-via-live-mcp.js` bridge |
| Local bootstrap and harmless deploy bootstrap | advisory | `bootstrap_risk` plan metadata and gate-plan advisory output |
| Production/live-MCP operation-class policy | enforced when `live_mcp` is declared | `live-mcp-lifecycle.js`, `analytics-gate.js`, runtime evidence receipt validators |
| DevOps scaffold checks | enforced in infra gate | `infra-gate.js` config/header/workflow checks |
| Enterprise deployment hardening | opt-in enforced | `infra-gate.js --enterprise-required` or enterprise deployment receipt/config |
| Continuity profile | advisory / planned engine work | `coord/product/CONTINUITY_PROFILE.md`; durable commands remain roadmap unless separately implemented |
| Memory architecture | advisory with implemented recall pieces | `recall.js`, `prework-pack.js`, memory eval tests; memory does not decide lifecycle authority |
| Business discovery protocol | warning-first where context is cited | `business-discovery*.js`, `business-context-pack.js`, `collectBusinessContextGateIssues` |
| ADR / decision process | enforced for high-impact triggers | `gov adr`, `adr-validator.js`, ADR readiness collectors |
| Canonical vs derived authority | enforced by checker; policy applied in plan records | `coord authority-check`, `canonical-derived-authority.js`, COORD-373 pure read/explicit repair split |
| Requirements assurance | enforced in command-specific validators | `requirements-*` command family and tests |

## Documentation Rule

Docs may describe future capabilities, but any sentence that says "must",
"enforced", "blocks", or "required" should point to a command, validator, gate,
or lifecycle collector. Otherwise it should use "advisory", "planned", or
"design intent".
