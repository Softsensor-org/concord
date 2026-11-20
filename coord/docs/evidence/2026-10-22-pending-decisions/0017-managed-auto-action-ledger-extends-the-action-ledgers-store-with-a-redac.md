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

## Approval State

Originally proposed by claudea11 under the 2026-10-21 investigating disposition. Acceptance applies to the architecture and bounded slice 1; Git reconciliation, governed summary anchoring, export and gate enforcement remain explicit follow-up work.
