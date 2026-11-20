# Repository Layout

The scaffold assumes three sibling git repos under one project root.

## Default Directory Structure

```text
/path/to/project/
├── backend/   ← product backend repo
├── frontend/  ← product frontend repo
└── coord/     ← governance and coordination repo
```

If your repo names differ, update:

- `coord/project.config.js`
- `coord/board/tasks.json` metadata that references repo layout
- any repo-name examples in onboarding docs and shims

## Repository Roles

### `backend/` — Product Backend

| | |
|---|---|
| Primary role | APIs, domain services, persistence, jobs, integrations |
| Repo code in board | `B` |
| Expected worktree root | `backend/.worktrees/<agent>/<ticket>/` |
| Owns | canonical server-side product behavior |
| Must not own | governance state or frontend-only UX behavior |

### `frontend/` — Product Frontend

| | |
|---|---|
| Primary role | UI, route shells, interaction flows, presentation logic |
| Repo code in board | `F` |
| Expected worktree root | `frontend/.worktrees/<agent>/<ticket>/` |
| Owns | client behavior and presentation composition |
| Must not own | authoritative backend contract invention or governance state |

### `coord/` — Governance Control Plane

| | |
|---|---|
| Primary role | board, prompts, governance policy, plans, questions, runtime locks |
| Repo code in board | `X` |
| Runtime state | `coord/.runtime/` |
| Owns | ticket lifecycle, operator policy, shared governance runtime |
| Must not own | project-specific product runtime logic |

## Ownership Rules

1. `backend` owns canonical product payload and workflow semantics.
2. `frontend` mirrors backend contracts and should not invent conflicting payload shapes.
3. `coord/board/tasks.json` is the canonical tracker across repos.
4. Use repo-local worktrees for code work in `backend` and `frontend`.
5. Cross-repo planning, governance, and design tickets use repo code `X`.
6. Repo name changes are a scaffold-tailoring step, not an implementation-ticket workaround.
