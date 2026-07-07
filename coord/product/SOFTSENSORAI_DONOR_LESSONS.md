# SoftSensorAI Donor Lessons Plan

Status: planned · Owner: Softsensor · Date: 2026-06-25

## Purpose

This document captures what Concord can borrow from the earlier
`SoftSensorAI` repository without directly carrying over its implementation.

The useful material is not the shell-script code. The useful material is the
product pattern:

- make adoption easy for an existing repo;
- detect the shape and maturity of the project;
- generate the right agent instructions and setup artifacts;
- give the user a clear command surface;
- report readiness gaps in a way that turns into actionable work;
- allow exploratory AI work, then promote it into governed delivery.

Concord should absorb those lessons as native, governed, testable capabilities.
It should not copy the old implementation or reproduce the `ssai` command
surface verbatim.

## Decision

Treat `SoftSensorAI` as a pattern donor, not a code donor.

Allowed:

- borrow workflow ideas;
- borrow UX affordances;
- borrow setup/readiness concepts;
- borrow naming only where it remains generic and appropriate;
- re-spec concepts in Concord terms;
- reimplement using Concord's current architecture, board, journal, evidence,
  gates, and docs.

Not allowed:

- copy shell scripts directly;
- import `ssai` implementation assumptions;
- carry over stale command names as product commitments;
- bypass Concord's governance model;
- create an ungoverned second setup system beside Concord.

## Why This Matters

Concord already has the stronger foundation:

- tickets;
- board state;
- hash-chained journal;
- plan records;
- evidence;
- gate profiles;
- multi-agent governance;
- repo-local agent instructions;
- public and enterprise packaging direction.

But `SoftSensorAI` had a sharper first-run and developer-experience instinct.
It made the system feel approachable before the user understood all of the
governance model.

The opportunity is to combine both:

> SoftSensorAI-style adoption UX + Concord-grade governed execution.

That would make Concord easier to land in real repos without weakening its
audit trail or product-engineering discipline.

## Donor Concepts To Borrow

### 1. Guided Setup

Borrow the idea of a first-run setup flow.

Concord version:

- `coord init --wizard`;
- detects repo type and existing project artifacts;
- accepts project phase and governance strictness through scriptable flags;
- generates or validates `AGENTS.md`, `CODEX.md`, `CLAUDE.md`, `GEMINI.md`;
- proposes initial tracks and gates;
- creates starter docs and starter tickets where missing;
- records setup decisions as `coord/setup.decisions.json` evidence.

The setup flow should be interactive for humans but also scriptable for
enterprise rollout.

It should produce durable artifacts, not one-off console output. The current
implementation keeps the no-clobber scaffolder stance: setup decisions and
project config are files to review and commit, not live runtime mutation.

### 2. Repo Shape Detection

Borrow smart project detection.

Concord version:

- detect languages, package managers, test commands, app types, docs, CI files,
  deployment files, and existing issue trackers;
- detect whether the repo is product, API, UI, data, docs, infrastructure, or
  multi-repo;
- detect whether the repo already has requirements, ADRs, release notes, tests,
  screenshots, or architecture docs;
- suggest a governance profile based on evidence, not a hardcoded assumption.

Detection must be advisory by default. It should not silently rewrite the repo.

### 3. Governance Profiles

Borrow the concept that different users and teams need different strictness.

Concord version:

| Profile | Intended use | Gate posture |
| --- | --- | --- |
| `solo-dev` | Individual or early prototype work | Lightweight tickets, local gates, clear closeout |
| `small-team` | Shared repo with several agents/developers | Board hygiene, review evidence, stronger ticket ownership |
| `product-engineering` | Real product delivery | Requirements trace, tests, rendered evidence, release proof |
| `regulated` | URS/SRS, validation, audit-facing work | Traceability, approval, evidence, change-control discipline |
| `enterprise` | Enterprise rollout or command-center layer | RBAC, SSO/KMS integration seams, evidence export, tenant boundaries |
| `production-mcp` | Agents observing deployed systems | scoped access, read receipts, redaction, approval, runtime evidence |
| `server-bootstrap` | Migrations, backfills, generated data, boot jobs | resource envelope, idempotency, rollback, runtime proof |

Profiles should map to:

- required ticket fields;
- required evidence classes;
- required gates;
- allowed adapter classes;
- closeout rules;
- UI track views.

### 4. Project Phase Profiles

Borrow the idea that work should be governed differently by phase.

Concord version:

| Phase | Governance intent |
| --- | --- |
| `exploration` | Capture discovery without pretending it is production-ready |
| `prototype` | Move quickly but preserve decisions and assumptions |
| `pilot` | Add user evidence, runtime verification, and adoption blockers |
| `production` | Require tests, release proof, rollback, and owner clarity |
| `regulated-production` | Require traceability, approvals, audit evidence, and validation |

This is important because Concord should work with existing repos. A mature
enterprise repo and a new prototype should not receive the same ceremony.

### 5. Doctor And Readiness Report

Borrow the `doctor` idea.

Concord version:

- `coord doctor`;
- scans the repo and coordination artifacts;
- reports readiness by dimension;
- separates blockers from warnings;
- links each finding to a suggested ticket;
- distinguishes local-development gaps from production-governance gaps;
- emits machine-readable JSON and human-readable markdown.

Candidate dimensions:

- governance setup;
- agent instruction consistency;
- requirements and URS coverage;
- test and gate maturity;
- security posture;
- runtime/deployment evidence;
- multi-agent collision risk;
- release/publication readiness;
- enterprise readiness.

The output should answer:

1. Can this repo safely use Concord today?
2. What track/profile does Concord recommend?
3. What is missing before pilot?
4. What is missing before enterprise/procurement?
5. Which tickets should be filed?

### 6. Command Registry

Borrow the idea of a clear command surface.

Concord version:

- a command registry that lists supported commands, status, purpose, and
  maturity;
- one discoverable `coord help` or `coord commands`;
- UI command palette backed by the same registry;
- docs generated from the registry, not manually duplicated.

This reduces product confusion as Concord grows more tracks:

- product engineering;
- requirements assurance;
- rendered experience QA;
- production MCP;
- server bootstrap;
- enterprise development landscape;
- memory/recall;
- public/enterprise release packaging.

### 7. Agent And Persona Configuration

Borrow the idea that the system can prepare multiple AI tools.

Concord version:

- canonical governance remains in `coord/GOVERNANCE.md`;
- tool shims remain thin: `CODEX.md`, `CLAUDE.md`, `GEMINI.md`;
- repo-local `AGENTS.md` files inherit from the canonical policy;
- validators detect drift and conflicting instructions;
- reviewer personas become governed review lenses, not informal prompts.

Useful built-in lenses:

- product reviewer;
- requirements reviewer;
- URS/SRS reviewer;
- security reviewer;
- test reviewer;
- deployment/runtime reviewer;
- UX/rendered-experience reviewer;
- buyer/user reviewer;
- enterprise architecture reviewer.

Persona output should be evidence-backed and synthesized into tickets by one
governed coordinator.

### 8. Exploratory Work Promotion

Borrow the exploration workflow.

Concord version:

- allow a lightweight exploration mode for research, donor repos, UI review,
  production observation, and requirements discovery;
- capture observations as notes and evidence;
- require promotion into governed tickets before implementation;
- preserve rejected ideas and assumptions;
- mark which findings came from rendered review, repo review, customer input,
  runtime evidence, or donor analysis.

This is especially useful for:

- URS discovery;
- donor repo evaluation;
- ecommerce rendered-site review;
- production MCP investigation;
- enterprise customer adoption analysis;
- bootstrapped app lessons.

The key rule:

> Exploration may discover. Governed tickets decide and deliver.

The dry-run promotion slice is `coord/scripts/exploration-promotion.js` and the
product-facing alias `coord exploration-promote --artifact <exploration.json>`.
Exploration artifacts capture source pointer, evidence classes, confidence,
findings, rejected ideas, and proposed ticket specs. Promotion emits governed
ticket specs with source evidence and keeps rejected/unpromoted findings visible
but non-authoritative. It does not mutate the board or implementation files.

### 9. Existing Repo Adoption

SoftSensorAI's useful instinct was that the tool should meet a repo where it
already is.

Concord should make this a first-class strength:

- no requirement to start from a Concord template;
- detect existing conventions;
- layer governance beside current code;
- preserve existing tests and workflows;
- avoid forcing GitHub Actions if local gates are the chosen policy;
- support multi-repo adoption through `coord/product/REPOS.md`;
- produce a clear migration path from "unmanaged repo" to "governed repo".

The product message should be:

> Concord can govern an existing repo without requiring a rewrite.

### 10. Quickstart And Learning Path

Borrow the idea of approachable learning paths.

Concord version:

- quickstart by profile;
- examples for existing repo, new repo, regulated repo, and production-MCP repo;
- "first 30 minutes" tutorial;
- "first governed ticket" tutorial;
- "first multi-agent run" tutorial;
- "first rendered QA review" tutorial;
- "first enterprise export" tutorial.

Docs should avoid explaining everything at once. They should guide the user to
the next concrete command and artifact.

## Translation Model

Every borrowed concept should pass through this translation model:

| Donor idea | Concord-native translation |
| --- | --- |
| Shell setup script | Typed setup command plus generated governance artifacts |
| `doctor` output | Structured readiness report with suggested tickets |
| Skill levels | Governance profiles and lane intensity |
| Project phases | Phase-aware required evidence and gates |
| Command list | Versioned command registry and generated docs |
| Multi-AI config | Canonical policy plus shim drift validation |
| Personas | Governed review lenses with evidence contracts |
| Vibe/exploration | Exploration capture plus ticket promotion |
| Project detection | Repo shape detector feeding profile recommendation |

## Architecture Principles

### Core Owns Policy

The Concord core should define:

- profiles;
- phases;
- command metadata;
- readiness dimensions;
- required evidence classes;
- validation contracts.

### Adapters Own Environment Detail

Adapters should handle:

- package manager detection;
- framework-specific test command suggestions;
- Shopify read-only checks;
- GitHub/project tracker reads;
- MCP observation;
- deployment metadata reads;
- enterprise export packaging.

### Board Owns Work

Setup, doctor, and exploration should not become side channels. When they find
real work, they should produce tickets.

### Journal Owns Evidence

Important setup decisions, readiness findings, promotion decisions, and closeout
evidence should be journaled or attached as plan artifacts.

### UI Mirrors The Model

The Coord UI should expose these as surfaces:

- setup/readiness;
- tracks and profiles;
- open gaps;
- command palette;
- review lenses;
- exploration findings awaiting promotion;
- enterprise readiness.

## Recommended Work Packages

### Work Package 1: Donor Lessons Spec

Document the pattern translation and decision boundary.

Acceptance:

- this document exists;
- it states what can be borrowed and what cannot;
- it defines Concord-native translations;
- it identifies candidate tickets.

### Work Package 2: Repo Doctor MVP

Implement `coord doctor` as a read-only scanner.

Acceptance:

- emits JSON and markdown;
- checks governance artifacts;
- checks shim drift;
- checks presence of requirements and tests;
- recommends a profile;
- reads `coord/setup.decisions.json` when present and reports the selected
  profile, phase, tracks, gates, and next steps;
- suggests tickets without mutating the board by default.

### Work Package 3: Governance Profiles

Add a typed profile model.

Acceptance:

- profile schema exists;
- profile-to-gates mapping exists;
- at least `solo-dev`, `product-engineering`, `regulated`, and `enterprise`
  profiles are represented;
- docs explain how profiles affect tickets and gates.

### Work Package 4: Phase-Aware Governance

Add phase metadata to setup/doctor recommendations.

Acceptance:

- phases are documented;
- doctor can recommend a phase;
- tickets can declare phase where useful;
- closeout requirements can differ by phase.

### Work Package 5: Command Registry

Create a single registry for command metadata.

Acceptance:

- command list is machine-readable;
- CLI help can read from it;
- docs can be generated from it;
- UI can later consume it.

### Work Package 6: Shim Drift Validator

Validate that tool-specific instruction files remain thin and aligned.

Acceptance:

- checks `AGENTS.md`, `CODEX.md`, `CLAUDE.md`, `GEMINI.md`;
- flags conflicting governance rules;
- confirms canonical policy pointer;
- can run in local gates.

### Work Package 7: Exploration Promotion Protocol

Define and then implement a path from exploratory notes to governed tickets.

Acceptance:

- exploration artifact schema exists;
- promotion command or workflow exists;
- promoted tickets include source evidence;
- unpromoted findings are visible but not treated as committed work.

### Work Package 8: Existing Repo Adoption Quickstart

Write a practical guide for applying Concord to an existing repo.

Acceptance:

- guide covers install/init, detect, doctor, first ticket, first gate, and first
  closeout;
- guide avoids requiring a repo rewrite;
- guide distinguishes template adoption from overlay adoption.

## Governed Tickets

These tickets convert the protocol into governed implementation work:

| Ticket | Theme | Summary | Priority |
| --- | --- | --- | --- |
| `COORD-252` | Donor lessons protocol | Save the SoftSensorAI pattern-donor decision and translation rules | P0 |
| `COORD-253` | Repo doctor MVP | Add read-only repo adoption/readiness scanner | P0 |
| `COORD-254` | Governance profiles | Add adoption profile schema and profile-to-governance mapping | P0 |
| `COORD-255` | Existing repo adoption quickstart | Document Concord overlay adoption for existing repos | P0 |
| `COORD-256` | Shim drift validator | Detect drift in `AGENTS.md`, `CODEX.md`, `CLAUDE.md`, `GEMINI.md`, and repo-local agent guides | P1 |
| `COORD-257` | Command registry | Centralize CLI/UI command metadata | P1 |
| `COORD-258` | Phase-aware governance | Add phase recommendation and phase-specific evidence rules | P1 |
| `COORD-259` | Exploration promotion | Convert exploratory notes/reviews into governed ticket specs | P1 |
| `COORD-260` | Setup wizard | Extend guided setup with detector, profiles, and quickstart path | P2 |
| `COORD-261` | UI readiness surface | Add a Coord UI page for readiness, profile, gaps, and suggested tickets | P2 |

The sequencing rule is deliberate: `COORD-252` lands the protocol first, then
`COORD-253` through `COORD-255` build the adoption-critical path. The P1/P2
tickets should consume the protocol and readiness artifacts instead of creating
parallel models.

## Risks

### Product Sprawl

Borrowing too many ideas can dilute Concord. The first implementation should
focus on adoption-critical flows:

1. doctor/readiness;
2. profiles;
3. existing repo quickstart;
4. shim drift validation.

### Ungoverned Setup Side Channel

Setup should not become a way to mutate repos without evidence. It should record
what it changed and why.

### False Precision

A readiness score can look authoritative even when it is based on shallow
signals. The report should show evidence and confidence per finding.

### Tool-Specific Drift

Generating tool shims is useful only if the canonical policy remains central.
Validators should fail closed on conflicting governance instructions.

### Copying The Wrong Thing

The old shell implementation is not the asset. The asset is the user journey.
Reimplementation should be native to Concord.

## Suggested Sequencing

1. File and review this donor-lessons protocol.
2. Implement `coord doctor` as read-only.
3. Add governance profile schema and docs.
4. Add existing-repo quickstart.
5. Add shim drift validator.
6. Add command registry.
7. Add exploration promotion.
8. Build setup wizard and UI surfaces after the model stabilizes.

## Product Positioning

This strengthens Concord's product story:

> Concord is not only a template for new projects. It is a governance layer that
> can be applied to existing repos, detect their current maturity, recommend the
> right controls, and help teams move from AI-assisted exploration to governed
> product engineering.

That is the durable lesson to carry forward from `SoftSensorAI`.
