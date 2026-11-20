# ADR 0029: Coord UI edits of governed configuration are governed proposals, never direct writes

- **Status:** Accepted
- **Ticket:** COORD-1017
- **Date:** 2026-11-16
- **Linked scope:** the coord UI (`frontend/apps/coord-ui`, including the read-only testing-policy views from COORD-939); the testing policy (`coord/engine/test-policy.json`, COORD-936) and its ticket exceptions (`coord/engine/scripts/test-policy-exceptions.js`); other adopter configuration owned by governance (`coord/project.config.js`, the repo map, landing mode); the human-admin override path (`resolveHumanAdminOverride` in `coord/engine/scripts/agent-commands.js`); the trusted-actor write path (ADR 0003); the guard registry (`coord/engine/governance-guards.json`); integration authority (ADR 0021, COORD-915); the local UI launcher and access model (COORD-940).

## Context

COORD-939 gives the coord UI read-only views of governed configuration: the versioned testing policy, the resolved policy for a ticket or branch, active ticket exceptions, scheduled-run decisions, and other adopter configuration. The read views are settled and need no ADR.

The edit half is different. An operator who sees a testing-policy value they want changed, or a ticket exception they need, has two options today. They can edit the file by hand, which bypasses the journal, the versioning and the gate, or they can use the CLI, which is governed but is not where the diff is shown. The COORD-939 ticket asks for the UI to produce the same governed change as the CLI, so that a UI edit is journaled, versioned and gated like any other.

This ADR settles the rules before any code exists. Three facts shape it:

1. Governed state is written only through `gov` verbs or their library equivalents, under the runtime lock and the journal (ADR 0002, ADR 0003). A UI that wrote a file would sit outside that path.
2. The existing human-admin path is an explicit reason string, `--human-admin-override "<reason>"`, recorded in the journal. It is used by ticket transfer, lock abandonment, test-policy exceptions and reconcile. No verb today approves an arbitrary configuration change.
3. A local UI is reachable by any process on the same machine that can reach its port. COORD-940 records that the current launcher binds `0.0.0.0` by default and trusts a role header in development. Approval must not depend on anything a local process can forge.

## Linked Scope

- The edit path only: how a change to editable configuration is proposed, reviewed, approved, applied, journaled and rolled back.
- The read surface from COORD-939 is referenced as given and is not changed here.
- Out of scope: policy semantics (COORD-936), the launcher fix (COORD-940), and any implementation. Implementation waits for this ADR to be accepted.

## Decision Criteria

- No UI path writes governed state. Every change is a proposal first, and a proposal changes nothing on disk.
- Approval is an explicit human act, bound to an identity the local UI cannot forge, and recorded in the journal with a reason.
- A proposal applies only to the exact version it was made against. Stale or concurrent edits are refused, not merged.
- The UI shows governance refusals verbatim and does not paper over them.
- The rule has to hold for a local process that can make HTTP requests to the UI.
- The set of editable configuration is closed and listed. Anything not listed is not editable from the UI.

## Options Evaluated

1. **Direct file write from the UI** (rejected). Simple, but it is exactly the path ADR 0003 forbids, and it skips the journal, the lock and the gate.
2. **Proposal artifact written by the UI to a side file, applied by a CLI command** (rejected). The side file is coordination state outside the journal (ADR 0020 keeps coordination state journal-only), so it can be edited or deleted with no record.
3. **Proposal as a journaled governed event, created by a verb the UI calls through the library, approved by a human-admin verb, applied by the same verb** (recommended, below).
4. **Approval by a UI button alone** (rejected). Any local process that can reach the UI could approve. Approval has to be bound to a trusted human actor (ADR 0003), not to the UI's own session.

## Decision

### 1. Proposal creation

- A UI edit is a **proposal**, not a write. The UI calls a governed verb through the same library function the CLI uses. The proposed verb is `config propose --target <config-id> --base-digest <sha256> --diff-file <file>` (a new verb, not yet implemented; the `gov` prefix is added only when it exists). The verb validates the diff against the target's schema, computes the proposed content, and appends a `config.proposed` event to the journal. It writes nothing else.
- The proposal records the target id, the base digest of the current content it was made against, the proposed content digest, the diff, the proposer's handle and session, and a timestamp.
- The UI renders the same diff the CLI would produce. The acceptance test for COORD-1017 compares the two.
- A proposal does not change `coord/engine/test-policy.json`, `coord/project.config.js` or any other file. The only on-disk change from creating a proposal is the journal append, which is the existing journal's normal behaviour.

### 2. Approval

- Approval is by a **new human-admin verb**, proposed here as `config approve <proposal-id> --human-admin-override "<reason>"` (a new verb, not yet implemented). It is the only path that applies a proposal. No agent session and no UI control can apply one on its own.
- The verb requires a bound human-admin session, the same condition `resolveHumanAdminOverride` already enforces for `claim --transfer-to` and `lock-abandon`. A `--human-admin-override` string alone, without that bound session, is refused.
- For exceptions, the existing `gov test-policy except --ticket` path already requires `--human-admin-override`. This ADR keeps that path for ticket-level exceptions and does not add a second one.
- The journal records the approval with the reason, the approver's identity, the proposal id and the base and result digests. The record is the same shape the CLI override writes, so acceptance (3) can check that the UI route and the CLI route produce the same journal event.

### 3. Apply

- Apply runs under the runtime lock, re-reads the target, and compares its digest with the proposal's base digest. A mismatch refuses the apply and tells the approver to re-propose against the current version. There is no merge.
- Apply writes through the existing governed write path for that file type, runs the target's own validator, and journals `config.applied` with the before and after digests. A validator failure rolls the write back and journals `config.apply_refused`.
- After apply, the proposal is closed. A closed proposal cannot be re-applied.

### 4. Editable and never-editable configuration

Editable from the UI, through proposals only:

- the testing policy's **selection and stage settings** that COORD-936 exposes as configuration (not its semantics);
- ticket-level **exceptions** (add checks or reduce scope), through `gov test-policy except` and its approval;
- `coord/project.config.js` settings that governance already owns, listed one by one in the implementation ticket, not as a wildcard;
- the repo map and landing mode, if the implementation ticket confirms they are config and not derived state.

Never editable from the UI, by any proposal:

- the **guard registry** (`coord/engine/governance-guards.json`) and any guard entry. Guard changes already go through the guard-registry write and check, and removing a guard is a governance change, not a setting;
- the **integration authority** and its verbs (`gov integration ...`), the owner lease, locks and sessions (ADR 0005, ADR 0021);
- the **architecture ratchet** (`coord/engine/architecture-ratchet.json`) and the engine pin and template manifest, which are regenerated by their own commands;
- the **board, journal, runtime, plan records and rendered views**, which are reached only through the verbs that own them;
- **ADR files and the decision index**, which change only through `gov adr`;
- **prompts** under `coord/prompts/`, which change only through `gov register-prompt`;
- anything under the **engine's own source** (`coord/engine/scripts/`), which is code and goes through a ticket.

The set above is closed. A target not in the editable list is refused by the proposed `config propose` verb with the list of valid targets.

### 5. Audit trail

- Every proposal, approval, refusal and apply is a journal event. The journal is the audit trail. The UI does not keep its own log.
- A refused proposal is recorded as `config.proposal_refused` with the verbatim refusal, so the UI can show the same text the CLI prints.
- The UI's view of pending proposals is derived from the journal. It is read-only.

### 6. Threat model

- A local UI is reachable by any local process that can reach its port. The UI is therefore not an authority. It can create proposals and display them. It cannot approve or apply.
- A local process that forges an HTTP request to propose a change can create a proposal. That is acceptable, because a proposal is inert until a human-admin session approves it, and the approval shows the diff and proposer.
- A local process that tries to approve a proposal has no bound human-admin session, so the verb refuses it. A forged role header in the UI does not grant approval, because approval is not a UI action (COORD-940 covers the launcher and header fixes that prevent the UI from granting roles in development).
- The UI binds loopback only, by the COORD-940 fix. Remote access is out of scope for this ADR.
- Diff injection: the proposal is parsed as data against the target's schema. Free text in a diff is never executed.
- Replay: a proposal is bound to its base digest and to a single apply. A replayed approval after apply finds the proposal closed and refuses.

### 7. Failure and rollback

- A propose failure writes nothing except the refusal event.
- An apply failure restores the file to its before-state and journals `config.apply_refused`. The journal is append-only, so the refusal stays visible.
- A rollback of an applied change is a new proposal that restores the earlier content, approved like any other change. There is no undo verb that rewrites history. This keeps the audit trail honest.
- If the journal append fails after the file write, apply fails closed: the write is rolled back, and the operator is told to rerun. This keeps the file and the journal in step.

## Alternatives Rejected

- **Direct write from the UI, with a journal entry added afterwards.** Rejected: the write precedes the check, so a failed check leaves the file changed.
- **A side file of pending changes.** Rejected: it would be coordination state outside the journal (ADR 0020).
- **UI-only approval, or a UI-only permission model.** Rejected: COORD-939 requires the existing governance authorization, and a UI-only role is forgeable on a local host (COORD-940).
- **Making all configuration editable.** Rejected: guards, integration authority and the ratchet are governance itself. Editing them from a UI would let a local edit remove the checks that judge the edit.

## Adopted Instead

- Proposal and apply as journaled governed events, created and approved by verbs, with the approval using the existing human-admin override, and with apply under the runtime lock.

## Rationale

The UI is a convenience. The authority stays where ADR 0003 and ADR 0021 put it: in verbs, in the journal, and with a human-admin act. A proposal gives the operator the same diff and the same refusal text as the CLI, with no extra path that can change governed state. The closed editable list keeps the feature to configuration that governance already treats as adopter settings.

## Consequences

- The UI gains an edit flow, but every save is a proposal and nothing takes effect until a human-admin approval.
- There is one new proposal record type in the journal and two new verbs (`config propose`, `config approve`). Both are proposed here, not implemented.
- COORD-939's read views are unchanged. The write surface sits behind the same governed library.
- Implementation depends on COORD-940's launcher and header fixes. Without them, the threat model in section 6 does not hold for development use.
- Rollback is a forward proposal, so the history is longer, not rewritten.

## Revisit Trigger

- A second approver role is needed (for example, a delegated reviewer for low-risk exceptions). That needs its own ADR.
- The editable list grows past the first implementation's targets.
- A local UI is exposed beyond loopback. That needs a new access ADR, and this one does not cover it.
- The journal-append-after-write failure mode in section 7 is seen in practice.

## Waiver Policy

No waiver. An edit that bypasses the proposal path is a governance violation, not a waivable exception. Ticket-level exceptions keep their own human-admin path under `gov test-policy except`, unchanged by this ADR.

## Open Questions for the Human Admin

1. **Approval verb.** Accept the proposed `config approve --human-admin-override` verb as a new verb, or should approval reuse an existing verb (for example `gov reconcile` or `gov amend-ticket`)? Neither fits a config change cleanly, which is why a new verb is proposed. Resolved at acceptance (human admin, 2026-11-16): the new verb `config approve <proposal-id> --human-admin-override "<reason>"`, as proposed in Decision section 2 (a new verb, not an existing one).
2. **Which identity counts as a human admin for approval.** The current override checks a bound session. Should the UI's approval step also require the trusted SSO actor from ADR 0003, or is a bound CLI human-admin session enough? Resolved at acceptance (human admin, 2026-11-16): "a bound human-admin session, the same condition `resolveHumanAdminOverride` already enforces" (Decision section 2). The proposal adds no separate SSO-actor check to the approval step.
3. **Editable list.** Confirm the exact targets in section 4, especially whether the repo map and landing mode are config or derived state. Resolved at acceptance (human admin, 2026-11-16): the editable list in Decision section 4 as written. The repo map and landing mode are editable only if the implementation ticket confirms they are config and not derived state (section 4, last bullet of the editable list).
4. **Proposal storage.** Is a `config.proposed` journal event enough, or do large diffs need a content-addressed blob next to the journal? Resolved at acceptance (human admin, 2026-11-16): a `config.proposed` journal event, with the diff recorded in the proposal (Decision section 1). No content-addressed blob is proposed.
5. **Rollback.** Is a forward proposal the right model for rollback, or is a named `config rollback` verb wanted, still approved and journaled? Resolved at acceptance (human admin, 2026-11-16): a forward proposal: rollback is "a new proposal that restores the earlier content, approved like any other change", and no named `config rollback` verb is proposed (Decision section 7).
6. **Dependency on COORD-940.** Should implementation wait for the launcher and header fixes, or may the edit flow ship first behind a development-only switch? Resolved at acceptance (human admin, 2026-11-16): implementation waits for the COORD-940 launcher and header fixes (Consequences: "Implementation depends on COORD-940's launcher and header fixes. Without them, the threat model in section 6 does not hold for development use."). No development-only switch is proposed.
7. **Scope of exceptions.** Ticket exceptions already have a human-admin path. Should the UI show them for approval only, or also allow a proposal to add one? Resolved at acceptance (human admin, 2026-11-16): ticket-level exceptions stay on the existing `gov test-policy except` path and its `--human-admin-override` approval, and "this ADR keeps that path for ticket-level exceptions and does not add a second one" (Decision section 2). Section 4 lists them among the targets editable through proposals only.

## Approval State

Accepted by the human admin on 2026-11-16 (human-admin decision, given directly in the orchestrator session and recorded under COORD-1030). The Decision section is accepted as written. Acceptance settles the approval verb, the authority path and the editable list, as recorded under Open Questions for the Human Admin above. It does not authorize implementation, which is a separate ticket step (COORD-1027). Review by agents is not human approval.
