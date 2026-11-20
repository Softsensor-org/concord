# ADR 0016: Bounded static source parsing ships with the engine

- **Status:** Accepted
- **Ticket:** COORD-582
- **Date:** 2026-10
- **Linked scope:** coord/engine/scripts/business-discovery-source-parser.js; coord/engine/vendor/babel-parser; coord/scripts/business-discovery-source.js; coord/scripts/test-runner.js

## Context

COORD-582 needs source syntax for route, workflow, and component evidence because path heuristics miss real repositories. The `create-concord` and SEA installers copy a standalone engine payload and do not install dependencies in the adopter's workspace. Adding a runtime npm dependency while requiring the adopter to run npm ci would change the current installer contract. Discovery code is untrusted-input handling and must never execute adopter modules. Accepted ADR 0011 governs project-config reading and remains unchanged.


## Linked Scope

- Governing ticket: COORD-582.
- Repos: X (coord).
- Modules: static discovery source parser, vendored runtime, engine packaging, native coverage runner.
- Accepted ADR 0011 continues to govern trusted project-config loading; this proposal does not modify that loader.

## Decision Criteria

- Static syntax only; never evaluate adopter code.
- Standalone npm and SEA payloads without adopter dependency installation.
- Exact auditable dependency bytes and notices; bounded work and explicit unknown semantics.
- Retain first-party native coverage and all existing ratchets.

## Options Evaluated

- Runtime npm dependency: conventional updates but adds a package-install prerequisite to copied standalone engines.
- Regex/lexical-only parsing: small payload, but cannot reliably distinguish nested syntax, strings and comments.
- Vendored single-file parser runtime: larger payload and deliberate refresh burden, compatible with standalone distribution.

## Decision

Vendor the single-file runtime entry from the exact upstream `@babel/parser` package beneath the engine, with the upstream MIT LICENSE and a provenance/refresh record. Parse bounded source as a static AST. Never evaluate it. Keep the parser's language and syntax detectors intentionally narrow and report unsupported/dynamic cases as unknown or unresolved. Treat findings as source-backed candidates, not validated business claims.

Use an exact upstream archive and verify its npm registry integrity before import. The reviewed prototype source is `@babel/parser` 7.29.7, tarball `https://registry.npmjs.org/@babel/parser/-/parser-7.29.7.tgz`, lock integrity `sha512-hnORnjP/1P/zFEndoeX+n+t1RwWRJiJpM/jO7FW32Kn9r5+sJB2JWOdYo4L6k78j15eCwY3Gm/7364B1EMwtNg==`. Cache entry verified that exact integrity; extracted `lib/index.js` SHA-256 `201724d1415df7749087d9d6e88af50f2bcafe2eb68dfbe9347f49d3361ff426` and LICENSE SHA-256 `2e97627cb278aa7556fb9e8817368302301a595b6c7582512b8d74c57b773652` are byte-identical to the vendored files. Upstream package declares no runtime dependencies; `@babel/types` is for parser type declarations.


The proposed adapter caps each input at250000 UTF8bytes and shares a4096state iterative mount-graph expansion budget across that input, caching per router. Exhaustion is unresolved without a partial resolved path list. JSX member chains and Express route chains use iterative processing. Mixed path arrays preserve known literal paths and explicit unresolved entries. Unsupported framework semantics remain unknown.

The native runner excludes only engine/vendor from coverage reporting in addition to test files, matching the existing first-party census (scripts and engine/scripts). This prevents Node22's reporter from following an upstream sourceMappingURL whose map is not distributed. The upstream runtime bytes remain unmodified; a regression verifies vendor exclusion and continued first-party coverage.

## Alternatives Rejected

- Executing imports or framework bootstraps to discover registrations would cross the untrusted-source boundary.
- Removing the upstream source-map comment would change the exact audited runtime bytes without a product need.
- Resetting coverage or silently dropping dynamic graph/path alternatives would hide uncertainty.

## Consequences

Positive: npm and SEA payloads carry the parser runtime and notice, eliminating an adopter-side package manager/network prerequisite. Prototype parser file adds 512,666 bytes (about 0.49 MiB) plus a 1,086-byte license. Actual unpacked npm artifact and SEA archive extraction both loaded and ran the vendored parser with no node_modules present.

Cost: source is duplicated and must be refreshed deliberately. Every version refresh must review exact upstream release, tarball integrity, package runtime dependency declaration, license, file digest, supported syntax compatibility, focused tests on both supported Node versions, packed npm artifact, SEA extraction, engine pin/template sync, and architecture gates. The provenance record and license travel with the source. Do not auto-follow a semver range.


Exact-source native coverage, affected suites and packed-payload tests are recorded with source hashes on the governing ticket. Final authoritative hosted qualification and packaging results remain separate gates. This proposed record does not assert release publication or ticket completion.

## Security and Claim Limits

Parser input is capped at 250,000 UTF-8 bytes per file; syntax/size failures produce explicit unparsed/skipped results. Static AST matches cannot establish runtime behavior or business meaning. Dynamic paths, dynamic mounts, imports, runtime framework wiring, and unknown schedulers stay unresolved/unknown. A digest binds bytes, not semantic truth. The parser is not used by the engine's trusted project-config loader and does not relax ADR 0011.


## Revisit Trigger

Review this choice if supported syntax/framework scope expands, an upstream parser vulnerability or dependency change is discovered, installer packaging changes, or measured source/graph bounds become unsuitable. A version refresh requires new archive integrity, license/runtime-dependency review and exact artifact tests.

## Approval State

This is a recorded proposal, not an accepted ADR or human approval. COORD-582 applies the bounded implementation under the task's existing authorization and records its precise tradeoffs; no ADR baseline adoption or unrelated policy waiver is implied.
