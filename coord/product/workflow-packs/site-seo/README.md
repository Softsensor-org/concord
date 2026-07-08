# Site SEO Workflow Pack

Status: operating governance pack.

This pack lets Concord govern external-site SEO work without becoming a data
warehouse. Coord owns the workflow contract, ticket routing, evidence links, and
closure rules. Raw Search Console exports, site-audit exports, commerce-admin
screenshots, and private crawl data stay in adopter-owned `data/` or `exports/`
folders.

## What It Adds

- `00-ops/seo/AUDIT-DATA-REGISTER.csv`
- `00-ops/seo/URL-REGISTRY.csv`
- `00-ops/seo/FINDING-LIFECYCLE.csv`
- `00-ops/seo/GSC-REQUEST-QUEUE.csv`
- `00-ops/seo/SEO-GOVERNANCE-CONTRACT.md`
- `00-ops/seo/SEO-EVIDENCE-CONTRACT.md`
- `00-ops/seo/EXPECTED-NOISE-POLICY.md`
- reusable prompt templates under `coord/prompts/tickets/`
- `data/raw`, `data/staged`, `data/clean`, `data/marts`, and `data/reports`
  folder notes for adopters that want the canonical data layout.

## Lifecycle

```text
audit source/export
-> raw immutable snapshot
-> staged parsed copy
-> normalized URL/finding rows
-> action evidence
-> live verification
-> request queue or monitoring
-> recrawl evidence
-> closed, expected-excluded, or deferred
```

## Ticket Model

Use a small number of parent tickets for standing channels and split child
tickets only when evidence, tools, or closure rules differ:

| Ticket class | Purpose |
|---|---|
| Search Console monitoring | Own latest export registration, recrawl queue, and monitoring movement. |
| Site-audit triage | Classify findings, suppress expected noise, and create action batches. |
| Content batch | Improve content quality and internal links for a defined URL set. |
| Admin edit batch | Track safe commerce-admin edits with before/read-back/live evidence. |
| Theme/runtime SEO fix | Route code changes through the site/theme repo, not through coord notes. |
| Monitoring review | Close, reopen, or defer findings after recrawl or fresh export evidence. |

## Non-Goals

- Do not move raw audit exports into coord.
- Do not use one ticket per URL unless risk, owner, tool, or approval differs.
- Do not mark indexing work done immediately after a live fix. Move it to
  monitoring until recrawl evidence exists.
- Do not let generic coding prompts run platform mutations without the SEO
  evidence contract.
- Do not bypass the product/theme repo's ticket, QA, commit, and deploy rules
  for code changes.

## Public Safety

Use synthetic fixture domains such as `https://www.example.com/products/example`.
Do not commit real domains, account ids, local filesystem paths, screenshots
with account data, raw exports, or customer-specific campaign data to this pack.
