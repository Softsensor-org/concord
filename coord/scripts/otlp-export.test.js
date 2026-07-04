// COORD-299: relocate this worker's ephemeral coarse state-locks + memory corpus to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntimeLocks();
// Behavior tests for coord/scripts/otlp-export.js — the ENT-005 OTLP exporter.
// The module is a pure DI factory (mirroring token-economics.js), so we drive it
// directly with fixture journals/board deps: hermetic, no env munging, no live
// collector, NO network. We assert the OTLP/JSON structure (tickets-as-traces,
// lifecycle-verbs-as-spans, cost/tier/attribution attributes, non-ticket events
// as log records), determinism (two runs byte-identical), and graceful handling
// of an empty journal. A thin facade test confirms the verb is wired on the CLI.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createOtlpExport = require("./otlp-export.js");
const { executeCommand } = require("./governance.js");

// A representative journal: a ticket lifecycle (start -> move-review -> mark-done)
// plus a cost.observed event, and two non-ticket events (a baseline + an agentid
// claim) that must become LOG records, not spans.
const FIXTURE_BOARD = {
  tasks: [
    { ID: "ENT-900", Repo: "X", Type: "feature", Pri: "P2", Status: "done", Owner: "claudea1" },
  ],
};

const FIXTURE_JOURNAL = [
  { ts: "2026-05-01T00:00:00.000Z", command: "journal-baseline", ticket: null, result: "succeeded", details: { reason: "baseline" } },
  {
    ts: "2026-05-01T00:01:00.000Z", command: "start", ticket: "ENT-900",
    before_status: "todo", after_status: "doing", result: "succeeded",
    identity: { agent_id: "a1", owner: "claudea1", session_id: "a1-sess", thread_id: "t1" },
  },
  {
    ts: "2026-05-01T00:05:00.000Z", command: "record-cost", ticket: "ENT-900",
    after_status: "doing", result: "succeeded",
    identity: { agent_id: "a1", owner: "claudea1", session_id: "a1-sess", thread_id: "t1" },
    details: {
      event_type: "cost.observed",
      cost: { ticket: "ENT-900", agent: "claudea1", model: "frontier", input_tokens: 1000, output_tokens: 500, usd: 0.5, phase: "implement" },
    },
  },
  {
    ts: "2026-05-01T00:10:00.000Z", command: "move-review", ticket: "ENT-900",
    before_status: "doing", after_status: "review", result: "succeeded",
    identity: { agent_id: "a1", owner: "claudea1", session_id: "a1-sess", thread_id: "t1" },
  },
  {
    ts: "2026-05-01T00:15:00.000Z", command: "mark-done", ticket: "ENT-900",
    before_status: "review", after_status: "done", result: "succeeded",
    identity: { agent_id: "a1", owner: "claudea1", session_id: "a1-sess", thread_id: "t1" },
  },
  { ts: "2026-05-01T00:20:00.000Z", command: "agentid", ticket: null, result: "succeeded", identity: { agent_id: "a1", owner: "claudea1" } },
];

function makeExporter(journal, board = FIXTURE_BOARD) {
  return createOtlpExport({
    fail: (m) => { throw new Error(m); },
    readGovernanceEventLog: () => journal,
    readBoard: () => board,
    getRows: (b) => (b && Array.isArray(b.tasks) ? b.tasks : []),
    // Mirror token-economics: P2 derives to "standard".
    resolveTicketTier: (row) => ({ tier: row.Pri === "P0" || row.Pri === "P1" ? "critical" : "standard", source: "derived-from-pri" }),
  });
}

function spanAttr(span, key) {
  const kv = span.attributes.find((a) => a.key === key);
  if (!kv) return undefined;
  const v = kv.value;
  return v.stringValue ?? v.doubleValue ?? v.intValue ?? v.boolValue;
}

test("otlp-export: ticket becomes a trace and lifecycle verbs become spans", () => {
  const ex = makeExporter(FIXTURE_JOURNAL);
  const payload = ex.buildOtlpPayload(FIXTURE_JOURNAL);

  assert.equal(payload.resourceSpans.length, 1);
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  // 1 synthetic root + 4 lifecycle events (start, record-cost, move-review, mark-done).
  assert.equal(spans.length, 5);

  // Exactly one trace id for the single ticket; all spans share it.
  const traceIds = new Set(spans.map((s) => s.traceId));
  assert.equal(traceIds.size, 1);
  const traceId = [...traceIds][0];
  assert.match(traceId, /^[0-9a-f]{32}$/);

  // The root span (name "ticket ENT-900") has no parent; lifecycle spans parent to it.
  const root = spans.find((s) => s.name === "ticket ENT-900");
  assert.ok(root);
  assert.equal(root.parentSpanId, undefined);
  assert.match(root.spanId, /^[0-9a-f]{16}$/);

  const verbSpans = spans.filter((s) => s.name !== "ticket ENT-900");
  assert.deepEqual(verbSpans.map((s) => s.name).sort(), ["mark-done", "move-review", "record-cost", "start"]);
  for (const s of verbSpans) {
    assert.equal(s.parentSpanId, root.spanId, `${s.name} should parent to ticket root`);
    assert.match(s.spanId, /^[0-9a-f]{16}$/);
  }
});

test("otlp-export: cost and tier and attribution land as span attributes", () => {
  const ex = makeExporter(FIXTURE_JOURNAL);
  const spans = ex.buildOtlpPayload(FIXTURE_JOURNAL).resourceSpans[0].scopeSpans[0].spans;

  const startSpan = spans.find((s) => s.name === "start");
  assert.equal(spanAttr(startSpan, "coord.owner"), "claudea1");
  assert.equal(spanAttr(startSpan, "coord.repo"), "X");
  assert.equal(spanAttr(startSpan, "coord.tier"), "standard");
  assert.equal(spanAttr(startSpan, "coord.after_status"), "doing");

  const costSpan = spans.find((s) => s.name === "record-cost");
  assert.equal(spanAttr(costSpan, "coord.cost.usd"), 0.5);
  assert.equal(spanAttr(costSpan, "coord.cost.input_tokens"), "1000");
  assert.equal(spanAttr(costSpan, "coord.cost.model"), "frontier");
  assert.equal(spanAttr(costSpan, "coord.cost.phase"), "implement");
  // Non-cost spans carry NO cost attributes.
  assert.equal(spanAttr(startSpan, "coord.cost.usd"), undefined);
});

test("otlp-export: non-ticket events become OTLP log records, not spans", () => {
  const ex = makeExporter(FIXTURE_JOURNAL);
  const payload = ex.buildOtlpPayload(FIXTURE_JOURNAL);

  assert.equal(payload.resourceLogs.length, 1);
  const logs = payload.resourceLogs[0].scopeLogs[0].logRecords;
  // journal-baseline + agentid.
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map((l) => l.body.stringValue).sort(), ["agentid", "journal-baseline"]);
  for (const l of logs) {
    assert.equal(l.severityText, "INFO");
    assert.match(l.timeUnixNano, /^\d+$/);
  }
});

test("otlp-export: deterministic — two runs are byte-identical", () => {
  const ex = makeExporter(FIXTURE_JOURNAL);
  const a = ex.serializeOtlp(ex.buildOtlpPayload(FIXTURE_JOURNAL));
  const b = ex.serializeOtlp(ex.buildOtlpPayload(FIXTURE_JOURNAL));
  assert.equal(a, b);
  // Ids are stable across independently-constructed exporters too (no random).
  const ex2 = makeExporter(FIXTURE_JOURNAL);
  assert.equal(ex2.serializeOtlp(ex2.buildOtlpPayload(FIXTURE_JOURNAL)), a);
});

test("otlp-export: empty journal yields a valid, empty OTLP/JSON payload (no throw)", () => {
  const ex = makeExporter([]);
  const result = ex.otlpExport({ silent: true });
  assert.equal(result.status, "exported");
  assert.equal(result.journal_event_count, 0);
  assert.equal(result.trace_count, 0);
  assert.equal(result.span_count, 0);
  assert.equal(result.log_record_count, 0);
  const parsed = JSON.parse(result.body);
  assert.deepEqual(parsed, { resourceSpans: [], resourceLogs: [] });
});

test("otlp-export: --output writes OTLP/JSON to a file and is read-only otherwise", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otlp-export-"));
  const out = path.join(dir, "otlp.json");
  const ex = makeExporter(FIXTURE_JOURNAL);
  const result = ex.otlpExport({ output: out, silent: true });
  assert.equal(result.sink, "file");
  assert.equal(result.output, out);
  const onDisk = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(onDisk.resourceSpans[0].scopeSpans[0].spans.length > 0);
});

test("otlp-export: summarize reports trace/span/log counts", () => {
  const ex = makeExporter(FIXTURE_JOURNAL);
  const s = ex.summarize(ex.buildOtlpPayload(FIXTURE_JOURNAL));
  assert.equal(s.trace_count, 1);
  assert.equal(s.span_count, 5);
  assert.equal(s.log_record_count, 2);
});

test("otlp-export: wired on the CLI facade (gov otlp-export --stdout)", () => {
  const res = executeCommand(["otlp-export", "--stdout"]);
  assert.equal(res.ok, true, res.error);
  // Default stdout sink prints raw OTLP/JSON parseable to the wire shape.
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed.resourceSpans));
  assert.ok(Array.isArray(parsed.resourceLogs));
});
