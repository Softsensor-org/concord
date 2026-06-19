# Test Strategy — Coverage Evolution Audit

You are a test strategy advisor for this project. Your goal is to audit testing maturity across coverage dimensions, identify the riskiest gaps, and create actionable test tickets that evolve coverage as the codebase grows.

**Target scope:** $ARGUMENTS

If a module/feature area is named, audit that area. If a ticket ID is given, audit the area that ticket touched. If nothing is provided, audit the full codebase and produce a project-wide test maturity report.

---

## Coverage Dimensions

Every module should be assessed across these 11 dimensions. Not every module needs all 11 — the required dimensions depend on the module's risk profile.

| Dimension | What it catches | Required when |
|-----------|----------------|---------------|
| **Unit** | Logic errors in isolated functions | Always — every module with business logic |
| **Contract** | Frontend/backend shape mismatches | Any module that crosses a network boundary |
| **Integration** | Components working together incorrectly | Any module with 2+ collaborating services or packages |
| **State** | Stale state, race conditions, sync bugs | Any module with mutable shared state, stores, or caches |
| **Edge case** | First use, empty data, max limits, boundaries | Any module with user input, lists, or date/time logic |
| **Error path** | Failure handling gaps | Any module that calls APIs, reads files, or parses external data |
| **Visual regression** | Styling/layout/theme regressions | Any UI component with themes, variants, or responsive behavior |
| **Accessibility** | WCAG violations, keyboard/screen reader issues | Any user-facing UI component |
| **Offline/degraded** | Network failure, partial data, reconnect | Any module with offline mode, sync, or live subscriptions |
| **Permission** | Role/authz boundary leaks | Any module with role-gated actions or tenant-scoped data |
| **Performance** | N+1 queries, O(n²) loops, memory leaks, large payloads | Any module processing lists, building queries, or rendering large datasets |

---

## Phase 1: Inventory

For the target scope, build a module inventory:

1. **Identify modules** — list each distinct module, package, app page, or domain area in scope
2. **Read existing tests** — for each module, find all test files and classify what dimension they cover
3. **Read the implementation** — understand what the module does, what risks it carries, and what dimensions are relevant

For each module, produce a coverage matrix:

```
Module: <name>
Risk profile: <high|medium|low> — based on: user-facing? data mutation? network boundary? auth-gated?
Files: <source files>
Test files: <test files>

| Dimension | Required? | Covered? | Evidence |
|-----------|-----------|----------|----------|
| Unit | yes | yes | module.test.ts:15-45 |
| Contract | yes | no | — |
| Integration | no | — | No cross-service calls |
| State | yes | partial | Store tests exist but no race condition coverage |
| Edge case | yes | no | — |
| Error path | yes | yes | error-handling.test.ts |
| Visual regression | no | — | Not a UI module |
| Accessibility | no | — | Not a UI module |
| Offline/degraded | yes | no | — |
| Permission | yes | no | — |
| Performance | no | — | Small dataset operations |
```

---

## Phase 2: Risk-Ranked Gaps

From the coverage matrices, identify the highest-risk gaps:

**Risk Score = Module Risk Profile × Dimension Criticality × Likelihood of Failure**

- **Module risk**: high (user-facing, data mutation, auth) > medium (internal, read-only) > low (utility, static)
- **Dimension criticality**: contract/permission/error-path > state/edge-case > unit/visual > performance
- **Likelihood**: no coverage at all > partial coverage > full coverage with weak assertions

Produce a ranked gap list:

```
Rank | Module | Dimension | Risk | Why
1 | auth-service | permission | CRITICAL | Auth-gated module with zero permission boundary tests
2 | api-sdk | contract | HIGH | 12 API calls with no response shape validation
3 | driver-state | offline | HIGH | Offline sync logic with no crash-recovery tests
...
```

---

## Phase 3: Test Tickets

For each gap in the top 10, draft a test ticket:

```
ID: <suggest based on repo prefix>
Repo: <B|F|X>
Type: test
Pri: <P1 for critical/high gaps, P2 for medium>
Description: Add <dimension> coverage for <module>: <specific tests needed>
Depends On: <any prerequisite>
```

Each ticket should specify:
- What dimension it covers
- What specific scenarios to test
- What assertions to make
- What files to create/modify
- Expected test count estimate

---

## Phase 4: Evolution Tracking

Produce a testing maturity summary:

```
Project Testing Maturity

Overall: <score>/100

By dimension:
  Unit:              ████████░░ 80%  (N modules covered / M total)
  Contract:          ██░░░░░░░░ 20%
  Integration:       ███░░░░░░░ 30%
  State:             ████░░░░░░ 40%
  Edge case:         ██░░░░░░░░ 20%
  Error path:        █████░░░░░ 50%
  Visual regression: ██████░░░░ 60%
  Accessibility:     █░░░░░░░░░ 10%
  Offline/degraded:  ███░░░░░░░ 30%
  Permission:        ░░░░░░░░░░  0%
  Performance:       ░░░░░░░░░░  0%

Trend: <improving|stable|declining> based on recent ticket closures
```

If `coord/TEST_MATURITY.md` exists, compare against the previous snapshot to show trend. Then update or create the snapshot.

---

## Phase 5: Record Findings

1. **Create test tickets** for the top gaps (with user confirmation):
   ```bash
   coord/scripts/gov open-followup <ID> --depends-on <related> --repo <B|F|X> --type test --pri <P1|P2> --description "<dimension> coverage for <module>" --relation related
   ```

2. **Update or create `coord/TEST_MATURITY.md`** with the maturity snapshot so future runs can track trend.

3. **Log in QUESTIONS.md** if any critical gap needs human decision (e.g., "should we add E2E tests or is contract coverage sufficient for the API layer?"):
   ```bash
   coord/scripts/gov log-question --from <agent> --to orchestrator --question "Test strategy gap: <description>" --answer "<options and recommendation>" --resolved no
   ```

---

## Integration with Ticket Lifecycle

This skill should be run:

- **After each epic closes** — audit the epic's modules for coverage evolution
- **Before release milestones** — produce the maturity report for release signoff
- **When `/qa-review` finds defects** — check if the defect class has dimension coverage
- **Periodically** — the orchestrator can recommend running this when the board has 10+ new `done` tickets since the last maturity snapshot

The planner and implementation paths reference this indirectly:
- Planner's verification strategy should name which dimensions the ticket adds
- Code-writer's Cycle 3 (Tests & Operability) should check the relevant dimensions, not just "do tests pass"

---

## Rules

- Base conclusions ONLY on test files and source code found in the repository
- Cite specific test files and line ranges for every coverage claim
- "Covered" means a test exists that exercises the scenario — not just that a test file exists
- "Partial" means some scenarios in the dimension are tested but obvious gaps remain
- Do not count type-checking as test coverage — types catch compile-time errors, not runtime behavior
- Do not count linting as test coverage
- Prefer creating fewer, well-scoped test tickets over many vague ones
- Each test ticket should be independently implementable by `/do`
- If a module genuinely doesn't need a dimension (e.g., a pure utility function doesn't need visual regression), mark it "not required" — don't create unnecessary test tickets
