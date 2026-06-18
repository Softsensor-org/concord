# coord/board

Purpose:
- canonical machine-readable source for the live board
- prompt mappings, review findings, landing evidence, and follow-up relations

Files:
- `tasks.json` — canonical board source
- `tasks.schema.json` — board schema
- `plans/<ticket>.json` — structured plan records
- `plan.schema.json` — plan record schema

Workflow:
- use `coord/scripts/gov ...` for normal lifecycle mutations
- run `node coord/board/board.js validate` to verify board integrity
- run `node coord/board/board.js sync` after successful board changes
- treat `coord/rendered/TASKS.md` and `coord/rendered/PROMPT_INDEX.md` as generated outputs

