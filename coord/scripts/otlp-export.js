"use strict";

// ENT-005: OTLP exporter for the governance journal (COMMUNITY tier, per-team).
//
// Emits the durable governance journal (coord/.runtime/governance-events.ndjson,
// ENT-001/ENT-002) as OpenTelemetry so a team's fleet of governed tickets/agents
// renders in tools they already run (Datadog/Grafana — already pre-wired in
// .mcp.json). Complements (does NOT replace) the future ENT-003 collector.
//
// Zero-dependency + deterministic by design: we emit the OTLP/JSON wire shape
// (the JSON encoding of OTLP ResourceSpans / ResourceLogs) DIRECTLY rather than
// pulling in a heavy OpenTelemetry SDK. That keeps the exporter hermetic,
// hash-stable, and testable WITHOUT a live collector or any network.
//
// Mapping:
//   ticket            -> TRACE          (trace_id deterministic from ticket id)
//   lifecycle event   -> SPAN           (span_id deterministic; parent = the
//                                         ticket-root span; name = the verb)
//   attribution/cost/  -> span ATTRIBUTES (owner/agent, repo, tier, result, and
//   tier                                   cost usd/tokens/model from cost.observed)
//   non-ticket event  -> LOG RECORD     (cannot be spanned to a ticket trace)
//
// READ-ONLY: reads the journal + writes ONLY to its own output file/stdout (or
// POSTs when --endpoint is given, which is OFF by default). It MUST NOT mutate
// the journal or the board.

const crypto = require("crypto");
const fs = require("fs");

function createOtlpExport(deps = {}) {
  const {
    fail,
    readGovernanceEventLog,
    readBoard,
    getRows,
    resolveTicketTier,
  } = deps;

  const COST_EVENT_TYPE = "cost.observed";
  // OTLP span kinds (numeric, per the proto enum). We model lifecycle spans as
  // INTERNAL (1) and the synthetic ticket-root span as SERVER (2) so a trace UI
  // shows the ticket as the root operation. Log severity uses INFO (9).
  const SPAN_KIND_INTERNAL = 1;
  const SPAN_KIND_SERVER = 2;
  const SEVERITY_INFO_NUMBER = 9;
  const SEVERITY_INFO_TEXT = "INFO";

  function sha1Hex(value) {
    return crypto.createHash("sha1").update(String(value)).digest("hex");
  }

  // OTLP trace ids are 16 bytes (32 hex chars); span ids are 8 bytes (16 hex
  // chars). We derive both deterministically from a stable string so identical
  // journal input always yields identical ids (no random) — the byte-stability
  // contract that lets two runs be diffed and lets ENT-003 re-key the same spans.
  function deterministicTraceId(seed) {
    return sha1Hex(`trace:${seed}`).slice(0, 32);
  }

  function deterministicSpanId(seed) {
    return sha1Hex(`span:${seed}`).slice(0, 16);
  }

  // Event timestamp -> Unix nanoseconds (OTLP uses string unix-nano). Lifecycle
  // events are instantaneous in the journal, so a span's start == end == the
  // event ts; a non-parseable/absent ts degrades to "0" (never throws).
  function nanosFromTs(ts) {
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) {
      return "0";
    }
    // BigInt avoids float precision loss at nanosecond magnitude.
    return (BigInt(ms) * 1000000n).toString();
  }

  // OTLP attribute KeyValue: { key, value: { <typed>: ... } }. We only emit a
  // KeyValue when the value is meaningful (non-null/non-empty) so the output is
  // compact and stable. Numbers map to doubleValue / intValue, booleans to
  // boolValue, everything else to stringValue.
  function attr(key, value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    if (typeof value === "boolean") {
      return { key, value: { boolValue: value } };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return Number.isInteger(value)
        ? { key, value: { intValue: String(value) } }
        : { key, value: { doubleValue: value } };
    }
    return { key, value: { stringValue: String(value) } };
  }

  function attributesFor(pairs) {
    return pairs.map(([k, v]) => attr(k, v)).filter(Boolean);
  }

  // The cost payload that a cost.observed event carries (token-economics.js).
  function costOf(event) {
    if (!event || !event.details || event.details.event_type !== COST_EVENT_TYPE) {
      return null;
    }
    return event.details.cost || null;
  }

  // Resolve a ticket id -> tier string, using the injected board + tier policy.
  // Falls back gracefully (null) when the ticket is not on the board or the
  // board is unavailable, so export never throws on an unknown/historic ticket.
  function buildTierResolver() {
    let rowsById = null;
    try {
      const board = readBoard();
      rowsById = new Map(getRows(board).map((row) => [row.ID, row]));
    } catch {
      rowsById = null;
    }
    return function tierFor(ticketId) {
      if (!rowsById) {
        return { tier: null, repo: null };
      }
      const row = rowsById.get(ticketId);
      if (!row) {
        return { tier: null, repo: null };
      }
      let tier = null;
      try {
        tier = resolveTicketTier(row).tier;
      } catch {
        tier = null;
      }
      return { tier, repo: row.Repo || null };
    };
  }

  // Group every journal event by ticket. Non-ticket events (journal-baseline,
  // agentid, chain-anchor, ...) are collected separately to become log records.
  // Stable: tickets sorted by id, events kept in journal (chronological) order,
  // with an index so two events sharing a (command, ts) still get distinct span
  // ids. No silent drops — every event lands as a span OR a log record.
  function partitionJournal(events) {
    const byTicket = new Map();
    const nonTicket = [];
    events.forEach((event, journalIndex) => {
      if (!event || typeof event !== "object") {
        return;
      }
      if (event.ticket) {
        if (!byTicket.has(event.ticket)) {
          byTicket.set(event.ticket, []);
        }
        byTicket.get(event.ticket).push({ event, journalIndex });
      } else {
        nonTicket.push({ event, journalIndex });
      }
    });
    return { byTicket, nonTicket };
  }

  function spanForEvent(traceId, rootSpanId, ticketId, entry, tierInfo) {
    const { event, journalIndex } = entry;
    const spanId = deterministicSpanId(`${ticketId}:${journalIndex}:${event.command}:${event.ts}`);
    const nanos = nanosFromTs(event.ts);
    const cost = costOf(event);
    const attributes = attributesFor([
      ["coord.ticket", ticketId],
      ["coord.command", event.command || null],
      ["coord.result", event.result || null],
      ["coord.before_status", event.before_status || null],
      ["coord.after_status", event.after_status || null],
      ["coord.owner", event.identity ? event.identity.owner : null],
      ["coord.agent_id", event.identity ? event.identity.agent_id : null],
      ["coord.session_id", event.identity ? event.identity.session_id : null],
      ["coord.thread_id", event.identity ? event.identity.thread_id : null],
      ["coord.repo", tierInfo.repo],
      ["coord.tier", tierInfo.tier],
      // Cost attributes (present only on cost.observed spans).
      ["coord.cost.usd", cost ? Number(cost.usd) : null],
      ["coord.cost.input_tokens", cost ? Number(cost.input_tokens) : null],
      ["coord.cost.output_tokens", cost ? Number(cost.output_tokens) : null],
      ["coord.cost.model", cost ? cost.model : null],
      ["coord.cost.phase", cost ? cost.phase : null],
    ]);
    return {
      traceId,
      spanId,
      parentSpanId: rootSpanId,
      name: event.command || "event",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos,
      endTimeUnixNano: nanos,
      attributes,
      status: event.result === "failed" ? { code: 2 } : { code: 1 },
    };
  }

  // One ResourceSpans scope per ticket: a synthetic SERVER root span representing
  // the ticket trace, plus one INTERNAL span per lifecycle event.
  function buildTraceScopeForTicket(ticketId, entries, tierFor) {
    const traceId = deterministicTraceId(ticketId);
    const rootSpanId = deterministicSpanId(`${ticketId}:root`);
    const tierInfo = tierFor(ticketId);
    const firstNanos = nanosFromTs(entries[0] ? entries[0].event.ts : null);
    const lastNanos = nanosFromTs(entries[entries.length - 1] ? entries[entries.length - 1].event.ts : null);
    const spans = [
      {
        traceId,
        spanId: rootSpanId,
        name: `ticket ${ticketId}`,
        kind: SPAN_KIND_SERVER,
        startTimeUnixNano: firstNanos,
        endTimeUnixNano: lastNanos,
        attributes: attributesFor([
          ["coord.ticket", ticketId],
          ["coord.repo", tierInfo.repo],
          ["coord.tier", tierInfo.tier],
          ["coord.event_count", entries.length],
        ]),
        status: { code: 1 },
      },
    ];
    for (const entry of entries) {
      spans.push(spanForEvent(traceId, rootSpanId, ticketId, entry, tierInfo));
    }
    return spans;
  }

  function buildLogRecord(entry) {
    const { event } = entry;
    return {
      timeUnixNano: nanosFromTs(event.ts),
      observedTimeUnixNano: nanosFromTs(event.ts),
      severityNumber: SEVERITY_INFO_NUMBER,
      severityText: SEVERITY_INFO_TEXT,
      body: { stringValue: event.command || "event" },
      attributes: attributesFor([
        ["coord.command", event.command || null],
        ["coord.result", event.result || null],
        ["coord.owner", event.identity ? event.identity.owner : null],
        ["coord.agent_id", event.identity ? event.identity.agent_id : null],
        ["coord.session_id", event.identity ? event.identity.session_id : null],
      ]),
    };
  }

  // The shared OTLP Resource for everything we export: identifies the producer
  // (the coord governance journal) so a backend can scope the fleet by service.
  function buildResource() {
    return {
      attributes: attributesFor([
        ["service.name", "coord-governance"],
        ["telemetry.sdk.name", "coord-otlp-export"],
        ["telemetry.sdk.language", "nodejs"],
      ]),
    };
  }

  const SCOPE = { name: "coord/scripts/otlp-export.js", version: "1" };

  // Build the full OTLP/JSON payload: ResourceSpans (tickets-as-traces) +
  // ResourceLogs (non-ticket events). Deterministic: tickets sorted by id,
  // events in journal order, fixed key order, no timestamps-of-now / no random.
  function buildOtlpPayload(events) {
    const { byTicket, nonTicket } = partitionJournal(events);
    const tierFor = buildTierResolver();

    const allSpans = [];
    for (const ticketId of [...byTicket.keys()].sort()) {
      for (const span of buildTraceScopeForTicket(ticketId, byTicket.get(ticketId), tierFor)) {
        allSpans.push(span);
      }
    }

    const resource = buildResource();
    const resourceSpans = allSpans.length
      ? [{ resource, scopeSpans: [{ scope: SCOPE, spans: allSpans }] }]
      : [];
    const logRecords = nonTicket.map((entry) => buildLogRecord(entry));
    const resourceLogs = logRecords.length
      ? [{ resource, scopeLogs: [{ scope: SCOPE, logRecords }] }]
      : [];

    return { resourceSpans, resourceLogs };
  }

  // Deterministic serialization: a fixed-key-order JSON of the payload. Two runs
  // on the same journal produce byte-identical text.
  function serializeOtlp(payload) {
    return JSON.stringify(payload);
  }

  // Opt-in HTTP-OTLP POST. OFF by default. Degrades gracefully: any failure is
  // reported in the result, never thrown, and tests never exercise the network
  // (no --endpoint => this is never called).
  function postToEndpoint(endpoint, body) {
    return new Promise((resolve) => {
      let lib;
      let url;
      try {
        url = new URL(endpoint);
        lib = url.protocol === "https:" ? require("https") : require("http");
      } catch (error) {
        resolve({ ok: false, error: `invalid --endpoint URL: ${error.message}` });
        return;
      }
      try {
        const req = lib.request(
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.resume();
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
          }
        );
        req.on("error", (error) => resolve({ ok: false, error: error.message }));
        req.write(body);
        req.end();
      } catch (error) {
        resolve({ ok: false, error: error.message });
      }
    });
  }

  function summarize(payload) {
    const spans = (payload.resourceSpans[0]?.scopeSpans[0]?.spans) || [];
    const logs = (payload.resourceLogs[0]?.scopeLogs[0]?.logRecords) || [];
    const traceIds = new Set(spans.map((s) => s.traceId));
    return {
      trace_count: traceIds.size,
      span_count: spans.length,
      log_record_count: logs.length,
    };
  }

  // The `gov otlp-export` entrypoint. Read-only. Sink is file/stdout by default;
  // --endpoint POST is opt-in and off by default. Returns a structured result
  // (consumed by tests + the CLI) and prints a deterministic summary or, with
  // --stdout/no sink, the OTLP/JSON itself.
  function otlpExport(options = {}) {
    const events = readGovernanceEventLog();
    const payload = buildOtlpPayload(events);
    const body = serializeOtlp(payload);
    const summary = summarize(payload);

    const result = {
      status: "exported",
      journal_event_count: events.length,
      ...summary,
      sink: null,
      endpoint: null,
    };

    // Async path ONLY when an endpoint is requested (opt-in). The default sink
    // (file/stdout) stays fully synchronous so the common case is simple +
    // deterministic and tests need no async plumbing.
    if (options.endpoint) {
      result.endpoint = options.endpoint;
      result.sink = "endpoint";
      return postToEndpoint(options.endpoint, body).then((post) => {
        result.endpoint_post = post;
        if (options.output) {
          fs.writeFileSync(options.output, body);
          result.sink = "endpoint+file";
          result.output = options.output;
        }
        if (!options.silent) {
          console.log(JSON.stringify(result, null, 2));
        }
        return result;
      });
    }

    if (options.output) {
      fs.writeFileSync(options.output, body);
      result.sink = "file";
      result.output = options.output;
      if (!options.silent) {
        console.log(JSON.stringify(result, null, 2));
      }
      return result;
    }

    // Default sink: stdout. We print the raw OTLP/JSON so it can be piped to a
    // file or a collector relay; --json/--summary semantics are not needed since
    // OTLP/JSON IS the machine output here.
    result.sink = "stdout";
    if (!options.silent) {
      console.log(body);
    }
    result.body = body;
    return result;
  }

  return {
    deterministicTraceId,
    deterministicSpanId,
    nanosFromTs,
    attr,
    attributesFor,
    costOf,
    partitionJournal,
    buildOtlpPayload,
    serializeOtlp,
    summarize,
    otlpExport,
  };
}

module.exports = createOtlpExport;
