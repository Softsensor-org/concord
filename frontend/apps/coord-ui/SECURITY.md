# coord-ui security & deployment notes (SEC-001)

coord-ui is a **strictly read-only** governance mirror. It performs no
governance mutations, no process control, and no command execution. Its only
security-relevant property is **disclosure**: when served, it exposes board
rows, ticket specs, governance events, git/worktree state, runtime locks,
process metadata (PIDs/cmdlines), evidence, and cost data.

This document is the deployment-facing summary of the access-control baseline.
The role/redaction reference table lives in `README.md`
("Access control & deployment modes").

## Threat model

- **In scope:** unauthorized *reads* of sensitive governance/operational data
  when the app is served beyond a trusted local machine.
- **In scope (SEC-002):** disclosure of files OUTSIDE the intended workspace via
  broad absolute-path env vars, and server-side execution surface from
  executable project-local config.
- **Out of scope (by design):** integrity/availability of governance state —
  the web tier cannot mutate anything. All mutations remain in
  `coord/scripts/gov`.

## Config & path trust boundary (SEC-002)

coord-ui trusts a small set of operator-supplied configuration inputs. Setting
them is a **trust decision** (see README "Trusted operator inputs"). The
hardening:

- **Allowed-root semantics.** `PROJECT_ROOT` (one level above `coord/`, derived
  from the resolved `COORD_DIR`) is the workspace boundary. The path env vars
  (`COORD_REQUIREMENTS_PATH`/`REQUIREMENTS_PATH`/`URS_PATH`, `SCREEN_APPS_DIR`)
  and every config-derived repo dir must resolve INSIDE it. An outside-root path
  is **rejected at load with a clear error** by default; an operator may opt a
  location back in via `COORD_UI_PATH_ALLOWLIST`.
- **Executable config, guarded as trusted-only.** `coord/project.config.js` is
  executable JS loaded via `createRequire`. It is kept executable because it is
  the coord ENGINE's canonical config seam (engine code requires the same file).
  It therefore sits at the **same trust level as engine code** — edited only
  through reviewed commits, never reachable from request input. coord-ui adds
  defense in depth: a FIXED in-workspace require path (no dynamic/request-derived
  module path), post-load shape validation of the consumed fields, and
  PROJECT_ROOT confinement of every resolved repo dir.
- **No new capability.** This path remains strictly read-only — no `fs` writes,
  no `child_process`/spawn. The boundary core is pure path arithmetic.
- **Single source of truth.** `coord/scripts/coord-ui-path-boundary.js` (pure,
  zero-dep) is shared by `lib/coord-paths.ts` and the node:test suite
  (`coord/scripts/coord-ui-path-boundary.test.js`), so served behavior and the
  gate cannot drift.

## Fail-closed posture

- **Development / localhost:** trusted loopback (`localhost`, `127.0.0.1`,
  `::1`) → full-access `local` role, no auth. Ergonomic by design; this is the
  documented primary mode.
- **Production:** an unauthenticated request **fails closed** — the edge
  middleware returns `403`, and the per-route server guard renders `404` to any
  caller it cannot authorize. There is no "open by default" path in production.

## Supported production deployment modes

1. **Identity-aware reverse proxy (recommended).** Front coord-ui with your SSO
   / IAP (e.g. oauth2-proxy, Cloudflare Access, an nginx auth_request). The
   proxy authenticates the user and sets the trusted role header
   (`x-coord-role`, configurable via `COORD_UI_TRUSTED_ROLE_HEADER`) to
   `viewer`, `operator`, or `admin`. coord-ui must **only** be reachable through
   that proxy — bind it to loopback/an internal interface so the role header
   cannot be spoofed by a direct client.
2. **Shared bearer token.** Set `COORD_UI_AUTH_MODE=shared-token` and
   `COORD_UI_AUTH_TOKEN=…`; clients present `Authorization: Bearer …`. Lower
   assurance (a single shared secret) — prefer mode 1 for multi-user deploys.

Loopback host trust is **off in production** by default because the `Host`
header is spoofable behind a proxy. Only enable `COORD_UI_TRUST_LOOPBACK=1` if a
trusted local proxy terminates all traffic.

## Role-aware redaction

Low-privilege (`viewer`) views redact absolute paths (→ basename), PIDs/cmdlines,
session/owner identifiers, PR refs, and cost details; `/cost` is denied to
`viewer` entirely. `operator`/`admin`/`local` see the full detail. Redaction is
fail-safe: an unknown/null role is treated as redacted.

## Where the policy lives

- `coord/scripts/coord-ui-access-core.js` — pure, zero-dependency decision +
  redaction core (single source of truth).
- `frontend/apps/coord-ui/middleware.ts` — edge fail-closed boundary.
- `frontend/apps/coord-ui/lib/access.ts` — server-side `requireRole` /
  `redact` guard used by sensitive routes.
- `coord/scripts/coord-ui-access-core.test.js` — unit + read-only-invariant
  tests (part of the node:test gate).
