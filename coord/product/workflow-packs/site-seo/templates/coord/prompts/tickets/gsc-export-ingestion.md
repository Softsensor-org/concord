# Search Console Export Ingestion

## Required Inputs

- Latest Search Console export set.
- Prior audit data register.
- URL registry.
- Current task ledger or board state.

## Required Output

- Updated audit data register rows.
- URL registry additions or identity updates.
- New, fixed, unchanged, ignored, and superseded counts.
- Work batch recommendation.

## Forbidden Actions

- Do not mutate live site, commerce admin, theme code, or Search Console.
- Do not treat screenshots as the canonical export when a dated export exists.
