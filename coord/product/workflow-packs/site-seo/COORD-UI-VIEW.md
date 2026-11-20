# Site SEO coord-ui View Contract

This pack defines a read-only cockpit model. The UI may display governance state,
but it must not mutate Search Console, commerce admin, theme code, or live sites.

## Suggested Sections

| Section | Inputs | Shows |
|---|---|---|
| Audit sources | `AUDIT-DATA-REGISTER.csv` | latest source date, issue bucket counts, stale/superseded flags. |
| URL registry | `URL-REGISTRY.csv` | canonical/final URL, object surface, indexability, last live check. |
| Finding lifecycle | `FINDING-LIFECYCLE.csv` | status distribution, next action, evidence links, closure reasons. |
| Request queue | `GSC-REQUEST-QUEUE.csv` | ready, blocked-browser, requested, monitoring, indexed, deferred. |
| Monitoring windows | lifecycle + queue rows | next check dates and overdue recrawl reviews. |
| Expected exclusions | `EXPECTED-NOISE-POLICY.md` + lifecycle rows | URLs classified as non-commercial utility noise. |

## Redaction

Viewer mode should redact full private URLs when the adopter marks the site as
sensitive. Show URL path/hash, status, owner ticket, and evidence class. Operator
and admin modes may show the operational URL if local access policy allows it.

## Demo Data

Use synthetic fixtures only:

- `https://www.example.com/products/sample-product`
- `https://www.example.com/blog/sample-guide`
- `https://www.example.com/search?q=example`
