# Review-cycle display totals

The PLAN renderer and operator ticket view derive each review denominator from
`self_review_cycles.length`. A four-cycle record displays `1/4`, `2/4`, `3/4`,
and `4/4`, even if its stored totals are `3`, `3`, `3`, and `4`.

Persisted `total` fields remain for compatibility and historical evidence.
Renderers ignore those fields for display. Reading or rendering an existing
record does not backfill, normalize, or rewrite its JSON, review content, or
recorded totals. No migration of historical records is required.

The denominator describes the reviews currently recorded. It does not determine
review readiness: one recorded cycle displays `1/1`, while the applicable
review profile may still require additional cycles. Existing cycle-count gates,
review grammar, and readiness rules continue to apply.

The governed writer continues to record review evidence through `add-review-cycle`
and the existing explicit replacement operations. Rendering a derived denominator
does not authorize replacing earlier review evidence.
