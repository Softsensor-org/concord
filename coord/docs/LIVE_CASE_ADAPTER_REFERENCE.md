# Live-Case Adapter Reference (Production MCP P3 / COORD-154)

A **generic, reusable reference pattern** for narrow, read-only
production/staging "case" reads. coord-template ships the *pattern*; the adopter
owns the real wiring (the actual MCP/tool call, the real endpoint, the real
credentials). A "case-management read" is only the motivating shape — the
pattern is domain-neutral.

- Reference adapter: `coord/scripts/adapters/live-case-adapter-reference.js`
- Promotion helper: `coord/scripts/adapters/live-case-fixture-promotion.js`
- Tests (synthetic only): `coord/scripts/live-case-adapter-reference.test.js`

## Non-goals (hard)

- **No committed customer data.** Tests use synthetic, fake records.
- **No real production credentials.** None are read, stored, or required.
- **No real endpoint / network call.** The reference NEVER touches the network.
  The adopter injects a `fetchCase` reader; tests inject a synthetic one.
- **No product-specific business logic in coord core.**

## What the pattern enforces

1. **Require narrowing filters.** A read must be scoped by `client + date +
   entity`. Missing/blank filters are refused.
2. **Reject broad dumps.** Wildcards (`*`, `%`, `all`, `any`, ...) are refused
   *before* the reader is ever invoked — no broad dump can execute.
3. **Redact sensitive fields.** Configured sensitive keys are masked
   (`[redacted]`); nested objects/arrays are summarized, never emitted raw. Raw
   values never reach the evidence record.
4. **Emit compact JSON evidence + a receipt.** The receipt is produced through
   the COORD-152 receipt writer (`runtime-evidence.js`) with
   `operation_class = read_sensitive`, so it satisfies COORD-153 live-MCP
   lifecycle enforcement.

## Usage shape (adopter-owned wiring)

```js
const { readLiveCase } = require("coord/scripts/adapters/live-case-adapter-reference.js");

const { scope, evidence, receipt } = readLiveCase({
  ticket: "ADOPTER-123",
  adapter: "live-case-readonly",
  filters: { client: "acme", date: "2026-06-24", entity: "case-7" },
  approval: "human:alice approved bounded read",
  // The adopter owns the real, narrow read. This is the ONLY place a real
  // MCP tool call / endpoint / credential is wired. coord ships no such call.
  fetchCase: (narrowScope) => myMcpClient.getCases(narrowScope),
});
// `receipt` is ready to embed as live_mcp.receipt or persist via
// `gov live-mcp-record`. `evidence` is compact + redacted.
```

`readLiveCase` returns `{ scope, evidence, receipt }`. The receipt is validated
in-line with `validateLiveMcpReceipt` so a misconfigured adopter fails at the
adapter, not at the COORD-153 closeout gate.

## How a live observation becomes a fixture / regression test / synthetic case

This is the **promotion path** COORD-153 requires for product-impacting live
findings. It is executable via `live-case-fixture-promotion.js`.

1. **Read narrowly + redact.** `readLiveCase(...)` yields compact, redacted
   evidence (no raw sensitive values).
2. **Promote to a synthetic fixture.** Feed the evidence to
   `promoteEvidenceToFixture(evidence, { ticket })`. It:
   - replaces identifying values (and any never-persist field) with synthetic
     stand-ins (`synthetic-<field>-<n>`);
   - synthesizes the scope (`synthetic-client` / `synthetic-date` /
     `synthetic-entity`) so no live client/entity id survives;
   - preserves the structural **shape** (status, priority, type, ...) so the
     fixture exercises the same code path the live read exposed;
   - marks the record `synthetic: true`.
3. **Assert customer-safe.** `assertFixtureCustomerSafe(fixture)` throws if any
   redacted marker or raw identity value survived. Run this before committing.
4. **Land as a regression test / synthetic case.** Commit the synthetic fixture
   under a repo fixtures dir and add a regression test that drives the affected
   code path with it. If the finding implies a behavior rule, record it as a
   spec/governance rule and reference the ticket.
5. **Record promotion on the ticket.** Declare
   `live_mcp.promotion` (e.g. via `gov update-plan --live-mcp`) pointing at the
   committed fixture/test so the COORD-153 promotion blocker clears.

The result: a reviewer reconstructs the finding from a committed synthetic
fixture + receipt — never from customer data or chat history.

## Operation-class mapping

A read-only case read maps to `read_sensitive` (production case payloads are
sensitive): approval required, redaction required, no cleanup. See the
operation-class table in `PRODUCTION_MCP_ADAPTER_PLAN.md` and `OPERATION_CLASSES`
in `coord/scripts/runtime-evidence.js`.
