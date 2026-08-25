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

// COORD-482 — the stdio transport is newline-delimited UTF-8 JSON-RPC per the
// MCP stdio spec (2025-11-25 basic/transports). LSP-style Content-Length
// framing was removed; these tests pin the spec-compliant behavior.

test("governance-mcp encodeStdioMessage emits one JSON line terminated by a single newline (no Content-Length header)", () => {
  const encoded = mcpTesting.encodeStdioMessage({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  const text = encoded.toString("utf8");
  assert.ok(text.endsWith("\n"), "record must be newline-terminated");
  assert.equal(text.indexOf("\n"), text.length - 1, "record must contain exactly one newline, at the end");
  assert.ok(!/content-length/i.test(text), "no Content-Length framing in standard mode");
  assert.deepEqual(JSON.parse(text), { jsonrpc: "2.0", id: 7, method: "tools/list" });
});

test("governance-mcp encodeStdioMessage escapes embedded newlines so a record is always a single line", () => {
  const encoded = mcpTesting.encodeStdioMessage({ jsonrpc: "2.0", id: 8, result: { text: "line one\nline two" } });
  const text = encoded.toString("utf8");
  assert.equal(text.indexOf("\n"), text.length - 1);
  assert.equal(JSON.parse(text).result.text, "line one\nline two");
});

test("governance-mcp newline parser reconstructs split and coalesced MCP messages", () => {
  const messages = [];
  const parser = mcpTesting.createNewlineMessageParser({
    onMessage(message) {
      messages.push(message);
    },
  });
  const first = mcpTesting.encodeStdioMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  });
  const second = mcpTesting.encodeStdioMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  const combined = Buffer.concat([first, second]);

  // Split mid-message, then deliver the remainder coalesced with message two.
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

test("governance-mcp newline parser survives chunk splits inside multi-byte UTF-8 sequences", () => {
  const messages = [];
  const parser = mcpTesting.createNewlineMessageParser({
    onMessage(message) {
      messages.push(message);
    },
  });
  const encoded = mcpTesting.encodeStdioMessage({ jsonrpc: "2.0", id: 3, params: { note: "ç → 日本語 ✓" } });
  // Push byte-by-byte: every multi-byte code point gets split across pushes.
  for (let i = 0; i < encoded.length; i += 1) {
    parser.push(encoded.subarray(i, i + 1));
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].params.note, "ç → 日本語 ✓");
});

test("governance-mcp newline parser accepts \\r\\n line endings and skips blank lines", () => {
  const messages = [];
  const errors = [];
  const parser = mcpTesting.createNewlineMessageParser({
    onMessage(message) {
      messages.push(message);
    },
    onError(error) {
      errors.push(error);
    },
  });
  parser.push(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\r\n\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n', "utf8"));
  assert.deepEqual(errors, []);
  assert.deepEqual(messages.map((m) => m.id), [1, 2]);
});

test("governance-mcp newline parser reports a malformed line and recovers on the next valid message", () => {
  const messages = [];
  const errors = [];
  const parser = mcpTesting.createNewlineMessageParser({
    onMessage(message) {
      messages.push(message);
    },
    onError(error) {
      errors.push(error);
    },
  });
  parser.push(Buffer.from('this is not json\n{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n', "utf8"));
  assert.equal(errors.length, 1, "malformed line must produce exactly one parse error");
  assert.equal(errors[0].code, -32700);
  assert.deepEqual(messages.map((m) => ({ id: m.id, method: m.method })), [{ id: 9, method: "tools/list" }]);
});

test("governance-mcp newline parser fails a runaway unterminated line instead of buffering without bound", () => {
  const errors = [];
  const parser = mcpTesting.createNewlineMessageParser({
    maxPendingBytes: 64,
    onError(error) {
      errors.push(error);
    },
  });
  parser.push(Buffer.from("x".repeat(100), "utf8"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, -32700);
  assert.match(errors[0].message, /without a newline/);
});

test("governance-mcp negotiates the client's protocol revision when supported, else answers with the latest", () => {
  for (const version of mcpTesting.SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(mcpTesting.negotiateProtocolVersion(version), version);
  }
  assert.equal(mcpTesting.negotiateProtocolVersion("1999-01-01"), mcpTesting.LATEST_PROTOCOL_VERSION);
  assert.equal(mcpTesting.negotiateProtocolVersion(undefined), mcpTesting.LATEST_PROTOCOL_VERSION);
});

test("governance-mcp handleRequest answers ping with an empty result", () => {
  assert.deepEqual(mcpTesting.handleRequest({ jsonrpc: "2.0", id: 4, method: "ping" }), {});
});

test("governance-mcp interoperates with newline-delimited initialize, initialized, and tools/list requests", async () => {
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
  // Unknown client notification: must be ignored, never answered.
  input.write(mcpTesting.encodeStdioMessage({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }));
  // Malformed line: must yield one parse-error response and not corrupt the
  // next valid message.
  input.write(Buffer.from("this is not a json-rpc line\n", "utf8"));
  input.end(
    mcpTesting.encodeStdioMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    })
  );

  await new Promise((resolve) => setImmediate(resolve));

  const stdoutText = Buffer.concat(outputChunks).toString("utf8");
  assert.ok(!/content-length/i.test(stdoutText), "no Content-Length headers may appear in standard mode");
  assert.ok(stdoutText.endsWith("\n"), "every stdout record must be newline-terminated");

  // Stdout purity: every non-empty line must be exactly one valid JSON-RPC message.
  const responses = stdoutText
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  assert.equal(
    responses.length,
    3,
    "expected initialize response, parse-error response, and tools/list response only (no responses to notifications)"
  );
  assert.deepEqual(heartbeatCalls, ["start", "stop"]);

  const [initializeResponse, parseErrorResponse, listResponse] = responses;
  assert.equal(initializeResponse.jsonrpc, "2.0");
  assert.equal(initializeResponse.id, 1);
  assert.equal(initializeResponse.result.protocolVersion, "2024-11-05");
  assert.equal(initializeResponse.result.serverInfo.name, "governance");

  assert.equal(parseErrorResponse.id, null);
  assert.equal(parseErrorResponse.error.code, -32700);

  assert.equal(listResponse.jsonrpc, "2.0");
  assert.equal(listResponse.id, 2);
  assert.ok(Array.isArray(listResponse.result.tools));
  assert.equal(
    listResponse.result.tools.length,
    Object.keys(mcpTesting.TOOLS).length,
    "tools/list must advertise exactly the runtime TOOLS catalog"
  );
  assert.deepEqual(
    listResponse.result.tools.map((tool) => tool.name),
    Object.keys(mcpTesting.TOOLS),
    "tools/list names must match the runtime TOOLS catalog"
  );
});

test("governance-mcp transport never answers a notification, even when handling it throws", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks = [];
  output.on("data", (chunk) => {
    outputChunks.push(chunk);
  });

  mcpTesting.startStdioTransport({
    input,
    output,
    ensureHeartbeatLoopFn() {},
    stopHeartbeatLoopFn() {},
    handleRequestFn() {
      throw { code: -32603, message: "synthetic failure" };
    },
    transportKeepAlive: setInterval(() => {}, 60_000),
  });

  input.write(mcpTesting.encodeStdioMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
  input.end(mcpTesting.encodeStdioMessage({ jsonrpc: "2.0", id: 5, method: "tools/list" }));

  await new Promise((resolve) => setImmediate(resolve));

  const responses = Buffer.concat(outputChunks)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 1, "only the id-bearing request may receive an (error) response");
  assert.equal(responses[0].id, 5);
  assert.equal(responses[0].error.code, -32603);
});

// COORD-483: the project default is a local transport declaration, not a
// hand-maintained catalog or an implicit third-party package installer.
test("governance-mcp is the sole local server in the default .mcp.json", () => {
  const mcpConfigPath = path.join(__dirname, "..", "..", ".mcp.json");
  const mcpConfig = JSON.parse(require("node:fs").readFileSync(mcpConfigPath, "utf8"));
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["governance"]);
  assert.equal(mcpConfig.mcpServers.governance.command, "node");
  assert.deepEqual(mcpConfig.mcpServers.governance.args, ["coord/scripts/governance-mcp.js"]);
  assert.doesNotMatch(mcpConfig.mcpServers.governance.description, /\b\d+\s+(?:typed\s+)?(?:MCP\s+)?tools?\b/i);
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

// ---------------------------------------------------------------------------
// COORD-482 — real spawned-server interoperability smokes
// ---------------------------------------------------------------------------

const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");

const SERVER_PATH = path.join(__dirname, "governance-mcp.js");

// Minimal spec-exact stdio client: spawns the real server process and speaks
// newline-delimited UTF-8 JSON-RPC exactly as the MCP stdio transport spec
// (2025-11-25 basic/transports) requires. This smoke always runs; the
// official-SDK smoke below additionally runs whenever the SDK is resolvable.
function spawnServerSmoke({ writes, expectedResponses, timeoutMs = 15_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      cwd: path.resolve(__dirname, "..", ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutRaw = "";
    let stderrRaw = "";
    const responses = [];
    let settledEarly = false;
    const timer = setTimeout(() => {
      settledEarly = true;
      child.kill("SIGKILL");
      reject(new Error(`spawned-server smoke timed out; stdout so far: ${stdoutRaw}\nstderr: ${stderrRaw}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutRaw += chunk.toString("utf8");
      const lines = stdoutRaw.split("\n");
      responses.length = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          // partial line still streaming — wait for more data
        }
      }
      if (responses.length >= expectedResponses) {
        child.stdin.end(); // clean shutdown: close stdin, expect exit 0
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrRaw += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settledEarly) reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (settledEarly) return;
      resolve({ code, signal, stdoutRaw, stderrRaw, responses });
    });

    for (const message of writes) {
      child.stdin.write(
        typeof message === "string" ? message : `${JSON.stringify(message)}\n`
      );
    }
  });
}

test("COORD-482 spawned-server smoke: initialize → initialized → tools/list over spec newline framing, clean exit", async () => {
  const { code, signal, stdoutRaw, responses } = await spawnServerSmoke({
    writes: [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "coord-spec-smoke", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      "not-a-json-line\n",
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gov_start", arguments: { ticket: "COORD-482" } } },
    ],
    expectedResponses: 4,
  });

  assert.equal(signal, null, "server must not need to be killed");
  assert.equal(code, 0, "server must exit 0 after stdin closes (clean shutdown)");

  // Stdout purity: protocol-only, one JSON-RPC message per newline-terminated
  // line, no Content-Length headers in standard mode.
  assert.ok(!/content-length/i.test(stdoutRaw), "no Content-Length headers on stdout");
  assert.ok(stdoutRaw.endsWith("\n"), "final stdout record must be newline-terminated");
  for (const line of stdoutRaw.split("\n")) {
    if (!line.trim()) continue;
    JSON.parse(line); // throws (fails the test) if any stdout line is not pure JSON
  }

  assert.equal(responses.length, 4, "initialize + parse error + tools/list + refused tools/call; no notification responses");
  const [initializeResponse, parseErrorResponse, listResponse, refusalResponse] = responses;

  assert.equal(initializeResponse.id, 1);
  assert.equal(initializeResponse.result.protocolVersion, "2025-11-25");
  assert.equal(initializeResponse.result.serverInfo.name, "governance");

  assert.equal(parseErrorResponse.id, null);
  assert.equal(parseErrorResponse.error.code, -32700);

  assert.equal(listResponse.id, 2);
  assert.equal(
    listResponse.result.tools.length,
    Object.keys(mcpTesting.TOOLS).length,
    "advertised tool count must be derived from the runtime TOOLS catalog"
  );

  // Identity v2: MCP mutation attempts fail closed against the REAL server.
  assert.equal(refusalResponse.id, 3);
  assert.equal(refusalResponse.result.isError, true);
  assert.equal(refusalResponse.result.structuredContent.error.details.reason, "v2_mcp_read_only");
  assert.match(refusalResponse.result.content[0].text, /read-only under identity v2/);
});

// Official MCP SDK client interoperability smoke. The engine itself stays
// zero-dependency, so the SDK is a test-time-only resolution: point
// GOVERNANCE_MCP_SDK_DIR at any directory whose node_modules contains
// @modelcontextprotocol/sdk (or have it resolvable from this file). When the
// SDK is absent the smoke is skipped — the spec-exact smoke above still
// guarantees framing compliance.
function resolveOfficialSdk() {
  const baseDirs = [];
  if (process.env.GOVERNANCE_MCP_SDK_DIR) {
    baseDirs.push(process.env.GOVERNANCE_MCP_SDK_DIR);
  }
  baseDirs.push(__dirname);
  for (const dir of baseDirs) {
    try {
      const requireFrom = createRequire(path.join(dir, "__sdk_resolver__.js"));
      const { Client } = requireFrom("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = requireFrom("@modelcontextprotocol/sdk/client/stdio.js");
      if (Client && StdioClientTransport) {
        return { Client, StdioClientTransport };
      }
    } catch {
      // try the next base dir
    }
  }
  return null;
}

const officialSdk = resolveOfficialSdk();

test(
  "COORD-482 official SDK client completes initialize, notifications/initialized, and tools/list against the real spawned server",
  { skip: officialSdk ? false : "official @modelcontextprotocol/sdk not resolvable (set GOVERNANCE_MCP_SDK_DIR); spec-exact smoke above still covers framing" },
  async () => {
    const { Client, StdioClientTransport } = officialSdk;
    const client = new Client({ name: "coord-official-sdk-smoke", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      cwd: path.resolve(__dirname, "..", ".."),
      stderr: "pipe",
    });
    try {
      // connect() performs the full spec handshake: initialize request +
      // notifications/initialized notification.
      await client.connect(transport);

      const serverVersion = client.getServerVersion();
      assert.equal(serverVersion.name, "governance");

      const list = await client.listTools();
      assert.equal(
        list.tools.length,
        Object.keys(mcpTesting.TOOLS).length,
        "official client must see the full runtime TOOLS catalog"
      );
      assert.deepEqual(
        list.tools.map((tool) => tool.name).sort(),
        Object.keys(mcpTesting.TOOLS).sort()
      );

      // Identity v2 mutation refusal must hold through the official client too.
      const refusal = await client.callTool({ name: "gov_start", arguments: { ticket: "COORD-482" } });
      assert.equal(refusal.isError, true);
      assert.match(refusal.content[0].text, /read-only under identity v2/);
    } finally {
      await client.close();
    }
  }
);
