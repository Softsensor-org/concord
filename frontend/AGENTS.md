# Frontend Agent Directives

- Use repo-local worktrees under `frontend/.worktrees/<agent>/<ticket>/` for code work.
- `frontend` should mirror backend contracts and must not invent conflicting payload shapes.
- If frontend work requires board, prompt, plan, or lock changes, use `coord/scripts/gov ...` instead of editing coord state directly.
- Keep environment-specific values and secrets out of committed frontend code.
- Add or adjust tests when behavior changes, especially around routing, client contracts, or stateful UX flows.
- Run relevant frontend quality gates before moving a ticket to `review` via `frontend/scripts/gate.sh <lane>`. The lane interface and env loading rules are defined in `coord/product/BOOTSTRAP_CONTRACT.md`; `frontend/BOOTSTRAP.md` is the per-repo checklist.

