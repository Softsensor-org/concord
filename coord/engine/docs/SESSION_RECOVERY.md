# Continue work after a session gap

A session ending does not abandon its ticket or its worktree. Start by reading
`gov explain <ticket>` and the governed plan. Preserve dirty and untracked work.

For a replacement conversation using the same provider and existing owner:

```sh
coord/scripts/gov recover <ticket> --owner <existing-handle>
```

Recovery can bind a replacement session only when the old session is recorded as
expired, the complete existing lock links to that session, the board and agent
registry agree on ownership, and the registered worktree matches the lock. The
explicit owner selects the intended continuation; knowing a handle alone is not
sufficient. Recovery preserves the old session interval and records its ID on the
replacement session and recovery event. Retrying does not create another active
session. A failed governed repair rolls the adoption back with the repair.

An active competing session, another owner bound to this thread, provider mismatch,
corrupted lock or ambiguous worktree must refuse. Do not solve these refusals by
changing provider variables, deleting locks or using a force flag. Explicitly
released sessions require deliberate rebinding; this expiry path does not undo
release. Identity-v2 locks retain their separate existing authority model.

For a missing lock, or work that should change owners, use the separately
authorized administrative paths:

```sh
coord/scripts/gov recover <ticket> --human-admin-override '<authorized repair reason>'
coord/scripts/gov claim <ticket> --transfer-to <new-handle> --human-admin-override '<authorized handoff reason>'
```

These commands have different effects: recovery preserves the owner; transfer
changes it with provenance. An expired session is not authorization to transfer.
An administrator must already have a bound identity for administrative repair.
Do not use `lock-abandon` for accrued work: it is a revert path and may clean the
workspace. Use the owner-preserving repair or explicit ownership-transfer path above.

Same-thread continuation following terminal release is tracked in COORD-724;
session release and reaping policy in COORD-689. COORD-716's scope is explicit
same-owner recovery from an expired session on a replacement thread.

## Park a finished worker without abandoning its ticket

```sh
coord/scripts/gov agent-release <exact-session-id> --reason 'worker finished; preserve in-flight work'
```

The bound thread may release its own session even while its ticket is doing.
The owner, lock, branch, dirty files and plan remain in place. An exact-session
retry is safe. An authorized operator may release a known-finished foreign
session with `--human-admin-override '<authorized handoff reason>'`; a bare
`--force` is not authorization. Release removes that session's concurrency
obstruction; it does not allow a caller to take the ticket or share its checkout.
An explicit release requires deliberate authorized rebinding before more work.

Recently active auto-claimed agents between tickets are protected just like
agents holding doing work. Automatic expiry measures recorded CLI activity,
independently of whether the owner has a doing ticket. Missing timestamps remain
unknown and are not evidence of inactivity. A long computation that runs no CLI
verbs cannot be distinguished from silence by these timestamps; use the existing
heartbeat/handoff workflow rather than treating expiry as permission to take work.
There is no background heartbeat service in this change.

## Continue the same conversation after closing a ticket

After a terminal transition, the next governed mutation (for example `coord/scripts/gov start COORD-NEXT`) automatically creates a new session interval for the same registered handle when the exact native thread, provider and board still agree. The closed interval remains intact and the replacement records `previous_session_id`. Eligible idle expiry follows the same rule. Read-only inspection does not create the replacement. A failed dependent mutation rolls it back.

A successful `agent-release` of an active session records explicit parking: automatic continuation refuses. To return deliberately, use `coord/scripts/gov agentid --owner YOUR_HANDLE`, then start or resume the ticket. This sequence is exercised through the real CLI. A competing active session, provider mismatch, changed board, ambiguous history or fallback-only token does not authorize automatic continuation. Historical released intervals without a recorded reason also require explicit binding; the engine does not guess why they ended.

For an already-expired session ID or owner handle, `agent-release` acknowledges
the normalized inactivity and preserves the expiry. Its journal details record
`release_status: "already_expired"` and the matched session IDs. The interval
stays expired with its existing release reason, so the existing idle-expiry
continuation rule still applies. Active matches take precedence over expired
history and retain their release authorization checks. Unknown subjects refuse
and roll back incidental normalization, leaving unrelated state intact.

New bindings record a monotonically increasing `binding_sequence` for the exact
board and native thread under the existing agent-state lock. Claim, rebind,
automatic claim, recovery, continuation and authorized doctor repair all record
this order. Continuation selects the unique highest sequence, so backward or
equal wall-clock timestamps cannot revive an older owner or bypass explicit
parking. An in-place doctor repair advances the sequence as well. UTC audit
timestamps and idle-expiry calculations retain their existing meanings.

Existing intervals are not rewritten. Legacy-only history can continue when
its stored order and strictly increasing claim timestamps agree; conflicting
or tied timestamps require explicit `agentid --owner` binding. A new explicit
binding records a later interval without deleting history. Malformed ordering
metadata, a conflicting highest sequence, or sequence exhaustion fails closed.

A new conversation is a different thread. For expired in-flight ownership, follow the same-owner `recover TICKET --owner YOUR_HANDLE` procedure above. Neither continuation nor expiry transfers ticket ownership or deletes a workspace. Authorized foreign handoff remains a separate operation.

## Blocked work and concurrent doing tickets

`doing (blocked: reason)` remains active ownership. `gov resume TICKET`, `gov recover TICKET` and `gov heartbeat TICKET` accept it without erasing the reason. Resume also accepts review; terminal tickets cannot resume. Recovery on review removes obsolete doing-lock residue rather than reviving work. Use `gov unblock TICKET` deliberately before commit, move-review or submit.

A blocked ticket still counts as a doing ticket. An owner who holds an unrelated second doing ticket is reported by the doctor (`[owner-doing]`), not refused (COORD-963). If a new ticket is specifically necessary to close the existing ticket, record the existing exception before starting it:

```bash
coord/scripts/gov set-followup-relation CHILD --depends-on PARENT --relation closeout-blocker
coord/scripts/gov start CHILD
```

The relation is an explicit dependency decision that also clears the owner-doing report for that pair. It is not a general permission to run unrelated work concurrently.

### COORD-558 status comparison inventory

Assessed against the COORD-724 base on 2026-09-08 by source inspection and the COORD-558 real CLI matrix in `engine/scripts/missing-ticket-lock.test.js`.

| Surface | Contract and assessment |
| --- | --- |
| `agent-commands.js` resume and missing-lock transfer | Verified: shared `isDoingStatus` recognizes blocked work; resume additionally permits review. Already fixed by COORD-725. |
| `doctor-recovery.js` production repair branch | Verified: shared predicate enters ownership checks and repairs for blocked work; exact board reason preserved. Already fixed by COORD-725. |
| `governance-session.js` lock integrity and lock construction | Lock payload remains plain `doing`, separate from the board status family. No blanket equality replacement. |
| `ticket-transitions.js` submit, move-review and block | Plain doing required intentionally. Blocked work needs explicit unblock before advancing. |
| Owner-doing doctor warning and closeout-blocker relation | Blocked work still counts as doing. Start and return-doing are not refused for a second doing ticket (COORD-963, COORD-1029; ADR 0021). The doctor reports each owner's unrelated doing pair as `[owner-doing]` (`buildOwnerDoingDoctorWarnings` over `findUnrelatedOwnerDoingPairs`); a recorded closeout-blocker relation suppresses that report for the pair. Matches `coord/GOVERNANCE.md` section 11. |
| Plan and rendered status | Existing COORD-687/725 scope-aware rendering retained; CLI assertions check exact status, owner and plan evidence after resume/recover. |

Documentation verification: the named resume, recover, heartbeat, refusal and relation/start commands are exercised in isolated Git fixtures. This is procedure evidence, not a claim that all governance documentation has been assessed.

## Reproduce the multi-agent conformance proof (COORD-712)

Run from the coord-template repository root with Node 22 or Node 25:

```bash
node --test coord/engine/scripts/session-lifecycle-conformance.test.js
node coord/engine/scripts/session-lifecycle-mutations.js
```

The first command launches three real OS-process workers with separate registered handles, native thread IDs, coord runtimes, Git worktrees and local bare remotes. It runs production CLI commands. It uses no shared-worktree override for these isolated lanes and never targets the live board or GitHub. Successful sandboxes are removed; `COORD_KEEP_CONFORMANCE=1` retains them. Failed workers print their retained sandbox path. The mutation command always retains its logs and `results.json`, reports each mutation separately, and fails if any mutation survives or only causes a syntax error.

| Required procedure or invariant | Verification method |
| --- | --- |
| Complete lane | Each worker binds, starts, records evidence, commits, reviews, lands to its local bare remote and releases. Source and push receipts are checked against remote ancestry. |
| New conversation after expiry | Lane A expires a fixture session, changes its native thread and invokes same-owner recovery with an intact lock. Dirty tracked bytes, untracked bytes, branch, blocked reason and review evidence survive. Expiry is simulated by timestamps rather than a four-hour wait. |
| Missing lock and transfer | A separately bound admin is refused ordinary foreign repair, then performs owner-preserving repair with an explicit reason. Transfer requires a second explicit authorization. |
| Live sibling | While B is active, A's thread cannot resume or recover B by naming its handle. B's bytes and lock inode, mode and timestamps remain unchanged. |
| Continuation and rollback | After terminal release, a missing prompt makes the next start fail. Session replacement rolls back. Restoring the prompt permits one linked replacement; retry does not duplicate the start event. B's committed checkpoint survives A's failure. |
| Final records | Board status/owner, reviewed plan, rendered rows, locks, worktree cleanup, session intervals, exactly-once starts/landing, journal chain and remote source ancestry are asserted. |
| Shared runtime exception | Separately runs the existing three-worker primitive burn-in: refusal without the explicit flag, serialized local mutations with it, and out-of-band seal refusal. Also runs COORD-698’s same-runtime rollback primitive with unchanged foreign lock bytes and filesystem identity. This does not make checkout edits or external effects atomic. |
| Load-bearing safeguards | Disposable bypasses cover runtime locking, native identity, transfer and repair authority, whole-plan rendering, and exactly-once journaling. The plan mutation truncates the record map at the actual rendering call and uses the production integration test. Mutating the map passed into the writer survived because the writer rereads all records itself; those ignored-input mutations are not counted as kills. |

Documentation adequacy assessment, 2026-09-08: these procedures are assessed through the named executable harness and mutation logs, with Node versions and results recorded in the COORD-712 governed plan. The required denominator is the eight rows above; this is a bounded assessment of this recovery workflow, not certification of all governance documentation.

The isolated fixture can retain QUESTIONS and compatibility TASKS changes after closeout because these surfaces are outside the sync commit set. The proof checks the current authoritative board and rendered projection and the actual source-publication receipt; it does not mislabel those remaining note changes as published. That existing artifact-set debt remains separate from identity and workspace safety. These are correctness scenarios with three workers, not a 100-developer capacity or distributed-locking claim.
