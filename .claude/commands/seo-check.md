# SEO Check — Run the Content Gate Locally (marketing track)

Run the marketing **content gate** over the site and report SEO/meta/link health in plain
language. This is a read-only check — it **does not auto-fix** anything.

**Arguments:** `$ARGUMENTS` — a `WEB-`/`DOC-` ticket id, and/or a site directory to check.
Examples:
- `WEB-014`
- `site/` or `WEB-014 --dir site/`

## Phase 1: Resolve the target

1. If a ticket id is given, look it up in `coord/board/tasks.json` and use its governed worktree
   and site directory.
2. If a directory is given, check that directory directly.
3. Default to the project's site dir if neither is specified.

## Phase 2: Run the content gate

```bash
node coord/scripts/content-gate.js <site-dir>
```

The content gate checks, per the marketing-track gate-proc:
- **HTML validity** and **broken-link** detection
- **SEO/meta enforcement** — canonical URL, Open Graph tags, Twitter card,
  `Organization` JSON-LD, sitemap membership (no page should land without them)
- **Lighthouse** SEO / performance / accessibility thresholds

## Phase 3: Report (no fixes)

Report in plain English:
- **Result:** pass or fail
- **Per-page issues:** which page, which check, what's missing (e.g. "careers.html has no canonical tag")
- **Links:** any broken/redirecting links
- **Lighthouse:** the SEO/perf/a11y scores vs. thresholds
- **Artifact path:** where the gate report was written

If anything fails, I list it and suggest a fix in words — then point you at **`/content-edit`**
to make the change. I do **not** edit files from this skill.

## Rules

- Read-only. This skill never modifies the site; it only reports.
- Always go through `node coord/scripts/content-gate.js` so results match what `/publish` will gate on.
- A page with missing SEO/meta is a **fail**, not a warning — flag it clearly so it's fixed before publish.
