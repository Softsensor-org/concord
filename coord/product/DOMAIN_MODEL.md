# Concord Domain Model

Status: canonical baseline
Updated: 2026-07-29
Governing ticket: COORD-590

## Purpose

Concord is a repo-local governed execution control plane. Its domain is not the
application being built; its domain is the trustworthy conversion of product
intent into isolated work, evidence, review, landing, and durable operational
memory.

## Core entities

### Workspace

The project root containing the governance repo and zero or more product repos.
It defines the boundary within which configuration, paths, and cockpit reads
are meaningful.

Invariant: a configured repo that cannot be resolved inside an approved
workspace boundary is an explicit error or unavailable repo. It must never be
silently replaced by a different directory.

### Repository Registration

A `coord/project.config.js` entry that maps a repo code to its path,
integration branch, optional start base, origin metadata, ticket prefixes, and
gate command. `X` is reserved for coord/cross-repo work.

### Ticket

The unit of governed work stored in `coord/board/tasks.json`. Important fields
include ID, repo, type, priority, status, owner, dependencies, prompt, review,
and landing evidence.

Legal lifecycle:

```text
todo -> doing -> review -> done
          |        |
          v        v
doing (blocked)   doing
          |
          v
        doing

todo <-> deferred
any -> superseded
```

`superseded` means obsolete, not landed. Completed work must close through
review/done even when the state machine itself needs repair.

### Owner Lease and Agent Session

An owner lease is the durable authority identity for a ticket. An agent session
binds a live conversation/process to that owner for continuity and liveness.
Session IDs are not ownership authority.

Invariant: releasing or expiring a session must not orphan tickets silently.
The operation must refuse, transfer ownership atomically, or preserve a
recoverable binding.

### Ticket Lock

Ephemeral runtime evidence that a doing-form ticket has one active owner and an
isolated execution location. It carries owner, ticket, repo, branch, worktree,
timestamps, and head evidence.

Invariants:

- every doing-form ticket has exactly one valid canonical lock;
- non-doing tickets have no active ticket lock;
- lock repair is non-destructive and monotonic;
- deleting a lock for active work requires an explicit, correctly classified
  administrative override.

### Worktree and Branch

The isolated implementation context for a ticket. Product-repo tickets use
repo-local worktrees. Repo-X work is also isolated, but its canonical governance
mutations must be performed from the integration tree under ADR 0002.

Invariant: `done` implies that the reviewed implementation is present on the
declared canonical base and has landed evidence. A closed board row without the
branch content is invalid.

### Prompt and Mandate

The ticket-scoped instruction and retrieved context that define assignment,
scope, likely files, verification, and stop conditions. A prompt narrows work;
it cannot override higher governance authority.

### Plan Record

Canonical structured evidence for planning and closeout: intended files,
change summary, invariants, gates, feature proofs, requirement closure,
self-review cycles, ADR references, questions, and context-pack acknowledgement.

Invariant: writer validation, runtime validation, JSON Schema, compatibility
rendering, and gate consumption must accept the same data model.

### Requirement and Requirement Link

A stable intent statement imported from or authored in a requirements source.
A requirement link connects intent to tickets, evidence, review, and closeout.

Invariant: unknown or malformed metadata is not silently coerced into reassuring
defaults. Imports either preserve the declared meaning or report the precise
loss.

### Gate Plan, Gate Run, and Evidence

A gate plan states which checks must prove a ticket. A gate run is an execution
against a specific tree/commit. Evidence records the command, result, and
provenance used at review and landing.

Invariant: evidence may certify only the tree it actually tested.

### Review Cycle and Finding

A structured inspection of contract/state invariants, security/failure modes,
tests/operability/performance, and requirement closure. Findings have severity,
evidence, disposition, and follow-up ownership.

### Landing Record

The proof that reviewed work reached the canonical base: PR, merge commit,
source commit, or an explicit no-PR/already-landed exception.

Invariant: external landing side effects and board transitions are reconciled
idempotently; neither may imply the other without proof.

### Journal Event and Governance Snapshot

The append-only audit event and content-addressed snapshot of governed state.
Together they detect out-of-band mutation, preserve recovery context, and bind
state transitions to evidence.

### Context Pack, Candidate Claim, and Governed Claim

A context pack is a ticket-scoped cited retrieval bundle. Candidate claims are
extractor proposals. Governed claims are reviewed, source-backed, status-aware
knowledge eligible for reuse.

Invariant: generated or implementation-derived observations do not become
business authority without promotion and appropriate source authority.

### Release Artifact, Template Manifest, and Engine Pin

A release artifact is a built Community or Enterprise tree. The template
manifest proves internal template consistency; the engine pin proves drift
against an intentionally frozen engine surface.

Invariant: build-time scrubbing or transformation must re-establish every
integrity surface against the final built tree before publication.

## Aggregate boundaries

| Aggregate | Owns | Must coordinate with |
| --- | --- | --- |
| Ticket lifecycle | ticket row, owner, lock, plan lifecycle fields | journal, worktree, session |
| Governance transaction | canonical file snapshot, mutation, journal event | board renderer, external side effects |
| Requirements assurance | source registry, requirements, links, findings | tickets, evidence, cockpit |
| Knowledge kernel | candidates, claims, evidence, conflicts, packs | ADRs, requirements, tickets |
| Release | donor input, cut policy, manifest, pin, artifact verification | install paths, package metadata |

## Status semantics by role

String form alone is not enough to choose behavior.

| Predicate | Plain doing | Blocked doing | Review |
| --- | ---: | ---: | ---: |
| Holds active ownership | yes | yes | policy-dependent lease continuation |
| Requires lock protection | yes | yes | no active doing lock |
| May heartbeat/recover context | yes | yes | resume/review path only |
| May advance to review | yes | no | n/a |
| May unblock | no | yes | no |

Named role predicates should implement this matrix. `isDoingStatus()` is useful
for ownership classification, but is not the universal transition predicate.

## Canonical, derived, and ephemeral state

| Class | Examples | Rule |
| --- | --- | --- |
| Canonical tracked | board, product docs, prompts, journal, snapshots, canonical plan records | mutate only through governed ownership paths |
| Derived | rendered task/prompt/plan views, discovery synthesis, reports | regenerate; never treat a hand edit as authority |
| Ephemeral | locks, sessions, worktrees, process registries | rebuildable, but loss must not destroy canonical meaning |

See `coord/DIRECTORY.md` and ADR 0002 for the normative boundary.

## Ubiquitous language

- **Governed**: mutated through the authoritative verb/transaction path and
  recorded with provenance.
- **Doing-form**: plain `doing` or `doing (blocked: <reason>)` when ownership
  semantics are being evaluated.
- **Blocked**: active work intentionally prevented from advancing; not retired.
- **Landed**: present on the canonical base with verifiable provenance.
- **Promoted claim**: candidate knowledge accepted through governed review.
- **Closeout**: evidence-backed transition from implementation through review
  to done.
- **Recovery**: a bounded operation that restores invariants without erasing
  valid state or history.

## Source map

- Lifecycle and authority: `coord/GOVERNANCE.md`
- State buckets: `coord/DIRECTORY.md`
- Architecture: `coord/product/ARCHITECTURE.md`
- Requirements: `coord/product/REQUIREMENTS.md`
- ADRs: `coord/docs/decisions/`
- Implementation map: `coord/scripts/README.md` and
  `coord/GOVERNANCE_ARCHITECTURE.md`
