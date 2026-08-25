# Concord Code Review Baseline

Status: current repository review
Reviewed: 2026-07-29
Governing ticket: COORD-590

## Executive assessment

Concord has a serious control-plane core: canonical mutations are serialized,
crash restore points are persisted before writes, the journal is fsynced and
hash-chained, and closeout evidence is modeled explicitly. The main risk is no
longer the absence of governance mechanisms. It is divergence between those
mechanisms at their boundaries: documented commands versus parsers, legal
status forms versus open-coded equality checks, worktree success versus actual
landing, source schemas versus runtime validators, and donor tests versus the
published artifact.

The highest-value work is therefore contract reconciliation and end-to-end
proof, not another layer of policy.

## Scope and method

This review inspected the control-plane architecture, lifecycle and recovery
paths, journal transaction envelope, CLI and MCP transports, board and plan
schemas, requirements import, discovery/synthesis, operator cockpit, public
release builders, install paths, tests, and active CI workflows. It also ran
controlled probes for business discovery and malformed requirement metadata.

Source-backed findings are linked to an existing ticket where one exists. The
review does not treat generated discovery output or ticket prose as proof by
itself.

## Prioritized findings

| Priority | Finding | Evidence | Governing work |
| --- | --- | --- | --- |
| P0 | Repo-X `gov land` can mark a ticket done without merging its worktree branch. Board truth can therefore contradict git truth. | `coord/scripts/closeout.js`, repo-X branch in `landTicket`; no branch integration before `applyMarkDone` | COORD-512 |
| Resolved | Public cold start formerly retained root `init.sh` while removing its `create-concord/` target. COORD-618 retired the shim, removed it from release cuts/install surfaces, and pinned the absence in the artifact gate. | `init.sh`; `release/build-public-release.sh`; `release/check-public-release.sh` | COORD-520 / COORD-618 |
| P0 | CLI/operator contracts are manually duplicated and already drifted across help, aliases, flags, JSON names, enum literals, emitted remediation, and gate plans. `set-priority` is implemented but absent from general help; COORD-590's generated gate plan selected `coord gate-proc test`, which the product CLI rejected as an unknown command. | `coord/scripts/cli.js`, `lifecycle-flags.js`, `command-registry.js`, `gates/business-context.js`, gate-plan track command rendering | COORD-572 |
| P0 | The cockpit silently substitutes the engine root for configured product repos outside `PROJECT_ROOT`, producing plausible but false git/test health. | `frontend/apps/coord-ui/lib/project-config.ts#confineRepoDir`; consumers in `git.ts` and `tests.ts` | COORD-543 |
| P0 | Governance MCP uses LSP-style `Content-Length` framing only. Current MCP stdio requires newline-delimited UTF-8 JSON-RPC. | `coord/scripts/governance-mcp.js#createContentLengthMessageParser`; protocol ticket and real-client acceptance plan | COORD-482 |
| P0 | There is no location-independent, worktree-safe canonical test entrypoint. `npm test` from the `coord` package ran with the wrong root and failed on missing repo-root-relative paths; the direct root command in the mandated Repo-X worktree reached 2,156 tests but 7 mutation tests were rejected by the ephemeral-authority boundary instead of using isolated authority paths. | `coord/package.json`; `governance-context.test.js`; journal repair/migration tests | COORD-480 |
| P1 | Blocked-doing is handled inconsistently. Recovery, resume, forced claim, fresh session rebind, lock release, and MCP heartbeat do not form one safe lifecycle; applying one universal status predicate would also weaken the legal unblock-before-review transition. | `doctor-recovery.js#recoverTicket`; `agent-commands.js#resumeTicket` and `claimTicket`; agent rebind path; `lifecycle-lock-commands.js#releaseLock`; `governance-mcp.js#resolveHeartbeatTicket`; `ticket-transitions.js#moveToReview` | COORD-558 needs the role matrix in this baseline |
| P1 | `requirements-import` accepts malformed metadata as prose and silently coerces unknown values to defaults. A controlled probe turned bare `Kind: non_functional`, `Risk: R4`, and `Priority: P1` into functional/medium/P2 while returning one successful import. | `coord/scripts/requirements-import.js#METADATA_RE`, `normalizeKind`, `normalizeRisk`, `normalizePriority`; missing negative tests in `requirements-import.test.js` | COORD-525, now verified |
| P1 | `context_pack_ack` has three competing contracts: JSON Schema, runtime validator, and writer. The writer stores shapes the schema later rejects. | `coord/board/plan.schema.json`; `coord/scripts/plan-records.js` validation and `--context-pack-ack` writer | COORD-571, COORD-557 |
| P1 | Business-context gating is driven by ambiguous prose words and its remediation advertises an input shape its parser rejects. | `coord/scripts/gates/business-context.js`; context-pack acknowledgement gate | COORD-554, COORD-569 |
| P1 | Discovery output is too noisy to become authority automatically. A run over this repo emitted 882 records, 748 generic facts (84.8%), zero business-rule/decision records, and false domain-adapter matches. | `coord/scripts/business-discovery.js`; `business-discovery-synthesize.js`; controlled COORD-590 run | COORD-550 and children |
| P1 | No active push/PR workflow runs the governance test suite, gate lanes, template sync, engine verification, or dependency audit. | `.github/workflows/verify-fresh-clone.yml`; `.github/workflows/release-linux-binary.yml` | COORD-560, after COORD-480 |
| P1 | The eight synthesis documents and this domain model have no cockpit reader, so curated knowledge remains filesystem-only. | synthesis output list in `business-discovery-synthesize.js`; no matching readers under `frontend/apps/coord-ui` | COORD-540 |
| P1 | UI dependency work must be based on a fresh audit, not the superseded advisory narrative. Installed versions are Next 15.5.19, PostCSS 8.4.31, and sharp 0.34.5; the corrected ticket is the authority for remediation. | `frontend/apps/coord-ui/package-lock.json` | COORD-573 (supersedes COORD-548) |

Test-entrypoint comparison: the direct root command passed all 2,156 tests in
the canonical integration tree. The same command in the required Repo-X linked
worktree passed 2,149 and failed seven because mutation fixtures reached live
authority paths; package-directory `npm test` introduced additional root-path
failures. This isolates COORD-480 to invocation and sandboxing rather than a
regression in these documentation changes.

## The blocked-status lesson

`doing (blocked: <reason>)` is not a new terminal state. It is a doing-form with
a mandatory transition back to plain `doing` before review. Code must therefore
choose a predicate by semantic role:

| Operation class | Blocked-doing behavior |
| --- | --- |
| Ownership, WIP accounting, lock retention, lock-release protection, heartbeat, deterministic recovery | Treat as active doing-form |
| Resume/rebind into the ticket context | Accept doing-form and preserve the blocked marker unless the explicit `unblock` verb runs |
| `unblock` | Require blocked-doing and transition to plain doing |
| Commit, submit, `move-review`, finalize | Reject blocked-doing; the explicit unblock transition is required |
| `block`/reason amendment | Accept only the lifecycle forms documented for that verb |

A blanket replacement of every `=== STATUS.DOING` with `isDoingStatus()` would
be wrong. The current `move-review` equality check is correct. The checks in
recovery, release protection, heartbeat, and resume are not.

Forced claim must also either recreate the missing canonical lock or fail
loudly; a successful result carrying `lock: null` is not recovery. A fresh
agent rebind must refuse to release a session that still owns active tickets or
transfer those tickets atomically.

## Recovery invariant

Recovery must be monotonic: after a repair attempt, the set of violated
canonical invariants must be smaller or unchanged. A recovery command must not
delete the last valid ownership artifact merely because it cannot classify a
legal status string. The required incident regression is:

```text
blocked ticket
  -> owner session released
  -> canonical ticket lock missing
  -> recover recreates or fails closed without deletion
  -> unblock
  -> finalize with preserved evidence
```

This scenario belongs in the preservation harness, not only in unit tests for
individual predicates.

## Architecture and maintainability

The earlier decomposition substantially improved ownership. `lifecycle.js` is
now mostly a composition root, and behavior-specific modules and tests exist.
The remaining risk is size and contract diffusion rather than a single untouched
monolith: `lifecycle.js`, `journal.js`, `plan-records.js`, and
`governance-context.js` remain large, while command metadata is spread across
multiple registries and help emitters.

Recommended direction:

1. Make machine-readable command/flag/value schemas the source for parsing,
   help, MCP tool definitions, and remediation examples.
2. Introduce named lifecycle classifiers by role (`holdsOwnership`,
   `mayHeartbeat`, `mayRecover`, `mayAdvanceToReview`) rather than a universal
   doing predicate.
3. Require postconditions for repair verbs and artifact builders.
4. Move incident sequences into executable preservation tests.
5. Keep discovery output quarantined until a cited, reviewed promotion step
   converts it into canonical knowledge.

## Verified strengths to preserve

- `withGovernanceMutation` serializes writes, persists a crash restore point,
  rolls back failed file mutations, records external side effects, and journals
  the resulting snapshot.
- Journal appends use an explicit file descriptor and `fsync`; torn-tail and
  hash-chain repair are auditable rather than silent.
- ADR 0002 physically separates canonical integration-tree authority from
  ephemeral worktrees.
- The board, plans, journal, locks, and derived views have explicit ownership
  boundaries.
- Feature proofs and landed provenance are modeled as closeout requirements.
- The memory design correctly makes extraction advisory and promotion governed
  (ADR 0004).

## Recommended critical path

1. COORD-512 — make done imply landed reality.
2. COORD-572 — make supported behavior discoverable and executable from emitted guidance.
3. COORD-558 — repair blocked-status semantics using the operation matrix above.
4. COORD-480 — establish one root-normalizing, worktree-safe serial test entrypoint.
5. COORD-482 and COORD-543 — restore interoperability and operator truth.
6. COORD-520 plus release verification — make the installable artifact self-consistent.
7. COORD-571/557 and COORD-569/554 — align authoring contracts with gates.
8. COORD-560 — enforce the canonical proof suite continuously.
9. COORD-550, COORD-523, COORD-540 — improve knowledge precision, operating instructions, and visibility.

## Review limits

- No external product repos were reviewed; this baseline describes the
  coord-template donor and its bundled sample repos.
- Dependency remediation was not implemented here. Use a current `npm audit`
  and the corrected successor ticket before choosing versions.
- Generated business-discovery documents were not accepted as canonical
  knowledge because their precision was insufficient.
