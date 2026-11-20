# ADR 0011: Business discovery reads an adopter project config statically and never executes it

- **Status:** Accepted
- **Ticket:** COORD-657
- **Date:** 2026-08
- **Linked scope:** coord/scripts/business-discovery.js, coord/scripts/static-config-declaration.js

## Context

`coord/scripts/business-discovery.js` `readProjectConfig()` resolved the
adopter's `coord/project.config.js` and called `require(configPath)` on it.
Discovery therefore EXECUTED code it found on someone else's disk, with the
operator's ambient credentials. Two details made it worse:

- `delete require.cache[require.resolve(configPath)]` forced RE-EXECUTION on
  every call rather than reusing a cached module.
- A bare `catch { }` returned `{ config: null }` and swallowed the error, so a
  config that performed side effects and then threw left NO trace in either the
  success or the failure path.

ADR 0007's context already forbids executing adopter code for the installer.
COORD-479 makes discovery run against arbitrary adopter workspaces, and
onboarding is precisely the moment Concord meets a repository it has never
seen, so the same rule has to hold here. This is ADR 0010's class exactly: an
artifact received from the environment is INPUT the code receives, not state it
holds.

## Linked Scope

- Linked ticket: COORD-657.
- Governing ticket: COORD-657.
- Extends ADR 0007 (never execute adopter code) and applies ADR 0010's
  untrusted-input rule to the discovery boundary. Both remain accepted.
- `coord/scripts/business-discovery.js` — `readProjectConfig`,
  `projectDeclaredSurface`, and the `analyze()` call site.
- `coord/scripts/static-config-declaration.js` — the non-executing reader.
- NOT in scope: `coord/paths.js` `loadProjectConfig` and its engine callers
  (`cli.js`, `coord-init.js`, `coord-init-wizard.js`, `contract-policy.js`,
  `agent-shim-validator.js`), which load the engine's OWN workspace config.
  That path is trusted and is deliberately unchanged.

## Premise Correction (COORD-657 review finding F6)

The ticket promised that `tier` would remain discoverable static metadata.
**There is no `tier` field in `coord/project.config.js`** — not in the shipped
template, not in `coord/paths.js`'s validator, and not in any adopter config in
this repository. The ticket named a field that does not exist.

Rather than silently substitute, this is recorded: the projected surface is
`repos[code].path`, `repos[code].integrationBranch`, the declared `tracks`
names, and `coordTicketPrefix`. `coordTicketPrefix` was projected **in place of**
the promised `tier`; it is a real declared field of the same kind (a
project-level governance label) and is what an adopter actually declares. No
`tier` support was invented to satisfy the wording. If a `tier` field is added
to the config seam later, adding it to the derived field list is a one-line
change and a new expectation in the proof-3 fixture.

## Decision Criteria

- No adopter code runs, proven by the ABSENCE of an observable side effect, not
  by the absence of a return value.
- UNVALIDATED and UNPROJECTED adopter content cannot reach a discovery
  artifact: not the process environment, not the contents of other files on
  disk, not unrelated keys parked in the config. Stated this narrowly on
  purpose. Validated, projected metadata — the repo map, integration branches,
  tracks and ticket prefix — IS adopter-controlled BY DESIGN and DOES reach the
  artifact; that is precisely what proof 3 asserts, and a criterion claiming
  otherwise would be one the implementation cannot meet.
- Static metadata the config legitimately declares stays discoverable. A guard
  that simply stops reading the file would satisfy the security requirement and
  destroy the feature; it is not a fix.
- An unreadable or dynamic configuration produces a classified, actionable
  refusal naming the file and the operator's next step, never a silent null.
- The engine's own trusted config load is not weakened.

## Options Evaluated

- **Read the existing `project.config.js` as a static declaration (chosen).**
  A hand-written tokenizer/parser accepts `module.exports = { <literals> }` and
  refuses anything that could run. Discovery then projects a fixed field list
  out of the declaration.
- **Migrate the declaration to a data file (JSON) the adopter cannot make
  executable.** Rejected as the primary fix. `analyze()` consumes a very small
  surface — `repos[code].path` for the repo map, `repos[code].integrationBranch`
  and `tracks` as declared metadata, `coordTicketPrefix`, and a
  `config ? "observed" : "unknown"` confidence flag. That surface is trivially
  expressible as literals, and every real adopter config in the wild is already
  a literal object. A JSON migration would buy nothing that the static grammar
  does not already give, would leave existing adopter workspaces undiscoverable
  until they migrated (the exact blanket-refusal failure this ticket forbids),
  and would fork the config seam away from the trusted loader that still reads
  the `.js`. Recorded here so it is not re-proposed as an oversight.
- **Sandbox the module (`node:vm`, a worker, a subprocess).** Rejected: it still
  EXECUTES adopter code, and every sandbox of this kind is a containment
  argument rather than an absence-of-execution guarantee. The proof required is
  that the side effect did not occur.
- **Blanket refusal — stop reading the file at all.** Rejected: it guts the repo
  map, the integration branches and the track declarations, and the resulting
  discovery run would be honest but useless.
- **Keep `require` and only fix the silent `catch`.** Rejected: it makes the
  execution audible without preventing it.

## Decision

Business discovery treats an adopter `coord/project.config.js` as UNTRUSTED
INPUT, reads it STATICALLY, and refuses rather than guesses.

1. **No execution.** `coord/scripts/static-config-declaration.js` tokenizes and
   parses the file. It never calls `require`, `eval`, `new Function` or
   `node:vm`, and there is no fallback that runs the file. The require-cache
   manipulation is gone with it. Proven by asserting that a file sentinel, an
   environment variable, a spawned process and a network connection the config
   declares all fail to occur.
2. **A declarative grammar.** `["use strict";] module.exports = { ... };` where
   values are strings, numbers, booleans, `null`, arrays and objects. An
   identifier reference, a call, a template literal, a spread, a function, a
   computed key, a reserved (`__proto__`/`constructor`/`prototype`) key, or a
   second top-level statement is refused and NAMED. Size, depth and node-count
   caps bound the work.
3. **A derived field list.** Discovery projects only
   `repos[code].{path, integrationBranch}`, the declared `tracks` names, and
   `coordTicketPrefix` out of the declaration. Every value is validated before
   it is believed. Stated precisely, because the loose form of this sentence is
   false: the projected metadata IS adopter-controlled by design — that is
   exactly what proof 3 asserts. The guarantee is narrower and is this:
   **unvalidated and unprojected adopter content cannot reach the artifact.**
   An unrelated key an adopter parks in the config, the process environment, and
   the contents of any other file the config could have read all fail to reach
   `run.json`; the declared repo map, integration branches, tracks and ticket
   prefix reach it deliberately, after validation.
4. **Untrusted path handling.** The platform capability is checked FIRST and
   FAILS CLOSED (`config_platform_unsupported`) where `O_NOFOLLOW` or
   `O_NONBLOCK` cannot be expressed, opening nothing at all. An earlier revision
   downgraded to a following open on such a platform, and a later one treated
   `O_NONBLOCK` as optional while this record already claimed every open used
   it; both were bypasses regardless of being disclosed. BOTH flags are
   REQUIRED, so every open refuses a symlink rather than traversing it and
   returns immediately on a FIFO, socket or device node rather than blocking.

   **Inspection precedes canonicalization, and this ordering is the load-bearing
   part.** The parent chain that is INSPECTED is the ORIGINAL LEXICAL one. A
   previous revision called `realpathSync` on the parent first and walked the
   RESULT, which meant `realpathSync` had already followed the
   adopter-controlled component before any check saw it: the symlink guard could
   not fire by construction, and a dangling parent symlink surfaced as `ENOENT`
   and was reported as ABSENT. Every component below the scanned root is now
   inspected with a no-follow `lstat` and classified exactly:

   | component state | outcome |
   | --- | --- |
   | missing entirely | `absent` |
   | present but a symlink (dangling or not) | `config_untrusted_path` |
   | present but not a directory | `config_unreadable` |
   | unreadable for any other reason | `config_unreadable` |

   The scanned root itself is the operator-supplied trust anchor and is exempt
   from the symlink refusal, so a legitimately symlinked scan root still works;
   everything beneath it is adopter-controlled and is not exempt. Stated
   precisely, and deliberately no more strongly than that: **the root alias's
   RESOLVED TARGET defines the containment anchor; the alias itself is NOT
   claimed symlink-free.** Human admin accepted this exemption because the
   operator-supplied root is the trust anchor, and rejecting its symlink would
   break legitimate aliased checkouts without strengthening protection below
   that boundary. The exemption is pinned by test in both directions (proof
   17A/17B): a stable aliased root still discovers its metadata by value, and
   the exemption is not a hole — it permits the root to BE an alias, never for
   the root to CHANGE IDENTITY mid-read, which the `dev`/`ino` re-verification
   below refuses before any content is read.
   Canonicalization runs only AFTER that inspection, purely as a containment
   cross-check — it is never the source of the inspected chain and never decides
   absence.

   Only then is the file opened, at the same lexical path that was inspected.
   The whole component chain and the final entry are RE-VERIFIED by `dev`/`ino`
   **before a single byte is read** (this is what detects a parent swapped
   across the open); the handle is `fstat`-ed, not the path, to confirm a
   regular file; and the read is bounded by the bytes ACTUALLY READ. `ENOENT`
   from the no-follow open of the FINAL component is the only condition read as
   absence there; `ENOTDIR`, `EACCES`, `EIO`, `ELOOP`, `ENAMETOOLONG` and
   `EPERM` are each classified refusals.

5. **Fail closed, loudly.** A refusal carries a classified code
   (`config_unreadable`, `config_too_large`, `config_unsupported_module_shape`,
   `config_untrusted_path`, `config_platform_unsupported`,
   `config_not_declarative`), a message naming the FILE, the construct kind and
   its line/column, and operator remediation. It is emitted as
   `configuration_declaration` on the artifact, as a `declaration_refused`
   record, as a decision-required question, and as a non-zero CLI exit. The
   classified line is written to STDERR so that `--json` stdout remains exactly
   one parseable document, with the remediation carried as a field. Refusals
   never quote file CONTENT, so a secret in a rejected config cannot ride the
   error message into an artifact.
6. **The trusted path is untouched.** `coord/paths.js` `loadProjectConfig` still
   requires the engine's own config for the engine's own workspace.

## Alternatives Rejected

- A JSON/data-file migration of the config seam (no gain over the static
  grammar; breaks existing adopter workspaces; forks the seam).
- Sandboxed execution (still executes; containment is not absence).
- Blanket refusal to read the file (guts discovery).
- Fixing only the silent `catch` (audible execution is still execution).

## Consequences

- Discovery gained a small parser it must maintain. The grammar is deliberately
  tiny and its refusals are classified, so an unsupported construct produces an
  operator decision point rather than a silent degradation.
- An adopter whose `project.config.js` is genuinely dynamic gets a refusal, not
  a repo map. That is the intended trade: the repo map is worth less than the
  guarantee that onboarding never runs a stranger's code.
- Integration branches, tracks and the coord ticket prefix are now discoverable
  metadata; previously only the repo map was read.
- `coord business-discovery` exits non-zero when the declaration is refused.
  The artifact is still emitted, because it is the operator's evidence.

## Residual Risk — parent-directory resolution (ESCALATED, COORD-657 H1)

**This is not a full containment guarantee, and must not be read as one.**

Correct containment requires opening the file RELATIVE to a directory file
descriptor that has already been validated — `openat(dirfd, "project.config.js",
O_NOFOLLOW)`. **Pure Node cannot express that.** Verified on Node v25.8.1:

- `fs` exposes no `openat`/`fstatat`/`*at` family (`Object.keys(fs).filter(/at$/)`
  yields only `fstat`, `lstat`, `stat`);
- `fs.constants.O_PATH` is `undefined` and `fs.constants.AT_FDCWD` is `undefined`;
- `fs.opendirSync()` returns a `Dir` that exposes no file descriptor.

So the open must be given a PATH STRING, and the kernel re-resolves every parent
component at that moment. What is implemented is the strongest discipline
available without a native addon: record the identity of each directory
component, open, then re-verify the entire chain and the final entry before any
byte is read. The demonstrated attack — replacing `coord/` with an external
symlink after canonicalization — is therefore **detected and refused, and no
external byte is ever parsed or emitted** (proof 9).

The residual, stated plainly: the `open()` syscall itself may transiently land
on an attacker-chosen path in the window between canonicalization and open. The
opened object is never read, and `O_NOFOLLOW`+`O_NONBLOCK` bound what that open
can do, but the syscall is not prevented. Closing it fully requires an `openat`
binding (a native addon or a Node core change), which is out of scope for this
ticket and was **escalated to human admin** rather than being silently absorbed.

**Ruling: the residual is ACCEPTED for this release** (human admin, 2026-08).
Recorded reasoning:

- the delivered boundary is sufficient for COORD-657's purpose, because
  attacker-selected content is never read, parsed, executed or emitted;
- the remaining risk is only the transient `open()` syscall itself;
- a native addon providing `openat` would introduce a larger portability,
  packaging and security surface than the bounded residual justifies.

No implementation ticket is opened. The revisit trigger below governs when this
is reconsidered.

**Residual-specific revisit trigger.** Reopen the residual — not the whole
decision — when ANY of the following becomes true:

1. Node exposes handle-relative opening (`openat`, `O_PATH`, or `AT_FDCWD`) in
   its public `fs` surface, making true containment expressible without a native
   addon.
2. The runtime already adopts a trusted native helper for other reasons, so the
   portability, packaging and security surface the ruling weighed is being paid
   for anyway.
3. The threat model expands to forbid even a transient `open()` on an
   attacker-chosen path during concurrent hostile mutation of the workspace.

**Also accepted as disclosed and non-blocking:** case-fold path aliases are not
separately detected. Stated, not chased.

## Review History

- Round 2 (commit `be817d80`) was returned by human-admin review with three new
  HIGH blockers — the parent-directory swap above, a FIFO blocking discovery
  indefinitely, and the Windows no-follow downgrade — plus the `undefined`
  parser inconsistency and the overclaims corrected in this revision. The
  static-parser architecture was again accepted in principle.
- Round 1 (commit `cf5def6a`) was returned to `doing` by human-admin review with
  six reproduced findings: stat errors classified as absence, symlink following,
  a check-then-act size bound, `--json` stdout polluted with prose, a missing
  network side-effect proof, and this unrecorded premise correction. The
  static-reader architecture itself was accepted in principle.
- Round 4 (commit `2a5d6ba4`) was held by human-admin review with three
  reproduced parent-path defects sharing ONE root cause — canonicalizing before
  inspecting (H4 dangling parent symlink reported absent, H5 in-workspace
  symlinked parent followed and accepted, M6 `ENOTDIR` misreported as a symlink)
  — all three uncovered while 21/21 passed. Point 4 above previously asserted a
  no-traversal guarantee the mechanism could not deliver; that is the SECOND
  time this record ran ahead of the code, and both the ordering and this text
  are corrected in round 5.
- Round 3 (commit `c5f163f6`) was reviewed with 20/20 green independently
  reproduced. Human admin ACCEPTED the H1 residual (see "Residual Risk") and
  required two corrections before acceptance of this record: the false Decision
  Criteria sentence above, and making `O_NONBLOCK` required rather than optional
  in `openFlags()`. Both are applied in round 4, and this record is therefore
  **Accepted**.

## Revisit Trigger

Reopen if a supported adopter configuration cannot be expressed in the static
grammar — i.e. if real workspaces need computed values in `project.config.js`.
The answer then is a declarative data file for the discovery surface, NOT a
sandbox: option two above, with the migration cost accepted deliberately.
