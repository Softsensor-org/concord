# Governance Phases

Status: implemented (catalog) · Owner: Softsensor · Date: 2026-06-25

Governance phases describe the maturity of a repo or ticket family. They are
separate from adoption profiles: a profile describes governance posture, while a
phase describes where the work is on the path from discovery to production.

The machine-readable catalog is
[`governance-phases.json`](governance-phases.json). The immediate consumer is
`coord doctor`, which reports `recommended_phase` and
`recommended_phase_details`.

| Phase | Intent | Minimum posture |
| --- | --- | --- |
| `exploration` | Capture discovery without pretending it is production-ready. | Notes, findings, and promotion path |
| `prototype` | Move quickly while preserving decisions and local verification. | Local gate/proof/closure |
| `pilot` | Add user evidence, runtime verification, and adoption blockers. | Review cycles plus runtime/user evidence |
| `production` | Require tests, release proof, rollback, and owner clarity. | Landing, rollback, runtime/deploy receipt |
| `regulated-production` | Require traceability, approvals, audit evidence, and validation-grade closure. | Regulated evidence, signoff, waiver/deviation controls |

Rules:

1. A phase may increase evidence depth; it must not weaken a stricter adoption
   profile.
2. `production` must not be weaker than `pilot`.
3. `regulated-production` must not be weaker than `production`.
4. Exploration findings must be promoted into governed tickets before
   implementation.
5. Ticket phase metadata is advisory unless a consuming gate explicitly enforces
   it.
