# Content Edit — Plain-English Marketing Change (marketing track)

Make a copy or image change to the marketing site, described in everyday language — no
HTML or git required. This skill drives the **same** governed flow the engineers use
(claim → governed worktree → edit → prepare), just wrapped for the marketing track.

**Arguments:** `$ARGUMENTS` — a `WEB-`/`DOC-` ticket id, and/or a plain-English description
of the change. Examples:
- `WEB-014 change the pharma case study headline to "Cut review time 40%" and swap the hero image for the new lab photo`
- `update the careers page intro paragraph` (I'll find or open the matching `WEB-`/`DOC-` ticket)

## Phase 1: Get a governed workspace

If you gave a ticket id, I open its governed worktree. If you only described a change, I find
the matching `WEB-`/`DOC-` ticket on the board (or open a follow-up) first.

```bash
coord/scripts/agent do $ARGUMENTS
```

This claims the ticket for this session, starts it on the **marketing track**, and binds an
isolated worktree — your live site is never touched directly.

## Phase 2: Make the change

I read the relevant page(s) and apply your change in plain language:
- swap headlines, body copy, button text, alt text, links
- replace or add images (and write sensible `alt` text + keep file sizes web-friendly)
- add or reorder a content section

I'll show you the before/after in words and confirm before saving.

## Phase 3: Prepare it for review

```bash
coord/scripts/gov commit $ARGUMENTS --message "<plain summary of the change>"
coord/scripts/gov heartbeat $ARGUMENTS
coord/scripts/gov explain $ARGUMENTS
```

Then I'll tell you the next step: run **`/seo-check`** to confirm meta/links are healthy,
then **`/publish`** to gate and ship. I do **not** publish from here.

## Rules

- Plain English in, governed change out — you never need to know HTML or git.
- All edits happen in the governed worktree via `coord/scripts/agent do`; never hand-edit the
  live site or board/plan state.
- One ticket per session. If your request spans two pages with different tickets, I'll say so.
- Stop at "prepared." Gating and going live are `/publish`'s job, never this skill's.
