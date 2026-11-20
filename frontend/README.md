# frontend

Reference frontend skeleton for projects using `coord-template` (FE-001).

> **Replaceable zero-dependency reference**, not a prescribed stack. It uses only
> Node.js built-ins so the template imposes no framework. A derived project swaps
> the renderer (Next/Vite/React/Vue/...) but keeps the seams: an app shell, a
> validated env loader with a public/secret split, an auth bootstrap, and pure
> route guards.
>
> `apps/coord-ui/` is a separate optional read-only governance UI; it is not this skeleton.

## Module / app-shell layout

```
src/
  config/env.js        # env loader + validation; rejects secret-looking keys
  auth/index.js        # auth bootstrap seam (session resolve, getPrincipal, roles)
  routes/guards.js     # pure allow/redirect guard decisions
  app/shell.js         # composition root: config + auth + route table + navigate()
tests/
  shell.test.js        # node --test smoke (env, guards, role gating)
scripts/
  gate.sh              # default | full | ci gate runner
```

## Environment variables

Validated in `src/config/env.js` (mirror into `.env.example`; client-safe only):

- `APP_ENV` (required) — development | staging | production
- `API_BASE_URL` (required) — backend API base URL
- `AUTH_MODE` (default redirect) — redirect | token | none
- `LOGIN_ROUTE` (default /login)

Secret-looking keys (`*SECRET*`, `*PRIVATE_KEY*`, `*PASSWORD*`) are rejected —
secrets stay server-side.

## Run gates

```bash
bash scripts/gate.sh default   # layout + syntax + unit tests
bash scripts/gate.sh full      # default + guard smoke
bash scripts/gate.sh ci        # CI entry
```

All lanes return 0 on a clean checkout. See `BOOTSTRAP.md` and
`coord/product/BOOTSTRAP_CONTRACT.md`.

### Coverage ownership

The `full` and `ci` lanes measure files under this frontend repository, including
`apps/coord-ui/`. Cross-repository imports still execute in integration tests,
but their implementation coverage belongs to the owning repository's gate.
The runner records `scope=repo-owned` in the gate artifact's command list and
uses Node's absolute `--test-coverage-include` boundary. Test files remain excluded, and an explicit
`**/node_modules/**` exclusion preserves the usual dependency boundary (Node 24
otherwise includes dependencies when an include pattern is supplied); this measures loaded files, not an inventory
of every source file on disk. The minimum remains 80% for lines, branches, and
functions (`GATE_COVERAGE_MIN` can explicitly configure it).

Install the optional UI's locked dependencies with `npm ci` from
`apps/coord-ui/` before running its tests. Qualify the full frontend gate on
both supported CI runtimes, Node 22.8 and Node 24. The coverage-boundary
regressions run through `node coord/scripts/test-runner.js --file
coord/scripts/coverage-policy.test.js` from the workspace root; they verify
both lanes, real sibling execution, and failure for uncovered frontend code.
