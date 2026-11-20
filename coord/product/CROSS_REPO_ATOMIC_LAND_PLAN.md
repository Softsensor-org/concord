# Cross-Repo Atomic Land Plan

## Problem Statement

Concord can coordinate work across multiple governed repos, but the current
landing model is repo-local. `coord/GOVERNANCE.md` Section 11.1 names the
current limitation: if a cross-repo ticket lands in one repo and then fails in
another, there is no automated rollback; the failed portion must be handled as a
new ticket.

That is acceptable for low-volume pilots, but it becomes fragile when a ticket
must change a backend API, frontend caller, shared schema, migration, and tests
as one logical unit. Each repo may be individually correct, while the partial
landed state is broken.

The goal is to design a governed multi-repo land protocol that detects partial
land, avoids it when possible, and records deterministic completion or
compensation when it occurs.

## Design Goals

- Preserve existing repo-local `gov submit`, `gov land`, and no-PR closeout
  semantics until a future implementation ticket explicitly adopts the protocol.
- Give cross-repo tickets an explicit prepare/commit lifecycle.
- Distinguish rollback before commit from compensation after a repo has landed.
- Make half-landed state detectable in the board, journal, and doctor output.
- Keep each repo's git history understandable; do not require distributed git
  transactions.
- Compose with affected-target gates, the contention-triggered land sequencer,
  and future transactional board storage.

## Non-Goals

- No runtime mutation in this spike.
- No replacement of GitHub PRs, branch protections, or repo-specific merge
  policies.
- No automatic production deployment or runtime rollback.
- No guarantee that an externally merged PR can be made un-happened. Once a repo
  commit is on the canonical branch, rollback is a new compensating change.

## Options

### Option A: True Two-Phase Commit

Each repo enters a prepared state, then all repos commit atomically.

```text
prepare B -> prepared
prepare F -> prepared
commit B
commit F
```

Pros:

- Familiar transaction model.
- Clear all-or-nothing intent.
- Easy to explain in governance records.

Cons:

- Git and hosted PR systems do not support true atomic multi-repo commit.
- A repo can be externally merged, rebased, force-pushed, or blocked between
  prepare and commit.
- Failure after the first commit still needs compensation.

### Option B: Saga With Compensating Rollback

Repos land one at a time. If a later repo fails, Concord records a compensating
action for already-landed repos.

```text
land B -> success
land F -> fail
open compensation for B
```

Pros:

- Matches how git and PR hosting actually work.
- Makes partial state explicit and recoverable.
- Does not overpromise atomicity the platform cannot provide.

Cons:

- Temporary partial states can still exist.
- Compensation may require human design, not a mechanical revert.
- Customer-visible breakage is possible if gating is weak.

### Option C: Prepare Barrier + Saga Commit

Use prepare checks to reduce partial-land risk, then land through a sequenced
saga with mandatory compensation records on failure.

Pros:

- Honest about git limitations.
- Catches most failure before any repo lands.
- Records deterministic action when a late failure occurs.
- Composes with the existing land sequencer and journal.

Cons:

- More ceremony for multi-repo tickets.
- Requires new plan/board evidence fields and doctor checks.
- Still cannot guarantee physical atomicity across independent repos.

## Recommendation

Adopt **Option C** for future implementation.

Concord should not claim true distributed atomic commit across git repos.
Instead, it should provide a governed atomicity envelope:

1. every participating repo reaches a prepared state;
2. a commit barrier freezes the expected commit/PR/gate identity for each repo;
3. the land sequencer lands repos in an explicit order;
4. every successful repo land is journaled immediately;
5. a later failure opens or records a compensation plan before the cross-repo
   ticket can close.

This gives users the property they need operationally: no invisible half-landed
state and no ticket that claims completion while one repo failed.

## Participation Model

A cross-repo ticket declares participants:

```json
{
  "ticket": "API-123",
  "participants": [
    {
      "repo": "B",
      "branch": "agent/a123-api-123-backend",
      "source_commit": "abc123",
      "base_ref": "dev",
      "required_gates": ["unit", "contract"],
      "rollback_strategy": "revert_or_forward_fix"
    },
    {
      "repo": "F",
      "branch": "agent/a123-api-123-frontend",
      "source_commit": "def456",
      "base_ref": "dev",
      "required_gates": ["unit", "e2e-smoke"],
      "rollback_strategy": "feature_flag_disable"
    }
  ]
}
```

Repo `X` remains the coordination authority. Product repos remain the source of
code truth.

## Protocol

### Phase 1: Declare

Before review, the ticket plan records:

- participating repo codes;
- source branches and expected commits;
- base refs;
- changed file surfaces;
- required gates per repo;
- cross-repo compatibility gate, if any;
- rollback or compensation strategy per repo;
- land order and why.

Missing participant declarations should make the ticket ineligible for
cross-repo closeout.

### Phase 2: Prepare

Prepare is read-only against canonical branches and write-only to ticket plans.
It proves each repo is landable before any repo lands.

Per repo:

- branch tip resolves to expected source commit;
- branch is based on or rebaseable onto the current canonical base;
- required repo gates pass;
- feature proofs exist at branch tip;
- PR mergeability is `MERGEABLE` if PR-backed;
- no declared file surface conflict requires the contention sequencer.

Across repos:

- contract/API compatibility gate passes against the prepared branch set;
- generated schemas/artifacts agree;
- dependency order is explicit;
- no participant has stale prepare evidence.

Prepare emits a `cross_repo.prepare` record in the plan and journal.

### Phase 3: Commit Barrier

The commit barrier freezes the prepared identities:

```json
{
  "ticket": "API-123",
  "barrier_id": "XRB-API-123-001",
  "prepared_at": "2026-06-28T06:30:00Z",
  "participants": {
    "B": {
      "source_commit": "abc123",
      "base_head": "bbase1",
      "gate_digest": "sha256:..."
    },
    "F": {
      "source_commit": "def456",
      "base_head": "fbase1",
      "gate_digest": "sha256:..."
    }
  }
}
```

If any participant changes after the barrier, the barrier is stale and prepare
must rerun.

### Phase 4: Sequenced Commit

The land sequencer commits participants in the declared order:

```text
commit participant B
record landed commit for B
verify B landed on expected base
commit participant F
record landed commit for F
verify F landed on expected base
```

Each successful participant land is journaled immediately. The cross-repo ticket
does not close until all participants are either:

- landed and verified; or
- landed and compensated; or
- not landed and safely abandoned.

### Phase 5: Completion or Compensation

If all participants land:

```text
cross_repo.status = complete
```

If a participant fails after earlier participants landed:

```text
cross_repo.status = compensating
open compensation ticket(s)
block closeout until compensation path is recorded
```

Compensation may be:

- revert the already-landed repo commit;
- forward-fix the failed repo;
- disable a feature flag;
- apply a compatibility shim;
- human-admin accept partial state with explicit risk record.

The key rule: **a half-landed ticket cannot silently become done**.

## State Model

```text
declared
  -> prepared
  -> barrier-open
  -> committing
  -> complete

committing
  -> compensating
  -> compensated
  -> complete

prepared | barrier-open
  -> stale
  -> prepared

declared | prepared | barrier-open
  -> abandoned
```

`complete` means either all participants landed, or compensation has restored a
recorded acceptable state.

## Journal Events

Future implementation should add structured event commands:

```text
cross_repo.declare
cross_repo.prepare
cross_repo.barrier
cross_repo.participant_landed
cross_repo.participant_failed
cross_repo.compensation_required
cross_repo.compensation_recorded
cross_repo.complete
```

These events should be normal governance journal events and therefore covered by
the same chain verification and conformance attestation.

## Board and Plan Evidence

The board row remains one logical ticket. The plan record carries participant
detail:

```json
{
  "cross_repo_land": {
    "status": "committing",
    "barrier_id": "XRB-API-123-001",
    "participants": {
      "B": {
        "prepare_status": "pass",
        "land_status": "landed",
        "landed_commit": "b789"
      },
      "F": {
        "prepare_status": "pass",
        "land_status": "failed",
        "failure": "merge conflict after base moved"
      }
    },
    "compensation": {
      "required": true,
      "tickets": ["API-124"],
      "strategy": "forward-fix frontend against landed backend"
    }
  }
}
```

Rendered views should show cross-repo tickets with partial-land state
prominently.

## Recovery Rules

| Failure | Required behavior |
|---|---|
| Prepare fails before any land | Remain in `doing` or `review`; no compensation needed. |
| Barrier becomes stale | Rerun prepare; old barrier is historical. |
| First participant land fails | No repo landed; ticket returns to repair. |
| Later participant land fails | Enter `compensating`; record landed participants and open/attach compensation. |
| Operator dies mid-commit | `gov doctor` reconstructs participant state from journal + repo refs. |
| External PR merge occurs | Record as participant landed if source/base match, otherwise flag as out-of-band partial land. |
| Compensation fails | Ticket remains blocked with explicit unresolved partial-land risk. |

## Validation Contract

Future validation should require:

- every multi-repo ticket has participant declarations before review;
- every participant has fresh prepare evidence before barrier;
- barrier source/base heads match current repo refs at commit time;
- every participant land has a recorded landed commit;
- a partial land cannot move to done unless compensation is recorded;
- feature proofs are verified against the actual landed commit per repo;
- doctor reports unresolved `compensating` tickets as high-priority issues.

## Interaction With Existing Concurrency Work

- **Transactional board store:** stores participant status without whole-board
  rewrites.
- **Affected-target gates:** run per-repo and cross-repo compatibility slices
  rather than full suites by default.
- **Contention-triggered land sequencer:** serializes overlapping participant
  lands and verifies the actual merged result.
- **Journal append sequencer:** gives all participant status events one
  auditable order.

## Security and Audit Considerations

- A compensation ticket must carry the same governance evidence as ordinary
  work; it is not an unreviewed rollback shortcut.
- Human-admin partial-state acceptance must record risk, affected repos, and
  follow-up.
- Cross-repo plan evidence can contain sensitive repository names in enterprise
  deployments; rendered exports should honor existing redaction policy.
- The protocol must not bypass repo-level branch protection, PR review, or
  deployment separation.

## Migration Plan

### Phase 0: Design Only

- Land this document.
- Keep current limitation text in Governance §11.1.

### Phase 1: Declaration Schema

- Add optional `cross_repo_land.participants` to plan records.
- Warn when a ticket touches multiple repos without participant declarations.

### Phase 2: Prepare Command

- Add read-only `gov cross-repo prepare <ticket>`.
- Record prepare evidence in the plan.

### Phase 3: Barrier and Doctor Checks

- Add stale-barrier detection.
- Add doctor warnings for partial participant state.

### Phase 4: Sequenced Participant Land

- Add `gov cross-repo land <ticket>` that calls existing repo-local land
  commands under the declared barrier.
- Keep repo-local `gov land` as the underlying primitive.

### Phase 5: Compensation Enforcement

- Refuse `done` for partial-land tickets without compensation evidence or
  explicit human-admin acceptance.

## Follow-Up Tickets

- Add cross-repo participant schema and plan renderer support.
- Add read-only prepare/barrier validator.
- Add doctor partial-land reconstruction from repo refs and journal.
- Add sequenced participant land command behind an explicit flag.
- Add compensation-required closeout gate.

## Rollback

Because this spike changes only documentation, rollback is deletion of this
document and prompt before closeout. Future implementation phases must keep a
feature flag that disables cross-repo atomic envelopes and falls back to the
current documented limitation.

