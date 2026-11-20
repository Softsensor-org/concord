# Production module size at control-plane closeout

Repo-X closeout enforces the existing production-module line-count budgets
before workspace integration or cleanup, including no-PR and already-integrated
tickets. This check does not depend on the plan naming the changed files and has
no skip or waiver flag. It uses the running engine's `arch-checks.js` counter and
budgets: the default is 1,200 counted lines, with the existing explicit high-water
entries for larger modules. Exact equality and unused headroom both pass.

The checker reads committed Git blobs in the control-plane repository, with
explicit path translation for donor and independent `coord/` repositories. It
does not execute candidate JavaScript or accept candidate changes to the checker
as authority. Production source links refuse because their target content cannot
be established by counting the link blob. Uncommitted edits cannot disguise an
oversized committed implementation.

With workspace merging enabled, Git previews all pending ticket branches in the
same order as integration. The resulting combined tree must pass before the
first real merge. Multiple branches can each fit independently and still exceed
the budget together. Preview trees and intermediate commits are unreferenced Git
objects, never branch updates or landing evidence. Git failures and merge
conflicts refuse verification. A shrink repair may pass even if the previous
integration tree was oversized: the proposed result is what must fit.

Every violation reports the file, measured count and declared budget. Split a
module to bring it within its existing limit. Do not raise the budget to admit
growth. Existing ownership, ancestry, review, engine-integrity and publication
checks remain in place. This gate does not automatically run all release scripts.

For a read-only check of committed HEAD, run:

```sh
node coord/engine/scripts/prodloc-closeout.js
```

In an independent control-plane repository, use `node engine/scripts/prodloc-closeout.js`.
This command measures the committed tree; an uncommitted implementation still
needs to be committed and checked before closeout. Merge preview requires Git
2.38.0 or newer: Git 2.38 introduced the modern `merge-tree --write-tree` mode
and its `--no-messages` option. The shared
`coord/engine/scripts/git-prerequisite.js` preflight reports detected and
required versions through doctor, onboarding, install, the test runner and the
release-cut check.

## Historical cause and baseline repair

COORD-445 implemented a publishability advice helper and explicitly deferred
automatic finalize enforcement. The historical Repo-X closeout did not call the
production LOC checker. COORD-663's successful `mark-done` event at
`2026-08-11T16:41:44.294Z` cites the merge containing `bf8f5db4`. Its
`lifecycle.js` measures 2,466 counted lines, versus 2,464 in its parent and the
then-declared 2,464 budget. The gap was an unwired check; the evidence does not
show an ignored failure or a ticket-specific size waiver.

Enabling the complete scan also exposed two default-budget modules omitted by
the old test's explicit-high-water inventory. COORD-674 extracts unchanged
target upgrade-lock operations into `upgrade-lock.js` and session lock-record
operations into `session-lock-records.js`. The original facades and injected
dependencies remain intact. `coord-upgrade.js` shrinks from 1,297 to 1,180 and
`governance-session.js` from 1,244 to 1,159 counted lines. No cap changes.

COORD-675 owns the separate decomposition-proof exact-equality policy. This
delivery gate uses the existing production budget's less-than-or-equal contract.
