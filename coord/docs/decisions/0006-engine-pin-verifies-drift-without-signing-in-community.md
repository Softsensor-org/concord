# ADR 0006: Engine-pin verifies drift without cryptographic signing in Community

- **Status:** Accepted
- **Ticket:** COORD-435 (records the ENT-011 decision)
- **Date:** 2026-07
- **Linked scope:** `coord/engine-pin.json`; `TEMPLATE_SYNC_MANIFEST.json`; the engine-pin check; `gov upgrade` re-pin/verify/rollback.

## Context

A generated/adopted coord instance must be able to tell whether its governance
engine has drifted from the pinned upstream version — otherwise a silent local
edit to engine internals (or a stale copy) goes undetected. A full answer is
cryptographic signing (a signed conformance bundle proving the engine bytes are
authentic). Signing requires key custody (KMS/HSM) that the Community edition
deliberately does not ship. This ADR records why the Community edition pins and
verifies drift **without** signing, and where signing lives instead.

## Linked Scope

`coord/engine-pin.json` (the pinned manifest version/digest), the template-sync
manifest checksums, the engine-pin verification, and the `gov upgrade` flow that
re-pins, verifies, and rolls back on failure.

## Decision Criteria

- Detect engine drift deterministically and offline (no server, no keys).
- Keep the Community edition free of key-custody requirements.
- Leave a clean seam for Enterprise to add signed attestation later.

## Options Evaluated

1. **No pin** — rejected: drift is undetectable; a stale/edited engine looks
   legitimate.
2. **Signed conformance bundle in Community** — rejected: requires KMS/HSM key
   custody the Community edition intentionally omits, and adds operational weight
   for a single-team user.
3. **Checksum-pin + drift verify, signing deferred to Enterprise** (chosen) — pin
   the manifest version/digest, verify template-sync checksums against it, and
   surface drift; cryptographic signing is an Enterprise concern (ENT-008).

## Decision

The Community edition **pins** the engine version (`engine-pin.json`) and
**verifies drift** by checking the template-sync manifest checksums, but does
**not** cryptographically sign. Signed attestation (signed conformance bundles,
central re-hash) is deferred to the Enterprise edition (ENT-008).

## Alternatives Rejected

- Shipping signing keys with the open-source template (leaks custody; meaningless
  trust root).
- Trusting an unpinned engine (no drift detection at all).

## Consequences

- Community users get deterministic, offline drift detection; they do not get
  cryptographic proof of engine authenticity.
- Enterprise adds the signing/attestation layer on the same pin seam.
- Revisit trigger: if a keyless attestation mechanism (e.g. transparency-log
  style) becomes viable for the Community edition, reopen the signing decision.
