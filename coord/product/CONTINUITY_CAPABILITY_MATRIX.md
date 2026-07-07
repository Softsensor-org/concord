# Continuity Capability Matrix

Status: Phase 0 adoption map
Owner surface: `coord/product/`
Related docs:
- `coord/GOVERNANCE.md`
- `coord/product/CONTINUITY_PROFILE.md`
- `coord/docs/MEMORY_ARCHITECTURE.md`
- `coord/product/BUSINESS_DISCOVERY_PROTOCOL.md`
- `coord/docs/MULTI_AGENT_TOPOLOGIES.md`
- `coord/docs/decisions/README.md`

## Purpose

This matrix separates what Concord can do immediately from what is documented
design, filed backlog, or still an execution gap. It is intentionally
conservative: existing board, journal, plan, context-pack, recall, ADR,
business-discovery, and identity surfaces are useful today, but they are not the
full continuity overlay.

Use this document when adopting Concord before the full continuity layer exists.
It prevents teams from mistaking future continuity objects for current product
behavior.

## MVP Adoption Path

The honest MVP path is:

1. Use the enforced governance substrate now: board rows, prompts, locks,
   `gov explain`, plan records, review cycles, repo gates, feature proofs,
   `QUESTIONS.md`, ADRs, identity binding, and the hash-chained journal.
2. Add advisory retrieval where useful: `gov context-pack`, `gov prework`,
   `gov recall`, `coord/scripts/coord business-discovery`, and
   `business-context-pack`. Treat every output as cited context, not authority.
3. Record durable handoff in existing artifacts: plan updates, review cycles,
   closeout evidence, ADR links/proposals, memory-claim proposals, questions,
   decisions, reflections, and business-context references.
4. Defer promises that need new continuity artifacts: daily journals,
   warm-start/cold-finish records, cadence/cursor records, promotion/demotion
   indexes, durability sweeps, shared/team/private memory scope controls, and
   multi-human attribution fields.

## Current Vs Incremental Capabilities

| Area | Implemented substrate usable now | Documented design | Filed backlog | Missing execution gap | Immediate MVP use |
| --- | --- | --- | --- | --- | --- |
| Agent boot and retrieval | Thin shims, `coord/GOVERNANCE.md` precedence, `gov explain`, prompts, board rows, plan records, repo guides, context-pack/prework references. | Cold-start contract in governance and multi-agent docs: chat memory is non-authoritative; retrieve minimum governed context before planning. | COORD-326 is done; COORD-338 will compose an MVP warm-start/cold-finish path from existing artifacts. | No first-class `gov warm-start` artifact yet; agents still assemble the read set manually. | Start from `AGENTS.md`, tool shim, `gov explain <ticket>`, prompt, plan/prework/context-pack, ADRs, requirements, discovery packs, and repo-local guides. |
| Identity and ownership | `gov agentid --assign`, provider session resolution, `COORD_SESSION_ID`, owner-bound locks, registered/bound-owner mutation guard, resume/rebind/takeover paths. | Identity v2 and collision recovery docs define provider/session precedence and recovery semantics. | COORD-339 adds multi-human/multi-agent attribution fields for continuity records. | Current identity proves agent/session ownership, not human/team sponsorship across shared memory records. | Require each agent to bind identity before mutation; use `COORD_SESSION_ID` for sub-agents sharing provider identity. |
| Board, journal, and plans | Canonical board, append-only hash-chained governance journal, runtime locks, plan records, review cycles, repo gates, feature proofs, closeout evidence. | Governance defines these as authoritative operational continuity. | COORD-340 will add continuity write-safety primitives for new shared continuity indexes/cursors. | Existing artifacts do not provide daily scratch continuity, cadence cursors, or stale-context compare-and-swap for future continuity records. | Use board/journal/plans as the source of truth. Do not create parallel status in chat or derived memory. |
| Memory and recall | Decision extraction, deterministic recall over governed corpus, `gov recall`, `gov prework`, `gov insights`, `gov closeout-summary`, claim compiler, context-pack commands. | `MEMORY_ARCHITECTURE.md` defines recommend-only, source-cited governed memory; derived views are rebuildable. | COORD-337 defines shared/private scope; COORD-345 to COORD-348 cover inspection, privacy tests, rebuild/export, and context-pack usage enforcement. | Permission-scoped shared/team/private memory controls and enforcement are incomplete; derived indexes are not the authority. | Use recall/prework as advisory cited leads. Verify against sources before treating a claim as policy, requirement, ADR, or business truth. |
| ADR and decision records | `coord/docs/decisions/`, `coord/scripts/coord adr-validate --json`, `gov adr list/show/check/new/link/supersede`, plan `adr_refs`, ADR readiness checks for high-impact work. | ADR docs define required/optional triggers, statuses, links, waivers, and supersession. | COORD-325 to COORD-332 cover ADR process hardening; continuity tickets add decision objects and warm-start surfacing. | Lightweight operational decision objects are not first-class continuity artifacts yet. | Use ADRs for high-impact architecture, security, data, memory authority, or agent-protocol choices; use plan/QUESTIONS for lower-impact decisions. |
| Business discovery | Product CLI for discovery, synthesis, and `business-context-pack`; schema and protocol; derived runtime artifacts; behavior-change gate guidance. | Business discovery protocol separates observed/inferred/confirmed facts and routes promotion through requirements, ADRs, memory, tickets, or questions. | COORD-301 to COORD-311 cover adaptive discovery and existing-repo discovery protocol expansion. | Discovery outputs are derived and advisory; promotion workflow and cockpit/readout integration are not a substitute for human acceptance. | Generate discovery/context packs for behavior-changing work, cite them in plans, and record approval, waiver, or investigation status before closeout. |
| Continuity objects | Existing plan records, repo gates, feature proofs, review cycles, questions, ADR links, memory-claim proposals, business-context refs, and closeout summaries can carry handoff residue. | `CONTINUITY_PROFILE.md` defines daily journal, warm-start, cold-finish, decision object, cadence/cursor, promotion candidate, and durability sweep boundaries. | COORD-327 is done; COORD-328 to COORD-335 and COORD-338 to COORD-342 implement templates, journals, decisions, cursors, promotion, readout, attribution, safety, backfill, and rollout. | No canonical daily journal, warm-start/cold-finish record, cadence/cursor schema, durability sweep command, or continuity readout exists yet. | Use existing artifacts for handoff now; label missing daily/cadence/promotion surfaces as backlog, not current capability. |
| Multi-agent teamwork | Distinct provider sessions, explicit `COORD_SESSION_ID`, registered handles, per-ticket locks/worktrees/branches, owner-bound mutation guard, same-owner resume, rebind, takeover. | `MULTI_AGENT_TOPOLOGIES.md` defines independent sessions and orchestrator/sub-agent topology. | COORD-339 and COORD-342 add multi-human attribution and team rollout guidance. | Shared continuity memory does not yet model human sponsor, team, project, private notes, or shared scope. | Run many agents through governed identity and isolated worktrees; serialize shared checkout/runtime writes; keep human/team memory claims out of authority until scope controls exist. |
| Privacy, sensitivity, and safety | Claim compiler rejects unsafe claims; discovery and memory docs require source citations, sensitivity labels, redaction, and secret-prohibited exclusion from active context. | Continuity profile defines conservative retention, classification, and non-surveillance stance. | COORD-337, COORD-345, and COORD-346 cover scope model, inspection/removal controls, and privacy enforcement tests. | No complete shared/team/private recall enforcement across warm-start, cold-finish, continuity readouts, and export/backfill yet. | Keep sensitive bodies out of shared artifacts; store pointers/hashes where possible; treat private notes as non-governing unless promoted through governed shared paths. |

## Adoption Boundary

Teams can adopt the MVP now if they are comfortable with a manual but governed
handoff flow: agents read the existing sources, cite advisory packs, and write
learning back into current governed artifacts.

Teams should not claim the full continuity overlay until the missing artifacts
exist and are enforced. In particular, do not promise automated daily journals,
cadence cursor advancement, shared/team/private memory policy, continuity
durability sweeps, stale warm-start compare-and-swap, or multi-human memory
attribution as current behavior.

The product claim today is narrower and stronger: Concord already has an
auditable governance substrate that supports cold-start recovery from governed
artifacts. The continuity overlay will make that recovery easier, more
structured, and safer across teams.
