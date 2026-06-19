# backend

Reference backend skeleton for projects using `coord-template` (BE-001).

> **This is a replaceable zero-dependency reference**, not a prescribed stack.
> It uses only Node.js built-ins so the template imposes no framework. A derived
> project swaps the HTTP/runtime layer for its real stack but keeps the seams:
> a single env-loading entry point, an auth seam, a module-boundary layout, and
> a gate runner with `default | full | ci` lanes.

If your real backend repo has a different name, update `coord/project.config.js`
and `coord/product/REPOS.md`.

## Stack

- Language/runtime: Node.js (>= 18), CommonJS, **zero external dependencies**.
- Test runner: built-in `node --test`.

## Module Boundary Layout

```
src/
  config/env.js          # environment loading + validation seam
  auth/index.js          # authentication seam (noop default, fail-closed outside dev)
  app.js                 # composition root: wires config + auth + modules
  index.js               # entrypoint (fail-fast on bad config)
  modules/
    health/index.js      # reference feature module
tests/
  smoke.test.js          # node --test smoke coverage
scripts/
  gate.sh                # default | full | ci gate runner
```

Boundary rule: feature modules depend on the shared seams (`config`, `auth`),
never on each other's internals.

## Run locally

```bash
APP_ENV=development PORT=8080 AUTH_PROVIDER=noop node src/index.js
```

## Environment variables

Loaded and validated in `src/config/env.js` (authoritative list; mirror into
`.env.example`):

- `APP_ENV` (required) — development | staging | production
- `PORT` (default 8080)
- `LOG_LEVEL` (default info)
- `AUTH_PROVIDER` (default noop) — `noop` is rejected unless `APP_ENV=development`

## Run gates

```bash
bash scripts/gate.sh default   # structure + syntax + unit tests
bash scripts/gate.sh full      # default + composition smoke
bash scripts/gate.sh ci        # CI entry; same as full
```

All lanes return 0 on a clean checkout. See `BOOTSTRAP.md` and
`coord/product/BOOTSTRAP_CONTRACT.md`.
