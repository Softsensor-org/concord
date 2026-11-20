# ADR 0023: Attempt-aware coordination: parallel attempts are allowed and integration selects

- **Status:** Accepted
- **Ticket:** COORD-899
- **Date:** 2026-11
- **Linked scope:** attempt records and canonical ticket fencing (COORD-899); publish board state while work is active (COORD-911, in progress); integration authority (COORD-915, ADR 0021 decision 6, `coord/GOVERNANCE.md` section 11.0); board landing modes and push preflight (COORD-894); identity and owner lease (`coord/GOVERNANCE.md` section 10.3, ADR 0005); `coord/engine/scripts/integration-authority.js`, `coord/engine/scripts/journal.js`, `coord/engine/scripts/session-lock-records.js`, `coord/engine/scripts/governance-session.js`, `coord/engine/scripts/control-plane-push.js`, `coord/engine/scripts/board-push-preflight.js`, `coord/engine/scripts/board-pr-landing.js`.

## Context

The human admin's coordination model (reconciled into COORD-899 on 2026-11-06) has three layers:

1. **Same checkout or worktree:** writing stays exclusive.
2. **Independent clones or machines:** parallel *attempts* on one ticket are allowed and are not blocked.
3. **Integration:** one integration authority (COORD-915) selects, combines or rejects attempts, and only it changes canonical ticket ownership and status. Reservations are hints, not locks.

ADR 0021 rejected a global cross-machine ticket mutex as a first step and left "atomic remote claims (COORD-899)" as a later, separate decision. This ADR is that decision. It replaces the exclusive remote-claim wording with attempt-aware coordination.

What exists today, from the code:

- **Local exclusivity is complete within one domain.**
  - The ticket lock is `coord/locks/<ticket>.lock`, written by `session-lock-records.js` `writeLock`. Under identity v2 it is owner-authoritative (`identity_model: "v2"`, no `session_id` authority).
  - The owner lease is checked by `governance-session.js` `inspectOwnerLease` through `identityV2.assertCanMutate`. An owner split-brain fails closed.
  - The co-located-writer guard is `governance-session.js` `detectColocatedForeignSessions`, with its message in `buildColocatedForeignSessionMessage`.
  - `journal.js` `withGovernanceMutation` serializes every governed write under the runtime lock, and first calls `integrationAuthority.assertNoForeignOperation`.
- **Integration authority is per domain only.** `integration-authority.js` keeps one record per canonical runtime (`coord/.runtime/integration-authority.json`).
  - Its fence (`authorityFence`, which serializes `holder` and `operation`) is compared under the local runtime lock by `runFenced`, `withActiveCommandFence`, `assertActiveExecutor` and `settleOperation`.
  - `coord/GOVERNANCE.md` section 11.0 states the limit: independent runtimes on separate hosts or clones are separate domains, and this record does not coordinate between them.
- **Nothing coordinates across domains.** Two clones can each run `gov start` on one ticket. Each writes its own lock and its own board row (`Status: doing`, `Owner: <its handle>`), and each can publish.
  - The only cross-domain check is that git rejects a non-fast-forward push. `control-plane-push.js` `classifyPushNeed` reports `diverged` and refuses without pushing.
  - That rejection is not a guard. A stale or disconnected holder that fetches, rebases or merges produces a valid fast-forward that still carries its stale ownership decision. The ticket requires a compare-and-swap against the exact value the actor decided from.
- **Governed pushes refuse every force form today.** `control-plane-push.js` `assertNoForceArgs` and `assertGovernedPushArgv` refuse `--force-with-lease` as well (the `FORCE_ARG` pattern) and accept only plain refspecs (COORD-664/691). A lease-based compare-and-swap therefore needs a new, narrow primitive. It must not loosen that guard for the integration branch.
- **Board landing has two modes (COORD-894).** `control-plane-landing.js` `boardLandingSettings` reads `boardLanding: "push" | "pr"`.
  - In `pr` mode, `board-pr-landing.js` pushes the board commit (never forced) to `coord-board/<ticket>`, opens a governance-only PR, enables auto-merge with a merge commit, and completes closeout only on a `merged` receipt.
  - `board-push-preflight.js` `probeBoardPush` reads the effective rules (`gh api repos/<o>/<r>/rules/branches/<b>`) plus classic protection, and reports `unknown` rather than a false pass when `gh` is unavailable.
  - In `pr` mode the board branch is advanced by the host's merge, not by the client, so the client cannot compare-and-swap the board branch itself.
- **Publishing during active work is not landed yet.** COORD-911 is in progress on another branch, and is not landed. Its ticket text defines a governed publish verb (for example `gov publish-board` or `gov sync --publish`) with these properties:
  - It commits and pushes canonical governance state while tickets are `doing`, provided every dirty canonical path is accounted for by the journal.
  - It refuses foreign sessions' in-flight paths and unaccounted paths.
  - It leaves live locks unchanged and follows the configured landing mode.
  - Today `gov sync` refuses tree-wide mutations while any `doing` lock is live.

  This ADR depends on that verb: attempt visibility and canonical projection must be publishable while work is active. Its exact verb name and contract are COORD-911's to settle.

## Linked Scope

- Governing ticket: COORD-899 (depends on COORD-911).
- Builds on: COORD-915 (`integration-authority.js`), COORD-894 (board landing modes and preflight), ADR 0005 (owner lease), ADR 0020 (board, plan records, locks and sessions stay journal-only), ADR 0021 (integration as a separate authority; the global mutex was rejected).
- Affected surfaces: `gov pick`, the next-ticket listing, `gov explain`, `gov doctor`, the `gov integration` verb family, the governed push primitives, board projection during publish, finalize and land.
- Not in scope: the hosted collaboration service (COORD-918). It must not carry reservations or canonical state (see that ticket's ADR).

## Decision Criteria

The decision must keep three guarantees intact:

- **(a) Local exclusivity within a domain.** Existing locks, owner leases, the co-located-writer guard and the runtime lock are unchanged.
- **(b) Non-interference across domains.** A parallel attempt never overwrites another domain's canonical ownership or status, never recreates a foreign lock, and never publishes canonical state for a ticket it does not own canonically.
- **(c) Fenced canonical transitions.** Every canonical transition carries a generation token that is checked on publish. The compare-and-swap uses `--force-with-lease` with the exact previous value the actor decided from. A plain push rejection is not the guard.

It must also meet these criteria:

- Parallel attempts are visible and never refused.
- A domain can work offline. Only canonical transitions need the remote.
- Every step has a defined crash and offline recovery window. Orphans are reported, never silently deleted.
- The governed-push safety guard for the integration branch (COORD-664/691) is not weakened.
- It works under both board-landing modes and under org rulesets (COORD-894), and the host can list and protect the chosen namespace.
- Every selection and rejection is auditable in the hash-chained journal.

## Options Evaluated

1. **Attempts and canonical state inside the published board (`tasks.json`) only.** Attempts would be extra board fields or rows, published through COORD-911.
   - For: one location, rendered views come for free, no new git surface.
   - Against: board publication is an integration verb (section 11.0), so a non-integrating domain cannot publish its own attempt without gaining authority it must not have.
   - Against: concurrent attempts from several domains conflict textually in one file.
   - Against: in `pr` mode every attempt becomes a PR.
   - Against: the board branch cannot be compare-and-swapped in `pr` mode, so it cannot carry the generation fence.
2. **A dedicated git ref namespace on the board remote.** Each attempt is its own create-only ref written only by its own domain. Each ticket's canonical state is one ref, advanced only by the integration authority with an exact-value lease. The board's Status and Owner fields become a projection of those refs.
   - For: append-friendly, with no textual conflicts.
   - For: a per-ticket compare-and-swap that the server's ref transaction enforces.
   - For: listable with `git ls-remote`, and works offline until publish.
   - For: no new infrastructure.
   - Against: needs a new lease-push primitive, extra refs on the host, and a host qualification that the namespace can be listed and protected.
3. **An external coordination service with leases** (a database or the COORD-918 service).
   - For: true leases with TTLs, and arbitrary queries.
   - Against: adds a hard runtime dependency to Community.
   - Against: canonical transitions stop working when that service is down, even though git is reachable.
   - Against: COORD-918's acceptance explicitly keeps integration reservations out of the messaging service.
   - Against: it reintroduces the global mutex shape that ADR 0021 rejected.
4. **Status quo plus retry on push rejection.**
   - For: no change.
   - Against: the ticket rules it out. A rebase or merge launders a stale decision into a fast-forward (see Context).
5. **Git notes (`refs/notes/coord-attempts`) as the attempt store.**
   - For: a standard mechanism.
   - Against: every attempt from every domain contends on one ref.
   - Against: appends need fetch, merge and retry loops, the data cannot be listed per ticket without fetching it all, and notes merge semantics are not suited to governance records.

## Decision

Adopt option 2. Detailed decisions follow. Items marked **[decision requested]** are left open for the human admin at acceptance (see the last section).

### 1. Coordination domain identity

- A coordination domain keeps the section 11.0 definition: one canonical runtime directory.
- Each domain mints a random, stable `domain_id` on first use and stores it in its runtime. Host, clone path and handle are carried as diagnostics only, never as authority. This follows section 10.3, where pid and host are evidence only.
- The **canonical domain** is the domain whose integration-authority holder publishes the integration branch. Its `domain_id` is recorded in the canonical authority ref (item 4).

### 2. Ref namespace

The logical namespace is `coord-state/`, with this physical layout (configurable prefix, default discussed in item 9):

| Ref | Writer | Update rule |
| --- | --- | --- |
| `coord-state/attempts/<ticket>/<domain_id>/<attempt_id>` | the owning domain only | created only if absent (`--force-with-lease=<ref>:` with an empty expected value); later updates are fast-forward with an exact lease |
| `coord-state/canonical/<ticket>` | the integration authority only | fast-forward only, with an exact-value lease (item 5) |
| `coord-state/authority` | the integration authority, through a human-admin handoff | fast-forward only, with an exact-value lease |
| `coord-state/reservations/<domain_id>` | the owning domain only | fast-forward only, with an exact-value lease; advisory (item 8) |

- Each ref points at a commit whose tree holds one JSON record and whose parent is the previous record. History is preserved in the ref's own chain.
- No ref in the namespace is ever deleted by an automatic process.

### 3. The attempt record

The attempt record uses schema `coord.attempt/v1`, with these fields:

- `ticket`;
- `attempt_id`: deterministic from the domain's journal transaction id, so a retried publish converges on one id;
- `agent`: handle and agent id;
- `domain_id`, plus a diagnostic `domain_label`;
- `base_sha`, `branch` and an optional latest `head`;
- `observed_canonical`: the canonical ref oid and generation the attempt started from;
- `state`: `active`, `submitted` or `withdrawn`, as set by the owning domain;
- timestamps.

Creating an attempt works as follows:

- An attempt is created locally by the existing start path, inside `withGovernanceMutation`. It takes the local lock and owner lease as today, and journals an `attempt-opened` event, which keeps guarantee (a).
- Publishing the attempt ref is a separate, retryable step.
- Attempts are never refused because other attempts exist.
- `gov pick`, the next-ticket listing, `gov explain` and `gov doctor` list overlapping attempts for a ticket (domain, agent, base, branch, age), without refusing anything.

### 4. Attempts are separate from canonical ownership and status

- Canonical ticket state lives in `coord-state/canonical/<ticket>`, schema `coord.canonical-ticket/v1`. It holds:
  - `generation`, a monotonic integer;
  - `status` and `owner`;
  - `selected_attempt`, plus any `combined_attempts`;
  - `rejected_attempts`, each with a reason;
  - `integrator`: handle, session and `domain_id`;
  - `authority_epoch`;
  - the journal transaction id of the decision.
- The board row's `Status` and `Owner` fields are a projection of this ref. Where the two disagree, readers report the ref as authoritative and flag a projection lag.
- `coord-state/authority` names the canonical domain, the holder handle and an `authority_epoch`. It is advanced only by a journaled human-admin handoff, the cross-domain counterpart of `gov integration handoff`.
- Non-interference rules, which give guarantee (b):
  - A non-canonical domain's publish paths refuse any board change to `Status` or `Owner`, and any change to the canonical ref of a ticket. This covers the COORD-911 publish verb, `sync`, and the terminal verbs.
  - When a domain pulls a board whose canonical owner is foreign, it never synthesizes a local lock for that ticket. `doctor` classifies "foreign canonical owner, no local lock" as expected state, not drift.
  - The integrator never writes another domain's attempt ref. Selection and rejection are recorded in the canonical ref and the journal, so attempt refs stay owned by their domains.
  - Inside the canonical domain, section 11.0 applies unchanged. Only the holder integrates, and an open integration operation reserves the domain.

### 5. Fencing of canonical transitions (guarantee (c))

1. **The generation token** is `<ticket>@<generation>:<oid>`, where `<oid>` is the exact commit the canonical ref pointed at when the integrator made its decision.
2. **Recording the decision.** The decision is journaled as a `canonical-transition-intent` event with the expected oid, the new record and the authority epoch. The token is also recorded in the open integration operation's baseline, next to the existing `baseline.head` and `journal_bytes` that `integration-authority.js` `newOperation` captures today.
3. **Publishing.** A new governed primitive pushes the new canonical commit (whose parent is the expected oid) with `--force-with-lease=refs/<prefix>canonical/<ticket>:<expected-oid>`, and with `--atomic` when other refs move in the same publication.
   - The client refuses if the advertised value differs from the lease.
   - The server's ref transaction then checks the old value under its ref lock. That second check is the actual compare-and-swap.
   - The primitive accepts a lease only as an explicit full object id, and only for refs under the configured namespace.
   - Integration-branch pushes keep `assertGovernedPushArgv` unchanged. Adding this primitive is a T2 guard change and gets a guard registry entry (COORD-914).
   - Because each new canonical commit has the expected oid as its parent, a host rule that blocks non-fast-forward updates stays enabled as defence in depth.
4. **Checking at each publication point:**
   - **Board push** (push mode: the COORD-911 publish, `sync --push`, and finalize or land in push mode). The board branch refspec and every canonical ref that changed are pushed in one `--atomic` push. The board commit carries a `Coord-Fence:` trailer listing each new token. For tickets whose canonical state did not change, the projection must equal the fetched refs, or the publish refuses.
   - **PR creation** (`pr` mode). The canonical ref is compare-and-swapped first. The governance-only PR's commit carries the `Coord-Fence:` trailer.
   - **Land and finalize.** Before closeout completes, the integrator fetches the canonical ref, checks that it still equals the operation's token, and compare-and-swaps it to the terminal generation (`done`). In `pr` mode, a PR whose fence is stale is closed rather than merged.
   - Whether `pr` mode also needs a required status check that verifies the trailer against the ref at merge time is **[decision requested]**.
5. **The result for a stale holder.** A stale, disconnected or handed-off holder can still prepare intents locally, but it cannot publish, open a PR or land. Its lease fails, and it is refused naming the current token and `gov integration recover`.
   - Every canonical record also carries `authority_epoch`. The engine refuses a transition whose epoch differs from the fetched `coord-state/authority`.
   - That epoch check is client-side. The host-side enforcement is the ruleset that restricts the canonical refs to the integrator's credential (item 9).

### 6. Selection contract

- `gov integration attempts <ticket>` lists every attempt and the current canonical record. It is read-only.
- `gov integration select <ticket> --attempt <id> [--reject <id> --reason <text> ...]` advances the canonical ref under the fence:
  - It records the selected attempt and each rejected attempt with its reason.
  - It changes the owner when the selected attempt's agent differs from the canonical owner.
  - It journals an `attempt-selection` event naming the generation before and after.
- Rejected attempts stay auditable in three places: their own refs, the canonical record's history, and the journal.
- Combining several attempts (`--combine`) records several selected attempts. The integrator produces the combined branch as ordinary work. Whether `--combine` is in the first version is **[decision requested]**.

### 7. Crash and offline recovery windows

Each window has one defined recovery, and `gov doctor` classifies each one.

| Step | Window | Crash recovery | Offline behaviour |
| --- | --- | --- | --- |
| A1 | attempt opened locally (lock, lease, `attempt-opened` journaled), ref not pushed | `gov resume` as today; the publish retry reuses the same `attempt_id` | Allowed indefinitely. Doctor reports `attempt-unpublished`. No canonical effect. |
| A2 | attempt ref push sent, result unknown | `ls-remote` the ref. If it holds the expected oid, journal `attempt-published`. If it is absent, re-push create-only. If it holds a different oid, refuse and report (an id collision). | Retried on the next online command. Doctor reports `attempt-publish-unknown`. |
| A3 | attempt published, domain silent | none needed | Doctor in any domain reports `attempt-stale` after the stale threshold, and `attempt-orphaned` once the canonical ticket is `done` or has selected another attempt, or after the orphan threshold. Orphans are reported, never deleted. |
| C1 | canonical intent journaled inside an integration operation, not pushed | The operation stays recorded (section 11.0). `gov integration recover` fetches the ref. If it equals the expected oid, `--resume` re-pushes. If not, the intent is stale and is abandoned with a journaled reason. | The integrator can prepare intents offline. No canonical effect until the push. |
| C2 | atomic push sent, result unknown | `recover` fetches the ref. If it equals the new oid, the push applied: journal `canonical-transition-published`. If it equals the expected oid, it did not apply: retry. If it is anything else, a foreign advance happened, which is only possible after an authority change: refuse, and require handoff and verified recovery. | Same as C1. |
| C3 | canonical ref advanced, board projection not yet published (or the `pr`-mode PR is still `pending`) | Re-publish the projection. A `pending` PR follows the COORD-894 receipt rules. | Readers show the ref and flag `canonical-projection-lag`. |
| C4 | projection published, closeout incomplete | The existing interrupted-operation recovery (section 11.0) | none |

Default thresholds are **[decision requested]**. The proposal:

- **attempt stale:** 72 hours without an update from the owning domain;
- **attempt orphaned:** 14 days, or the canonical ticket being terminal;
- **integration operation lease:** the existing `DEFAULT_LEASE_MS` (2 hours) in `integration-authority.js`.

Canonical intents have no time limit. The lease decides whether they are still valid.

### 8. Optional reservations

- `coord-state/reservations/<domain_id>` holds a list of tickets, each with an expiry and a note.
- It is published by its own domain through a governed verb and journaled locally.
- `gov pick` and the next-ticket listing show it. It is never enforced against any domain, never blocks a start, and never changes canonical state.

### 9. Hosting qualification

The namespace qualifies on a host only when a governed probe passes all of the following. The probe extends `board-push-preflight.js` `probeBoardPush` and is reported by install, onboarding and `gov doctor`.

1. **Accepted:** create, fast-forward with a lease, and refuse a stale lease on a probe ref in the namespace. Also run an `--atomic` push that spans the board branch and a namespace ref.
2. **Listable:** `git ls-remote <remote> '<prefix>*'` returns the probe refs.
3. **Protectable:**
   - Deleting and force-updating canonical refs is blocked for ordinary writers.
   - Canonical and authority refs can be restricted to the integrator's credential. On GitHub, that is a bypass actor, as in the COORD-894 remedies.
4. **Compatible with branch rulesets (COORD-894):**
   - The effective rules for the namespace do not require a pull request. If an org ruleset covers the namespace, a bypass in "Always" mode applies to the integrator.
   - The board branch's own rules still let the chosen board-landing mode work.
5. **Degraded results:** unauthenticated or offline probes report `unknown`, never a false pass, as in COORD-894. An unqualified host keeps the domain working locally, but canonical transitions are refused, and attempts are published only when item 1 passes.

GitHub branch and tag rulesets protect only `refs/heads/` and `refs/tags/`. So the proposed default physical prefix is the branch-backed `refs/heads/coord-state/`. A non-branch prefix such as `refs/coord/` is allowed only on a host where the probe proves equivalent protection (for example, server-side hooks on a self-hosted remote). This choice of default is **[decision requested]**.

### 10. What stays unchanged

- Same-checkout exclusivity: locks, owner leases, the co-located-writer guard and the runtime lock.
- The integration-authority record and its in-domain fence.
- ADR 0020's rule that the board, plan records, locks and sessions are journal-only.
- The never-force rule for the integration branch.

## Alternatives Rejected

- **Board-only attempts (option 1):** a non-integrating domain would need board publication, which is integration authority, just to announce an attempt. The board also cannot carry a compare-and-swap fence in `pr` mode.
- **An external lease service (option 3):** canonical integration would depend on a service being up. That reintroduces the global mutex that ADR 0021 rejected, and conflicts with COORD-918 keeping reservations out of messaging.
- **Retry on push rejection (option 4):** a rebase or merge turns a stale decision into a valid fast-forward. The ticket states that plain push rejection is not the guard.
- **Git notes (option 5):** one contended ref for every domain, merge-based appends, and no per-ticket listing.
- **Globally exclusive remote claims:** superseded by the human admin's 2026-11-06 model. Parallel attempts are allowed.
- **Allowing `--force-with-lease` on the integration branch:** it would weaken the COORD-664/691 guard. The lease is confined to the coordination namespace, and the board branch moves only by fast-forward inside an atomic push.

## Consequences

- Teams on several machines can work on one ticket at the same time, and each sees the others' attempts.
- Ownership and status change in exactly one place, behind a fence the server enforces. A disconnected or stale integrator cannot publish, open a PR or land.
- `gov start` in a non-canonical domain no longer implies canonical `doing`. Whether opening an attempt requests a canonical `doing` from the integrator, or canonical state stays `todo` until selection, is **[decision requested]**. Local views mark local status as such.
- Migration: at upgrade, the integrator bootstraps one canonical ref per non-terminal ticket from the current board at generation 0. This is one journaled event per ticket, and needs a qualified host.
- New costs:
  - extra refs on the host, so a retention policy for terminal tickets' attempt refs is **[decision requested]**;
  - one new push primitive and its guard registry entry;
  - one network round trip per canonical transition;
  - hosts that lack ruleset coverage for the namespace need a bypass actor or a non-branch prefix with server hooks.
- Doctor gains these classifications: `attempt-unpublished`, `attempt-publish-unknown`, `attempt-stale`, `attempt-orphaned`, `overlapping-attempts` (informational), `foreign-canonical-owner` (informational), `canonical-projection-lag`, `canonical-intent-stale`, and `namespace-unqualified`.
- Implementation cannot start before this ADR is accepted (COORD-899 acceptance item 1), and it depends on COORD-911 landing.
- The tests required by COORD-899 item 9 run against a real bare remote with two domains:
  - concurrent attempts;
  - selection;
  - a stale holder refused by the fence;
  - a crash at each window in item 7;
  - doctor classification.

  The hosting probe additionally runs against the real host.

## Revisit Trigger

- The host qualification fails for both the branch-backed and the non-branch prefix on a supported host.
- COORD-911 lands with a publish contract that cannot carry an atomic board-plus-canonical push, or cannot carry the fence trailer in `pr` mode.
- A stale holder publishes canonical state in any test or incident.
- The ref count or fetch cost on a real board becomes material.
- A need arises for more than one canonical domain per board, which this ADR does not support.

## Decisions Requested At Acceptance

The tickets leave these open. The human admin decides them; this ADR does not.

1. **Physical prefix.** Branch-backed `refs/heads/coord-state/` (protectable by GitHub rulesets, but visible as branches) versus a non-branch `refs/coord/` (hidden from branch lists, but protectable only with server hooks). Resolved (human admin, 2026-11-16): branch-backed `refs/heads/coord-state/`, which is protectable by GitHub rulesets.
2. **Canonical `doing`.** Does opening the first attempt request a canonical `doing` from the integrator, or does canonical status stay `todo` until the integrator assigns or selects? Resolved (human admin, 2026-11-16): canonical status stays `todo` until the integrator assigns or selects.
3. **Host-side restriction.** Is restricting the canonical and authority refs to the integrator's credential required for qualification, or advisory, with the client-side epoch check alone accepted on hosts that cannot restrict? Resolved (human admin, 2026-11-16): advisory; the client-side epoch check is accepted on hosts that cannot restrict.
4. **`pr`-mode fencing.** Is a required status check on the board repository that verifies the `Coord-Fence:` trailer at merge time mandatory, or is the closeout re-verification in item 5 enough? Resolved (human admin, 2026-11-16): the closeout fence re-verification is enough; no mandatory status check.
5. **`--combine`.** Is combining attempts in the first implementation, or is select-only first? Resolved (human admin, 2026-11-16): select-only first; `--combine` later.
6. **Thresholds and retention.** The attempt stale and orphan thresholds (proposed 72 hours and 14 days), and how long attempt refs of terminal tickets are retained. Resolved (human admin, 2026-11-16): stale 72 hours, orphan 14 days, and attempt refs of terminal tickets deleted after 30 days.
7. **Domain identity.** Is `domain_id` registered in the agents registry for attribution, or kept runtime-local with its label? Resolved (human admin, 2026-11-16): `domain_id` is registered in the agents registry.

## Approval State

Accepted by the human admin on 2026-11-15 (human-admin decision, given directly in the orchestrator session and recorded under COORD-1024). The Decision section is accepted as written: parallel attempts are allowed and integration selects. The seven questions under Decisions Requested At Acceptance are not answered by this record and stay open for the human admin. Review by agents is not human approval. COORD-899 builds on this decision.
