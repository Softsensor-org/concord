# Concord Business Context

Status: canonical baseline
Updated: 2026-07-29

## Product intent

Concord is a repo-local execution governance layer for teams using coding agents
across one or more repositories. It binds product intent to isolated work,
evidence, review, landing, recovery, and durable knowledge so delivery does not
depend on a chat transcript or operator folklore.

It complements external trackers, requirements systems, git hosting, and CI. It
does not replace them.

## Users and outcomes

| User | Primary outcome |
| --- | --- |
| Human admin | Can authorize, stop, recover, review, and land agent work with an auditable trail. |
| Agent operator | Gets a deterministic next/start/resume/review/land path and actionable refusals. |
| Engineering or platform lead | Can evaluate throughput and control across a repo family without adopting a hosted control plane. |
| Security/GRC/procurement reviewer | Can inspect data boundaries, provenance, retention, and unsupported claims. |
| Product or business contributor | Can contribute requirements, decisions, and feedback through a governed actor/write boundary rather than direct file mutation. |

These roles come from `coord/product/REQUIREMENTS.md`; the human-write boundary
is decided in ADR 0003.

## Value chain

```text
intent / requirements
  -> governed ticket and mandate
  -> isolated implementation
  -> gates and structured review
  -> evidenced landing
  -> journaled closeout
  -> reusable, cited knowledge
```

The value is lost if any arrow is merely asserted. In particular, `done` must
mean landed, a green gate must name the tree it checked, and reusable knowledge
must cite an authoritative source.

## Operating boundary

Concord owns delivery-control state in `coord/`: board, prompts, plan evidence,
locks, journal, snapshots, recovery, knowledge promotion, and release integrity.
Application repos own runtime product behavior. `coord/project.config.js` is the
project-owned seam that declares those repositories and gates.

The default donor contains sample `backend/` and `frontend/` repos, but the
engine's purpose is adoption into arbitrary existing repo shapes. Assumptions
about file extensions, folder names, branches, or sibling layout must therefore
fail visibly or be configurable.

## Trust promises

Concord's useful promises are narrower than “AI work is correct”:

- one authoritative mutation path for shared governance state;
- one active owner/lease and protected execution context per doing ticket;
- explicit legal lifecycle transitions;
- evidence and provenance attached to review and closeout;
- detectable out-of-band state changes;
- bounded, auditable recovery;
- honest operator surfaces and release artifacts;
- source-backed memory that distinguishes observation from intent.

It cannot determine whether a self-review is intellectually strong, guarantee
cross-repo transactional rollback, or keep the system live when no operator or
orchestrator runs. Those limitations are documented in
`coord/GOVERNANCE.md` Section 11.1.

## Current product risks

The current risk is false assurance at boundaries: a board can say done before
Repo-X content lands; the cockpit can report health for a substituted directory;
an advertised remediation can be rejected by its parser; a successful import
can have discarded metadata; a donor build can invalidate its own install or
integrity path. `coord/product/CODE_REVIEW_BASELINE.md` is the current detailed
assessment.

## Knowledge policy

Business discovery is an advisory intake path, not authority. The 2026-07-29
baseline run over this governance repo produced mostly generic file facts and
several false domain-adapter matches. Curated documents in this directory are
therefore maintained from requirements, policy, ADRs, and verified source
behavior. Generated records may propose updates but must not overwrite this
baseline automatically.

## Non-goals

- replacing Jira, Linear, GitHub Issues, Azure DevOps, or requirements authoring;
- storing product runtime state in the governance repo;
- treating code as automatic proof of business intent;
- treating self-signed local evidence as independent certification;
- claiming hosted enterprise controls before they are implemented and verified.

## Authoritative sources

- `coord/product/REQUIREMENTS.md`
- `coord/product/ARCHITECTURE.md`
- `coord/GOVERNANCE.md`
- `coord/docs/decisions/0002-canonical-ephemeral-runtime-boundary.md`
- `coord/docs/decisions/0003-governed-human-writes-use-trusted-sso-actors-and-the-coord-verb-layer.md`
- `coord/docs/decisions/0004-precision-first-governed-memory-kernel.md`
