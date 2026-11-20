# Data Retention And Custody

Use this file to adapt the workflow-pack retention rules to this workspace.

## Retention Classes

| Class | Meaning | Local retention |
|---|---|---|
| `public-synthetic` | Synthetic docs/demo data. | Keep with template/docs. |
| `private-raw-short` | Raw platform exports for operational review. | TODO |
| `private-raw-audit` | Raw exports required for audit or dispute evidence. | TODO |
| `clean-shareable` | Normalized and redacted or aggregated clean data. | TODO |
| `derived-report` | Review notes and decisions that link to evidence. | TODO |

## Rules

1. Raw snapshots are immutable.
2. Clean data points back to raw evidence; it does not replace it.
3. Public examples must be synthetic.
4. Reports that support decisions link to raw evidence, mart output, and
   reconciliation label.
5. Deleted raw data leaves a register row with retention/deletion notes.
