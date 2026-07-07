# Content-Site Governance Profile — Tracks for Marketing, Development & DevOps

> **Extended to five tracks.** This document defines the original three tracks (marketing, development,
> devops). The product-engineering and data & analytics tracks, plus the full implemented model, live in
> [`MULTI_TRACK_GOVERNANCE_PROFILE.md`](MULTI_TRACK_GOVERNANCE_PROFILE.md) — read that for the current shape.

Status: **Implemented (pilot)** · Owner: Softsensor · First consumer: `example-content-site` (a static marketing site on Azure Static Web Apps)

> This document specifies a reusable extension to coord-template: a **multi-track
> governance profile** that lets one Concord-managed project govern *content*
> (marketing/docs), *code* (development), and *infrastructure* (devops) work —
> each with its own gate, skills, review policy, and operator persona — without
> forking the engine. It is designed per the existing seam rule (see
> [`CONFIG_INHERITANCE_MODEL.md`](CONFIG_INHERITANCE_MODEL.md) and
> `coord/docs/GCV4_ENGINE_CONFIG_SEAM.md`): **extend by config + gate-procs +
> skills, never by editing engine files.**

---

## 1. Use case

Softsensor.ai's marketing site is a static HTML site (16 pages) deployed to Azure
Static Web Apps via GitHub Actions (`Softsensor-org/example-content-site`, push to
`main` → build → deploy). It will become the primary site once a custom domain is
pointed at it. Three different populations need to change this repo:

| Population | Changes they make | Example |
|---|---|---|
| **Marketing** (non-technical) | Copy, images, new content pages, SEO/meta, docs | "Update the pharma case study headline + hero image" |
| **Developers** (AI agents + engineers) | Components, layout, build, structural refactors, new templates | "Refactor pages so copy is CMS-editable" |
| **DevOps** | Azure SWA config, domain/DNS, headers, CI/CD, deploy gates | "Point softsensor.ai at the SWA + add HSTS headers" |

Today these would collide on `main` with no isolation, no review policy fit to the
work type, and no audit answer to *"who changed this page and was it reviewed?"*
That is exactly Concord's problem statement — but the **gate** for a marketing copy
edit must not be `npm run test:ci`, and a marketer must not be handed the
`/code-writer` skill. Hence: **tracks**.

## 2. Core model: Track × Lane (two composing axes)

Concord already uses the word **lane** for *gate execution intensity* (`default` =
lean local check; `full`/`ci` = heavy, resource-spawning) — see the
`COORD-075..082` lane-control decision and `gate-proc-registry.js`. We do **not**
overload that term.

We introduce a new orthogonal axis, **track** = *work-type / governance policy*:

```
            TRACK  (what kind of work — new)
            ├── marketing   → content/docs
            ├── development → code
            └── devops      → infra / deploy

            LANE   (how heavy the gate runs — existing engine concept)
            ├── default → lean local check
            ├── full    → heavy
            └── ci      → heaviest

  A TRACK selects: a gate-proc + a default LANE + a skill set + a review policy + an operator persona.
```

A ticket's **track** is resolved from its id prefix (`WEB-`, `DOC-`, `DEV-`/`FE-`,
`OPS-`) via the existing `ticketPrefixes` seam in `project.config.js`, with an
explicit `--track` override on `gov start`. The track then drives everything
downstream.

## 3. The three tracks

### 3.1 Marketing track (content & docs)
- **Triggers / prefixes:** `WEB-` (site content), `DOC-` (docs).
- **Operators:** marketing team, driving **Claude Code** in natural language (no HTML/git skill required) and/or an optional local git-based CMS (Decap/Sveltia) at `/admin`.
- **Skills (new, plain-English wrappers over the existing flow):** `/content-edit`, `/seo-check`, `/publish`. Each drives the *same* claim→worktree→gate→land machinery the engine already provides.
- **Gate-proc (new): `content` gate** — registered in `gate-proc-registry`:
  - HTML validity + broken-link check
  - **SEO/meta enforcement**: canonical, Open Graph, Twitter card, `Organization` JSON-LD, sitemap membership — *no page lands without them*
  - Lighthouse SEO/perf/a11y thresholds
  - Azure SWA **PR preview URL** captured as the visual review artifact
- **Default lane:** `default` (content checks are lean; no test workers).
- **Review policy:** lightweight — one human approver eyeballs the preview; gate evidence (scores + preview link) recorded in the journal.

### 3.2 Development track (code)
- **Triggers / prefixes:** `DEV-` / `FE-` (existing frontend pattern).
- **Operators:** engineers + AI coding agents (existing `/planner`, `/code-writer`, `/code-reviewer`, `/qa-review`, `/test-strategy`).
- **Gate-proc:** the **existing test gate** (`testCommand`, e.g. `npm run test:ci`) — unchanged.
- **Default lane:** `default` locally, escalating to `full`/`ci` per existing lane discipline.
- **Review policy:** full evidence-gated review (existing behavior).

### 3.3 DevOps track (infra / deploy)
- **Triggers / prefixes:** `OPS-`.
- **Operators:** platform/devops engineers.
- **Gate-proc (new): `infra` gate** — config/manifest validation (`staticwebapp.config.json` schema, GitHub Actions workflow lint), required security-headers assertion (HSTS/CSP), DNS/cert pre-checks, and a **deploy smoke** against the SWA preview before promotion.
- **Default lane:** `full` (deploy steps are heavy / side-effecting).
- **Review policy:** strictest — mandatory second approver for anything touching DNS, secrets, or the deploy workflow; tamper-evident journal entry required.

## 4. How it plugs into existing seams (no engine fork)

| Need | Seam used | Change |
|---|---|---|
| Register `example-content-site` as a governed repo | `coord/project.config.js` `repos` | add repo `W` (path, `integrationBranch: main`, `ticketPrefixes`) |
| Map ticket id → track | `ticketPrefixes` + new `tracks` config block | new config key `tracks` mapping prefix→track→{gateProc, defaultLane, skills, reviewPolicy} |
| Content/infra gates | `gate-proc-registry.js` | register `content` and `infra` gate-procs alongside the existing test gate |
| Track-aware skills | `.claude/commands/` | add `content-edit`, `seo-check`, `publish` (marketing); reuse existing dev skills |
| Review policy per track | existing review/gate evidence machinery | policy table keyed by track (approver count, required artifacts) |
| Operator/permission separation | [`ENTERPRISE_RBAC_MODEL.md`](release/ENTERPRISE_RBAC_MODEL.md) | map track → role so marketing can't run dev/devops verbs |

Everything above is **config + registered procs + new skill files**. Engine files
(`paths.js`, `board.js`, `gate-runtime.js`, schemas) are untouched.

## 5. Phasing

**Phase A — Upstream: extend coord-template (this repo).**
Make tracks a first-class, reusable capability. Tracks/gate-procs/skills shipped as
template defaults; the two-repo demo profile stays the default, content-site profile
is opt-in. Tickets: `COORD-` (see §7).

**Phase B — Downstream: instantiate on `example-content-site`.**
Borrow `coord/` into the website project, set `project.config.js` (repo `W` + tracks),
seed the `WEB-`/`DOC-`/`DEV-`/`OPS-` board, wire the content/infra gate scripts to the
real site, connect the Azure preview URL. Tickets: `WEB-`/`OPS-`.

**Phase C — Team rollout.**
Marketing onboarded to the marketing track (Claude Code + optional CMS); devs to the
development track; platform to the devops track. `MARKETING.md` playbook + a short
runbook per track.

## 6. Decisions (confirmed 2026-06-23)

1. **User-facing term: `track`.** "Lane" stays reserved for the engine's gate-intensity meaning. CLI/docs/skills surface "track".
2. **Phase B marketing scope: Claude Code only first.** No local CMS in the initial pilot; add Decap/Sveltia later only if marketers request a visual editor.
3. **RBAC: documented posture for the pilot.** Tracks documented + convention + review now; harden to engine-enforced RBAC (per [`ENTERPRISE_RBAC_MODEL.md`](release/ENTERPRISE_RBAC_MODEL.md)) before non-technical marketers self-serve on the live domain.
4. **Docs (`DOC-`): same marketing track, distinct prefix.**

## 7. Proposed ticket breakdown

### Upstream (coord-template) — `COORD-`
- **COORD-A1 — Track model + config seam.** Add `tracks` block to `project.config.js` schema + resolver (prefix→track→{gateProc, defaultLane, skills, reviewPolicy}); `gov start --track` override. Docs + tests.
- **COORD-A2 — `content` gate-proc.** Register in `gate-proc-registry`: HTML validity, link check, SEO/meta enforcement, Lighthouse thresholds, preview-URL artifact capture. Fixtures + tests.
- **COORD-A3 — `infra` gate-proc.** Config/workflow validation, security-headers assertion, deploy-smoke hook. Tests.
- **COORD-A4 — Marketing skills.** `.claude/commands/content-edit.md`, `seo-check.md`, `publish.md` wrapping existing claim→gate→land flow.
- **COORD-A5 — Track→review-policy + RBAC mapping.** Per-track approver counts/required artifacts; track→role map (documented posture).
- **COORD-A6 — Content-site profile docs + opt-in wiring.** This doc finalized, `TESTING_AND_GATES.md`/`QUALITY_AUTOMATION.md` cross-links, profile toggle so the two-repo default is unchanged.

### Downstream (example-content-site) — `WEB-` / `OPS-`
- **WEB-B1 — Borrow `coord/` + configure.** Add repo `W` + tracks to `project.config.js`; seed board sections for the four prefixes.
- **WEB-B2 — Wire `content` gate to the real site.** `gate:site` script (validate/links/SEO/Lighthouse) + capture Azure preview URL.
- **WEB-B3 — Seed the SEO/meta backlog as `WEB-` tickets** (canonical, OG/Twitter, JSON-LD, sitemap.xml, robots.txt) — the audit from the site review.
- **OPS-B4 — `infra` gate + deploy wiring.** `staticwebapp.config.json` (clean URLs + security headers), workflow lint, domain/cert pre-check, deploy smoke.
- **WEB-B5 — `MARKETING.md` playbook + track runbooks.** Plain-English "to change X, tell Claude Code …" + per-track operating notes.

---

*Next step: confirm §6 decisions, then create the `COORD-` tickets on this repo's board (Phase A) and the `WEB-`/`OPS-` tickets downstream (Phase B).*
