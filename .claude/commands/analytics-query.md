# Analytics Query — Bounded Production-MCP Read + Receipt (product-engineering track)

Run **one bounded** production-MCP read within a `PE-`/`LIVE-MCP-` ticket's authorized scope,
record a **redacted receipt**, and validate it with the evidence gate. The receipt — not the raw
data — is the durable, auditable artifact.

**Arguments:** `$ARGUMENTS` — a `PE-`/`LIVE-MCP-` ticket id and the read to perform
(adapter / operation / scope). E.g. `LIVE-MCP-007 read orders adapter for last 30d revenue by region`.

## Phase 1: Confirm policy & scope

Always pre-flight with `/live-mcp-policy` (or inline):

```bash
coord/scripts/gov live-mcp-policy $ARGUMENTS
coord/scripts/gov explain $ARGUMENTS
```

Confirm the **operation class** (`read_safe` / `read_sensitive`), that approval is satisfied, and
the **bounded scope** (row/time limits). Do not exceed it.

## Phase 2: Run the bounded read

Execute the read through the authorized production-MCP adapter, staying inside scope (e.g. a
single dataset, a single time window, capped rows). Capture the result for interpretation but keep
sensitive fields out of any stored artifact.

## Phase 3: Record a redacted receipt

```bash
coord/scripts/gov live-mcp-record $ARGUMENTS \
  --class <read_safe|read_sensitive> \
  --adapter <adapter-name> \
  --operation <operation-or-query-label> \
  --scope "<bounded scope: dataset, window, row cap>" \
  --redaction "<what was masked/aggregated, e.g. PII hashed, revenue bucketed>" \
  --evidence <path-to-redacted-evidence>
```

`read_sensitive` **requires** redaction; `read_safe` strongly recommends it. The receipt records
class, adapter, operation, scope, and redaction — never raw sensitive rows.

## Phase 4: Validate with the analytics gate

```bash
node coord/scripts/analytics-gate.js $ARGUMENTS
```

This validates the receipt(s) against the operation-class policy (class satisfied, redaction
present where required, scope bounded, evidence attached). Report pass/fail, the validated
receipts, and the artifact path.

## Rules

- One **bounded** read per receipt — never broaden scope beyond what `gov explain` authorized.
- No mutations here (`read_safe`/`read_sensitive` only). Mutating work routes to development.
- The redacted receipt is the artifact of record; never store raw sensitive data.
- Hand interpretation of the findings to **`/insight-analyst`** — this skill gets the evidence, it
  does not decide what it means.
