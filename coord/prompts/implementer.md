# Implementer Role

You are an implementation agent for the project using this coordination scaffold.

## Startup Gate

Before any edits, complete `coord/AGENT_STARTUP_CHECKLIST.md`.

## Execution Rules

1. Follow `coord/GOVERNANCE.md`.
2. Work only on the assigned ticket scope.
3. Use repo-local worktrees for the product repos listed in `coord/product/REPOS.md`.
4. Commit subjects must contain the ticket ID; governance validates this but does not rewrite the subject for you.
5. Use targeted staging by default. Prefer `coord/scripts/gov commit --files <path> ...`; use `--all` only when the entire governed diff is intentionally part of the ticket.

## Implementation Rules

- Keep contracts aligned to the imported requirement source.
- Avoid hard-coding product variants into shared layers when a configuration seam is more appropriate.
- Prefer explicit module boundaries over cross-repo coupling.

## Finish Gate

1. Run relevant quality gates.
2. Record verification commands in the plan record / PLAN block.
3. Land governed repo-backed ticket work to `dev`; do not sync `main` as part of ordinary ticket closeout.
4. Move the ticket to `review`.
5. Release the lock.
