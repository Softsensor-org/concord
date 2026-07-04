# Commerce Rendered Experience QA Plan

Status: planned · Owner: Softsensor · Date: 2026-06-24

## Purpose

This plan captures a repeatable Concord pattern for improving Shopify and other
commerce sites through governed rendered-site review.

The motivating workflow was a real ecommerce-site improvement cycle where the
work was not only code or content editing. It included multi-agent reviews,
buyer-persona reviews, rendered browser inspection, Chrome-based agent usage,
coworker-style review, and Playwright checks against the live rendered
experience.

The lesson:

> Commerce quality is not proven by theme code alone. It is proven by rendered
> buyer journeys, screenshots, traces, accessibility checks, content clarity,
> and post-fix verification.

Concord should make that loop repeatable, evidence-backed, and safe.

## Product Position

Concord can provide a `Commerce / Rendered Experience QA` profile that governs
site improvement as a full experience-assurance loop:

1. Identify page or journey.
2. Capture rendered evidence.
3. Run role/persona reviews.
4. Convert findings into governed tickets.
5. Fix through the normal lifecycle.
6. Re-verify the rendered site before closeout.

The value is discipline. Instead of unstructured notes such as "Claude looked
in Chrome and found issues," Concord records:

- reviewed URL or preview;
- reviewer persona and lens;
- screenshot, trace, console, and network evidence;
- linked fix ticket;
- post-fix verification proof;
- publish/readiness decision.

## Scope

In scope:

- Shopify theme and storefront rendered-experience review;
- homepage, collection, product, cart, content, search, and checkout-boundary
  journeys;
- buyer, UX, accessibility, conversion, mobile, SEO, performance, content, and
  Shopify/theme review lenses;
- Playwright, screenshot, console, network, trace, Lighthouse, axe, and
  theme-check style evidence;
- read-only Shopify adapter concepts;
- governed ticket synthesis from review findings;
- post-fix rendered verification.

Out of scope for the first profile:

- uncontrolled production Shopify writes;
- automated checkout completion against real payment flows;
- replacing Shopify admin governance;
- broad marketing campaign management;
- full visual CMS or merchandising system.

## Relationship To Existing Track Model

This profile builds on the existing multi-track governance model documented in
`CONTENT_SITE_GOVERNANCE_PROFILE.md` and
`MULTI_TRACK_GOVERNANCE_PROFILE.md`.

It should introduce a commerce-specific track or profile rather than force all
commerce work into the generic marketing track.

Recommended track split:

| Track | Purpose | Typical evidence |
| --- | --- | --- |
| `commerce-experience` | Buyer journey, UX, conversion, rendered content, mobile, accessibility | Screenshots, Playwright trace, persona review, Lighthouse/axe |
| `commerce-theme` | Shopify theme code, Liquid/section schema, app embeds, templates | Theme check, code diff, rendered preview |
| `commerce-ops` | Publish/release, markets, shipping/payment boundary checks, operational readiness | Preview URL, config readout, publish checklist |

The track chooses gates and review policy. The lane still controls intensity:
default, full, or ci.

## Review Lenses

A rendered commerce review should support read-only sub-agents or reviewers for:

- Buyer: can a real buyer understand, trust, and purchase?
- Mobile buyer: does the experience work on common mobile widths?
- Conversion: are CTA, trust, price, shipping, returns, urgency, and friction
  handled well?
- Product detail: are variants, size/color, media, descriptions, and FAQs clear?
- Accessibility: keyboard, contrast, labels, focus, touch targets, alt text.
- SEO/content: metadata, canonical, structured data, headings, copy quality.
- Performance: LCP/CLS/INP, image weight, script bloat, app embed cost.
- Shopify/theme: Liquid, section schema, app embeds, template routing, theme
  settings, product/collection data dependencies.
- QA/regression: console errors, network failures, broken links, flaky UI,
  viewport regressions.

Sub-agents should emit findings only. A single governed synthesizer turns
findings into board tickets and docs.

## Evidence Model

Each rendered-site finding should be evidence-backed:

- URL or Shopify preview URL;
- viewport and device class;
- screenshot before fix;
- Playwright trace or video where applicable;
- console/network error summary;
- Lighthouse or Web Vitals summary where applicable;
- axe/accessibility result where applicable;
- buyer/persona note with severity and page/journey context;
- expected outcome;
- post-fix verification artifact.

Evidence should distinguish:

- observed rendered problem;
- inferred buyer risk;
- code/theme root cause;
- Shopify configuration/data dependency;
- accepted non-goal or deferral.

## Suggested Gates

`rendered-smoke`

- page loads;
- no fatal console errors;
- no critical network failures;
- primary hero/product/cart elements render.

`buyer-journey`

- homepage to collection;
- collection to product;
- variant selection;
- add to cart;
- cart review;
- checkout-boundary handoff, without claiming real payment completion unless an
  approved safe checkout mode is used.

`mobile-ux`

- screenshots at common mobile widths;
- no overlapping text or controls;
- visible CTA;
- touch targets usable;
- sticky bars and modals do not block purchase flow.

`visual-regression`

- before/after screenshot comparison;
- known intentional changes documented;
- no unrelated layout break on key pages.

`accessibility`

- automated axe check;
- manual keyboard/focus spot check for key journey;
- alt text and form labels for buyer-critical elements.

`performance`

- Lighthouse/Web Vitals budget;
- image/script/app-embed hotspots;
- mobile-first thresholds.

`content-commerce`

- product promise clear;
- pricing, shipping, returns, trust, FAQ, and CTA clarity;
- no confusing placeholder copy;
- selected buyer personas can understand what to do next.

`shopify-theme`

- theme check or equivalent;
- section schema sanity;
- app embed inventory;
- template/section dependency notes;
- theme preview URL captured.

## Shopify Adapter Boundary

Shopify support should live behind a separate adapter, not in the Concord core.

Read-only first capabilities:

- discover theme preview URLs;
- read product, collection, page, and theme metadata;
- inspect theme sections/schema where permitted;
- inspect app embed status;
- read market/currency/basic storefront config;
- run theme-check/lint where available;
- capture rendered pages and buyer journeys.

Write capabilities should require explicit governed tickets and human approval:

- theme publish;
- product/content mutations;
- market/shipping/payment-affecting changes;
- app embed enable/disable.

The core Concord responsibility is intent, evidence, traceability, and gates.
The adapter owns Shopify-specific API calls.

## Workflow

1. `observe`
   - Capture current rendered state, preview URLs, screenshots, and smoke
     evidence.

2. `review`
   - Run buyer, UX, accessibility, conversion, mobile, SEO, performance, and
     Shopify/theme lenses.

3. `synthesize`
   - Deduplicate findings.
   - Classify severity and page/journey.
   - Create governed ticket proposals.

4. `fix`
   - Execute fixes through normal development/content/theme tickets.

5. `verify`
   - Re-run rendered gates.
   - Attach post-fix screenshot, trace, or metric evidence.

6. `publish`
   - Optional commerce-ops gate for Shopify publish/release readiness.

## Coord UI Opportunity

The Coord UI can make this profile tangible with:

- reviewed page map;
- buyer journey status;
- persona findings by page;
- screenshot gallery before/after;
- severity heatmap;
- Playwright trace/video links;
- console/network issue list;
- Lighthouse/axe summaries;
- Shopify theme/config observations;
- open tickets linked to findings;
- publish readiness checklist.

## Open Questions For The Real Repo Review

When the real ecommerce repo is available, inspect:

- commits that improved the rendered site;
- `tasks.json` or equivalent backlog history;
- review notes from multi-agent/persona reviews;
- Playwright tests and traces;
- screenshots or browser-review artifacts;
- Shopify theme structure and adapter opportunities;
- what fixes were code changes vs content/theme settings vs Shopify admin data;
- which checks were useful enough to become gates.

The next grounded step is to turn those observed patterns into tickets for the
commerce profile.
