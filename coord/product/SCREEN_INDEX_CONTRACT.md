# Screen / Requirement Index — Method Contract

Reusable, framework-agnostic contract for indexing a project's user-facing
**screens** and cross-linking them to requirement sources (URS, requirements
docs, persona/workflow matrices).

This is the **foundation** for downstream BA capabilities: requirement
traceability, multi-agent URS improvement, multi-agent manual testing, and
persona-scoped ticket views. None of those can anchor to anything until
"what screens exist and which requirements they satisfy" is a queryable,
regenerable artifact.

## Why this is a method, not a one-off

The index is **derived** (regenerable from source), never hand-maintained.
A stale hand-kept screen list is worse than none. The generator is the
contract; the JSON it emits is disposable runtime/derived state.

## Generated artifact

A generator produces a single derived JSON document. Path is project-local
(e.g. `coord/.runtime/screen-index.json`); it is **derived/runtime**, not
canonical, and not hand-edited.

```jsonc
{
  "version": 1,
  "generated_at": "<ISO-8601>",
  "source_commit": "<sha>",
  "apps": [
    {
      "app": "<workspace app name>",          // e.g. ops-web
      "framework": "next-app-router|next-pages|react-router|expo-rn|other",
      "root": "<repo-relative path>",
      "screens": [
        {
          "id": "<app>:<stable-slug>",         // stable across renames where possible
          "route": "/path or null",            // null for non-routed RN screens
          "title": "<human label>",            // from heading/nav/explicit metadata
          "source": "<repo-relative file>",
          "persona_hints": ["<persona>"],      // from path/nav segment, best-effort
          "requirement_refs": [                // cross-link, may be empty
            { "doc": "<requirement doc path>", "anchor": "<heading slug>", "confidence": "explicit|inferred" }
          ]
        }
      ]
    }
  ],
  "requirements": {
    "source": "<requirement doc path or null>",
    "headings": [ { "anchor": "<slug>", "text": "<heading>", "level": 1 } ],
    "coverage": {
      "linked_anchors": <int>,
      "total_anchors": <int>,
      "unlinked_anchors": ["<slug>"]           // requirements with no screen — the BA's worklist
    }
  }
}
```

## Generation rules

1. **Discovery is framework-aware, not framework-locked.** Each `framework`
   has an adapter that enumerates screens (Next app-router: `app/**/page.*`;
   Expo/RN: screen components under the navigation tree; etc.). Unknown
   frameworks degrade to "directory of components named `*Screen|*Page`".
2. **Stable IDs.** Prefer route-derived slugs; fall back to file path. IDs
   should survive cosmetic refactors so traceability links don't churn.
3. **Requirement cross-link is best-effort and labeled.** `explicit` only
   when the screen source or a registry declares the requirement anchor;
   everything else is `inferred` (slug/title match) and must be visibly
   marked as such. Never present inferred links as authoritative.
4. **Coverage is the product.** The high-value output is
   `requirements.coverage.unlinked_anchors`: requirements with no screen.
   That list is what a BA acts on and what multi-agent URS/test work targets.
5. **No mutation.** The generator only reads source and requirement docs.
   It never edits screens, requirements, or governance state.

## Consumer contract (read-only surfaces)

A read-only UI (e.g. coord-ui) or CLI may consume the artifact to:
- list screens per app with their requirement links,
- show requirement coverage and the unlinked-requirement worklist,
- deep-link a screen ↔ requirement anchor ↔ governed ticket.

Consumers **must not** treat the artifact as canonical or write through it.
Acting on it (improving a URS section, opening manual-test work) happens via
the normal governed ticket lifecycle, not by mutating the index.

## Project adoption

A project adopts this method by:
1. providing/selecting framework adapters for its frontends,
2. pointing the generator at its requirement doc(s),
3. wiring the generator into its derived-artifact regeneration step,
4. optionally surfacing the artifact in its read-only governance UI.

The contract is stable; adapters and the requirement-doc path are the only
project-specific parts.

The coord-template default requirement source is
`coord/product/REQUIREMENTS.md`. Downstream projects may override that path
with `COORD_REQUIREMENTS_PATH`; compatibility aliases such as
`REQUIREMENTS_PATH` or `URS_PATH` are acceptable when adapting older project
UI packages. If no explicit path is configured, consumers should prefer
`coord/product/REQUIREMENTS.md` before checking project-specific legacy names.

The reusable read-only UI contract lives in
[`COORD_UI_CONTRACT.md`](./COORD_UI_CONTRACT.md).
