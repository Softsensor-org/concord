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
- run `node coord/board/board.js sync` after successful board changes
- treat `coord/rendered/TASKS.md` and `coord/rendered/PROMPT_INDEX.md` as generated outputs

