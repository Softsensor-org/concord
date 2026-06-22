# Memory Architecture — Concord's Governed Memory Layer

> **Tagline:** *"Memory you can audit, not memory you have to trust."*
>
> **Status:** design spec (canonical). No memory feature is implemented by this
> document; it defines the architecture and registers the phased `[Memory]`
> backlog (COORD-140..149). Authority for anything claimed here is the repo
> itself — every factual claim below cites the real file/function it rests on.

---

## 1. Thesis & positioning

Concord is a **governance-grade memory substrate for software agents** —
memory that is **durable, inspectable, replayable, attributable, and
tamper-evident** — evolving into a **governed learning system for software
delivery**.

The governing principle is **source-backed, not model-inferred**. Summaries,
indexes, and embeddings are *derived views*; the **journal**
(`coord/scripts/journal.js`), the **board** (`coord/board/tasks.json`,
`coord/board/board.js`), the **plan records** (`coord/scripts/plan-records.js`),
the **git history**, and the **signed conformance attestations**
(`coord/scripts/conformance-attestation.js`) remain the authority. A derived
view is never evidence; it is a convenience pointer back to the hash-linked
source.

This reframes the question-class Concord can answer:

| | Question class |
|---|---|
| **Today (operational governance)** | *"What is happening, who owns it, what evidence exists, can we recover/land safely?"* |
| **With governed memory** | *"What have we learned, what patterns recur, what should we do next, and how do we execute it safely?"* |

The second class is the **learning system**. It is built *on top of* the first,
and — critically — it only ever **recommends**; it never decides (see §5).

---

## 2. The precise trust model

This section states the trust model **exactly**, because it is easy to overclaim
and a prior draft did.

**Journal events are hash-chained and attributed — they are NOT per-event
signed.**

- **Hash-chained.** Each appended event carries `prev_event_hash`, the canonical
  hash of the prior stored event (`coord/scripts/journal.js`: the
  `prev_event_hash` stamping at append time and the chain-walk verification that
  requires each event's `prev_event_hash` to equal the canonical hash of the
  prior stored event). The chain begins at a genesis marker (`CHAIN_GENESIS_PREV`);
  legacy **pre-chain** events have no `prev_event_hash` and are accepted-but-
  unverified rather than rewritten. Re-ordering or altering a chained event
  breaks a `prev_event_hash` link and is detectable.
- **Attributed.** Each event carries an `identity` field (`coord/scripts/journal.js`
  reads `metadata.identity?.agent?.handle`), so every event records *who* emitted
  it. (Pre-chain / system events may carry `identity: null`.)
- **No per-event signature.** A journal event has **no `signature` field**. Its
  schema is, in order: `ts`, `command`, `ticket`, `before_status`,
  `after_status`, `identity`, `result`, `details`, `changed_paths`,
  `snapshot_digest`, `prev_event_hash`. There is no cryptographic signature on
  the individual event.

**The signature lives once, over the chain head.** The **conformance
attestation** (`coord/scripts/conformance-attestation.js`) derives a
deterministic subject digest over the engine-integrity inputs — and that subject
**includes `journal_chain_head`**, the journal hash-chain head — then **signs
the digest with a local ed25519 keypair** (`SIGNATURE_ALGORITHM = "ed25519"`,
`crypto.sign(null, Buffer.from(subjectDigest, "hex"), privateKey)`). The
wall-clock `issued_at` lives in the outer envelope, not in the signed subject,
so the digest stays reproducible.

**What this proves:**

- **Integrity + order** — via the hash chain (`prev_event_hash`).
- **Anchored trust** — via **one** ed25519 signature over a subject that
  includes the chain head, so the whole chain is anchored by a single signature,
  **not N**.
- **Per-event attribution** — via the `identity` field.

So Concord can prove **where prior context came from and that it has not been
reordered or altered since the last attestation**.

**What this does NOT prove (state it honestly):** there is **no per-event
non-repudiation**. The attestation anchors the chain head, not each event
individually. Per-event or batch signing is a **future** item, tied to the
KMS / key-custody roadmap (tracked as COORD-146).

---

## 3. The 4-layer memory model

| Layer | Question | Current Concord fit | Needed refinement |
|---|---|---|---|
| **Operational** | *what happened* | Journal (`coord/scripts/journal.js`), board (`coord/board/tasks.json`), plan records — hash-chained, attributed, rendered. **Already strong.** | None for the substrate; this is the raw truth other layers derive from. |
| **Decision** | *why it happened* | Plan records (`coord/scripts/plan-records.js`): `requirement_closure` (ticket-ask / implemented / not-implemented / **deferred-to** / verdict), `self_review_cycles` (each with `lens`, `risks`, `findings`, `verification`, `verdict`), `critical_invariants`; plus `QUESTIONS.md`. The *why* is **already captured as required fields**. | **Extract & index decision records.** This is **cheap** — a *transform of fields the validator already requires*, not model inference (COORD-140). |
| **Semantic** | *what this means* | **Not built.** No retrieval/recall surface today. | `gov recall` (§7), hybrid retrieval (§6) — deterministic first (COORD-141), vector/graph later (COORD-143). |
| **Procedural** | *how agents should behave* | The 19 skills under `.claude/commands/` + `AGENTS.md` + `CLAUDE.md` + `GOVERNANCE.md` — already version-controlled and changed only via PRs. | Route **learned** rules through submit/review/land — never silently rewrite agent behavior (COORD-145). |

---

## 4. Capability map (the learning-system payoff)

Each capability is tagged with the layer(s) it draws on. **Every one of these
RECOMMENDS; none of them DECIDES** (see §5).

### Strategic (operational + decision)

- Repeated **failure-theme detection** across tickets / gates / reviews /
  recoveries.
- **Architectural-debt by subsystem** from real touch + failure history.
- **Explain why** a past decision was made (drawn from `requirement_closure` /
  `self_review_cycles`).
- **Recommend roadmap / backlog priorities** from real execution evidence.
- **Detect churn-instead-of-value** (motion without closure).
- Show **which repos / teams have weak gates, slow reviews, or high recovery
  load.**

→ Registered as COORD-147 (execution-insight reports).

### Solving (all layers)

- **Retrieve the most relevant** prior tickets / decisions / files / gates /
  fixes **before** an agent starts.
- Generate **better-scoped plans**.
- **Prevent agents repeating already-failed approaches.**
- Recommend **safe work decomposition.**
- **Guide test selection** from touched-area + past failures.
- Provide **recovery playbooks** from similar historical incidents.
- Auto-produce **evidence-backed closeout summaries.**

→ Registered as COORD-148 (pre-work context pack + prevent-repeated-failures)
and COORD-149 (auto closeout summaries).

---

## 5. The cardinal guardrail

> **Memory RECOMMENDS. Governance DECIDES. Sources are CITED. Execution remains
> GATED.**

Concretely:

- **No uncited strategic claims.** A recommendation that cannot point at its
  hash-linked source is not emitted.
- **No silent rewriting of agent behavior.** Procedural-memory changes go
  through the governed lifecycle (submit → review → land), exactly like every
  other change to `.claude/commands/`, `AGENTS.md`, `CLAUDE.md`,
  `GOVERNANCE.md`.
- **Summaries are convenience; the hash-linked source is evidence.** When source
  and summary disagree, source wins and the summary is invalid.
- **Execution stays gated.** Memory may *recommend* a plan, a test set, or a
  recovery; the existing gates, reviews, and conformance still decide whether it
  lands.

**The risk to avoid:** becoming *"another opaque AI assistant"* — a black box
that asserts conclusions you cannot trace. Concord's whole edge is the opposite.

---

## 6. Design principles

1. **`coord/memory/` is derived + rebuildable.** Its contents — `index.json`,
   `decisions.ndjson`, `summaries/{tickets,epics,subsystems,repos}/`,
   `embeddings/`, `recall-cache/` — can be deleted and regenerated. **Raw truth
   stays** in the journal, board, plans, git, and attestations. Losing
   `coord/memory/` loses no authority.

2. **Hybrid retrieval, not vector-only.** Retrieval is a pipeline:
   `exact id/path` → `BM25 / SQLite FTS` → `vector similarity` → `graph links`
   → `recency/status filters` → **source-trust weighting**. Vector-only
   retrieval returns plausible-but-wrong matches; Concord's edge is **structured
   provenance**, so deterministic and provenance signals lead.

3. **Provenance-weighted recall (Concord-unique).** **Chained-and-attested**
   memory outranks **legacy-unverified pre-chain** memory. Every citation is
   explicitly labeled `verified` or `legacy-unverified`, reusing the journal's
   own chained-vs-pre-chain distinction.

4. **Permission classification.** Memory artifacts are classified
   `public | internal | sensitive | secret-prohibited` and enforced through the
   **existing ENT-012 RBAC redaction** (`coord/scripts/coord-ui-access-core.js`):
   a viewer gets redacted summaries; operator/admin get full provenance.

5. **Summary tiers carry provenance.** Each summary carries `source_hashes`,
   `generated_at`, `chain_head`, and an **"invalid if source changed"** flag, so
   a stale summary is detectable and refused rather than silently trusted.

---

## 7. The `gov recall "<query>"` contract

`gov recall` returns a **cited answer**, never a bare assertion:

```json
{
  "query": "...",
  "answer": "...",
  "sources": [
    {
      "type": "ticket|decision|event|file",
      "id": "COORD-095",
      "path": "...",
      "event_hash": "...",
      "chain_head": "...",
      "verified": true
    }
  ],
  "confidence": "high|medium|low",
  "staleness": "fresh|stale"
}
```

**No uncited memory claims.** Every element of `answer` must be backed by an
entry in `sources`, each pinning an `event_hash` + `chain_head` and a `verified`
flag. `staleness` reflects whether the cited sources still match their recorded
hashes.

---

## 8. Phased plan

| Phase | What | Cost | Now / Later | Ticket |
|---|---|---|---|---|
| **Phase 0** | Prove the substrate: extract `decisions.ndjson` from existing plan fields (`requirement_closure`, `self_review_cycles`, `critical_invariants`) **+ build an eval benchmark FROM REAL REPO HISTORY** (e.g. *"why was COORD-095 deferred?"*, *"which files define conformance signing?"*, *"what broke during multi-agent Playwright contention?"*) | **Cheap** | **Now** | COORD-140 (P1, ready) |
| **Phase 1** | `gov recall` **deterministic-first**: id/path + FTS/BM25 + provenance weighting, source-cited, permission-aware, **NO vectors** | Medium | Later | COORD-141 (deferred) |
| **Phase 2** | **Summary tiers** (ticket → epic → subsystem → repo) as derived artifacts with `source_hashes` + invalidation | Medium | Later | COORD-142 (deferred) |
| **Phase 3** | **Semantic layer**: vector similarity + graph links, **measured vs the harness** from Phase 0 | High | Later | COORD-143 (deferred) |
| **Cross-cutting** | Permission classification + role-based recall on ENT-012 RBAC | Medium | Later | COORD-144 (deferred) |
| **Cross-cutting** | Governed **procedural-memory promotion** (learned rules via submit/review/land) | Medium | Later | COORD-145 (deferred) |
| **Cross-cutting** | **Per-event/batch signing** for memory non-repudiation, **folded into KMS work** | High | Later | COORD-146 (deferred) |
| **Strategic** | Execution-insight reports (failure themes, arch-debt-by-subsystem, gate/review/recovery health) | Medium | Later | COORD-147 (deferred) |
| **Solving** | Pre-work context pack + prevent-repeated-failed-approaches | Medium | Later | COORD-148 (deferred) |
| **Solving** | Auto evidence-backed closeout summaries | Medium | Later | COORD-149 (deferred) |

**Eval metrics** (Phase 0 builds the harness; every later phase is measured
against it): **recall@k**, **citation precision**, **answer groundedness**,
**token savings**, **stale-answer rate**, **latency**, **redaction
correctness**.

---

## 9. Honest sequencing note

The 8-company adoption simulation found that the *required-for-adoption* items
are **tracker integration, SSO, and KMS** — **not** memory. No company is
blocked from adopting Concord by the absence of a memory layer.

Therefore the memory layer is the **differentiation / moat** — a
category-defining, design-partner-magnet play — and it is sequenced **behind**
those adoption blockers. Only **Phase 0 is cheap-now** and worth doing
immediately: it proves the thesis and **doubles as the best demo** —
recall-with-citations over a real governed project (this repo's own history).

---

## 10. What NOT to do

- **Don't lead with a vector DB.** It makes Concord look like *another RAG
  layer* and discards its provenance edge. Deterministic + provenance retrieval
  leads; vectors are Phase 3, gated on measured lift.
- **Don't let agents freely rewrite memory.** That is silent policy drift.
  Procedural-memory changes go through submit/review/land (COORD-145).
- **Don't treat summaries as evidence.** Summaries are convenience views; the
  hash-linked source is evidence.
- **Don't overclaim "semantic memory"** until `gov recall` exists *and* is
  evaluated against the Phase 0 harness.

---

## 11. State of the art (position against, don't reproduce)

| System | Memory angle |
|---|---|
| **OpenAI Agents SDK (sessions)** | Session continuity across turns. |
| **LangGraph** | Short/long-term memory; episodic / semantic / procedural split; hot-path vs background writes. |
| **MemGPT** | OS-style virtual-context tiers (paging context in/out). |
| **Zep / Graphiti** | Temporal knowledge graph over conversation/state. |
| **A-MEM / Mem0** | Self-organizing memory; token / latency savings. |
| **G-Memory** | Multi-agent **collaboration-trajectory** memory — directly relevant: Concord's journal **IS** native collaboration-trajectory memory, the *exhaust of governance*. |
| **Memory-governance-risk work** | Memory must be **inspectable and governable**, not opaque. |

**Concord's differentiated angle vs all of them: trust, provenance, and governed
use of memory.** Where others optimize recall quality or token economy, Concord
makes memory *auditable* — every recalled claim is anchored to a hash-chained,
attributed, attestation-anchored source, and every use of memory stays
recommend-only inside a governed, gated lifecycle.

---

## 12. Optionality, governance & how Concord is configured

### Two-layer optionality

- **Operational memory** (journal / board / plans) is **intrinsic** — it *is* the
  governance engine. You don't toggle it off; you control **access** (who can read)
  and **retention** (how long).
- **The recall / learning layer** (decision extraction, `gov recall`, summaries,
  semantic recall, the strategic/solving capabilities) is **opt-in, tiered,
  permission-scoped, default-conservative.** Tiers:
  `off (operational only) → decisions → recall → insights`, each opt-in and
  permission-scoped.

### Memory-governance challenges (ranked) + mitigation

1. **Surveillance / privacy framing — the #1 risk.** Strategic capabilities
   (weak-gates / slow-reviews / high-recovery / churn by repo or team) must be
   **aggregate, system-level — never individual performance monitoring.** This is a
   positioning + governance *stance*, not a feature flag: Concord memory exists to
   **improve delivery, not rank people.** Get this wrong and org adoption dies.
2. **Stale / wrong recall presented as fact** → source-cited + provenance-weighted +
   staleness-flagged; never uncited.
3. **Data governance** (retention, residency, right-to-be-forgotten, access audit) →
   classification (`public` / `internal` / `sensitive` / `secret-prohibited`) +
   retention/eviction + opt-in.
4. **Memory poisoning in multi-agent** → the hash-chain + `identity` + ownership
   guard stop tampering; provenance weighting + recommend-not-decide handle
   well-formed-but-wrong input.
5. **Authority confusion** → derived/rebuildable; summaries are convenience, the
   hash-linked source is evidence; invalid-if-source-changed.
6. **Opaque-assistant drift** → the cardinal guardrail (§5) enforced, not aspirational.
7. **Cost / dependency / latency** → deterministic-first (FTS before vectors),
   pluggable backend, graceful-skip.
8. **Opt-in discoverability paradox** (an off-by-default moat may never get enabled)
   → a clear enable path + the Phase-0 demo motivate it.

### How Concord is configured (the setup / admin stance)

The admin surface is small and **config-as-code**: `coord/project.config.js` (repo
map, `integrationBranch`, `ticketPrefixes`, `coordTicketPrefix`,
`defaultStartBaseRef`, arch-gate mode), gate thresholds (`GATE_COVERAGE_MIN`,
`GATE_AUDIT_THRESHOLD`), board-metadata governance cutoffs, `.mcp.json`, and
(future) optional-capability flags incl. the memory tiers. `coord init` bootstraps it.

- **Configuration changes go through config-as-code on the governed lifecycle** — a
  git PR/review, or a journaled, owner-bound `coord config` verb — so every
  enable/disable is an **audited, reversible, attributable governed event**.
- **Not a hosted runtime admin console** that mutates a live deployment — that would
  break the SEC-001/SEC-002 strictly read-only / fail-closed cockpit invariant (the
  web tier cannot mutate / spawn / write) and re-open SSO / RBAC / CSRF / config
  audit; it also contradicts the thesis that *changes go through governance, not
  opaque clicks*.
- The right setup UX, **if/when invested** (self-serve-era; deferred — **COORD-150**):
  (i) an **interactive `coord init` wizard** that *generates* the config-as-code you
  then commit (a scaffolder like `create-next-app`, not a live mutator); and (ii) a
  **read-only "Configuration" cockpit view** that surfaces the current config + what
  each option does + the governed command to change it (the same
  "render-the-command" pattern coord-ui uses for tickets via `buildTicketNextCommands`).
  This stance generalizes to **all** optional Concord capabilities, not just memory.

---

## Appendix — backlog index

| Ticket | Title | Status |
|---|---|---|
| COORD-139 | Write `MEMORY_ARCHITECTURE.md` + register the phased `[Memory]` backlog | (this ticket) |
| COORD-140 | [Memory] Phase 0: extract decision records from plans + real-history eval benchmark | **todo (P1)** |
| COORD-141 | [Memory] Phase 1: `gov recall` — deterministic hybrid, source-cited, permission-aware, no vectors | deferred |
| COORD-142 | [Memory] Phase 2: summary tiers (ticket→epic→subsystem→repo) with `source_hashes` + invalidation | deferred |
| COORD-143 | [Memory] Phase 3: semantic layer — vector similarity + graph links, measured vs the harness | deferred |
| COORD-144 | [Memory] Cross-cutting: memory permission classification + role-based recall on ENT-012 RBAC | deferred |
| COORD-145 | [Memory] Cross-cutting: governed procedural-memory promotion (learned rules via submit/review/land) | deferred |
| COORD-146 | [Memory] Cross-cutting: per-event/batch signing for memory non-repudiation (folded into KMS) | deferred |
| COORD-147 | [Memory] Strategic: execution-insight reports (failure themes, arch-debt, gate/review/recovery health) | deferred |
| COORD-148 | [Memory] Solving: pre-work context pack + prevent-repeated-failed-approaches | deferred |
| COORD-149 | [Memory] Solving: auto evidence-backed closeout summaries | deferred |
| COORD-150 | [Config] Setup/admin config UX — interactive `coord init` wizard + read-only Configuration view (config-as-code, not a runtime console) | deferred |
