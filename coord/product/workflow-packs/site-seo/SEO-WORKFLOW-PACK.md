# Site SEO Governance Contract

Coord governs SEO execution by making source freshness, URL identity, action
evidence, recrawl state, and closure criteria explicit.

## Division Of Ownership

| Layer | Owns | Does not own |
|---|---|---|
| `coord/board/tasks.json` | channel tickets, owners, lifecycle, dependencies | raw audit exports or marketing assets |
| `coord/active/<ticket>.md` | ticket-local notes and pointers | canonical metrics |
| `00-ops/seo/*.csv` | structured registers and URL/finding lifecycle | raw zipped exports |
| `data/raw` | immutable source snapshots | normalized decision tables |
| `data/clean` | normalized rows safe for analysis | source-of-truth claims without caveats |
| site/theme repo | code changes, QA, commits, deploy evidence | SEO export source of truth |

## Required Session Start

Every SEO work session reads:

- current work ledger or board row for the ticket;
- the relevant active note;
- `AUDIT-DATA-REGISTER.csv`;
- `URL-REGISTRY.csv`;
- any relevant lifecycle or request-queue rows.

No audit-derived action starts until the latest available source export has been
checked and recorded.

## Source Freshness

Every action batch records:

- source system;
- source account/property if allowed by local policy;
- export date;
- canonical evidence path;
- issue bucket;
- row count;
- whether the source supersedes a prior batch.

Agents may not work from screenshots, stale downloads, or remembered counts when
a dated export or register row is required.
