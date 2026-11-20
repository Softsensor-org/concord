# Concord Workflow Packs

Workflow packs are optional operating-governance bundles that adopters can copy
into a Concord workspace. They are not engine rules by default.

Each pack supplies some combination of:

- governance docs for `00-ops/...`;
- register templates and status enums;
- ticket prompt templates;
- evidence and closure rules;
- synthetic fixtures and report templates;
- future validation ideas that can be promoted to engine checks only after the
  operating contract proves stable.

Install with `create-concord --workflow-pack <id>` or copy a pack's
`templates/` directory into an existing workspace.

Available packs:

| Pack id | Purpose |
|---|---|
| `site-seo` | External-site SEO governance: audit sources, URL lifecycle, recrawl queues, SEO evidence, and monitoring. |
| `daily-analytics` | Daily analytics governance: utilities, data sources, guidance rules, pipelines, reconciliation, and run ledgers. |

Public-safety rule: packs ship with synthetic examples only. Raw exports,
account screenshots, access tokens, customer names, private domains, and private
repository paths stay in adopter-owned evidence locations, not in the public
template.
