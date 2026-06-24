# coord-ui

Read-only, config-driven web view over coord governance state. Ported into
coord-template as a portable operator cockpit (UI-001); it derives its repo
model from `coord/project.config.js` and has no dependency on any specific
project's repo names, package names, or design tokens.

## Routes

Listed in nav order (`app/layout.tsx`). The route list and the nav are kept in
sync by `coord/scripts/coord-ui-nav-readme-sync.test.js`.

- `/` — kanban board (todo / doing / review / done / blocked)
- `/agents` — agent/session liveness
- `/timeline` — event log viewer
- `/gates` — gate artifact summaries
- `/quality` — code-quality / architecture-check cockpit (per-repo scope)
- `/dispatch` — agent dispatch queue and next-command guidance
- `/tests` — testing maturity and evidence
- `/health` — derived governance health
- `/runtime` — runtime snapshot, locks, and live-session state
- `/pipeline` — landing and PR pipeline
- `/urs` — configured requirements document
- `/configuration` — read-only config-as-code view (current config + the governed command to change each setting)
- `/screens` — screen/requirement index and unlinked-requirement worklist
- `/traceability` — closure and feature-proof traceability
- `/evidence` — exported evidence bundles and conformance artifacts
- `/live-mcp` — read-only live-MCP cockpit (per-ticket adapter, environment, operation class, approval/redaction/receipt/cleanup/promotion status + unresolved closeout blockers; viewer sees redacted summaries, operator/admin see operational detail)
- `/bootstrap-risk` — read-only server-bootstrap / backfill risk surface (per ticket: declared work class, runs-at-boot/app-process flags, resource envelope, idempotency/checkpoint strategy, verification signal, rollback/disable, observability, data-access shape from the COORD-159 plan field; the COORD-161 job-completion receipt; and unresolved COORD-160/162 warnings. Server readiness and job completion are shown as separate states — a ready server is not a finished job. Viewer sees redacted summaries; operator/admin see operational detail. Never runs a job.)
- `/cost` — token-economics / cost view
- `/issues` — review findings
- `/waivers` — waiver and follow-up exception index
- `/git` — per-repo git state
- `/ticket/[id]` — ticket spec, lock, plan record, related events
  (dynamic route; not a top-level nav entry)

## Run locally

The app is a standalone Next.js 15 / React 19 project (no workspace tooling
required). From this directory:

```bash
npm install
npm run dev      # serves on http://localhost:3002
```

Other scripts: `npm run build`, `npm run start`, `npm run typecheck`,
`npm run gen:screens` (regenerates the derived screen index artifact).

## Configuration

By default the app resolves `coord/` as a sibling of `frontend/` and reads the
repo layout from `coord/project.config.js`. Env vars override the defaults.

| Variable | Purpose |
| --- | --- |
| `COORD_DIR` | Absolute or relative path to the `coord/` repo. Defaults to `<frontend>/../coord`, with an upward search fallback. |
| `COORD_REQUIREMENTS_PATH` | Requirements/URS document. Relative paths resolve from `COORD_DIR`. |
| `REQUIREMENTS_PATH` | Backwards-compatible alias for `COORD_REQUIREMENTS_PATH`. |
| `URS_PATH` | Legacy alias for `COORD_REQUIREMENTS_PATH`. |
| `SCREEN_APPS_DIR` | Directory containing frontend apps to index. |
| `COORD_UI_PATH_ALLOWLIST` | SEC-002 opt-in: `:`/`;`/`,`-delimited absolute roots permitted OUTSIDE `PROJECT_ROOT`. Empty by default. |

### Trusted operator inputs & the path trust boundary (SEC-002)

The configuration env vars above are **trusted operator inputs**. Setting them
is a **trust decision**: coord-ui runs them through a path trust boundary, but
the operator is responsible for pointing them at intended locations.

- `COORD_DIR` selects which workspace coord-ui mirrors and therefore defines
  `PROJECT_ROOT` (the directory one level above `coord/`). It is the trust
  anchor — set it only to a coord checkout you trust.
- `COORD_REQUIREMENTS_PATH` / `REQUIREMENTS_PATH` / `URS_PATH` and
  `SCREEN_APPS_DIR` must resolve **inside `PROJECT_ROOT`** by default. A path
  that resolves OUTSIDE the workspace is **rejected at load with a clear
  error** (path-traversal / file-disclosure guard). To intentionally read an
  outside-root location, add it (or a parent dir) to `COORD_UI_PATH_ALLOWLIST`
  — an explicit operator opt-in.
- `coord/project.config.js` is **executable, trusted config** at the same trust
  level as engine code (paths.js / scripts / board all `require()` it). coord-ui
  keeps `createRequire` for it but (a) loads it only from the FIXED in-workspace
  path — no request input ever reaches the require argument, (b) validates the
  consumed shape after load, and (c) confines every resolved repo dir to
  `PROJECT_ROOT`. Edit it only through reviewed commits.

The boundary logic is a single zero-dependency, pure core
(`coord/scripts/coord-ui-path-boundary.js`) shared by `lib/coord-paths.ts` and
its node:test suite (`coord/scripts/coord-ui-path-boundary.test.js`), so the
served behavior and the gate cannot drift.

When no requirements path is configured, coord-ui tries, in order:
`coord/product/REQUIREMENTS.md`, `coord/product/LAST_MILE_OPS_URS.md`,
`coord/REQUIREMENTS.md`, `coord/LAST_MILE_OPS_URS.md`.

### Repo model

Repo codes, paths, display names, roots, and integration branches come from
`coord/project.config.js` (see `lib/project-config.ts`):

- Product repos are read from the `repos` map (e.g. `B → backend`, `F → frontend`).
- The code `X` is reserved for cross-repo / coord-only work and is excluded
  from the product-repo list.
- The `git` and dirty-repo views inspect the product repos **plus** the coord
  governance repo; the dirty-repo denominator is the number of repos inspected,
  not a fixed value.
- A ticket's repo is taken from its `coord/board/tasks.json` row when present;
  active markdown with no board row falls back to `X`.

## Supported artifact paths

All under `COORD_DIR`:

- `board/tasks.json` — board rows (all table sections, including `PILOT-*`/`UI-*`)
- `active/*.md` — active ticket specs
- `.runtime/governance-latest-snapshot.json`, `.runtime/governance-events.ndjson`
- `.runtime/locks/*`, `.runtime/agents.json`, `.runtime/agent_sessions.json`
- Plan records: prefers `.runtime/plans`, falls back to the legacy
  `board/plans`; missing files render as empty states.
- Gate artifacts: `<repo>/artifacts/gates/<lane>.latest.json`
- `.runtime/screen-index.json` — derived screen/requirement index

## Access control & deployment modes (SEC-001)

coord-ui is read-only, but when served it exposes board rows, ticket specs,
governance events, git/worktree state, runtime locks, process metadata
(PIDs/cmdlines), evidence, and cost data. It therefore has an access-control
baseline that **fails closed in production** while keeping local development
ergonomic.

The decision logic is a single zero-dependency, pure module
(`coord/scripts/coord-ui-access-core.js`) shared by the Next.js edge boundary
(`middleware.ts`), the server-side guard (`lib/access.ts`), and the unit tests
(`coord/scripts/coord-ui-access-core.test.js`) — so the served behavior and the
gate cannot drift.

### Roles

| Role | Sees |
| --- | --- |
| `viewer` | Aggregate governance state. **Sensitive fields are redacted**: absolute paths, PIDs/cmdlines, session/owner identifiers, PR refs, and cost details. The `/cost` view is denied entirely. |
| `operator` | Full operational detail (runtime/git/process internals, cost). |
| `admin` | Full access (superset of operator). The deployment owner. |
| `local` | Implicit full-access role for trusted localhost requests. Cannot be claimed via a header. |

### Supported modes

1. **localhost-dev (default in development).** A trusted loopback request
   (`localhost` / `127.0.0.1` / `::1`) is granted the full-access `local` role
   with no auth. This is the documented primary mode for local operators.
2. **proxy-header (default in production).** The operator's trusted reverse
   proxy (SSO / identity-aware proxy) sets a role header
   (`x-coord-role: viewer|operator|admin` by default). The app honors only a
   **known** role; absence or an unknown value is **denied (403)**.
3. **shared-token.** A configured bearer token (`Authorization: Bearer …`) must
   match `COORD_UI_AUTH_TOKEN`. The role comes from the role header or
   `COORD_UI_DEFAULT_ROLE` (default `viewer`).

In production, loopback host trust is **off** by default (a `Host` header is
spoofable behind a proxy) — set `COORD_UI_TRUST_LOOPBACK=1` only if you front
the app with a trusted local proxy. **An unauthenticated production request
fails closed.**

### Configuration env vars

| Variable | Purpose |
| --- | --- |
| `COORD_UI_AUTH_MODE` | `localhost-dev` \| `proxy-header` \| `shared-token`. Defaults: dev → `localhost-dev`, prod → `proxy-header`. |
| `COORD_UI_TRUSTED_ROLE_HEADER` | Header the trusted proxy sets the role on. Default `x-coord-role`. |
| `COORD_UI_AUTH_TOKEN` | Shared bearer secret (required for `shared-token` mode). |
| `COORD_UI_DEFAULT_ROLE` | Role for authenticated-but-unroled requests. Default `viewer`. |
| `COORD_UI_TRUST_LOOPBACK` | `1`/`true` to trust loopback host in production (default off in prod, on in dev). |

The sensitive routes (`/runtime`, `/git`, `/cost`, `/evidence`, `/ticket/[id]`,
`/timeline`) each pass through a per-route `requireRole` guard and apply
role-aware redaction via `redactForRole`. Deny renders a 404 (no route
confirmation to an unauthorized caller); the edge middleware returns 403 first.

## Read-only boundary

The web tier is strictly read-only. No request path performs `fs` writes,
`child_process` mutations, mutating `git`, or `gov` mutations. The only git
calls are read-only inspection (`status`, `rev-parse`, `rev-list`,
`worktree list`). All governance mutations stay in `coord/scripts/gov` or a
future governed MCP surface. The sole writer in this package is the
`gen:screens` CLI script, which is run manually and is not part of any request
path. The access-control tier (`middleware.ts`, `lib/access.ts`,
`coord/scripts/coord-ui-access-core.js`) only **gates and redacts reads** — it
adds no write/spawn/exec surface, enforced by a node:test grep contract.

## Known limitations

- Dependencies are not vendored in coord-template; run `npm install` before
  `npm run dev`/`build`/`typecheck`. With dependencies installed, both
  `npm run typecheck` and `npm run build` (production build) pass.
- Read-only only: there is no mutation surface in the UI by design.
- An explicit ticket-prefix → repo map is not yet configurable; tickets without
  a board row resolve to `X`.
