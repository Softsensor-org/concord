# ADR 0008: Adopter workspaces use a non-Git container and an independent coord control-plane repository

- **Status:** Accepted
- **Ticket:** COORD-631
- **Date:** 2026-08
- **Linked scope:** create-concord/lib/install-plan.js, create-concord/bin/create-concord.js, coord/scripts/worktree-ops.js, coord/scripts/lifecycle-repox-closeout.js, coord/scripts/onboard.js, coord/scripts/doctor-report.js

## Context

Concord's donor repository (`coord-template`) is a single Git repository with
`coord/` as a subdirectory. That layout was silently treated as the adopter
layout too, so the installer offered parent-workspace Git initialization
(`--git-init`, `--git-stage`, `--git-baseline-commit`) and the engine resolved
Repo-X operations against `path.dirname(COORD_DIR)`.

A real 11-clone adoption test showed the consequences: installing into a
container of existing product repositories added 574 sample product files, and
the governance surface assumed it owned the container. COORD-624 fixed the
product-file pollution and established governance-only, sibling-workspace
installation, but did not change Git ownership.

The donor's convenience layout was determining adopter topology. Those are
different problems and need different answers.

## Linked Scope

- COORD-624 — governance-only sibling-workspace installation (landed)
- COORD-631 — retarget consent-based Git bootstrap from the container to `coord/`
- COORD-635 — control-plane Git lifecycle against `coord/.git`
- COORD-617 / COORD-621 — publication and released-artifact verification, both
  gated on the above

## Decision Criteria

1. An adopter's existing product repositories must never be modified by
   installation.
2. Governance history must be versionable without requiring the adopter to make
   their workspace container a repository.
3. Security boundaries must be legible: it must be obvious which directory owns
   which `.git`.
4. The donor's own layout must not leak into adopter topology.
5. Existing installations must be migratable without destructive action.

## Options Evaluated

**A. Container is a Git repository (status quo).** Governance history lives at
the workspace root. Simple, matches the donor. But it makes the container own
Git for a tree that also contains independent product repositories, invites
recursive staging of sibling repos, and forces adopters with an existing
directory structure to accept a repository they did not ask for.

**B. No Git anywhere except product repos.** Governance state is unversioned.
Rejected: it discards history, branches, worktrees and landing provenance for
control-plane changes, which the governed lifecycle depends on.

**C. Container is not a repository; `coord/` optionally is.** Governance history
lives in an independent `coord/.git`. Product repos remain independent siblings.
Chosen.

## Decision

Adopter workspaces use a **non-Git container** with an **independent `coord/`
control-plane repository**:

```
workspace/                  # NOT a Git repository
├── coord/.git/             # OPTIONAL independent governance repository
├── .claude/                # workspace-level agent integration
├── AGENTS.md
├── repo-one/.git/          # independent product Git repository
└── repo-two/.git/
```

Binding rules:

- The **parent workspace is never a Git repository** — not by default, not with
  consent. Absence is the control, not consent.
- **`coord/` is the control-plane repository** when Git-backed governance is
  enabled, providing history, branches, worktrees and landing provenance for
  control-plane work.
- **Product repositories are independent siblings.** Installation never mutates
  them; they are read-only *during* installation, not merely restored after.
- **Root-level workspace assets** (`.claude/`, `AGENTS.md`, `CLAUDE.md`,
  `CODEX.md`, `GEMINI.md`, `.mcp.json`) remain **installer/upgrader-owned**
  transactional files. They are not staged in the coord repository, and a
  control-plane ticket must not treat them as belonging to the coord worktree.
- **Control-plane Git operations resolve only to `coord/`.**
- **The donor repository's layout does not determine adopter topology.**
- **Existing parent-Git installations require explicit, reviewed migration** with
  backups and consent. Automatic removal or relocation of an existing parent
  `.git` is forbidden.

## Alternatives Rejected

Option A is rejected because it conflates the container with a repository and
was the direct cause of the product-repo pollution class. Option B is rejected
because it removes the provenance the governed lifecycle requires.

Making the container a repository "only when empty" was also considered and
rejected: emptiness at install time is not a durable property, and the rule
would be untestable as an invariant.

## Consequences

- The installer must retarget `--git-init` and its staging/baseline-commit
  consents from the container to `coord/`, and parent initialization must become
  impossible rather than merely off by default (COORD-631).
- Repo-X operations currently resolving to `path.dirname(COORD_DIR)` and
  `ROOT_DIR` are wrong and must move to a `coordRepoRoot` concept; worktree
  layout and `.runtime` placement change accordingly (COORD-635).
- Workspace-relative `coord/...` paths and coord-repo-relative `scripts/...`
  paths must be explicitly translated, or engine-integrity attribution will
  silently miss control-plane changes.
- `gov doctor` must classify the four states (parent Git / coord Git / neither /
  both) and offer migration rather than acting automatically.
- Released-artifact verification must exercise the full lifecycle against this
  topology, not merely file installation.

Relates to ADR-0002 (canonical/ephemeral runtime boundary) and ADR-0007
(transactional installation). Neither answers Git ownership; this ADR does.
