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
