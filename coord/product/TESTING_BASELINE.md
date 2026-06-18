# Practical Testing Baseline

This document declares the per-repo testing baseline that the coverage-floor
tool (`coord/scripts/check-testing-baseline.js`) enforces. Each row names a
product repo, the canonical CI command that establishes its coverage floor, the
proof that command must produce, and the current source of that coverage.

The canonical command for a repo MUST NOT use `--forceExit` (it masks
open-handle leaks and lets a passing run hide a broken teardown). The checker
fails if any `test:ci*` script in the repo uses `--forceExit`.

> Template default registry is `backend/` (B) and `frontend/` (F), matching
> `coord/paths.js`. Downstream projects MUST override both this table and the
> `EXPECTED_BASELINE` map in `check-testing-baseline.js` to match their own
> repo registry (see `coord/product/REPOS.md`).

| Repo | Baseline command | Required proof | Current source |
| --- | --- | --- | --- |
| `backend/` | `npm run test:ci` | Backend regression suite passes with zero failures and no open-handle leaks. | Existing backend tests (template default; repo not yet scaffolded). |
| `frontend/` | `npm run test:ci` | Frontend test suite passes with zero failures. | Existing frontend tests (template default; repo not yet scaffolded). |

## Governance harness baseline (this template repo)

The coord governance harness itself is exercised by the Node test suite:

```
node --test coord/scripts/*.test.js coord/board/*.test.js
```

This is the live coverage floor for the template repo today and must stay green
before any ticket lands on the integration branch.
