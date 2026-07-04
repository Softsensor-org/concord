const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const mcp = require("./governance-mcp.js");

// COORD-090: facade→module relocation. The governance MCP behavior tests below
// were moved here from governance.test.js (which now keeps facade-level
// contracts only). They drive the MCP module's own __testing surface.
const { __testing: mcpTesting } = mcp;
const pathsModule = require("../paths.js");
const { allBoardRepoCodes } = pathsModule;

// GCV-1 O3 (SETTLED): the long-lived MCP server cannot prove the calling
// conversation's live identity per call, so under identity v2 the MCP
// write surface is interim read-only — mutating tools fail closed at the
// dispatch chokepoint. These tests assert the set of tools that must be
// gated; the actual fail-closed dispatch is exercised in CI through the
// MCP protocol harness.

test("GCV-1 O3: MUTATING_TOOLS gates the lifecycle write surface", () => {
  // The named, reviewer-flagged lifecycle mutators must be present.
  const lifecycle = ["gov_claim", "gov_start", "gov_commit", "gov_submit", "gov_land"];
  for (const t of lifecycle) {
    assert.ok(mcp.MUTATING_TOOLS.has(t), `MUTATING_TOOLS must gate ${t}`);
  }
  // Additional v2-mutating tools also gated (state-changing / authority).
  const otherMutators = [
    "gov_resume",
    "gov_heartbeat",
    "gov_finalize",
    "gov_supersede",
    "gov_update_plan",
    "gov_live_mcp_record",
    "gov_bootstrap_record",
    "gov_deploy_record",
    "gov_verify_runtime",
    "gov_falsify",
    "gov_recover",
    "gov_reconcile",
    "gov_open_followup",
    "gov_agent_rebind",
    "gov_rebuild_board",
  ];
  for (const t of otherMutators) {
    assert.ok(mcp.MUTATING_TOOLS.has(t), `MUTATING_TOOLS should gate ${t}`);
  }
});

test("GCV-1 O3: read-only / inspection tools are NOT in MUTATING_TOOLS", () => {
  const readOnly = [
    "gov_initiate",
    "gov_counts",
    "gov_ticket",
    "gov_explain",
    "gov_doctor",
    "gov_pick",
    "gov_recent",
    "gov_agent_status",
    "gov_orch",
    "gov_gate", // verification-only; produces an artifact, no governed-state mutation
    "gov_live_mcp_policy",
    "gov_deploy_check",
    "gov_validate_receipt",
  ];
  for (const t of readOnly) {
    assert.equal(
      mcp.MUTATING_TOOLS.has(t),
      false,
      `MUTATING_TOOLS must NOT gate read/inspection tool ${t}`
    );
  }
});

test("production/runtime MCP tools map to governed CLI receipt verbs", () => {
  const calls = [];
  mcpTesting.setRunGovImplForTesting((args, options) => {
    calls.push({ args, options });
    return { ok: true, text: "ok" };
  });
  try {
    assert.ok(mcpTesting.TOOLS.gov_live_mcp_policy);
    assert.ok(mcpTesting.TOOLS.gov_live_mcp_record);
    assert.ok(mcpTesting.TOOLS.gov_bootstrap_record);
    assert.ok(mcpTesting.TOOLS.gov_deploy_record);
    assert.ok(mcpTesting.TOOLS.gov_deploy_check);
    assert.ok(mcpTesting.TOOLS.gov_verify_runtime);
    assert.ok(mcpTesting.TOOLS.gov_falsify);
    assert.ok(mcpTesting.TOOLS.gov_validate_receipt);

    mcpTesting.TOOLS.gov_deploy_check.handler({ ticket: "DEP-001", json: true });
    mcpTesting.TOOLS.gov_validate_receipt.handler({ receipt: "coord/evidence/deployment/x.json" });
    mcpTesting.TOOLS.gov_live_mcp_record.handler({
      ticket: "LIVE-001",
      operationClass: "read_safe",
      adapter: "case-readonly",
      operation: "get_case",
      scope: "case_id=abc",
      evidence: ["mcp receipt"],
      result: "observed",
    });

    assert.deepEqual(calls[0], {
      args: ["deploy-check", "DEP-001", "--json"],
      options: { captureJson: true },
    });
    assert.deepEqual(calls[1], {
      args: ["validate-receipt", "--receipt", "coord/evidence/deployment/x.json"],
      options: { captureJson: false },
    });
    assert.deepEqual(calls[2], {
      args: [
        "live-mcp-record",
        "LIVE-001",
        "--class",
        "read_safe",
        "--adapter",
        "case-readonly",
        "--operation",
        "get_case",
        "--scope",
        "case_id=abc",
        "--receipt-result",
        "observed",
        "--evidence",
        "mcp receipt",
      ],
      options: { captureJson: false },
    });
  } finally {
    mcpTesting.resetRunGovImplForTesting();
  }
});

test("GCV-1 O3: gov_doctor with {fix:true} is treated as a mutation (no name-only bypass)", () => {
  assert.equal(mcp.isMutatingCall("gov_doctor", { fix: true }), true);
  assert.equal(mcp.isMutatingCall("gov_doctor", { fix: false }), false);
  assert.equal(mcp.isMutatingCall("gov_doctor", {}), false);
  assert.equal(mcp.isMutatingCall("gov_doctor", undefined), false);
});

test("GCV-1 O3: gov_orch with {fix:true} is treated as a mutation", () => {
  assert.equal(mcp.isMutatingCall("gov_orch", { fix: true }), true);
  assert.equal(mcp.isMutatingCall("gov_orch", { fix: false }), false);
  assert.equal(mcp.isMutatingCall("gov_orch", {}), false);
});

test("GCV-1 O3: name-only mutators stay gated regardless of args", () => {
  assert.equal(mcp.isMutatingCall("gov_start", {}), true);
  assert.equal(mcp.isMutatingCall("gov_commit", { ticket: "X-1" }), true);
  assert.equal(mcp.isMutatingCall("gov_land", { ticket: "X-1" }), true);
});

test("GCV-1 O3: pure read tools stay un-gated even with stray flags", () => {
  // The predicate is positive-list only — a stray fix:true on a tool we
  // have not registered as conditional must not flip its gating.
  assert.equal(mcp.isMutatingCall("gov_counts", { fix: true }), false);
  assert.equal(mcp.isMutatingCall("gov_ticket", { ticket: "X-1" }), false);
  assert.equal(mcp.isMutatingCall("gov_pick", { mode: "general" }), false);
});

// ---------------------------------------------------------------------------
// COORD-090: relocated from governance.test.js (governance MCP module behavior)
// ---------------------------------------------------------------------------

test("governance-mcp gov_open_followup derives its repo enum from allBoardRepoCodes (no hardcoded letters)", () => {
  const repoEnum = mcpTesting.TOOLS.gov_open_followup.inputSchema.properties.repo.enum;
  assert.deepEqual(repoEnum, allBoardRepoCodes());
});

test("governance-mcp gov_open_followup rejects the 'independent' relation (matching the core rule)", () => {
  const relationEnum = mcpTesting.TOOLS.gov_open_followup.inputSchema.properties.relation.enum;
  assert.ok(!relationEnum.includes("independent"),
    "gov_open_followup relation enum must not advertise 'independent' since the core rejects it there");
  assert.deepEqual(relationEnum.slice().sort(), ["blocking", "closeout-blocker", "related"]);
});

test("governance-mcp gov_set_followup_relation exposes all four core relations including 'independent'", () => {
  const tool = mcpTesting.TOOLS.gov_set_followup_relation;
  assert.ok(tool, "gov_set_followup_relation MCP tool must exist");
  const relationEnum = tool.inputSchema.properties.relation.enum;
  assert.deepEqual(relationEnum.slice().sort(), ["blocking", "closeout-blocker", "independent", "related"]);
});

test("governance-mcp FOLLOWUP_RELATIONS is FOLLOWUP_OPEN_RELATIONS plus 'independent'", () => {
  const openOnly = new Set(mcpTesting.FOLLOWUP_OPEN_RELATIONS);
  for (const relation of mcpTesting.FOLLOWUP_RELATIONS) {
    assert.ok(
      openOnly.has(relation) || relation === "independent",
      `unexpected relation "${relation}" — FOLLOWUP_RELATIONS must be FOLLOWUP_OPEN_RELATIONS plus 'independent'`,
    );
  }
  assert.ok(mcpTesting.FOLLOWUP_RELATIONS.includes("independent"));
});

test("openFollowup accepts any repo code returned by allBoardRepoCodes (no stale enum drift)", () => {
  const canonical = new Set(allBoardRepoCodes());
  assert.ok(canonical.has("X"), "allBoardRepoCodes must include the reserved coord/cross-repo X code");
  for (const code of Object.keys(pathsModule.createCoordPaths().repoRoots)) {
    assert.ok(canonical.has(code), `allBoardRepoCodes must include configured repo "${code}"`);
  }
});

test("governance-mcp buildRunGovEnv promotes GOVERNANCE_MCP_THREAD_ID into AGENT_THREAD_ID", () => {
  const env = mcpTesting.buildRunGovEnv({ GOVERNANCE_MCP_THREAD_ID: "mcp-thread-abc" });
  assert.equal(env.AGENT_THREAD_ID, "mcp-thread-abc");
  assert.equal(env.GOVERNANCE_MCP_CALLER, "true");
});

test("governance-mcp buildRunGovEnv overrides an inherited AGENT_THREAD_ID when MCP caller declares one", () => {
  const env = mcpTesting.buildRunGovEnv({
    GOVERNANCE_MCP_THREAD_ID: "mcp-thread-abc",
    AGENT_THREAD_ID: "ambient-thread-old",
  });
  assert.equal(env.AGENT_THREAD_ID, "mcp-thread-abc");
});

test("governance-mcp buildRunGovEnv leaves AGENT_THREAD_ID untouched when GOVERNANCE_MCP_THREAD_ID is absent", () => {
  const env = mcpTesting.buildRunGovEnv({ AGENT_THREAD_ID: "ambient-thread-xyz" });
  assert.equal(env.AGENT_THREAD_ID, "ambient-thread-xyz");
  assert.equal(env.GOVERNANCE_MCP_CALLER, "true");
});

test("governance-mcp buildRunGovEnv is a no-op on thread env when neither var is set", () => {
  const env = mcpTesting.buildRunGovEnv({ SOMETHING_ELSE: "1" });
  assert.equal(env.AGENT_THREAD_ID, undefined);
  assert.equal(env.GOVERNANCE_MCP_CALLER, "true");
  assert.equal(env.SOMETHING_ELSE, "1");
});

test("governance-mcp buildRunGovEnv accepts an explicit caller thread id argument", () => {
  const env = mcpTesting.buildRunGovEnv({}, "explicit-thread-id");
  assert.equal(env.AGENT_THREAD_ID, "explicit-thread-id");
});

test("governance-mcp defaultRunGov delegates to governance.executeCommand with MCP env and repo-root cwd", () => {
  const calls = [];
  const previousThreadId = process.env.GOVERNANCE_MCP_THREAD_ID;
  process.env.GOVERNANCE_MCP_THREAD_ID = "mcp-thread-abc";
  mcpTesting.setExecuteGovCommandImplForTesting((args, options) => {
    calls.push({ args, options });
    return {
      ok: true,
      stdout: JSON.stringify({ status: "doing", owner: "codexa41" }),
      stderr: "",
    };
  });
  try {
    const response = mcpTesting.defaultRunGov(["ticket", "GOV-055"]);
    assert.equal(response.ok, true);
    assert.deepEqual(response.data, { status: "doing", owner: "codexa41" });
    assert.deepEqual(calls, [{
      args: ["ticket", "GOV-055"],
      options: {
        cwd: path.resolve(__dirname, "..", ".."),
        env: mcpTesting.buildRunGovEnv(),
      },
    }]);
  } finally {
    if (previousThreadId === undefined) {
      delete process.env.GOVERNANCE_MCP_THREAD_ID;
    } else {
      process.env.GOVERNANCE_MCP_THREAD_ID = previousThreadId;
    }
    mcpTesting.resetExecuteGovCommandImplForTesting();
  }
});

test("governance-mcp gov_commit schema matches the governed CLI commit contract", () => {
  const tool = mcpTesting.TOOLS.gov_commit;
  assert.ok(tool, "gov_commit MCP tool must exist");
  assert.match(
    tool.inputSchema.properties.message.description,
    /must already include the ticket ID prefix/i,
    "gov_commit must not claim the ticket ID is auto-prefixed"
  );
  assert.equal(tool.inputSchema.properties.all.type, "boolean");
  assert.equal(tool.inputSchema.properties.files.type, "array");
  assert.equal(tool.inputSchema.properties.files.items.type, "string");
});

test("governance-mcp gov_commit forwards --all and repeated --files to the core CLI bridge", () => {
  const calls = [];
  mcpTesting.setRunGovImplForTesting((args, options) => {
    calls.push({ args, options });
    return { ok: true, text: "committed" };
  });
  try {
    const response = mcpTesting.TOOLS.gov_commit.handler({
      ticket: "GOV-054",
      message: "GOV-054 tighten MCP regression coverage",
      all: true,
      files: ["coord/scripts/governance-mcp.js", "coord/scripts/governance.test.js"],
    });
    assert.equal(response.ok, true);
    assert.deepEqual(calls, [{
      args: [
        "commit",
        "GOV-054",
        "--message",
        "GOV-054 tighten MCP regression coverage",
        "--all",
        "--files",
        "coord/scripts/governance-mcp.js",
        "--files",
        "coord/scripts/governance.test.js",
      ],
      options: { captureJson: false },
    }]);
  } finally {
    mcpTesting.resetRunGovImplForTesting();
  }
});

test("governance-mcp content-length parser reconstructs split and coalesced MCP frames", () => {
  const messages = [];
  const parser = mcpTesting.createContentLengthMessageParser({
    onMessage(message) {
      messages.push(message);
    },
  });
  const first = mcpTesting.encodeStdioMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  const second = mcpTesting.encodeStdioMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  const combined = Buffer.concat([first, second]);

  parser.push(combined.subarray(0, 19));
  parser.push(combined.subarray(19, combined.length - 11));
  parser.push(combined.subarray(combined.length - 11));

  assert.deepEqual(
    messages.map((message) => ({ id: message.id, method: message.method })),
    [
      { id: 1, method: "initialize" },
      { id: 2, method: "tools/list" },
    ]
  );
});

test("governance-mcp interoperates with standard framed initialize and tools/list requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const heartbeatCalls = [];
  const outputChunks = [];
  output.on("data", (chunk) => {
    outputChunks.push(chunk);
  });

  mcpTesting.startStdioTransport({
    input,
    output,
    ensureHeartbeatLoopFn() {
      heartbeatCalls.push("start");
    },
    stopHeartbeatLoopFn() {
      heartbeatCalls.push("stop");
    },
    transportKeepAlive: setInterval(() => {}, 60_000),
  });

  input.write(
    mcpTesting.encodeStdioMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "governance-test-client", version: "1.0.0" },
      },
    })
  );
  input.write(mcpTesting.encodeStdioMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
  input.end(
    mcpTesting.encodeStdioMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })
  );

  await new Promise((resolve) => setImmediate(resolve));

  const responses = [];
  let parseError = null;
  const parser = mcpTesting.createContentLengthMessageParser({
    onMessage(message) {
      responses.push(message);
    },
    onError(error) {
      parseError = error;
    },
  });
  parser.push(Buffer.concat(outputChunks));

  assert.equal(parseError, null, `could not parse governance-mcp stdout: ${parseError?.message || parseError}`);
  assert.equal(responses.length, 2, "notifications/initialized should not emit a response frame");
  assert.deepEqual(heartbeatCalls, ["start", "stop"]);

  const [initializeResponse, listResponse] = responses;
  assert.equal(initializeResponse.jsonrpc, "2.0");
  assert.equal(initializeResponse.id, 1);
  assert.equal(initializeResponse.result.protocolVersion, "2024-11-05");
  assert.equal(initializeResponse.result.serverInfo.name, "governance");
  assert.equal(listResponse.jsonrpc, "2.0");
  assert.equal(listResponse.id, 2);
  assert.ok(Array.isArray(listResponse.result.tools));
  assert.ok(
    listResponse.result.tools.some((tool) => tool.name === "gov_ticket"),
    "expected tools/list to advertise the governance tool catalog"
  );
});

// GOV-058 — machine-readable governance MCP results
test("governance-mcp buildSuccessResponse emits structuredContent when the CLI returned JSON", () => {
  const response = mcpTesting.buildSuccessResponse({ ok: true, data: { status: "doing", owner: "claudea11" } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, { status: "doing", owner: "claudea11" });
  assert.equal(response.content[0].type, "text");
  assert.equal(JSON.parse(response.content[0].text).status, "doing");
});

test("governance-mcp buildSuccessResponse wraps plain text under structuredContent.text for text-only tools", () => {
  const response = mcpTesting.buildSuccessResponse({ ok: true, text: "Governance doctor OK" });
  assert.equal(response.isError, undefined);
  assert.deepEqual(response.structuredContent, { text: "Governance doctor OK" });
  assert.equal(response.content[0].text, "Governance doctor OK");
});

test("governance-mcp buildSuccessResponse falls back to OK when neither data nor text is present", () => {
  const response = mcpTesting.buildSuccessResponse({ ok: true });
  assert.deepEqual(response.structuredContent, { text: "OK" });
  assert.equal(response.content[0].text, "OK");
});

test("governance-mcp buildErrorResponse carries a typed code plus the human message", () => {
  const response = mcpTesting.buildErrorResponse({
    code: mcpTesting.ERROR_CODES.INVALID_ARGUMENTS,
    message: 'Missing required argument: "ticket"',
    details: { tool: "gov_ticket" },
  });
  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, 'Missing required argument: "ticket"');
  assert.deepEqual(response.structuredContent, {
    error: {
      code: "invalid_arguments",
      message: 'Missing required argument: "ticket"',
      details: { tool: "gov_ticket" },
    },
  });
});

test("governance-mcp buildStructuredError omits details when none are provided", () => {
  const structured = mcpTesting.buildStructuredError({ code: "handler_error", message: "boom" });
  assert.deepEqual(structured, { error: { code: "handler_error", message: "boom" } });
  assert.ok(!("details" in structured.error));
});

test("governance-mcp handleRequest tools/call unknown-tool path returns typed error shape", () => {
  const response = mcpTesting.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "gov_no_such_tool", arguments: {} },
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, "unknown_tool");
  assert.equal(response.structuredContent.error.details.tool, "gov_no_such_tool");
  assert.match(response.content[0].text, /Unknown tool/);
});

test("governance-mcp handleRequest tools/call argument validation returns invalid_arguments code", () => {
  const response = mcpTesting.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "gov_ticket", arguments: {} },
  });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, "invalid_arguments");
  assert.equal(response.structuredContent.error.details.tool, "gov_ticket");
  assert.match(response.structuredContent.error.message, /Missing required argument.*ticket/);
});

test("governance-mcp handleRequest tools/list exposes outputSchema for every tool", () => {
  const response = mcpTesting.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.ok(Array.isArray(response.tools) && response.tools.length > 0);
  for (const tool of response.tools) {
    assert.ok(tool.outputSchema, `tool ${tool.name} is missing outputSchema in tools/list`);
    assert.equal(tool.outputSchema.type, "object", `tool ${tool.name} outputSchema type must be object`);
  }
});

test("governance-mcp handleRequest tools/call plumbs handler errors into handler_error code", () => {
  const originalTool = mcpTesting.TOOLS.gov_counts;
  mcpTesting.TOOLS.gov_counts = {
    ...originalTool,
    handler: () => ({ ok: false, error: "synthetic handler failure" }),
  };
  try {
    const response = mcpTesting.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gov_counts", arguments: {} },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, "handler_error");
    assert.equal(response.structuredContent.error.message, "synthetic handler failure");
    assert.equal(response.structuredContent.error.details.tool, "gov_counts");
    assert.equal(response.content[0].text, "synthetic handler failure");
  } finally {
    mcpTesting.TOOLS.gov_counts = originalTool;
  }
});

test("governance-mcp handleRequest tools/call success path routes JSON data into structuredContent", () => {
  const originalTool = mcpTesting.TOOLS.gov_ticket;
  mcpTesting.TOOLS.gov_ticket = {
    ...originalTool,
    handler: () => ({ ok: true, data: { ID: "GOV-058", Status: "doing", Owner: "claudea11" } }),
  };
  try {
    const response = mcpTesting.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gov_ticket", arguments: { ticket: "GOV-058" } },
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent, {
      ID: "GOV-058",
      Status: "doing",
      Owner: "claudea11",
    });
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.Status, "doing");
  } finally {
    mcpTesting.TOOLS.gov_ticket = originalTool;
  }
});

test("governance-mcp handleRequest tools/call success path wraps text-only handlers under structuredContent.text", () => {
  const originalTool = mcpTesting.TOOLS.gov_counts;
  mcpTesting.TOOLS.gov_counts = {
    ...originalTool,
    handler: () => ({ ok: true, text: "Board: ...\nTickets: 75" }),
  };
  try {
    const response = mcpTesting.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "gov_counts", arguments: {} },
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent, { text: "Board: ...\nTickets: 75" });
    assert.equal(response.content[0].text, "Board: ...\nTickets: 75");
  } finally {
    mcpTesting.TOOLS.gov_counts = originalTool;
  }
});
