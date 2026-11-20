# Daily Analytics Retention And Custody

Raw analytics evidence often contains private business data. The workflow pack
therefore separates public templates from adopter-owned evidence.

## Retention Classes

| Class | Meaning | Default handling |
|---|---|---|
| `public-synthetic` | Example data created only for docs or demos. | May ship in the public template. |
| `private-raw-short` | Raw platform exports used for operational review. | Keep in adopter storage for the local retention window, commonly 30-90 days. |
| `private-raw-audit` | Raw exports required for audit, dispute, or regulated evidence. | Keep per local policy and access controls. |
| `clean-shareable` | Normalized data with private values removed or aggregated. | May be shared inside the adopter org when caveats are attached. |
| `derived-report` | Human review or decision note with links to evidence. | Commit when it contains no raw private data. |

## Custody Rules

1. Raw snapshots are immutable. If a source export was wrong, write a new raw
   snapshot and supersede the prior register row.
2. Clean data never replaces raw evidence. It points back to raw path and source
   register row.
3. Public examples use synthetic source systems, synthetic ids, and
   `example.com` style labels only.
4. Reports that support a business decision must link to raw evidence, mart
   output, and reconciliation label.
5. Deleting raw data requires updating the data register with retention class,
   deletion date or planned deletion date, and any remaining audit-safe pointer.
