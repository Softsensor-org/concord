# @coord/shared

Canonical home for cross-repo shared utilities and components.

This package is the **convergence target** for the
**Component-library-convergence** quality dimension (COORD-136, dimension #6 in
`coord/docs/QUALITY_DIMENSIONS.md`).

## Why this exists

Divergent UI/logic across repos is **not** solved by inventing a checker that
asserts "use the library" (per the boundary section, §5 of
`QUALITY_DIMENSIONS.md`). It is solved by two halves working together:

1. **The build/convergence half (this package).** A real, zero-dependency
   package that gives currently-duplicated logic *somewhere to go*. The
   frontend, the coord-ui app, and the backend each tend to grow their own
   slightly-different copy of the same utility (byte formatting, truncation,
   result wrapping, …). Those copies converge **onto** the exports here.

2. **The extraction-pressure half (the duplication gate).** The
   `arch-checks` duplication dimension ships an **extraction-tuned profile**
   (`extractionTunedConfig`): a **lower `minLines`** (more sensitive) and a
   **cross-repo corpus** (duplication detected *across* repo/dir boundaries,
   e.g. `frontend/` vs the coord-ui app vs `backend/`, not just within one file
   set). Run in **ratchet** mode (COORD-126), it is frictionless on
   pre-existing divergence and fails only on **new** cross-repo duplication —
   pressuring that new logic toward this package.

The default duplication gate is **unchanged** (`minLines: 12`, single intra-repo
corpus, warn). The extraction-tuned profile is a **separate, opt-in** mode; it
does not retroactively alter the default gate's behavior.

## Exports

| Export        | Source                | Purpose                                            |
|---------------|-----------------------|----------------------------------------------------|
| `formatBytes` | `src/format.js`       | Human-readable byte size (`1.5 KB`).               |
| `truncate`    | `src/format.js`       | Ellipsis-truncate to a max length (budget-aware).  |
| `pluralize`   | `src/format.js`       | Count-aware noun pluralization.                    |
| `ok`          | `src/result.js`       | Construct a success `{ ok:true, value }`.          |
| `err`         | `src/result.js`       | Construct a failure `{ ok:false, error }`.         |
| `attempt`     | `src/result.js`       | Run a fn, capturing a throw as an `err` result.    |
| `mapResult`   | `src/result.js`       | Map over a success value, passing failures through.|

## Usage

```js
const { formatBytes, ok, attempt } = require("@coord/shared");

formatBytes(1536);          // "1.5 KB"
ok(42);                     // { ok: true, value: 42 }
attempt(() => JSON.parse(s)); // { ok: true, value } | { ok: false, error }
```

Zero runtime dependencies. Pure functions only.
