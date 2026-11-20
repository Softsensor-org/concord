# ADR 0017: Managed-auto action ledger extends the action-ledgers store with a redacted v2 chain and explicit coverage states

- **Status:** Accepted
- **Ticket:** COORD-492
- **Date:** 2026-10
- **Linked scope:** `coord/scripts/managed-auto-ledger.js` (slice 1); `coord/scripts/auto-mode-ledger.js` (v1 store and chain, unchanged); `coord/scripts/runtime-authority-hook.js` (existing v1 writer, unchanged); slice 2 consumers named under Consequences.

## Context

The optional managed-auto profile (COORD-490, COORD-491) needs evidence of the security-relevant effects an agent session produced: commands, file writes, network egress, secret-reference use and remote side effects. The governance journal records Concord lifecycle mutations only. Raw provider transcripts and tool output are unsuitable as audit artifacts because they can carry source, credentials, customer data and provider-private metadata.

A local store already exists. `auto-mode-ledger.js` writes `coord.auto-mode.ledger/v1` NDJSON records to `coord/.runtime/action-ledgers/<ticket>.ndjson`, with `sequence`, `previous_hash` and `hash` computed over canonical JSON. The runtime authority barrier (`runtime-authority-hook.js`) appends deny and subagent records there under a `<file>.lock` exclusive-create lock. The v1 records have no session lifecycle, no coverage semantics, no policy digest, and only key-name redaction applied after the record is assembled.

The human admin approved, on 2026-10-21, a bounded first slice under investigation status. This ADR records the architecture of that bounded slice. The remaining implementation is tracked separately; slice 1 must not be described as complete managed-auto enforcement.

## Linked Scope

- Linked ticket: COORD-492.
- Governing ticket: COORD-492.
- Slice 1 (this branch): ledger v2 schema, redaction before persistence, hash chain, session lifecycle markers, and the coverage verifier, with tamper, gap, crash and canary fixtures.
- Slice 2 (outstanding, to be filed separately): Git and policy-scope reconciliation, the redacted execution summary in the plan and journal with plan-schema changes, the managed-auto review and landing gate, evidence-export, and the human-admin technical policy exception.

## Decision Criteria

- Absence of events is never evidence of safe behavior.
- Nothing that could be a secret, payload, source body or full tool input or output is ever persisted, and this holds by construction rather than by a deny-list alone.
- One local, customer-controlled store per ticket. No hosted service and no duplication of journal lifecycle events.
- Existing v1 writers, the v1 verifier and journal hash-chain verification keep working unchanged.
- Deterministic replay: the same inputs and clock produce the same chain root.

## Options Evaluated

- **A. Extend the v1 store with a versioned v2 event schema on the same chain.** v2 events use the same file, the same `sequence`, `previous_hash` and `hash` fields, the same `entryHash` and the same lock-file protocol. v1 barrier records and v2 managed records then form one chain.
- **B. A parallel managed-auto store**, for example `coord/.runtime/managed-auto/<session>.ndjson`, with its own chain.
- **C. Record managed-auto effects in the governance journal.**
- **D. Retain redacted provider transcripts.**

## Decision

Adopt option A.

1. **Store and chain.** `managed-auto-ledger.js` writes `coord.auto-mode.ledger/v2` events into the existing `coord/.runtime/action-ledgers/<ticket>.ndjson` file. The chain fields and hash function are the v1 ones, so `auto-mode-ledger.verifyLedger` still accepts a mixed v1 and v2 file. The v2 verifier also accepts v1 records for chain integrity, but never counts them toward managed coverage (it reports them as `legacy_v1`). Appends use the same `<file>.lock` exclusive-create protocol as v1, so the barrier and the managed recorder serialize on one file. Appending onto a ledger with an unparseable line is refused rather than silently extending a corrupt chain.
2. **Schema.** Each v2 event carries `schema`, `type`, `ts`, `ticket`, `session`, `provider`, `policy_digest`, the chain fields and `redaction` metadata (schema, redacted field names, dropped field count). Actions also carry `kind` and `operation_class`, `tool`, `decision`, `rule`, `result`, `duration_ms`, and a relative `resource` with its `resource_scope`. Per kind: commands keep only a command class, a two-word summary and a digest of the scrubbed command. Files keep a worktree-relative path (outside paths become `[outside-worktree]`) and before and after digests. Network events keep the destination host and port and the decision. Secret uses keep a reference ID and a bounded purpose. Git, MCP and governance events keep a bounded operation identifier and an optional commit SHA.
3. **Redaction before persistence, failing closed.** Normalization reads only a closed whitelist of input fields. Raw tool input and output, environment values, payloads and source bodies are dropped by construction and counted, never copied. Free-text fields are scrubbed against the session's known secret values (including environment values whose names look sensitive) and against assignment, bearer and token-shape patterns. Identifier-like required fields (path, destination, secret reference, tool, rule) are refused if they contain a secret, because a partly masked identifier is not trustworthy evidence. A final check refuses any event whose serialized form still contains a known secret. A refusal throws `LedgerNormalizationError`, which names only a code and a field, writes nothing, and must fail the affected managed action.
4. **Session lifecycle markers.** The markers are `session_start` (with the adapter version), `heartbeat`, `session_end`, `interruption`, `adapter_failure`, `bypass` and `unmanaged`, plus `action` events. Both supported provider adapters, `claude` and `codex` (`auto-mode-adapters.PROVIDERS`), are accepted. Any other provider is refused.
5. **Coverage states.** The verifier reports `integrity` (valid or invalid) separately from `coverage`. Coverage takes exactly one of five values, in this order of precedence:
   - `unmanaged`: no managed session, or an `unmanaged` marker;
   - `bypassed`: a `bypass` marker;
   - `interrupted`: an `interruption` or `adapter_failure` marker, or no clean `session_end`;
   - `partial`: any integrity or session issue, such as a missing or duplicate start, duplicate end, events before start or after end, a changed policy digest or provider, a clock regression, a ticket mismatch, or a heartbeat gap above the configured maximum;
   - `complete`: none of the above.
   `ok` is true only for valid integrity with complete coverage. The `chain_root` is the hash of the ledger head and `session_head` is the hash of the selected session's last event. Diagnostics carry codes and sequence numbers only, never values.

## Alternatives Rejected

- **B (parallel store)** would leave two hash chains for one ticket that can disagree about ordering, and would duplicate the lock protocol and file layout the barrier already uses. A reviewer would have to reconcile two local ledgers before reconciling either with Git.
- **C (journal)** conflicts with the ticket's non-goal of not duplicating lifecycle events. It would also put high-volume, customer-sensitive effect records into tracked durable evidence, which ticket scope requires to stay local and customer-controlled.
- **D (transcripts)** is excluded by the ticket: even redacted transcripts keep payloads and provider metadata that a deny-list cannot reliably clean.
- **Rewriting v1 records or migrating v1 writers** was rejected for this slice to keep the barrier's behavior and its tests unchanged.

## Consequences

- The detailed ledger stays local under `coord/.runtime` (ignored runtime state). Only a redacted summary leaves it. In slice 2 that summary will be the policy digest, chain root, event counts, coverage, gaps, diff digest and reconciliation verdict, written into the ticket plan and journal.
- The chain is tamper-evident, not tamper-proof. Anyone with write access can rewrite the whole file consistently, and truncating the tail of a chain is only visible as a missing `session_end`. The chain root must therefore be anchored in governed evidence (slice 2) for tamper detection to bind.
- Command digests are taken over the scrubbed command, so a known or pattern-shaped secret never feeds a hash. Unrecognised low-entropy arguments still influence the digest, which a determined reader could probe offline. Summaries keep at most the program name and one argument.
- A secret that is neither registered nor pattern-shaped can still appear in a recorded identifier such as a file path. Adapters must register known secret values with the recorder. Registered values shorter than six characters are not matched, to avoid masking ordinary words.
- Ordinary governance-only tickets are unaffected: slice 1 adds no gate wiring, and a ticket with no managed session reports `unmanaged`, never a failure of the existing gates. Slice 2 must keep that labeling rather than blocking or upgrading such tickets.
- Slice 2 consumers: `managed-auto-reconcile.js` (Git status, diff and commit, plus policy declared scope), `governance-validation.js` (review and landing gate), `coord/engine/board/plan.schema.json` (execution summary), `evidence-export.mjs`, and the human-admin technical policy exception (with a recorded reason, named gaps and a residual-risk statement; not a legal waiver).

## Security and Claim Limits

This ledger is evidence for the optional managed-auto profile. It is not a guarantee that all local activity was observed, and it is not a legal waiver or compliance attestation.

## Revisit Trigger

Revisit if a third provider adapter is added, if v1 barrier records are migrated to v2, if the chain root needs a keyed or signed anchor, or if slice 2 reconciliation needs fields that this schema does not carry.

## COORD-860 additive action-attempt and receipt contract

This follow-up contract extends the accepted ledger architecture for slice 2. It changes no accepted slice-1 architecture or claim limit.

1. **Compatible event envelope.** Keep `coord.auto-mode.ledger/v2`, the existing per-ticket NDJSON file, `sequence`, `previous_hash`, `hash`, `entryHash`, and the v1/v2 shared lock. Do not create a second ledger and do not change v1 records or writers. Add the following optional v2 action fields; the integrity verifier continues to hash and validate the entire entry as it does today:
   - `action_id`: opaque stable identifier for one logical operation, scoped to the ticket and session; match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
   - `attempt_id`: opaque identifier for one authorized execution attempt of that logical operation; same syntax as `action_id`. A retry of one logical operation retains `action_id` and receives a new `attempt_id` only after the prior attempt has a terminal result and policy permits retry.
   - `phase`: exactly `attempt` or `result`.
   - `receipt_id`, `receipt_digest`, `receipt_capability`, `receipt_target_class`, `receipt_target_digest`, `receipt_result`, and optional `receipt_external_id_digest`: receipt fields are permitted only on a `result` phase. IDs and classes are bounded safe identifiers, digests are lower-case SHA-256 hex, and `receipt_result` uses an existing terminal value from `EVENT_STATUSES`, never `attempted`. The event's own `action_id`, `attempt_id`, ticket, session, provider and policy digest bind the receipt to its originating action. No unredacted external identifier or receipt body is retained.

2. **Attempt/result meaning.** Every new managed effect is appended as an `attempt` before dispatch and a terminal `result` after the action returns. The attempt event carries `result: "attempted"` and the policy decision. The result event carries a value from the existing `EVENT_STATUSES` vocabulary other than `attempted` and repeats the same `action_id` and `attempt_id`; `allowed` records an allowed action state but does not establish process completion or a required remote outcome. Process actions require a terminal `completed`, `failed`, or `interrupted` result; denied actions use `denied` and must not dispatch. A denied attempt records its denied result and must not dispatch. A missing result, an invalid phase transition, multiple conflicting terminal results, or a result without its attempt produces an explicit partial/interrupted evidence gap; it never implies no effect. For remote actions requiring a broker receipt, a successful/allowed terminal result without a complete attributable receipt is a gap.

3. **Receipt projection and redaction.** The recorder accepts a receipt only through a closed whitelist: receipt ID, ticket, capability class, redacted target class/digest, result, and optional external-ID digest; the receipt ticket must equal the enclosing event ticket. It stores target class and digest in `receipt_target_class` and `receipt_target_digest`, and computes `receipt_digest` from canonical JSON of the complete normalized projection, including receipt ID. It never hashes or stores raw receipt payloads, provider output, command output, source, environment values, credentials, or arbitrary receipt fields. Known-secret values in any required identifier cause refusal before append; a final serialized secret check remains mandatory. Error text and diagnostics expose only stable issue codes, action/attempt IDs where safe, and ledger sequence numbers.

4. **Replay and idempotency.** The uniqueness key is `(ticket, session, action_id, attempt_id, phase)`. IDs are generated before any side effect, `attempt_id` is unique within its `action_id`, and the first append for a pair must be the attempt phase. Replay equivalence compares the normalized caller-semantic action and receipt fields and the derived `redaction` metadata. It excludes writer-generated `ts`, `sequence`, `previous_hash`, and `hash`; `redaction` remains included because different redacted fields or dropped-field counts describe a different normalized event and are part of the hashed evidence. The action-begin API returns `{ entry, replayed }`. Re-appending an equivalent normalized event for an existing key is a no-op that returns the existing entry unchanged with `replayed: true`; the caller must not dispatch the effect again. Reusing a key with any conflicting normalized semantic body or terminal result refuses without writing. A result phase is accepted only after its matching attempt phase and only once (an identical replay is a no-op); a result without an attempt or a second conflicting result refuses without writing. A genuinely new attempt uses a new `attempt_id`. Remote broker requests use `action_id` as their idempotency key and must return the same attributable receipt for a replay; if an external endpoint cannot guarantee idempotency, an attempt with an unknown outcome is not automatically retried and stays partial until resolved by attributable evidence or the human-admin technical exception. A local process attempt with no terminal result is likewise never automatically relaunched. This is an evidence/retry contract, not an exactly-once guarantee for effects outside a cooperating idempotent broker.

5. **Legacy and missing data.** Existing v1 records remain valid for chain integrity and never count toward managed coverage. Existing v2 action records without `action_id`, `attempt_id`, or `phase` (or without a required result/receipt) remain integrity-readable, but cannot satisfy correlation or required-receipt coverage; reconciliation reports a stable missing-correlation/receipt gap and `partial`. A truncated chain, absent terminal result, absent required receipt, or missing ledger for a previously declared managed session remains an explicit gap. No legacy record is retroactively assigned an action ID, receipt, or successful outcome, and absence of a record never proves that an effect did not happen.

6. **Policy and claim boundary.** COORD-860 defines policy allowlist matching for observed network destinations, secret-reference IDs/purpose classes, process command classes/results, file/Git changes, and broker capabilities/targets. A policy digest must be deep-canonical over the full declared policy (excluding its derived digest field); nested policy changes must change the digest. This amendment does not assert that adapters observe surfaces they declare unmanaged, does not introduce provider hooks, OS sandboxing, or new containment, and does not expand the accepted claim that only activity inside a declared observation boundary can be assessed. Ordinary unmanaged tickets retain existing gates. A human-admin technical exception records the reason, exact named gaps and residual risk through the current governed explicit operator-attestation path; it is not a legal waiver and does not rewrite the underlying coverage or integrity verdict.

7. **Required qualification.** Production-path regressions must cover allowed and unexplained effects for file/Git, egress, secret reference, process/result, and remote receipt classes; denial before dispatch; missing, partial, mismatched and replayed receipts; interrupted attempts; identical and conflicting retries; a retry after an unknown external outcome without duplicate dispatch; legacy v2 events without correlation; tampered, corrupt and truncated ledgers; concurrent append; policy nested-key digest changes; Git changes after reconciliation; rollback/persistence failure; and canary values absent from plan, journal and export. The export reads only the redacted canonical summary and never opens or emits the raw action ledger.

### Amendment rationale and boundaries

The accepted v2 envelope already carries result, destination, secret-reference, operation, decision and commit facts, and the existing broker already returns a redacted receipt. The additive fields above supply only the missing correlation and receipt binding required to reconcile process outcomes, retries, and remote receipts. All records remain on the accepted action-ledger chain. The review/landing summary and gates, plan/journal anchoring, evidence export, technical exception, unmanaged compatibility and claim limits remain as decided above.

## Approval State

Originally proposed by claudea11 under the 2026-10-21 investigating disposition. Acceptance applies to the architecture and bounded slice 1; Git reconciliation, governed summary anchoring, export and gate enforcement remain explicit follow-up work.
