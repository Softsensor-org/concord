"use strict";

// COORD-155: tests for the temporary-access / AWS ECS cleanup-receipt adapter
// reference. SYNTHETIC INPUTS ONLY — no real AWS calls, no real credentials, no
// real account ids or resource ARNs, no network. Tests prove:
//   1. a temp-access grant produces a receipt recording resource/task id +
//      timeout + revoke command (and validates via COORD-152 when complete);
//   2. cleanup-PENDING => closeout blocked (COORD-153 reuse, not a parallel gate);
//   3. cleanup-COMPLETE (stop/revoke evidence + timestamp) => closeout ready;
//   4. cleanup-FAILED => closeout blocked + failure state recorded;
//   5. a "completed" claim missing stop-evidence or timestamp is downgraded to
//      failed (cannot masquerade as done);
//   6. grants missing a resource id / timeout / revoke command are refused;
//   7. committed reference source carries no real-credential / ARN patterns.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const adapter = require("./adapters/temp-access-cleanup-reference.js");
const { validateLiveMcpReceipt } = require("./runtime-evidence.js");
const { buildLiveMcpLifecycle } = require("./live-mcp-lifecycle.js");

// A synthetic ECS debug-task grant as a real adopter executor MIGHT shape it.
// The identifiers below are FAKE and exist only to prove traceability + redaction.
function syntheticGrant() {
  return {
    access_type: "ecs-debug-task",
    task_arn: "arn:aws:ecs:synthetic:000000000000:task/cluster/deadbeef", // FAKE
    timeout: "900s",
    revoke_command: "aws ecs stop-task --task <task>",
    started_at: "2026-06-24T00:00:00.000Z",
    token_ref: "should-never-leak-token-value",
  };
}

const APPROVAL = "human:alice approved one-off debug task";

function completedCleanup() {
  return {
    state: "completed",
    stop_evidence: "ecs:task STOPPED (exitCode=0), security-group ingress rule revoked",
    cleaned_at: "2026-06-24T00:12:00.000Z",
  };
}

// Helper: run the COORD-153 lifecycle gate against the declaration the adapter
// emits, exactly as governance-validation.js does at move-review/closeout.
function gate(liveMcpDeclaration) {
  return buildLiveMcpLifecycle({ planState: { live_mcp: liveMcpDeclaration } });
}

test("temp-access grant produces a receipt with resource/task id + timeout + revoke command", () => {
  const { receipt, evidence, grant } = adapter.recordTempAccess({
    ticket: "COORD-155",
    grant: syntheticGrant(),
    cleanup: completedCleanup(),
    approval: APPROVAL,
  });

  assert.equal(receipt.ticket, "COORD-155");
  assert.equal(receipt.operation_class, "write_prod");
  assert.equal(grant.resource_id, "arn:aws:ecs:synthetic:000000000000:task/cluster/deadbeef");
  assert.equal(receipt.temp_access.timeout, "900s");
  assert.equal(receipt.temp_access.resource_id, grant.resource_id);
  assert.equal(receipt.temp_access.revoke_command, "aws ecs stop-task --task <task>");
  // Compact evidence carries the identifiers + timeout.
  assert.equal(evidence.resource_id, grant.resource_id);
  assert.equal(evidence.timeout, "900s");
  // Token reference is masked — raw value never present anywhere.
  assert.ok(!JSON.stringify({ receipt, evidence }).includes("should-never-leak-token-value"));
  assert.match(receipt.temp_access.cleanup_state, /completed/);
});

test("cleanup-COMPLETE (stop/revoke evidence + timestamp) => receipt valid + closeout READY", () => {
  const { receipt, closeoutReady, liveMcpDeclaration } = adapter.recordTempAccess({
    ticket: "COORD-155",
    grant: syntheticGrant(),
    cleanup: completedCleanup(),
    approval: APPROVAL,
  });

  // Receipt validates against the COORD-152 substrate (cleanup field populated).
  assert.doesNotThrow(() => validateLiveMcpReceipt(receipt));
  assert.ok(receipt.cleanup && /cleaned_at=/.test(receipt.cleanup), "cleanup proof + timestamp present");
  assert.equal(closeoutReady, true);

  // COORD-153 gate: a complete cleanup is NOT blocked.
  const result = gate(liveMcpDeclaration);
  assert.equal(result.declared, true);
  assert.deepEqual(result.issues, [], "no closeout blockers when cleanup complete");
});

test("cleanup-PENDING => closeout BLOCKED via COORD-153 (reuse, not a parallel gate)", () => {
  const { closeoutReady, liveMcpDeclaration, receipt } = adapter.recordTempAccess({
    ticket: "COORD-155",
    grant: syntheticGrant(),
    cleanup: { state: "pending" },
    approval: APPROVAL,
  });

  // Cleanup field absent => COORD-152 cleanup proof not present.
  assert.equal(receipt.cleanup, null);
  assert.equal(closeoutReady, false);
  assert.equal(liveMcpDeclaration.cleanup, undefined, "no cleanup proof embedded while pending");
  assert.equal(liveMcpDeclaration.cleanup_required, true, "cleanup requirement armed");

  // COORD-153 gate BLOCKS: it must surface a cleanup-related blocker.
  const result = gate(liveMcpDeclaration);
  assert.equal(result.declared, true);
  assert.ok(result.issues.length > 0, "pending cleanup must block closeout");
  assert.ok(
    result.issues.some((i) => /cleanup/i.test(i.code) || /cleanup/i.test(i.message)),
    "blocker must be cleanup-related"
  );
});

test("cleanup-FAILED => closeout BLOCKED + failure state recorded", () => {
  const { closeoutReady, liveMcpDeclaration, receipt, cleanup } = adapter.recordTempAccess({
    ticket: "COORD-155",
    grant: syntheticGrant(),
    cleanup: { state: "failed", failure_reason: "stop-task call timed out; task still RUNNING" },
    approval: APPROVAL,
  });

  // Failure state explicitly recorded on the receipt.
  assert.equal(cleanup.state, "failed");
  assert.equal(receipt.temp_access.failure_state, "stop-task call timed out; task still RUNNING");
  assert.equal(receipt.result, "fail");
  assert.equal(receipt.cleanup, null, "no cleanup completion proof on failure");
  assert.equal(closeoutReady, false);

  // COORD-153 gate BLOCKS.
  const result = gate(liveMcpDeclaration);
  assert.ok(result.issues.length > 0, "failed cleanup must block closeout");
});

test('a "completed" cleanup missing stop-evidence or timestamp is downgraded to FAILED', () => {
  // Missing timestamp.
  const noTs = adapter.recordTempAccess({
    ticket: "COORD-155",
    grant: syntheticGrant(),
    cleanup: { state: "completed", stop_evidence: "task stopped" },
    approval: APPROVAL,
  });
  assert.equal(noTs.cleanup.state, "failed");
  assert.match(noTs.cleanup.failure_reason, /cleanup timestamp/);
  assert.equal(noTs.closeoutReady, false);

  // Missing stop evidence.
  const noEvidence = adapter.recordTempAccess({
    ticket: "COORD-155",
    grant: syntheticGrant(),
    cleanup: { state: "completed", cleaned_at: "2026-06-24T00:12:00.000Z" },
    approval: APPROVAL,
  });
  assert.equal(noEvidence.cleanup.state, "failed");
  assert.match(noEvidence.cleanup.failure_reason, /stop\/revoke evidence/);
  assert.equal(noEvidence.closeoutReady, false);
});

test("grant missing resource id / timeout / revoke command is refused", () => {
  const base = syntheticGrant();
  assert.throws(
    () => adapter.recordTempAccess({ ticket: "COORD-155", grant: { ...base, task_arn: undefined } }),
    /resource\/task identifier/
  );
  assert.throws(
    () => adapter.recordTempAccess({ ticket: "COORD-155", grant: { ...base, timeout: undefined } }),
    /timeout/
  );
  assert.throws(
    () => adapter.recordTempAccess({ ticket: "COORD-155", grant: { ...base, revoke_command: undefined } }),
    /stop\/revoke command/
  );
});

test("requires a governing ticket and a cleanup-bearing operation class", () => {
  assert.throws(() => adapter.recordTempAccess({ grant: syntheticGrant() }), /governing ticket/);
  assert.throws(
    () =>
      adapter.recordTempAccess({
        ticket: "COORD-155",
        operationClass: "read_safe",
        grant: syntheticGrant(),
      }),
    /cleanup-bearing operation_class/
  );
});

test("port / security-group / role / token grants are all traceable", () => {
  const port = adapter.recordTempAccess({
    ticket: "COORD-155",
    grant: { port: 9229, timeout: "600s", revoke_command: "close debug port 9229" },
    cleanup: completedCleanup(),
    approval: APPROVAL,
  });
  assert.equal(port.grant.resource_id, "port:9229");

  const sg = adapter.recordTempAccess({
    ticket: "COORD-155",
    grant: { security_group_rule_id: "sgr-synthetic", timeout: "600s", revoke_command: "revoke-security-group-ingress" },
    cleanup: completedCleanup(),
    approval: APPROVAL,
  });
  assert.equal(sg.grant.resource_id, "sgr-synthetic");
});

test("committed reference source contains no real-credential / ARN / endpoint patterns", () => {
  const files = [
    path.join(__dirname, "adapters", "temp-access-cleanup-reference.js"),
    __filename,
  ];
  const forbidden = [
    /AKIA[0-9A-Z]{16}/, // AWS access key id
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // private key block
    /\bpassword\s*[:=]\s*["'][^"']+["']/i, // hard-coded password literal
    /\bBearer\s+[A-Za-z0-9._-]{20,}/, // bearer token
    /arn:aws:[a-z0-9-]+:[a-z0-9-]+:[1-9][0-9]{11}:/i, // real (non-zero) AWS account ARN
    /https?:\/\/(?!.*(example|localhost|test))[a-z0-9.-]+\.(com|net|io|aws)\b/i, // real endpoint
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${path.basename(file)} matched forbidden pattern ${pattern}`);
    }
  }
});
