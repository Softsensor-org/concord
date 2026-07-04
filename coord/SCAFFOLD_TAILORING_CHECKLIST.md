# Scaffold Tailoring Checklist

Ticket: COORD-001
Status: tailoring reference
Date: 2026-06-04

This is the complete checklist for adopting the coord scaffold in a real
project. `QUICKSTART.md` is the 5-minute happy path; this document is the
authoritative reference for **every seam a project edits when it adopts the
scaffold** — repo names, prompts, validation hooks, and starter process notes.

Rule of thumb: projects edit the **config seam**, not the engine. Engine files
(`coord/paths.js`, `coord/scripts/*`, `coord/board/board.js`, schemas) are
engine-managed; upgrade the engine rather than forking it. See
`coord/docs/GCV4_ENGINE_CONFIG_SEAM.md`.

## 1. Repo names and layout

The repo map is the one required change.

- [ ] `coord/project.config.js` — set `repos` to your real codes, paths,
      `integrationBranch`, and `origin`. `X` is reserved for coord-only work and
      must not appear in `repos`. `integrationBranch` defaults to `dev`.
- [ ] `coord/product/REPOS.md` — update repo roles/descriptions to match.
- [ ] Confirm with `node coord/board/board.js validate` and
      `coord/scripts/gov counts`.

Renaming repos is a config edit, not an engine fork and not a per-ticket
workaround.

## 2. Requirement and architecture references

- [ ] Populate `coord/product/REQUIREMENTS.md`, `ARCHITECTURE.md`,
      `DOMAIN_MODEL.md`, `INTEGRATION.md`, and `MVP_AND_PHASE_MATRIX.md` with
      real project content (these ship as stubs).
- [ ] Update `coord/board/tasks.json` `metadata.canonical_references` if you add
      or rename reference docs.

## 3. Prompts

- [ ] Review the generic role prompts in `coord/prompts/` (`planner.md`,
      `implementer.md`, etc.) — adjust wording for your domain if needed.
- [ ] For tickets that need bespoke acceptance criteria, add a ticket-specific
      prompt under `coord/prompts/tickets/<TICKET>.md` and map it in
      `coord/board/tasks.json` `prompt_index`.
- [ ] Run `coord/scripts/gov sync` to regenerate `rendered/PROMPT_INDEX.md`.

## 4. Validation hooks

- [ ] `coord/scripts/preflight.sh` — the hygiene + contract gate. Set
      `COORD_PREFLIGHT_TICKET` / contract command for your project's local
      checks. Wire it into your pre-push or CI as desired.
- [ ] `coord/scripts/hooks/session-start.js` — the Claude Code SessionStart
      identity hook (exports `COORD_PROVIDER*` durable identity). Keep it wired
      in `.claude/` settings so governance has a stable session fingerprint.
- [ ] Per-repo quality gates: confirm the gate commands referenced by
      `coord/product/TESTING_AND_GATES.md` and
      `coord/product/LOCAL_AUTOMATION_AND_GATES.md` exist in each product repo.

## 5. Starter process notes

- [ ] Read `coord/GOVERNANCE.md` (authority order, lifecycle) and the repo-local
      `AGENTS.md` files — these are canonical and usually need no edit.
- [ ] Decide the integration branch per repo (`dev` by default). If a repo lands
      on `main`, record that intentionally; base-branch overrides are
      human-admin only.
- [ ] Confirm session discipline expectations in `CLAUDE.md` (one ticket per
      session) fit your team's workflow.
- [ ] Seed your first real backlog rows (the one allowed hand-edit of
      `tasks.json`: new `todo`/`unassigned` rows), then `gov sync`.

## 6. Verify the tailoring

```bash
node coord/board/board.js validate
coord/scripts/gov counts
coord/scripts/gov doctor
```

All three should pass cleanly before you start governed work.

## Related Documents

- `QUICKSTART.md` — 5-minute first-run path
- `coord/product/REPOS.md` — repository roles and layout
- `coord/docs/GCV4_ENGINE_CONFIG_SEAM.md` — why config beats forking the engine
- `coord/GOVERNANCE.md` — canonical governance policy
