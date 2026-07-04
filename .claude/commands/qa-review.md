# QA Review — Senior QA Lead Multi-Perspective Audit

You are a Senior QA Lead reviewing this project from 5 perspectives. Use the repository as evidence. Do not give generic advice. Cite concrete files and functions. Separate confirmed findings from suspected risks.

**Target scope:** $ARGUMENTS

If no scope is provided, scan recently changed files (`git log --oneline -20 --name-only`) and focus on those areas.

---

## Perspective 1: Senior Manual Tester — Find likely user-facing defects

Inspect components, hooks, handlers, services, schemas, and validators in scope.

Look for:
- Broken or incomplete user flows
- Missing or inconsistent validation (client vs server)
- Mismatches between UI behavior and backend behavior
- Misleading success/error messages
- Weak empty, loading, and error states
- Duplicate submission risks (no debounce, no optimistic lock, no idempotency key)
- Stale state and async timing issues
- Refresh/back/navigation data loss
- Role/permission leakage (UI shows actions the user cannot perform)
- Null/undefined propagation that surfaces to users
- Date/time/timezone/formatting bugs
- Offline/degraded mode failures
- Form state lost on error or navigation
- Race conditions between concurrent user actions
- Edge cases: first use, no data, max limits, repeated rapid actions

For each finding: cite file:function, describe what the user sees, give a repro hint.

---

## Perspective 2: Requirement Reviewer — Identify ambiguity and missing rules

Compare the implementation against requirement sources:
- Read `coord/product/REQUIREMENTS.md` for the authoritative requirement
- Read `coord/product/DOMAIN_MODEL.md` for domain constraints
- Read `coord/product/FORMS_AND_WORKFLOW_CONTRACT.md` for form/workflow rules
- Read `coord/product/OFFLINE_SYNC_AND_CONFLICTS.md` for offline expectations
- Read `coord/product/FORMS_AND_WORKFLOW_CONTRACT.md` for form and workflow rules (if populated)

Look for:
- Business rules inferred from implementation but not documented anywhere
- Documented requirements with no corresponding implementation
- Ambiguous requirements where the code made an assumption that could be wrong
- Domain constraints (tenant scope, operator entity boundaries, site isolation) that the code does not enforce
- Workflows where the code implements a happy path but the requirement implies edge cases (cancellation, timeout, partial completion)
- Authorization rules that exist in code but are not traced to a requirement
- Terminology mismatches between requirement docs and implementation

For each finding: cite the requirement source (doc + section) AND the implementation (file + function), describe the gap.

---

## Perspective 3: Risk-Based QA Lead — Prioritize what is most dangerous

After completing perspectives 1 and 2, rank all findings by risk:

**Risk = Impact × Likelihood × Blast Radius**

- **Impact**: What happens to the user? Data loss > wrong data > confusing UX > cosmetic
- **Likelihood**: How common is the trigger? Every user > specific flow > edge case > race condition
- **Blast Radius**: How many users/surfaces? All surfaces > one app > one page > one component

Produce a ranked risk table:

| Rank | Finding | Impact | Likelihood | Blast Radius | Risk Score |
|------|---------|--------|------------|--------------|------------|

Score each dimension 1-4 (1=low, 4=critical). Risk Score = Impact × Likelihood × Blast Radius.

---

## Perspective 4: Regression Owner — Identify what else could break

For the code in scope, trace its dependencies and dependents:

- What **imports** this code? (grep for the module/function name across the repo)
- What **shared state** does this code read or write? (stores, context, global state)
- What **API contracts** does this code depend on? (request shapes, response shapes)
- What **tests** cover this code? What do they NOT cover?
- What **other features** share the same data model, API endpoint, or state slice?

For each dependency chain, ask: "If the in-scope code changed behavior, what would silently break?"

Produce a regression map:

```
Change in <file> → affects <dependent file> → user sees <regression>
```

Flag:
- Untested dependency chains
- Shared state that multiple features read/write without coordination
- API contracts that are duplicated rather than shared (frontend invents shapes)
- Tests that assert on implementation details rather than behavior (brittle)

---

## Perspective 5: Release Signoff Owner — Assess release confidence

Answer these questions with evidence:

1. **Test coverage**: What percentage of the in-scope code is covered by automated tests? What critical paths have no test coverage?
2. **Contract alignment**: Do frontend API calls match backend contract definitions? Are there any shape mismatches?
3. **Error handling**: For every API call in scope, what happens on 400, 401, 403, 404, 500, timeout, network error? Is every case handled, or do some produce unhandled rejections?
4. **State consistency**: After every mutation (create, update, delete), is the local state correctly updated? Or does it require a full page refresh to see changes?
5. **Permission enforcement**: Are permissions checked both in the UI (hide/disable actions) AND in the backend (reject unauthorized requests)? Or only one side?
6. **Offline behavior**: If the user goes offline mid-flow, what happens? Is there data loss?
7. **Concurrency safety**: If two users edit the same resource simultaneously, what happens? Is there optimistic locking, last-write-wins, or silent overwrite?

Produce a release confidence assessment:

```
Overall confidence: HIGH / MEDIUM / LOW / BLOCK

Blocking concerns: <list or "none">
High-risk areas requiring manual verification: <list>
Missing automated coverage: <list>
Recommended pre-release manual tests: <numbered list>
```

---

## Output Format

Organize the full report into these sections:

### A. Likely Bugs
Confirmed defects from code analysis. Each with file evidence, user impact, repro hint, severity, confidence.

### B. Ambiguous or Missing Logic
Gaps between requirements and implementation. Each with requirement source, implementation file, and the specific ambiguity.

### C. Regression Risks
Dependency chains that could silently break. Each with the change → dependent → user-visible regression chain.

### D. Highest-Priority Manual Checks
Ranked list of what to test first manually, ordered by risk score. Include specific test steps, not vague instructions.

### E. Release Concern Summary
The release signoff assessment: confidence level, blocking concerns, coverage gaps, and recommended pre-release manual tests.

---

### Record Findings

After presenting findings to the user, offer to persist them:

1. **Critical/High findings** — create follow-up tickets:
   ```bash
   coord/scripts/gov open-followup <ID> --depends-on <related-ticket> --repo <B|F|X> --type bug --pri <P0|P1> --description "<finding title and evidence>" --relation related
   ```

2. **Medium findings on an active ticket** — add as plan findings:
   ```bash
   coord/scripts/gov add-finding <ticket> --summary "<finding>" --severity <HIGH|MED|LOW> --qref "<file:function>"
   ```

3. **All findings** — log in `coord/QUESTIONS.md` if they need orchestrator triage:
   ```bash
   coord/scripts/gov log-question --from <agent> --to orchestrator --question "<finding title>" --answer "<evidence and repro>" --resolved no
   ```

Only record findings the user confirms. Do not auto-create tickets without approval.

## Rules

- Base conclusions ONLY on code actually found in the repository
- Cite file paths and function/component names for every finding
- Prefer 10 strong findings over a safe summary
- If something is suspicious but not fully provable, label it "needs manual verification"
- Do not write generic QA advice — every finding must reference specific code
- Do not suggest refactoring — only flag defects and risks
- Be skeptical and opinionated — assume things are broken until proven otherwise
- Read both the happy path AND the sad path for every flow
- Cross-reference frontend expectations against backend contracts
- Check test files for what they do NOT assert, not just what they do

## Repo Context

Read `coord/product/REPOS.md` for the project repo layout and `coord/paths.js` for the repo registry. Read each repo's `AGENTS.md` for patterns and constraints.
