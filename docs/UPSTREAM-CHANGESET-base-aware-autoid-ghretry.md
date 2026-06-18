# Upstream change-set: config-aware base default · auto-ID · gh retry · sync/hint polish

Origin: validated locally in the HOS deployment of this template during a ~25-agent
parallel governed wave (see that deployment's `coord/docs/PARALLEL_LANDING_LEARNINGS.md`).
These five changes remove the most repeated friction of high-fan-out governed work.
All are additive or no-op for a `dev`-integrating project (which the template is), so
the existing governance suite stays green; they only change behaviour for
main-integrating downstreams and under high fan-out.

Target: `coord/scripts/governance.js`. Branch: `feat/coord-base-aware-autoid-ghretry` off `dev`.

---

## 1. Config-aware base default (was: hardcoded `"dev"`)

**Problem.** Several base-ref resolution paths fall back to a literal `"dev"` instead of
the repo's configured `REPO_INTEGRATION_BRANCHES[<repo>]`. A project that integrates on
`main` is then forced to pass `--base main` on *every* `submit`/`land`/`finalize`. For a
`dev`-integrating project the value is unchanged, so this is a no-op for the template and
its fixtures, and a fix for main downstreams.

**Change.** At each base-resolution site that has the repo in scope, replace
`options.base || "dev"` (and `landing.base_ref || "dev"`) with
`options.base || REPO_INTEGRATION_BRANCHES[<repoVar>] || "dev"`. Sites (HOS analogues —
locate the template equivalents; `REPO_INTEGRATION_BRANCHES` is already imported):

- PR creation base + the recorded `base:` in the submit/pr-create path (`ref.row.Repo`).
- `assertLandingIntegrity` — `const requestedBaseRef = landing.base_ref || REPO_INTEGRATION_BRANCHES[row.Repo] || "dev";`
- `ensureLandingRecord` — `const requestedBaseRef = String(options.base || REPO_INTEGRATION_BRANCHES[row.Repo] || "dev").trim() || REPO_INTEGRATION_BRANCHES[row.Repo] || "dev";`
- `detectSupersedeLandingBypass` — `String(options.base || REPO_INTEGRATION_BRANCHES[row.Repo] || "dev").trim()`
- the two `landing.base_ref || "dev"` readers (e.g. the already-landed close + a feature-proof base reader).

Leave normalization helpers (`String(baseRef||"dev")`), branch-flag defaults, and any
site without a repo in scope untouched.

**Test note.** The template integrates on `dev`, so every fixture asserting `dev` still
passes. (Downstreams that integrate on `main` should make their fixtures assert the
fixture's own `integrationBranch` rather than a literal — noted for them, not required here.)

---

## 2. Auto-ID — remove hand-numbering

**Problem.** Creating a follow-up requires the human to pick the next free `PREFIX-N` and
avoid collisions; non-conforming ids (`FRESHNESS-001-WEB`) are rejected by the schema.

**Change.** Add a `nextTicketId(board, prefix)` allocator, a `gov next-id <PREFIX>` verb,
make `open-followup`'s id optional when `--prefix` is given, and add a `gov split-ticket`
verb for cross-repo umbrellas. Exact code (verified in HOS):

```js
// Auto-allocate the next free ticket id for a prefix. Scans the board for the
// highest PREFIX-N and returns PREFIX-(N+1), zero-padded to the widest existing
// width (min 3). Always yields a schema-valid ^[A-Z]+-\d+$ id. Race-safe when
// called inside the runtime-lock mutation.
function nextTicketId(board, prefix) {
  const P = String(prefix || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!P) fail('Auto-id needs a letters-only --prefix, e.g. --prefix TRUST.');
  let max = 0, width = 3;
  for (const row of getRows(board)) {
    const m = String(row.ID || "").match(/^([A-Z]+)-(\d+)$/);
    if (m && m[1] === P) {
      const n = parseInt(m[2], 10);
      if (n > max) max = n;
      if (m[2].length > width) width = m[2].length;
    }
  }
  return `${P}-${String(max + 1).padStart(width, "0")}`;
}

function printNextId(prefix) { console.log(nextTicketId(readBoard(), prefix)); }

// Cross-repo splitter: one auto-allocated followup per repo, each --relation
// related to the umbrella (ready immediately, no parent-dep deadlock).
function splitTicket(parentId, options) {
  if (!parentId) fail("split-ticket requires <parent-ticket-id>.");
  if (!options.into) fail('split-ticket requires --into <repo-codes>, e.g. --into B,F.');
  const board = readBoard();
  const parentRef = getTicketRef(board, parentId);
  if (!parentRef) fail(`Parent ticket ${parentId} does not exist.`);
  const repos = String(options.into).split(/[,\s]+/).filter(Boolean);
  const prefix = (options.prefix || (parentId.match(/^([A-Z]+)-/) || [])[1] || "").toUpperCase();
  if (!prefix) fail("Could not derive a prefix from the parent id; pass --prefix <PREFIX>.");
  const pri = options.pri || parentRef.row.Pri || "P2";
  const type = options.type || "feature";
  const roleFor = (r) => ({ B: "Backend", F: "Frontend", C: "Legacy" }[r] || `repo ${r}`);
  const parentDesc = String(parentRef.row.Description || "").replace(/\s+/g, " ").slice(0, 500);
  for (const repo of repos) {
    const desc = options.description
      ? `${roleFor(repo)} half of ${parentId}: ${options.description}`
      : `${roleFor(repo)} half of cross-repo ${parentId}. Parent intent: ${parentDesc} — implement the ${roleFor(repo)} portion only; the other half(s) are sibling splits. FILL IN repo-specific acceptance criteria + tests.`;
    openFollowup(null, { prefix, dependsOn: parentId, repo, type, pri, description: desc, relation: "related" });
  }
  console.log(`Split ${parentId} -> ${repos.length} ${prefix}-* halves (${repos.join(", ")}), each related to ${parentId} (ready now). After both land, close the umbrella: gov finalize ${parentId} --no-pr --fulfilled-by-ticket <a-half> --landed "<both PRs>".`);
}
```

`open-followup` top (make id optional, allocate under the lock):

```js
function openFollowup(newTicketId, options) {
  const mutation = { command: "open-followup", ticket: newTicketId || `(auto:${options.prefix || "?"})` };
  return withGovernanceMutation(mutation, () => {
    if (!options.dependsOn) fail("open-followup requires --depends-on <ticket-id>.");
    if (!options.repo || !options.type || !options.pri || !options.description)
      fail("open-followup requires --repo, --type, --pri, and --description.");
    const board = readBoard();
    if (!newTicketId && options.prefix) { newTicketId = nextTicketId(board, options.prefix); mutation.ticket = newTicketId; }
    if (!newTicketId) fail("open-followup requires <new-ticket-id> or --prefix <PREFIX> to auto-allocate.");
    if (getTicketRef(board, newTicketId)) fail(`Ticket ${newTicketId} already exists.`);
    /* …unchanged… */
```

Dispatch (the `open-followup` case must allow a flag-leading invocation):

```js
case "open-followup": {
  const ofHasId = args[0] && !args[0].startsWith("--");
  return openFollowup(ofHasId ? args[0] : null, parseFlags(ofHasId ? args.slice(1) : args));
}
case "next-id":
  return printNextId(args[0]);
case "split-ticket": {
  const stHasId = args[0] && !args[0].startsWith("--");
  return splitTicket(stHasId ? args[0] : null, parseFlags(stHasId ? args.slice(1) : args));
}
```

`parseFlags` (add two cases):

```js
case "--prefix": requireValue(arg, next); parsed.prefix = next; index += 1; break;
case "--into":   requireValue(arg, next); parsed.into = next;   index += 1; break;
```

Update the usage strings to show `open-followup [<id>|--prefix <PREFIX>] …`, and add
`next-id <PREFIX>` and `split-ticket <id> --into <repos>`.

---

## 3. `ghPrView` retry-with-backoff (high-fan-out gh throttle)

**Problem.** Under high fan-out GitHub secondary-throttles bursts of `gh` calls as
intermittent `HTTP 401` on the GraphQL endpoint; one throttled `ghPrView` fails the whole
submit/move-review/land op.

**Change.** Wrap the existing `runGh(...)` body of `ghPrView` in a bounded retry. Add:

```js
function isTransientGhError(message) {
  return /HTTP 401|Requires authentication|GraphQL|secondary rate|rate limit|abuse detection|HTTP 4(03|29)|HTTP 5\d\d|timed out|timeout/i.test(String(message || ""));
}
function sleepSyncMs(ms) { try { spawnSync("sleep", [String(Math.max(0, ms) / 1000)]); } catch (_) {} }

function ghPrView(url) {
  const maxAttempts = 6;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = runGh(ROOT_DIR, ["pr", "view", url, "--json",
        "number,url,state,mergedAt,title,headRefName,baseRefName,isDraft,author,mergeStateStatus,mergeCommit"], { capture: true });
      return JSON.parse(output);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isTransientGhError(error && error.message)) { sleepSyncMs(1500 * attempt); continue; }
      throw error;
    }
  }
  throw lastError;
}
```

(`spawnSync` is already imported.) `ghPrView` is a pure read, so retry is safe.

---

## 4. Merge-not-rebase recovery hint

The DIRTY/BEHIND mergeability hint currently leads with `git rebase … && git push
--force-with-lease`, which sandboxed/auto-mode agents are routinely denied. Lead with the
**merge** path (append-only, normal push; `land --method squash` flattens it) and offer
force-push only as an alternative. Replace the `recoveryHint` construction so DIRTY/BEHIND
and "Resolve merge conflicts" both point at:
`git fetch origin <base> && git merge origin/<base> --no-edit (resolve, commit), then a normal git push — no force; land --method squash flattens the merge. (Alternative where force-push is allowed: git rebase … && git push --force-with-lease.)`

---

## 5. Silent sync skip when coord/ isn't a git worktree

In `autoSyncAfterLifecycle`'s catch, before the loud warning, detect the benign
"coord root isn't a git repo" case and skip quietly:

```js
if (/not a git repository|show-toplevel failed|rev-parse --show-toplevel/i.test(reason)) {
  return { skipped: true, reason: "coord-root-not-a-git-repo" };
}
```

(No-op for the template's own self-tests, which run inside a git repo.)

---

## Validation

Run the full governance + agent/MCP/board/evidence suites — all must stay green (the
template is `dev`-integrating, so §1 is behaviour-preserving here). Add focused tests for
the new `next-id`/auto-id `open-followup`/`split-ticket` verbs and the `ghPrView` retry.
Land via the template's own gov lifecycle (`gov claim/start …`) or a maintainer PR.
