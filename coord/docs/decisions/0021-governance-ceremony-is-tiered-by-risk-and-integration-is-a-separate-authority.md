# ADR 0021: Governance ceremony is tiered by risk, and canonical integration is a separate authority

- **Status:** Accepted
- **Ticket:** COORD-919
- **Date:** 2026-11-06
- **Linked scope:** the guard registry (COORD-914); integration authority (COORD-915); run manifests and evidence reuse (COORD-910); fast checks at commit (COORD-906); advisory early coverage (COORD-907); gate wall time (COORD-904); opt-in sharding (COORD-900); test isolation (COORD-916); `coord/GOVERNANCE.md` sections on landing and gates.

## Context

Every governance incident so far has added a mandatory check, and none has been retired. Landing one ticket now takes about twelve governed steps. A full gate runs about 21,500 test executions: 5,681 on each Node lane, plus the Community cut (5,011) and the Enterprise cut (5,190). It takes 39 minutes on a 32-thread host and up to four hours on an 11 GB laptop. A 7-line test-runner change pays the same as a 250-file engine migration.

Landing the COORD-871..888 engine-migration stack on 2026-11-05 and 06 hit a guard on almost every ticket:

- the prompt content contract;
- the ADR requirement, and a separate ADR compliance closure;
- an ADR path packet for a one-line Ticket-metadata edit;
- two reconciles after governed files were restored byte-identically;
- the workspace-merge guard refusing byte-identical files;
- prodloc closeout unable to see budgets carried through a move (COORD-913, which needed a human break-glass fast-forward);
- a failing update-plan call silently dropping later fields;
- `gov sync` refusing to publish while any ticket was `doing` (COORD-911).

The same tree needed six gate attempts across two hosts before its evidence was accepted.

One guard did not exist. A second agent, registered remotely and connected over SSH to the canonical checkout, ran `gov sync --commit` between COORD-888's merge and its finalize, and committed the owning orchestrator's in-flight state. Nothing refused it: registration implied full authority, and the runtime lock serializes only single commands.

## Linked Scope

- Linked tickets: COORD-900, COORD-904, COORD-906, COORD-907, COORD-910, COORD-914, COORD-915, COORD-916.
- Proposal reviewed with the human admin and a remote reviewing agent: <https://claude.ai/artifact/9AVgsDpJMJFEYTAR4yRM9V> (version 4).

## Decision Criteria

- Every guard keeps its protective intent. Cost moves to where the risk is, not away from it.
- No reduction in assurance before the means of proving it is in place.
- Authority follows the coordination domain and the workspace accessed, never where an agent runs.
- Evidence is data that a machine can verify, not prose a human must reconcile.

## Options Evaluated

1. Keep the current model and add more hardware. This rejects nothing, but every guard still runs for every ticket, and the gates' cost grows with the suite.
2. Remove or relax individual guards case by case. Fast, but it repeats the accretion problem in reverse, and loses the incidents each guard answers.
3. Tier ceremony by risk, consolidate guards through a registry, make evidence reusable and machine-verifiable, and separate integration authority. This ADR chooses option 3.

## Decision

1. **Ceremony tiers, as direction only.** Every ticket is classified from its changed paths and declared type:
   - **T0:** docs, prompt text, test-only and fixture changes with no production engine path. T0 still runs the changed tests, and prompt changes that affect authority, ownership or acceptance scope are classified higher.
   - **T1:** ordinary engine or product changes within existing contracts.
   - **T2:** policy, trust, identity, upgrade, migration, release, ADR and other high-impact surfaces.

   A human admin may raise a tier, and nothing lowers one silently. Reduced gates switch on only after the guard registry is reviewed, and tier classification and affected-test selection are validated against full runs.
2. **The guard registry comes first (COORD-914).** It records every guard and gate check:
   - its tier;
   - the incident it answers;
   - overlapping guards;
   - implementation location;
   - measured cost;
   - failure remedy;
   - retirement criteria;
   - a review date.

   A refusal site with no registry entry fails a check. The registry changes no enforcement.
3. **Evidence reuse binds to every input.** Evidence is reused only when all of these match:
   - the code tree and base;
   - governance policy and gate configuration;
   - dependencies;
   - toolchain;
   - edition;
   - relevant environment settings.

   Reuse requires a machine-verifiable run manifest (COORD-910), and stacked reuse also needs a recorded batching decision.
4. **Coverage.** The whole-suite ratchet stays authoritative. Affected-suite coverage is advisory (COORD-907) until its selection and semantics are validated.
5. **Plan updates are transactions.** The whole request is validated, then applied atomically. A partly valid request changes nothing and names every failing field.
6. **Integration authority is a separate permission (COORD-915).** Registering an identity, owning a ticket attempt, and integrating canonical state are three distinct permissions:
   - Integration covers board publication, canonical commits, `sync --commit`, finalize and reconcile.
   - Each coordination domain has one integration-authority holder at a time.
   - An integration operation (merge, record evidence, finalize, publish) holds that authority from start to end.
   - Handoff is explicit and journaled, and an interrupted operation is preserved and needs verified recovery.
   - An SSH session into the canonical checkout is another writer in the same domain. An independent clone with its own runtime is an independent domain.
7. **Gate strategy.**
   - The full serial gate plus dual-release remains the bar for every release candidate, and runs nightly on the integration branch.
   - Every nightly failure is triaged. A demonstrated shared regression blocks the landings it affects. A failure shown to be environmental is recorded and does not block.
   - Opt-in sharding (COORD-900) is allowed on large hosts behind an equivalence proof.
8. **A passing gate does not authorize a landing by itself.** Existing governance and the applicable merge approval still apply.

## Alternatives Rejected

- **More hardware only:** it shortens the wait, but leaves accretion, prose evidence and the authority gap untouched.
- **Ad hoc relaxation:** it removes protections without recording which incidents they answered.
- **A global, cross-machine ticket mutex as the first step:** shared published ticket facts do not require globally exclusive execution claims. The model stays local exclusivity within a domain, independent preparation across clones, and controlled integration. Atomic remote claims (COORD-899) remain a later, separate decision.

## Consequences

- T0 and T1 changes will land in minutes once tiers are active, and human approvals concentrate on T2.
- Evidence is generated from manifests and git, so drafts stop going stale, and failed plan fields fail loudly.
- New guards cost a registry entry and a review date, which makes accretion visible.
- Until the registry is reviewed and selection is validated, every ticket still pays the full gate. This ADR changes no enforcement by itself.
- Risks and their mitigations:
  - **Misclassification:** the tier is computed from paths, never self-lowered, and caught by the nightly full gate.
  - **Missed dependencies in affected-test selection:** selection is proven against full runs before it counts.
  - **Evidence reuse hiding a changed input:** reuse binds to every input above.
  - **Consolidation losing a protection:** each merge lists its incidents and keeps a regression test for each.

## Revisit Trigger

Revisit this ADR in any of these cases:

- registry review shows a tier assignment that would have let a known incident through;
- affected-test selection misses a regression that the full gate catches;
- the nightly full gate fails on shared regressions more than twice in a release cycle;
- integration authority blocks a legitimate single-orchestrator workflow that has no governed alternative.

## Approval State

The decisions above were accepted by the human admin on 2026-11-06, with these safeguards: tiers as direction only until registry review and validation; evidence reuse only with machine-verifiable manifests; the guard registry first, with no enforcement change; integration authority with explicit handoff and recovery of interrupted operations.

That acceptance is of the decisions, not of this file. These exact bytes are adopted only when the human admin approves the governed ADR packet at COORD-919's landing. Review recommendations from agents, including the remote reviewing agent, informed the decisions but are not human approval of either.
