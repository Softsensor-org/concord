# ADR 0018: Independent reviews are commit-bound plan evidence

- **Status:** Accepted
- **Ticket:** COORD-718
- **Date:** 2026-10-22
- **Linked scope:** canonical ticket plans, independent-review writer and evidence projections.

## Context

Independent reviews need reviewer identity and an immutable reviewed commit. Owner self-review cycles cannot represent an independent reviewer, and QUESTIONS.md is neither structured review evidence nor a commit-bound authority source. The COORD-718 implementation and proposal at PR #218 commit 6ddf54a4791d80a411afa99199bc54920494a17d define the initial contract.

## Linked Scope

- Governing ticket: COORD-718.
- Plan schema, governed record-independent-review command, explain, PLAN rendering, evidence export, closeout summary and cockpit read models.
- A follow-up will record the submitted repository and commit for tickets in review. Requiring independent reviews is a separate policy decision.

## Decision Criteria

Preserve independent authorship, exact repository/commit binding, immutable history, atomic writes, retry safety and consistent reader semantics without creating a second evidence store.

## Options Evaluated

1. Store independent_reviews in existing canonical plan records.
2. Reuse self_review_cycles or QUESTIONS.md.
3. Add a separate review ledger with new snapshot, journal and rollback integration.

## Decision

Use option 1. Plan records already participate in snapshot, provenance, rollback and journal protocols.

The writer captures reviewer handle, agent id, session id and thread id from the active bound session and owner_at_review from the board. The reviewer cannot be the ticket owner. The writer requires a full immutable commit that exists in the named repository; it does not claim the ticket, change its owner or alter its lock.

The stable review id hashes the version domain, ticket, reviewer handle and review_key. The default key is repository@commit:method. Identical reviewed content under the same id is an idempotent no-op; conflicting reuse refuses without mutation. Timestamp and session evidence do not redefine the retry identity.

Corrections and supersessions append a new record by the same reviewer with a required reason and a forward-only, single-successor link. Original records remain visible as history.

A current review must be valid, neither corrected nor superseded, from someone other than the current owner, and match the claimed repository and commit. Initially claimed scope comes from the doing lock head, otherwise the landing source commit, otherwise it is unresolved and no review counts as current. Review status has no durable submitted-head record in this slice; readers must say scope unresolved rather than imply current coverage.

QUESTIONS.md and self_review_cycles never count as independent reviews. Existing self-review gates and review_round semantics remain unchanged. This ADR introduces evidence recording, not a requirement for a minimum number of independent reviews.

## Alternatives Rejected

Self-review would misattribute authorship. QUESTIONS.md cannot supply canonical structured commit-bound evidence. A separate ledger duplicates persistence and recovery protocols. Incrementing review_round would confuse lifecycle repair with independent review.

## Consequences

Historical reviews remain auditable after a head change. The unresolved scope in review status is explicit until the submitted-head follow-up lands. Ownership transfer can make an earlier review non-current. A recorded review is an attributed verdict, not proof that the review was adequate or that a policy gate has been satisfied.

## Revisit Trigger

A submitted-head contract, a requirement for independent-review counts, stronger reviewer authentication, or a change to correction and supersession policy requires explicit review of this decision.
