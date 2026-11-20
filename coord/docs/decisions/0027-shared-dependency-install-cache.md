# ADR 0027: Shared dependency install cache

- **Status:** Accepted
- **Decision status:** Accepted by the human admin on 2026-11-16 (COORD-1030), explicitly reaffirmed with authorization to land this ADR-only change on 2026-11-17. Implementation remains deferred.
- **Ticket:** COORD-942
- **Date:** 2026-11
- **Linked scope:** `gov start` worktree setup (dependency install step), the repo config key `dependencyStrategy`, a new install-cache module under `coord/engine/`, the adopter docs for install configuration.

## Context

Every governed ticket worktree is created by `gov start` and gets its own dependency install. For a product repository with a large `node_modules` tree, that install is the slowest part of starting a ticket, and it repeats work that is often identical across worktrees: the same lockfile, the same package-manager version, the same Node ABI, the same platform. Parallel staggered workers (up to five at once) multiply the cost.

A shared install cache would let compatible worktrees link one immutable install instead of each installing privately. The risk is correctness: a dependency tree that is wrong for a worktree (wrong Node ABI, a local workspace package that resolves to the wrong clone, a partially written install, a mutable tree that one worktree changes under another) can make gate results misleading. The cache therefore has to be opt-in, fail closed, and never produce gate evidence.

The board row for COORD-942 (human-admin direction 2026-11-14) asks for this design to be recorded as an ADR before any implementation. This ADR records the accepted design. Implementation remains deferred to a separately scoped ticket; acceptance of this ADR does not authorize host provisioning or enable the cache.

## Linked Scope

- Governing ticket: COORD-942 (feature, P2). Acceptance items (1) to (8) are the board row's; this ADR records the design that items (1) to (6) depend on. Items (7) and (8) (tests and docs) belong to the implementation.
- Related: ADR 0021 (tiered governance; a change that alters install behaviour for adopters is a governed change), ADR 0025 (per-PR impact-radius gates; a cache must never weaken a configured gate), ADR 0018 (independent reviews bind to commits; the cache must not change what a review evidences).

## Decision Criteria

- **Default unchanged.** An adopter who does not set `dependencyStrategy` gets exactly today's install behaviour, byte for byte in the command it runs.
- **Opt-in is explicit.** Sharing is enabled only by an adopter's repo config value `link-shared`. No environment variable or heuristic turns it on.
- **Verified before reuse.** A cache entry is used only after its metadata is re-derived and matched against the requesting worktree. A mismatch is a miss, never a warning-and-use.
- **Immutable published entries.** No worktree writes into a published entry. A worktree receives read-only links, not a writable tree.
- **Fail closed.** Anything the cache cannot represent exactly falls back to a private install, with a stated reason.
- **Performance only.** A cache hit is an install-time optimisation. It is never test evidence or gate evidence, and it does not change the install semantics that a clean-checkout gate uses.
- **No secrets.** Metadata records identity inputs and hashes, never tokens, registry credentials or environment values.

## Options Evaluated

1. **Private install only (status quo).** Simple and correct. Cost: one full install per worktree.
2. **Opt-in shared install cache with verified immutable entries and read-only links (`link-shared`) (accepted).** One builder per compatibility key, staged publish with atomic rename, verification before reuse, fail-closed fallback.
3. **Content-addressed store** (a pnpm-style global store of files, hard-linked into each tree). Strong deduplication across different trees, but it depends on a package-manager-specific layout and a store that all tools understand. Larger change, weaker fit for npm and yarn users.
4. **Package-manager-native shared stores** (for example a shared pnpm store, or an npm/yarn cache directory). Uses supported tooling and needs no custom cache format, but the reuse is only of downloaded tarballs; the install step still runs per worktree, so the performance gain is smaller and it depends on each manager's behaviour.

## Decision

Adopt option 2 as the accepted design for COORD-942. This landing records the decision only; implementation, tests and adopter documentation remain deferred.

### 1. Configuration

- `dependencyStrategy` in the adopter's repo config. Values: `private` (default, current behaviour) and `link-shared` (opt-in).
- With `link-shared`, `gov start` may link a cache entry. Any other value, or a missing value, is `private`.

### 2. Cache identity (compatibility key)

The key is a hash over a canonical, versioned record. Two entries share a key only if every field below is equal. Each field is a separate input, so any single difference yields a different key.

- **Lockfile bytes:** the SHA-256 of the lockfile the package manager reads.
- **Package manager and version:** detected name and exact version (for example `npm@10.x.y`), read from the package manager's own version command, not from a guess.
- **Node version and ABI:** exact Node version and its module ABI (`process.versions.modules`).
- **OS and architecture:** platform and CPU architecture.
- **Install flags and config:** the exact argv of the install command, and the hashes of the package-manager config files that affect resolution or scripts (for example `.npmrc`, `.yarnrc.yml`), after removing any credential fields.
- **Declared extra inputs:** adopter-declared files or values that affect the install (for example a postinstall-relevant env allowlist). An input not declared is not represented, so it forces the fail-closed path below.

Metadata stores the record fields and the key. It never stores token values, registry auth lines, or environment variables outside the declared allowlist.

### 3. Fail-closed rules (private install instead)

The cache is not used, and the worktree gets a private install with a recorded reason, when any of these hold:

- The dependency graph has local, `file:`, `link:`, workspace or git dependencies that resolve to paths outside the worktree or that the key cannot represent exactly. (Acceptance item 5: such trees are rejected to private install in this first version. Rebinding them per worktree is an open question below.)
- The package manager or lockfile format is not on the supported list.
- An install input is unrepresented (an undeclared env or config file that the install reads).
- Verification of the entry fails for any reason (see section 5).

A miss (no entry for the key) is also a private install, but the worktree builds the entry for next time only if it holds the per-key builder lock; otherwise it installs privately and does not wait.

### 4. Publish: staged build, atomic rename, per-key builder lock

- A builder takes an exclusive lock named by the key. Only one builder runs per key. A second starter for the same key waits on the lock or, if the lock is held beyond a bounded timeout, installs privately and reports it.
- The builder installs into a staging directory under the cache root, named with the key and a random suffix. It writes the metadata file last, after the install completes and the exit status is zero.
- Publish is an atomic rename of the staging directory to its final key path. Readers only ever see a complete, final directory.
- An interrupted build leaves a staging directory with no metadata file. Such directories are never reused and are removed by the cleanup policy (open question on retention).

### 5. Verify before reuse

Before linking, a reader:

- reads the metadata file and checks its schema version;
- recomputes the key from the requesting worktree's inputs and requires equality with the entry's key;
- recomputes a digest over the entry's tree (paths, sizes, modes, symlink targets and cryptographic hashes of every regular file's contents) and requires equality with the recorded digest. This makes a corrupted, partial or edited entry detectable;
- refuses an entry whose metadata is missing, whose digest does not match, or whose staging marker is present.

Verification failure is a miss with a reason, never a use. A failed entry is quarantined for inspection rather than silently repaired.

### 6. Read-only links

- The worktree's dependency directory is a link to the published entry. The published entry is set read-only (directories and files) after publish.
- Read-only modes alone are insufficient when a reader can change permissions or replace entry bytes or metadata. Reuse requires an enforced boundary that prevents readers from modifying the published entry from verification through use; otherwise the topology is unsupported and must use a private install. The implementation must prove this boundary, including same-user and verification-to-use races.
- Nothing in a worktree writes through the link. A tool that tries to write fails, which is the intended outcome; the fallback is a private install, not a copy-on-write repair.
- Because a link cannot be made writable by the worktree, install-time scripts that write into the tree run only at build time, in the builder, never at link time.

### 7. Cleanup of only worktree-owned links

- The worktree records the link it created (path and target key) in its own governed state.
- Worktree cleanup removes only that recorded link. It never deletes the cache entry, never removes a directory the worktree did not create, and never changes the product clone.
- A removal that cannot prove the path is the recorded link is refused and reported.

### 8. Poisoning and concurrency

- **Poisoning.** Entries are immutable after publish and verified on every reuse (sections 5 and 6), so a poisoned or edited entry is detected at read time. The cache root is writable only by the builder identity; readers do not get write access. A shared operating-system identity that can restore writes does not satisfy this requirement. Content verification detects existing corruption; it is not a substitute for the enforced write boundary during use.
- **Concurrent starts.** One builder per key (section 4). Readers see only completed, final entries (atomic rename). Two readers of one entry do not interfere because nothing writes to a published entry.
- **Interrupted builds.** Never reused (section 4). A staging directory is never promoted without its metadata file.
- **Cross-key contamination.** Keys differ on every compatibility input (section 2), so an entry cannot be linked into a worktree with a different Node ABI, platform, lockfile or install flags.

### 9. Evidence and reporting

- `gov start` reports, for every worktree, either `cache hit: key=<key> source=<cache root entry>` or `private install: reason=<reason>`.
- A cache result is recorded as an install note, never as a test, gate or review result. A configured gate still runs its defined install semantics and is not weakened.

### 10. Cache root and permissions (default proposal, to be confirmed)

- The cache root is a directory owned by the governance operator on the host, with the builder writing and readers reading. Entries are mode read-only for group and other.
- The location is configured per host, not per repo, so one shared root can serve several adopter repos on one host. The open question on shared multi-user hosts is below.

## Alternatives Rejected

- **Content-addressed store as the mechanism.** Rejected for this version: it needs a store layout that every package manager and tool agrees on, a larger change to the install path, and it is harder to make read-only per worktree. It remains a candidate for a later ADR if the link-shared performance is not enough.
- **Package-manager-native shared store as the mechanism.** Rejected as the primary mechanism: it shares downloads, not the install result, so the install step still runs in every worktree and the gain is smaller. It stays available to adopters as a `private` install detail, outside this ADR.
- **Link-shared as the default.** Rejected. Sharing changes which tree a worktree runs against, and a wrong tree can mislead a gate. Default behaviour stays private.
- **Writable links or copy-on-write repair.** Rejected: a worktree writing into a shared entry would poison it for every other worktree.
- **Silently falling back to a shared entry on any verification failure.** Rejected: a failed entry must be a reason-carrying miss, never a use.

## Consequences

- Adopters who do not opt in see no change.
- Adopters who opt in get faster worktree starts for compatible trees and a clear reason whenever they do not.
- Local, workspace and git dependencies are not shared in the first version. Repos with many such dependencies get private installs and no benefit. This is deliberate.
- A cache entry is a dependency of every worktree linked to it, so cache-root retention and cleanup need an explicit policy (open question). Deleting an entry that a live worktree links is a failure mode the policy must address.
- The verification digest adds a one-time cost per entry on each reuse. This is accepted to make corruption detectable.
- Read-only links make some install-time tooling behaviour a build-time-only concern. Any tool that needs to write into `node_modules` at test time will fall back to a private install, and the reason will say so.
- The feature is not evidence. Reviewers and gates must not treat a cache hit as a clean install.

## Open Questions for Implementation

The core design is accepted. These deployment and implementation choices remain unresolved; they do not authorize weakening the fail-closed rules. Resolve applicable choices in the implementation ticket before enabling sharing.

1. **Cache location and permissions on a shared multi-user host.** Who owns the cache root, which group may read it, and may several unrelated adopters share one root? Shared roots raise the cross-tenant poisoning question; per-user roots remove the sharing benefit. Please decide the location, owner, group and mode.
2. **Retention and cleanup.** How long does an unused entry stay? What happens to an entry that a live worktree still links? Is cleanup a governed verb, a scheduled job, or manual? What disk-usage ceiling triggers it?
3. **Whether link-shared may ever be the default.** This ADR proposes it stays opt-in. Should a future ADR consider a default for a narrow class (for example, repos whose every dependency is registry-resolved and whose lockfile is fully pinned), or is opt-in permanent?
4. **Local and workspace dependencies.** Should a later version rebind workspace links per worktree, or keep rejecting them to a private install? The first version rejects them.
5. **Supported package managers.** Which managers and lockfile formats are in scope for the first implementation?
6. **Declared extra inputs.** Who may declare an extra install input, and does a declaration need a human review because it widens the key?

## Revisit Trigger

Reopen this ADR if install time remains a bottleneck after link-shared is used on compatible repos, if a poisoned or wrong entry reaches a worktree, or if the human admin changes any answer to the open questions above.

## Waiver Policy

No waiver applies to the fail-closed rules or to the rule that a cache result is never gate evidence. A waiver for an opt-in adopter's specific install input may be granted by the human admin through a governed change that cites this ADR.
