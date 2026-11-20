# coord/board

Purpose:
- canonical machine-readable source for the live board
- prompt mappings, review findings, landing evidence, and follow-up relations

Files:
- `tasks.json` — canonical board source
- `tasks.schema.json` — board schema
- `plans/<ticket>.json` — structured plan records
- `plan.schema.json` — plan record schema

Dependency-edge contract (decided under COORD-673):
- `Depends On` is a COMMA-SEPARATED LIST of ticket ids, not a single value. It is
  the multi-edge field: `governance-validation.js#splitDependsOn` feeds
  `evaluateReadiness`, which walks EVERY entry and reports each unmet one in
  `readiness.blockedBy`. A ticket blocked by two independent tickets records both.
- `followup_exceptions[<ticket>]` is by contrast a SINGLE `{parent, type}` record
  (see `tasks.schema.json`), so the relations that need one — `related`,
  `closeout-blocker` — bind exactly ONE parent per ticket. Extra dependencies are
  recorded as plain blocking edges in `Depends On`.
- `gov set-followup-relation` therefore ACCUMULATES `Depends On` edges (comma form
  and repeated `--depends-on` both accepted) and FAILS CLOSED rather than
  discarding an existing follow-up exception; `--replace` is the explicit opt-in,
  and `--relation independent --depends-on <id>` removes one edge without
  disturbing the others. Prose (a block reason, a plan note) is not a substitute:
  only `Depends On` feeds readiness.

Workflow:
- use `coord/scripts/gov ...` for normal lifecycle mutations
- run `node coord/board/board.js validate` to verify board integrity
- run `coord/scripts/gov sync` after successful governed board changes; direct `board.js sync`/`render` is reserved for bootstrap without a journal
- `gov sync` recovers exact generated-view drift only on a journal baseline that records the rendering policy inputs (`GOVERNANCE.md`, `project.config.js`, the board schemas); a legacy baseline that predates them still needs the reviewed `gov reconcile` procedure, so this does not automatically unblock an existing downstream wedge
- treat `coord/rendered/TASKS.md` and `coord/rendered/PROMPT_INDEX.md` as generated outputs

