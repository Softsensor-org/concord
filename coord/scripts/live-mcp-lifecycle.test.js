"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildLiveMcpLifecycle, readLiveMcpDeclaration } = require("./live-mcp-lifecycle.js");

// COORD-153: live-MCP lifecycle ENFORCEMENT. These tests pin the acceptance
// criteria from the ticket + PRODUCTION_MCP_ADAPTER_PLAN.md:
//   - a declared live-mcp ticket missing required evidence -> blocking issues
//     naming each missing item;
//   - a fully-evidenced live-mcp ticket -> ready (no issues);
//   - operation-class-driven approval/redaction/cleanup requirements;
//   - pending cleanup blocks;
//   - product-impacting findings require promotion;
//   - a NON-live-mcp ticket is completely unaffected (no new requirements),
//     and detection does not false-trigger on a missing/malformed field.

const FULL_SENSITIVE = {
  adapter: "hos-prod-db",
  operation: "case-read",
  operation_class: "read_sensitive",
  environment: "prod",
  scope: "client_code=AGNLI, board=current",
  redaction: "masked",
  approval: "human-admin",
  receipt_path: "coord/evidence/live-mcp/case-read.json",
};

function codes(result) {
  return result.issues.map((issue) => issue.code);
}

test("non-live-mcp ticket is unaffected: declared=false, no issues", () => {
  assert.deepEqual(buildLiveMcpLifecycle({ planState: {} }), { declared: false, issues: [] });
  assert.deepEqual(
    buildLiveMcpLifecycle({ planState: { critical_invariants: ["x"], feature_proof: ["path:a"] } }),
    { declared: false, issues: [] }
  );
});

test("detection does not false-trigger on a description that merely mentions production/mcp", () => {
  // The board row Description is intentionally NOT consulted — only the explicit
  // declared `live_mcp` plan object turns the gate on.
  const result = buildLiveMcpLifecycle({
    row: { ID: "APP-9", Description: "Investigate the production MCP adapter and live database reads." },
    planState: {},
  });
  assert.equal(result.declared, false);
  assert.deepEqual(result.issues, []);
});

test("malformed live_mcp field (array/scalar) does not enable the gate", () => {
  assert.equal(readLiveMcpDeclaration({ live_mcp: [1, 2] }), null);
  assert.equal(readLiveMcpDeclaration({ live_mcp: "yes" }), null);
  assert.equal(buildLiveMcpLifecycle({ planState: { live_mcp: [] } }).declared, false);
});

test("declared but empty -> blocks listing every required intent field", () => {
  const result = buildLiveMcpLifecycle({ planState: { live_mcp: {} } });
  assert.equal(result.declared, true);
  assert.deepEqual(codes(result), [
    "live_mcp_operation_class",
    "live_mcp_adapter",
    "live_mcp_operation",
    "live_mcp_environment",
    "live_mcp_scope",
    "live_mcp_receipt",
  ]);
});

test("unsupported operation_class fails closed", () => {
  const result = buildLiveMcpLifecycle({
    planState: { live_mcp: { ...FULL_SENSITIVE, operation_class: "bogus" } },
  });
  assert.ok(codes(result).includes("live_mcp_operation_class"));
});

test("read_sensitive with full evidence -> ready (no issues)", () => {
  const result = buildLiveMcpLifecycle({ planState: { live_mcp: FULL_SENSITIVE } });
  assert.equal(result.declared, true);
  assert.deepEqual(result.issues, []);
});

test("read_sensitive requires redaction evidence", () => {
  const { redaction, ...noRedaction } = FULL_SENSITIVE;
  const result = buildLiveMcpLifecycle({ planState: { live_mcp: noRedaction } });
  assert.ok(codes(result).includes("live_mcp_redaction"));
});

test("write_prod and destructive require approval evidence", () => {
  for (const operationClass of ["write_prod", "destructive"]) {
    const result = buildLiveMcpLifecycle({
      planState: {
        live_mcp: {
          adapter: "a",
          operation: "o",
          operation_class: operationClass,
          environment: "prod",
          scope: "s",
          redaction: "summary",
          cleanup: "task stopped + sg revoked",
          receipt_path: "p",
        },
      },
    });
    assert.ok(codes(result).includes("live_mcp_approval"), `${operationClass} should require approval`);
  }
});

test("write_prod policy requires cleanup completion", () => {
  const result = buildLiveMcpLifecycle({
    planState: {
      live_mcp: {
        adapter: "a",
        operation: "o",
        operation_class: "write_prod",
        environment: "prod",
        scope: "s",
        redaction: "summary",
        approval: "human",
        receipt_path: "p",
      },
    },
  });
  assert.ok(codes(result).includes("live_mcp_cleanup"));
});

test("explicit cleanup_required=true blocks on a class whose policy does not force cleanup", () => {
  const result = buildLiveMcpLifecycle({
    planState: {
      live_mcp: {
        adapter: "a",
        operation: "o",
        operation_class: "read_safe",
        environment: "prod",
        scope: "s",
        receipt_path: "p",
        cleanup_required: true,
      },
    },
  });
  assert.ok(codes(result).includes("live_mcp_cleanup"));
  // and supplying cleanup evidence clears it
  const ok = buildLiveMcpLifecycle({
    planState: {
      live_mcp: {
        adapter: "a",
        operation: "o",
        operation_class: "read_safe",
        environment: "prod",
        scope: "s",
        receipt_path: "p",
        cleanup_required: true,
        cleanup: "debug task stopped",
      },
    },
  });
  assert.deepEqual(ok.issues, []);
});

test("product-impacting finding requires fixture/test/spec promotion evidence", () => {
  const result = buildLiveMcpLifecycle({
    planState: {
      live_mcp: {
        adapter: "a",
        operation: "o",
        operation_class: "read_safe",
        environment: "prod",
        scope: "s",
        receipt_path: "p",
        product_impact: true,
      },
    },
  });
  assert.ok(codes(result).includes("live_mcp_promotion"));
});

test("embedded receipt satisfies receipt requirement and is structurally validated", () => {
  const ok = buildLiveMcpLifecycle({
    planState: {
      live_mcp: {
        adapter: "a",
        operation: "o",
        operation_class: "read_safe",
        environment: "local",
        scope: "s",
        receipt: {
          ticket: "COORD-200",
          adapter: "a",
          operation_class: "read_safe",
          operation: "o",
          scope: "s",
          result: "observed",
          evidence: ["coord/evidence/live-mcp/x.json"],
        },
      },
    },
  });
  assert.deepEqual(ok.issues, []);

  const bad = buildLiveMcpLifecycle({
    planState: {
      live_mcp: {
        adapter: "a",
        operation: "o",
        operation_class: "read_safe",
        environment: "local",
        scope: "s",
        receipt: { ticket: "COORD-200" },
      },
    },
  });
  assert.ok(codes(bad).includes("live_mcp_receipt_invalid"));
});

test("every issue carries a remediation next_step (never throws)", () => {
  const result = buildLiveMcpLifecycle({ planState: { live_mcp: {} } });
  for (const issue of result.issues) {
    assert.ok(Array.isArray(issue.next_steps) && issue.next_steps.length > 0);
    assert.ok(issue.message && issue.message.length > 0);
  }
});
