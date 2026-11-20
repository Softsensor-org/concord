# Backend Agent Directives

- Use repo-local worktrees under `backend/.worktrees/<agent>/<ticket>/` for code work.
- `backend` owns API contracts, persistence semantics, events, and domain truth.
- If a backend change affects governance state, prompts, plans, or the board, use `coord/scripts/gov ...` instead of editing coord state directly.
- Keep backend contracts explicit; frontend consumers should mirror them rather than infer them.
- Run relevant backend quality gates before moving a ticket to `review` via `backend/scripts/gate.sh <lane>`. The lane interface and env loading rules are defined in `coord/product/BOOTSTRAP_CONTRACT.md`; `backend/BOOTSTRAP.md` is the per-repo checklist.
- Do not commit secrets, generated credentials, or local environment files.

