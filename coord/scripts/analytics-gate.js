"use strict";

// COORD-187: evidence gate-proc for the PRODUCT-ENGINEERING track.
//
// Unlike the development `test` gate (which runs a test suite), the
// product-engineering track gates on EVIDENCE INTEGRITY: a ticket that touched
// production via MCP must carry one or more valid live-MCP receipts
// (operation-class satisfied, redaction present where the class requires it,
// scope bounded, evidence attached). This is the first evidence-only gate path
// in the engine — it passes/fails on validated receipts, not on test output.
//
// It REUSES the existing receipt machinery in runtime-evidence.js
// (OPERATION_CLASSES + validateLiveMcpReceipt) rather than re-implementing
// policy, and emits a track-gate report in the shared shape used by the other
// track gate-procs (content-gate.js, infra-gate.js, data-contract-gate.js).

const fs = require("fs");
const path = require("path");
const {
  validateLiveMcpReceipt,
  readReceipt,
  __testing: { safeSlug },
} = require("./runtime-evidence.js");
const { shapeGateResult } = require("./gate-result.js");

// Pure evaluation over an in-memory receipt set — no fs, fully unit-testable.
// receipts: array of { receipt, source } where source labels where it came from.
function evaluateReceiptSet(ticket, receipts) {
  const checks = [];
  const artifactPaths = [];

  // Check 1: at least one receipt is present for the ticket.
  if (!Array.isArray(receipts) || receipts.length === 0) {
    checks.push({
      name: "receipt_present",
      result: "fail",
      detail: `No live-MCP receipt found for ${ticket}. A product-engineering ticket must record at least one bounded production-MCP operation (gov live-mcp-record).`,
    });
    return finalize(ticket, checks, artifactPaths);
  }
  checks.push({
    name: "receipt_present",
    result: "pass",
    detail: `${receipts.length} receipt(s) found for ${ticket}.`,
  });

  // Check 2: every receipt validates against its operation-class policy.
  for (const { receipt, source } of receipts) {
    if (source) artifactPaths.push(source);
    const errors = [];
    const collect = (msg) => errors.push(msg);
    try {
      validateLiveMcpReceipt(receipt, collect);
    } catch (err) {
      errors.push(err && err.message ? err.message : String(err));
    }
    const label = `${receipt && receipt.operation_class ? receipt.operation_class : "?"}:${receipt && receipt.operation ? receipt.operation : source || "receipt"}`;
    if (errors.length === 0) {
      checks.push({ name: `receipt_valid[${label}]`, result: "pass", detail: "operation-class satisfied (redaction/approval/scope/evidence as required)." });
    } else {
      checks.push({ name: `receipt_valid[${label}]`, result: "fail", detail: errors.join("; ") });
    }
  }

  return finalize(ticket, checks, artifactPaths);
}

function finalize(ticket, checks, artifactPaths) {
  // COORD-279: shared gate-result shaping (was an inlined duplicate of the
  // content/infra blocks). Label stays "evidence" (the gateProc) for an
  // identical summary string.
  return shapeGateResult({
    gateProc: "evidence",
    track: "product-engineering",
    subject: { ticket },
    checks,
    artifactPaths,
  });
}

// Load receipts for a ticket from a live-MCP evidence directory. Each file is a
// JSON receipt; we select files whose name embeds the ticket slug (matching the
// runtime-evidence.js naming convention `<ts>-<ticketSlug>-<label>.json`).
function loadReceiptsForTicket(ticket, evidenceDir) {
  if (!evidenceDir || !fs.existsSync(evidenceDir)) return [];
  const slug = safeSlug(ticket);
  return fs
    .readdirSync(evidenceDir)
    .filter((name) => name.endsWith(".json") && name.includes(`-${slug}-`))
    .sort()
    .map((name) => {
      const source = path.join(evidenceDir, name);
      let receipt = null;
      const errs = [];
      try {
        receipt = readReceipt(source, (m) => errs.push(m));
      } catch (err) {
        errs.push(err && err.message ? err.message : String(err));
      }
      // An unreadable file becomes a receipt that fails validation loudly.
      return { receipt: receipt || { __unreadable: errs.join("; ") }, source };
    });
}

// runEvidenceGate({ ticket, evidenceDir?, receipts? }) -> report
function runEvidenceGate(options = {}) {
  const ticket = options.ticket;
  if (!ticket) throw new Error("runEvidenceGate requires a ticket");
  const receipts = options.receipts
    ? options.receipts.map((r) => (r.receipt ? r : { receipt: r, source: null }))
    : loadReceiptsForTicket(ticket, options.evidenceDir || defaultEvidenceDir(options.coordDir));
  return evaluateReceiptSet(ticket, receipts);
}

function defaultEvidenceDir(coordDir) {
  return path.join(coordDir || path.join(__dirname, ".."), "evidence", "live-mcp");
}

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--ticket") out.ticket = argv[++i];
    else if (a === "--evidence-dir") out.evidenceDir = argv[++i];
    else if (!out.ticket && !a.startsWith("--")) out.ticket = a;
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.ticket) {
    process.stderr.write("usage: node analytics-gate.js <ticket> [--evidence-dir <dir>] [--json]\n");
    process.exit(2);
  }
  const report = runEvidenceGate(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`${report.summary}\n`);
    for (const c of report.checks) {
      process.stdout.write(`  [${c.result}] ${c.name}: ${c.detail}\n`);
    }
  }
  process.exit(report.result === "pass" ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateReceiptSet,
  loadReceiptsForTicket,
  runEvidenceGate,
  main,
};
