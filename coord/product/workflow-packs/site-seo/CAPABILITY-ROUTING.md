# Site SEO Capability Routing

Tickets should declare required capabilities instead of naming a specific agent.

| Capability | Meaning | Example work |
|---|---|---|
| `seo_data_ingestion` | Parse audit exports and normalize URL rows. | Search Console CSV import, site-audit issue import. |
| `seo_strategy_triage` | Decide priority and current relevance. | Separate commercial pages from expected utility noise. |
| `seo_content_strategy` | Improve page usefulness and search intent fit. | Collection copy, article summaries, hub copy. |
| `commerce_admin_ops` | Safe admin edits with read-back. | SEO fields, content summaries, redirects. |
| `theme_seo_runtime` | Template/runtime SEO code changes. | Canonical, robots, rendered metadata, JSON-LD. |
| `live_seo_qa` | Verify live rendered HTML and indexability. | HTTP status, canonical, robots, H1, links, schema. |
| `browser_search_console_ops` | Use logged-in browser/tooling for inspection/request steps. | URL inspection requests and blocked-browser records. |
| `analytics_monitoring` | Evaluate movement after fixes. | Indexed status, impressions, landing page movement, audit deltas. |
| `governance_repair` | Fix board, lock, journal, or stale-source drift. | `gov explain`, validate, sync, doctor. |

Example ticket declaration:

```text
Required capabilities:
- seo_data_ingestion
- live_seo_qa
- analytics_monitoring

Forbidden actions:
- commerce admin mutation
- theme deploy
- paid app recommendation
```

For admin mutation tickets, require:

- before admin values;
- mutation result with zero user-facing errors;
- admin read-back;
- live storefront verification;
- URL registry update;
- request queue or monitoring update.
