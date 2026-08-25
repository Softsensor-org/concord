# Concord Workflow Inventory

Status: canonical baseline
Updated: 2026-07-29

This inventory names the control-plane workflows, their authority boundaries,
and the proof that completes them. Command details remain normative in
`coord/GOVERNANCE.md`, `coord/scripts/README.md`, and generated CLI help.

## WF-001 — Cold start and governed retrieval

Trigger: an agent enters the workspace or resumes after context loss.

1. Read root and coord agent shims.
2. Resolve authority order from `coord/GOVERNANCE.md`.
3. Bind a live owner/session through `gov agentid` or the supported facade.
4. Inspect the ticket with `gov explain` and retrieve its prompt, plan,
   requirements, ADRs, recall, and business-context pack as applicable.
5. Record a plan before substantive mutation.

Proof: bound identity, ticket prompt, canonical plan record, and no unresolved
start-gate blockers.

## WF-002 — File, approve, and start work

Trigger: a verified gap or approved feature needs a governed unit of work.

1. File a ticket through a governed verb; proposed work remains quarantined
   until approved.
2. Ensure a specific prompt and dependency/relationship metadata exist.
3. Start from the configured base, create the isolated worktree/branch, acquire
   the ticket lock, and set the owner/status transactionally.
4. Re-read the canonical board under the mutation lock.

Proof: legal `todo -> doing` transition, one owner, complete lock, isolated
workspace, plan stub, journal event, and synced derived views.

## WF-003 — Implement and collect evidence

Trigger: a ticket is doing and unblocked.

1. Change only the ticket scope in its worktree.
2. Run the declared gate lane and targeted tests.
3. Record feature proofs, requirement closure, verification commands, and
   structured self-review cycles.
4. Commit with ticket affiliation and preserve the source commit.

Proof: clean scoped diff, passing declared gates, feature proofs resolving in
the tested tree, and complete closeout fields.

## WF-004 — Block, park, and resume

Trigger: work cannot safely advance because of a dependency or engine defect.

1. Record the reason through `gov block`; retain ownership and lock protection.
2. If the blocker is a related follow-up, use the governed closeout-blocker
   relation rather than bypassing WIP rules.
3. Keep the blocked marker until the condition is resolved.
4. Re-enter through resume/claim as supported, then run explicit `unblock`.

Proof: status remains `doing (blocked: reason)`, ownership artifacts are
preserved, the blocker is durable, and review remains impossible until unblock.

Current defect: recovery/resume/release/heartbeat semantics are inconsistent for
blocked-doing; see COORD-558 and `CODE_REVIEW_BASELINE.md`.

## WF-005 — Recover lifecycle invariants

Trigger: session, lock, worktree, board, or journal state is inconsistent.

1. Inspect with `gov explain`, ticket-scoped `gov doctor`, and `gov recover`.
2. Classify the status by operation role, not by one universal string predicate.
3. Preview or compute the repair plan under the runtime lock.
4. Apply only deterministic, non-destructive changes.
5. Verify postconditions and journal the repair.

Proof: fewer invariant violations, no loss of valid evidence, consistent
board/lock/session/worktree state, and an auditable recovery event.

## WF-006 — Review and land product-repo work

Trigger: implementation and evidence are complete.

1. Move plain doing to review; blocked work must unblock first.
2. Verify PR/base/commit evidence and required review cycles.
3. Merge through the configured landing path.
4. Reconcile external merge effects idempotently with the board transition.
5. Record canonical landed and source commits; remove the worktree.

Proof: reviewed content is an ancestor of the canonical base and board/journal
closeout references that exact content.

## WF-007 — Land Repo-X work

Trigger: governance/docs/engine work in a Repo-X worktree is ready.

Target workflow:

1. Verify the Repo-X source commit and scoped diff.
2. Integrate it into the canonical workspace branch or require explicit
   already-landed evidence.
3. Only then transition review to done and sync governance state.

Current defect: `gov land` can close before integration. Until COORD-512 lands,
do not treat its success text as branch-landing proof.

## WF-008 — Requirements import and traceability

Trigger: a project has a PRD, URS, specification, or direct requirements file.

1. Declare authoritative sources and stable IDs.
2. Parse explicit requirement headings and supported bullet metadata.
3. Validate metadata without silent coercion.
4. Produce the registry and link requirements to tickets/evidence.
5. Surface import findings and traceability gaps.

Proof: source path/anchor/block hash, stable IDs, lossless metadata or explicit
findings, and requirement-to-ticket-to-proof linkage.

Current defect: malformed/unknown metadata is silently normalized; see COORD-525.

## WF-009 — Business discovery and knowledge promotion

Trigger: an existing codebase needs a governed knowledge baseline.

1. Run deterministic discovery over declared repo roots.
2. Synthesize candidate documents and claims into scratch/derived output.
3. Reject noise, label inference, reconcile conflicts, and cite source evidence.
4. Promote only reviewed claims through the governed knowledge path.
5. Curate canonical product documents and context-pack eligibility.

Proof: source-backed claims with authority/status/confidence and explicit
dispositions for stale/conflicting/weak proposals.

Current constraint: discovery is path-pattern heavy and noisy; see COORD-550.

## WF-010 — Build and verify a public release

Trigger: a Community/Enterprise cut is prepared.

1. Build from a clean donor commit under the declared cut policy.
2. Apply confidentiality transformations.
3. Re-render and re-pin integrity artifacts against the final tree.
4. Verify install entrypoints, package contents, tests/gates, template sync,
   engine pin, privacy scans, and dual-release policy against the cut.
5. Publish only the verified artifact and record exact provenance.

Proof: reproducible cut, executable cold start, self-consistent manifest/pin,
passing release verifier, and published commit/tag/digest.

## WF-011 — Human-authored governed change

Trigger: a business user submits a requirement, decision, approval, or feedback.

1. Authenticate at the trusted SSO/OIDC edge.
2. Map claims to a governed human actor and board-scoped role.
3. Authorize deny-by-default.
4. Emit a governed verb envelope to the single writer.
5. Journal the attributed mutation and refresh views.

Proof: trusted actor attribution, authorized verb, serialized canonical write,
and no direct web-tier file mutation. Source: ADR 0003.
