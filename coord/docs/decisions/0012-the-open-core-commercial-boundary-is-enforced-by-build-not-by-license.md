# ADR 0012: The open-core commercial boundary is enforced by build, not by license

- **Status:** Accepted
- **Ticket:** COORD-111, ENT-007, ENT-008, ENT-009
- **Date:** 2026-09
- **Linked scope:** the Enterprise-only subtree; the import-boundary rule; the public-release builder; and the fail-closed release leak scan.

## Context

Concord ships from one donor repository under Apache-2.0 but is delivered as two
editions: Community (per-team, OSS) and Enterprise (central). Some mechanism has
to decide what a given adopter receives, and that choice determines whether the
commercial model is defensible at all.

The obvious mechanism — a runtime licence check or entitlement flag — was not
chosen. This record captures why the boundary is instead a property of the
**build**, and why the Enterprise source being readable does not surrender the
commercial position.

This record is written after the fact. COORD-111 implemented the boundary and is
`done`; the gates are in place and green. The ADR exists because the decision is
currently legible only in ticket titles and code comments, and a reviewer reading
the donor tree can reasonably conclude there is no boundary at all. That
misreading has already occurred during a governance audit, from exactly the
evidence a careful reader would consult: `TEMPLATE_SYNC_MANIFEST.json` and
`coord/engine-pin.json` both list every Enterprise file, because they track the
**donor** surface, which by design holds both cuts.

## Linked Scope

- Governing ticket: COORD-111.
- Enterprise implementation: an isolated, edition-specific subtree (46 files at the time of this decision).
- Import-boundary rule in `coord/scripts/arch-checks.js` (COORD-111 comment block).
- Community cut builder and its `--enterprise` variant: `release/build-public-release.sh`.
- Fail-closed leak scan: `release/scan-enterprise-refs.sh`.
- Maintenance guidance for the two-edition release process is kept outside the public artifact.
- Related decision: ADR 0006 records the narrower case — Community pins and verifies engine drift *without* signing, leaving signing to Enterprise. This record generalises that seam to the whole commercial boundary.

## Decision Criteria

- The Community artifact must contain no Enterprise code, provably, not by convention.
- The check must fail closed: an incomplete strip must break the release rather than ship quietly.
- One donor must remain the source of both editions, so the two cannot drift apart.
- The commercial asset must survive the Enterprise source being readable, since Apache-2.0 permits redistribution and enterprise buyers routinely audit.
- No mechanism may weaken the fail-closed posture the rest of the engine depends on.

## Options Evaluated

1. **Runtime licence key / entitlement flag.** Enterprise modules ship everywhere and refuse to run without a valid key.
2. **Separate private repository.** The Enterprise tier lives outside the donor entirely, with its own history and release channel.
3. **Build-time strip with an enforced boundary.** One donor; the Community cut deletes the Enterprise subtree; a static import rule and a leak scan prove the strip is complete.

## Decision

Adopt option 3. The commercial boundary is a property of the built artifact,
enforced at five layers:

| Layer | Mechanism |
|---|---|
| Code demarcation | An isolated module subtree is included only in the Enterprise edition |
| Import gate | arch-checks `imports` rule denies any core → enterprise specifier |
| Builder strip | `build-public-release.sh` strips the subtree by default; `--enterprise` keeps it |
| Leak scan | `scan-enterprise-refs.sh` hard-fails on a surviving enterprise path or import |
| Distinct artifacts | `softsensor-concord` vs `softsensor-concord-enterprise` |

Enterprise modules are additionally **not wired into the core `gov` CLI**; each
ships its own entrypoint. Removing the subtree therefore cannot leave a dangling
verb on the Community surface.

The commercial moat is **not** the Enterprise source. It is cryptographic
conformance: signed engine-and-policy bundles (ENT-008) and central re-hash
verification that the project edge cannot forge (ENT-007). Without that
conformance the control plane is advisory; with it, the control plane is
enforceable. Whoever holds the vendor signing authority is the vendor, and that
property is unaffected by the code being readable.

## Alternatives Rejected

**Runtime licence key.** Rejected on three grounds. It contradicts the
fail-closed ethos: a governance engine whose behaviour can be altered by a
missing key teaches adopters that controls are negotiable. It places the
commercial check inside the same process as the authority checks, so a bypass of
one sits adjacent to a bypass of the other — the standing objection in this repo
that a guard with a credential keeps the credential where the attacker is. And
under Apache-2.0 it is trivially removable, buying compliance theatre rather than
defensibility.

**Separate private repository.** Rejected as premature rather than wrong. It
gives the cleanest boundary but doubles the maintenance surface precisely where
the two halves are designed to interlock: `gov conform --attest` (ENT-010) emits
the exact input ENT-007 re-computes, and `verify-engine` (ENT-011) is the
unsigned half of ENT-008. Splitting the repository would turn that seam into a
cross-repository contract, subject to the same release-carriage and traceability
problems already tracked on the board. Retained as the escalation if the strip
ever proves unreliable.

## Adopted Instead

One donor, two cuts, with the boundary enforced statically by the import rule and
at release time by the strip plus a fail-closed leak scan — and the commercial
value located in key custody and central verification rather than code secrecy.

## Rationale

A build-time boundary is checkable. "Zero core → enterprise imports" is a fact a
reviewer can reproduce; "the licence check is present" is not evidence that the
code is absent. The leak scan is deliberately scoped to the *path and import* of
the enterprise subtree rather than the English word "enterprise", so
adopter-facing prose that legitimately mentions enterprise integration survives
the cut — a narrower and therefore more trustworthy rule than a keyword filter.

Locating the moat in signing authority also resolves the apparent tension with
Apache-2.0. The licence lets anyone read, fork, and run the Enterprise code; none
of that lets them issue attestations an organization will trust, because trust
attaches to the key and the verifier, not to the algorithm. This is the same
posture as a public certificate authority or a transparency log.

## Consequences

- The donor tree legitimately contains both editions. `TEMPLATE_SYNC_MANIFEST`
  and `engine-pin.json` list Enterprise files by design; **neither is evidence
  about the contents of the public artifact.** The published cut is the output of
  `build-public-release.sh`, and the npm staging step packages that output, not
  the donor tree.
- Release integrity depends on the leak scan actually running on every Community
  cut. If it is skipped, the boundary is unenforced for that release and nothing
  else will detect it.
- The Enterprise cut carries its own artifact identity and therefore its own
  release provenance, version pinning, and carriage obligations.
- Key custody becomes a first-class operational responsibility. The moat is only
  as strong as protection of the ENT-008 signing authority; compromising or
  casually distributing it forfeits the commercial position in a way no code
  change can restore.
- Adopters granted donor access can read Enterprise source. Donor access is
  therefore a commercial decision, not merely an engineering one.

## Revisit Trigger

Reopen this decision if any of the following occur:

- the leak scan or the import rule reports a finding on a Community cut — the
  strip is not reliable, and option 2 becomes the fallback;
- a third party stands up a competing attestation verifier that organizations
  accept, which would mean the moat was in the code after all;
- the Community and Enterprise halves stop interlocking — for example if
  attestation formats diverge — removing the maintenance argument that keeps them
  in one donor;
- signing authority moves to a customer-managed KMS in a way that transfers the
  vendor role out of the vendor.

## Waiver Policy

No waiver path. A Community cut that fails `scan-enterprise-refs.sh` must not be
published; the correct response is to fix the strip and rebuild, never to
override the scan. Suppressing the import rule for a specific module is likewise
not a waiver but a re-classification: if a core module genuinely requires an
Enterprise capability, that module is Enterprise-tier and moves into the subtree,
as COORD-111 already specifies for core verbs that depend on Enterprise modules.
