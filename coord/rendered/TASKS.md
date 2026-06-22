# Project Task Board

Generated from `coord/board/tasks.json`. Do not hand-edit.
Regenerate with `node coord/board/board.js sync`.

Before starting any ticket, complete coord/AGENT_STARTUP_CHECKLIST.md.
Replace the example tickets below with your project work.
Repo codes are defined in coord/project.config.js. Use X for cross-repo / coordination work.

## Getting Started

This is a starter board. Replace these example rows with real tickets.
Each ticket flows todo -> doing -> review -> done via coord/scripts/gov.
Run `npm run demo` in frontend/apps/coord-ui to see a populated example cockpit.

---

## Backlog

| ID | Repo | Type | Pri | Status | Owner | Description | Depends On |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SETUP-001 | X | docs | P1 | todo | unassigned | Configure coord/project.config.js with your repo map and populate the coord/product/ specification stubs. |  |
| SAMPLE-001 | B | feature | P2 | todo | unassigned | Example backend ticket. Replace with your first real unit of work. | SETUP-001 |
