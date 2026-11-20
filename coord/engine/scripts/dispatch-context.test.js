"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeContextMode,
  resolveTierContextMode,
  buildDispatchCachePrefixMarker,
  renderDispatchCachePrefix,
  resolveDispatchCachePrefixReferences,
  validateRequestReason,
  parseRequestContextArgs,
  parseContextRequestsArgs,
  projectContextRequestEvent,
  createDispatchContext,
} = require("./dispatch-context.js");

test("COORD-770: omitted legacy tier mode stays open; explicit policy modes are validated", () => {
  assert.equal(normalizeContextMode(undefined), "open");
  assert.equal(resolveTierContextMode("standard", { tiers: { standard: {} } }), "open");
  assert.equal(resolveTierContextMode("mechanical", { tiers: { mechanical: { context_mode: "pack_only" } } }), "pack_only");
  assert.throws(() => normalizeContextMode("explore"), /context_mode must be one of open\|pack_only/);
  assert.throws(() => resolveTierContextMode("missing", { tiers: {} }), /unknown tier/);
});

test("COORD-770: shared dispatch cache references remain sorted and deterministic", () => {
  const digest = (content) => require("node:crypto").createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
  const resolved = [
    { path: "a.md", content: "A\n", sha256: digest("A\n"), byte_length: 2 },
    { path: "z.md", content: "Z\n", sha256: digest("Z\n"), byte_length: 2 },
  ];
  const marker = buildDispatchCachePrefixMarker(["z.md", "a.md"], resolved);
  assert.deepEqual(marker.shared_references, ["a.md", "z.md"]);
  assert.equal(marker.resolved_references[0].content, "A\n");
  assert.equal(marker.byte_length, Buffer.byteLength(renderDispatchCachePrefix(marker), "utf8"));
  assert.match(marker.sha256, /^[a-f0-9]{64}$/);
});

test("COORD-770: request parser requires normalized relative POSIX paths and bounded reasons", () => {
  assert.deepEqual(parseRequestContextArgs(["--path", "coord/requirements.md", "--reason", "Check whether a requirement applies"]), {
    path: "coord/requirements.md",
    reason: "Check whether a requirement applies",
  });
  for (const path of ["", "  ", "/etc/passwd", "C:/private", "../outside", "a/../b", "a//b", "a/./b", "a\\b", "a\nb"]) {
    assert.throws(() => parseRequestContextArgs(["--path", path, "--reason", "need context"]), undefined, JSON.stringify(path));
  }
  for (const reason of ["", "  \t  ", "\treason", "\nreason", "reason\t", "reason\n", "reason\u0000", "r".repeat(513)]) {
    assert.throws(() => parseRequestContextArgs(["--path", "safe/file.md", "--reason", reason]), undefined, JSON.stringify(reason));
  }
  for (const args of [
    ["--path", "a", "--path", "b", "--reason", "x"],
    ["--path", "a", "--reason", "x", "--other", "y"],
    ["--path", "a", "--reason", "x", "extra"],
    ["--path", "a", "--reason", "x", "toString", "ignored"],
    ["--path", "a", "--reason", "x", "constructor", "ignored"],
    ["--path", "a"],
  ]) {
    assert.throws(() => parseRequestContextArgs(args));
  }
  const maxPath = `${"a".repeat(1022)}/x`;
  assert.equal(Buffer.byteLength(maxPath), 1024);
  assert.equal(parseRequestContextArgs(["--path", maxPath, "--reason", "ok"]).path, maxPath);
  assert.throws(() => parseRequestContextArgs(["--path", `${maxPath}x`, "--reason", "ok"]), /1024-byte limit/);
  const maxReason = "r".repeat(512);
  assert.equal(parseRequestContextArgs(["--path", "a", "--reason", maxReason]).reason, maxReason);
  const multibyteReason = "é".repeat(257);
  assert.throws(() => parseRequestContextArgs(["--path", "a", "--reason", multibyteReason]), /512-byte limit/);
});

test("COORD-770: direct reason validation and missing request path refuse malformed API input", () => {
  assert.throws(() => validateRequestReason(null), /--reason requires a non-empty explanation/);
  assert.throws(() => validateRequestReason("   "), /--reason must not be blank/);
  assert.throws(() => parseRequestContextArgs(["--reason", "Need the acceptance text"]), /requires --path/);
});

test("COORD-770: context request listing accepts one ticket and bounded positive limits only", () => {
  assert.deepEqual(parseContextRequestsArgs(["COORD-770", "--limit", "5", "--json"]), {
    ticket: "COORD-770", limit: 5, json: true,
  });
  assert.deepEqual(parseContextRequestsArgs([]), { ticket: null, limit: 20, json: false });
  assert.throws(() => parseContextRequestsArgs([" \t "]), /ticket id must not be blank/);
  for (const args of [
    ["COORD-770", "COORD-771"],
    ["--limit", "0"],
    ["--limit", "101"],
    ["--limit", "1.5"],
    ["--limit", "1", "--limit", "2"],
    ["--json", "--json"],
    ["--unexpected"],
  ]) {
    assert.throws(() => parseContextRequestsArgs(args));
  }
});

test("COORD-770: reader projects only successful context.requested journal evidence", () => {
  const valid = {
    command: "request-context", ticket: "COORD-770", ts: "2026-10-06T12:00:00.000Z",
    result: "succeeded", identity: { owner: "claudea11", agent_id: "a11" },
    details: { event_type: "context.requested", context_request: { path: "coord/a.md", reason: "Need current acceptance" } },
  };
  assert.deepEqual(projectContextRequestEvent(valid), {
    ticket: "COORD-770", requested_by: "claudea11", requested_agent_id: "a11",
    requested_at: valid.ts, path: "coord/a.md", reason: "Need current acceptance",
  });
  assert.equal(projectContextRequestEvent({ ...valid, result: "failed" }), null);
  assert.equal(projectContextRequestEvent({ ...valid, details: { ...valid.details, event_type: "record.cost" } }), null);
  for (const malformed of [
    null,
    {},
    { ...valid, details: { event_type: "context.requested" } },
    { ...valid, details: { ...valid.details, context_request: { path: null, reason: "Need context" } } },
    { ...valid, identity: { owner: "" } },
    { ...valid, identity: null },
  ]) {
    assert.equal(projectContextRequestEvent(malformed), null, "malformed journal rows are not projected as requests");
  }
  assert.deepEqual(projectContextRequestEvent({
    ...valid,
    ts: undefined,
    identity: { owner: "claudea11" },
  }), {
    ticket: "COORD-770", requested_by: "claudea11", requested_agent_id: null,
    requested_at: null, path: "coord/a.md", reason: "Need current acceptance",
  }, "legacy successful journal observations without optional identity/time fields remain readable");
});

test("COORD-770: invalid ticket and incomplete actor refuse before emitting request output", () => {
  const scenarios = [
    { ticket: undefined, identity: { agent: { id: "a11", handle: "claudea11" } }, expected: /requires <ticket-id>/ },
    { ticket: "--not-a-ticket", identity: { agent: { id: "a11", handle: "claudea11" } }, expected: /requires <ticket-id>/ },
    { ticket: "COORD-770", identity: { agent: { handle: "claudea11" } }, expected: /registered bound owner session/ },
    { ticket: "COORD-770", identity: { agent: { id: "a11" } }, expected: /registered bound owner session/ },
  ];
  const previousLog = console.log;
  const output = [];
  console.log = (line) => output.push(line);
  try {
    for (const scenario of scenarios) {
      let transactions = 0;
      const api = createDispatchContext({
        withGovernanceMutation(_metadata, callback) {
          transactions += 1;
          return callback();
        },
        readBoard() { return {}; },
        getTicketRef(_board, ticket) { return { row: { ID: ticket, Owner: "claudea11", Status: "doing" } }; },
        findLockForTicket() { return null; },
        assertTicketMutationOwnership() { return scenario.identity; },
      });
      assert.throws(() => api.requestContext(scenario.ticket, [
        "--path", "coord/acceptance.md", "--reason", "Check this requirement",
      ]), scenario.expected);
      assert.equal(transactions, scenario.ticket === "COORD-770" ? 1 : 0,
        "malformed ticket IDs refuse before opening the governance transaction");
      assert.deepEqual(output, [], "refused requests never print a success-shaped payload");
    }
  } finally {
    console.log = previousLog;
  }
});

test("COORD-770: a legacy ticket without status records null before-status", () => {
  let captured;
  const api = createDispatchContext({
    withGovernanceMutation(metadata, callback) {
      captured = metadata;
      return callback();
    },
    readBoard() { return {}; },
    getTicketRef(_board, ticket) { return { row: { ID: ticket, Owner: "claudea11" } }; },
    findLockForTicket() { return null; },
    assertTicketMutationOwnership() {
      return { agent: { id: "a11", handle: "claudea11" }, session: { session_id: "s1" } };
    },
  });
  const previousLog = console.log;
  console.log = () => {};
  try {
    const result = api.requestContext("COORD-770", [
      "--path", "coord/acceptance.md", "--reason", "Check this requirement",
    ]);
    assert.equal(result.status, "requested");
    assert.equal(captured.beforeStatus, null);
  } finally {
    console.log = previousLog;
  }
});

test("COORD-770: writer resolves ticket and bound identity inside the governed transaction", () => {
  const order = [];
  let captured;
  const api = createDispatchContext({
    withGovernanceMutation(metadata, callback) {
      order.push("transaction");
      captured = metadata;
      return callback();
    },
    readBoard() { order.push("board"); return {}; },
    getTicketRef(_board, ticket) { order.push(`ticket:${ticket}`); return { row: { ID: ticket, Owner: "claudea11", Status: "doing" } }; },
    findLockForTicket(ticket) { order.push(`lock:${ticket}`); return null; },
    assertTicketMutationOwnership(ticket, row, lock, options) {
      order.push(`ownership:${ticket}`);
      assert.equal(row.Owner, "claudea11");
      assert.equal(lock, null);
      assert.deepEqual(options, { readOnly: true });
      return { agent: { id: "a11", handle: "claudea11" }, session: { session_id: "s1" } };
    },
    readGovernanceEventLog() { return []; },
  });
  const previousLog = console.log;
  console.log = () => {};
  try {
    const result = api.requestContext("COORD-770", ["--path", "coord/acceptance.md", "--reason", "Check this requirement"]);
    assert.equal(result.access_granted, false);
  } finally {
    console.log = previousLog;
  }
  assert.deepEqual(order, ["transaction", "board", "ticket:COORD-770", "lock:COORD-770", "ownership:COORD-770"]);
  assert.equal(captured.command, "request-context");
  assert.equal(captured.forceLog, true);
  assert.equal(captured.preserveAgentState, true);
  assert.deepEqual(captured.details, {
    event_type: "context.requested",
    context_request: { path: "coord/acceptance.md", reason: "Check this requirement" },
  });
  assert.equal(captured.allowProvenanceDrift, undefined);
});

test("COORD-770: request output is emitted only after its journal transaction succeeds", () => {
  const api = createDispatchContext({
    withGovernanceMutation(_metadata, callback) {
      callback();
      throw new Error("injected journal commit failure");
    },
    readBoard() { return {}; },
    getTicketRef() { return { row: { ID: "COORD-770", Owner: "claudea11", Status: "doing" } }; },
    findLockForTicket() { return null; },
    assertTicketMutationOwnership() {
      return { agent: { id: "a11", handle: "claudea11" }, session: { session_id: "s1" } };
    },
  });
  const previousLog = console.log;
  const output = [];
  console.log = (line) => output.push(line);
  try {
    assert.throws(() => api.requestContext("COORD-770", [
      "--path", "coord/acceptance.md", "--reason", "Check this requirement",
    ]), /injected journal commit failure/);
  } finally {
    console.log = previousLog;
  }
  assert.deepEqual(output, [], "a transaction failure must not print a success-shaped request result");
});

test("COORD-770: context request reader defaults to bounded text and refuses unknown tickets without output", () => {
  const valid = {
    command: "request-context", ticket: "COORD-770", ts: "2026-10-06T12:00:00.000Z",
    result: "succeeded", identity: { owner: "claudea11", agent_id: "a11" },
    details: { event_type: "context.requested", context_request: { path: "coord/a.md", reason: "Need current acceptance" } },
  };
  let lookups = 0;
  const api = createDispatchContext({
    getTicketRef(_board, ticket) {
      lookups += 1;
      return ticket === "COORD-770" ? { row: { ID: ticket } } : null;
    },
    readBoard() { return {}; },
    readGovernanceEventLog() { return [valid]; },
  });
  const previousLog = console.log;
  const output = [];
  console.log = (line) => output.push(line);
  try {
    const listing = api.contextRequests();
    assert.equal(listing.limit, 20);
    assert.equal(listing.observation_only, true);
    assert.equal(listing.count, 1);
    assert.equal(lookups, 0, "unfiltered listing does not perform a ticket lookup");
    assert.deepEqual(output, [
      "Context requests (1; observations only, no access granted):",
      "- COORD-770 by claudea11: coord/a.md — Need current acceptance",
    ]);

    output.length = 0;
    assert.throws(() => api.contextRequests(["MISSING-770", "--json"]), /Unknown ticket/);
    assert.equal(lookups, 1);
    assert.deepEqual(output, [], "unknown-ticket refusal does not print a success-shaped listing");
  } finally {
    console.log = previousLog;
  }
});

test("COORD-771: stable prefix fingerprint binds exact resolved content and refuses unsafe paths", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-prefix-content-"));
  const stableFile = path.join(root, "coord", "docs", "stable.md");
  fs.mkdirSync(path.dirname(stableFile), { recursive: true });
  fs.writeFileSync(stableFile, "Stable bytes\n", "utf8");
  try {
    const refs = ["coord/docs/stable.md"];
    const firstResolved = resolveDispatchCachePrefixReferences(refs, root);
    const first = buildDispatchCachePrefixMarker(refs, firstResolved);
    const firstText = renderDispatchCachePrefix(first);
    assert.ok(firstText.includes("Stable bytes\n"));
    assert.equal(first.sha256, require("node:crypto").createHash("sha256").update(Buffer.from(firstText, "utf8")).digest("hex"));

    fs.writeFileSync(stableFile, "Stable bytes changed\n", "utf8");
    const secondResolved = resolveDispatchCachePrefixReferences(refs, root);
    const second = buildDispatchCachePrefixMarker(refs, secondResolved);
    assert.notEqual(second.sha256, first.sha256, "content changes must change the prefix digest even when the path is stable");
    assert.throws(() => resolveDispatchCachePrefixReferences(["../outside.md"], root), /invalid shared context reference/);
    const outsideDir = path.join(root, "outside");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "stable.md"), "outside\n", "utf8");
    fs.rmSync(path.dirname(stableFile), { recursive: true });
    fs.symlinkSync(outsideDir, path.dirname(stableFile), "dir");
    assert.throws(() => resolveDispatchCachePrefixReferences(refs, root), /regular directories/);
    assert.throws(() => buildDispatchCachePrefixMarker(refs, [{ ...firstResolved[0], sha256: "0".repeat(64) }]), /digests must match/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-771: shared-prefix resolver rejects malformed roots, non-regular paths, and invalid UTF-8", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-prefix-validation-"));
  try {
    assert.throws(() => resolveDispatchCachePrefixReferences(["safe.md"]), /project root is required/);
    assert.throws(() => resolveDispatchCachePrefixReferences(["safe.md"], path.join(root, "missing")));

    for (const reference of [null, "", "\\windows.md", "/absolute.md", ".", "a/./b", "a//b", "../outside.md", "a/../b"]) {
      assert.throws(() => resolveDispatchCachePrefixReferences([reference], root), /invalid shared context reference/,
        `invalid reference should be rejected: ${String(reference)}`);
    }

    fs.writeFileSync(path.join(root, "parent-file"), "not a directory\n", "utf8");
    assert.throws(() => resolveDispatchCachePrefixReferences(["parent-file/child.md"], root));
    fs.mkdirSync(path.join(root, "directory-final"));
    assert.throws(() => resolveDispatchCachePrefixReferences(["directory-final"], root), /regular directories/);
    fs.writeFileSync(path.join(root, "invalid-utf8.md"), Buffer.from([0xff, 0xfe]));
    assert.throws(() => resolveDispatchCachePrefixReferences(["invalid-utf8.md"], root), /valid UTF-8/);
    fs.symlinkSync(path.join(root, "missing-target"), path.join(root, "dangling.md"));
    assert.throws(() => resolveDispatchCachePrefixReferences(["dangling.md"], root));

    const pathApi = require("node:path");
    const originalResolve = pathApi.resolve;
    try {
      pathApi.resolve = (...parts) => parts.length === 2 && parts[0] === root && parts[1] === "escape-probe.md"
        ? originalResolve(root, "..", "outside.md")
        : originalResolve(...parts);
      assert.throws(() => resolveDispatchCachePrefixReferences(["escape-probe.md"], root), /escapes the project root/);
    } finally {
      pathApi.resolve = originalResolve;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-771: stable prefix renderer handles empty metadata and unterminated reference content", () => {
  const crypto = require("node:crypto");
  assert.match(renderDispatchCachePrefix({}), /Shared, cache-friendly preamble/);
  assert.match(renderDispatchCachePrefix({ description: "", shared_references: [], resolved_references: [] }),
    /Shared, cache-friendly preamble/);
  const content = "Stable content without a final newline";
  const resolved = [{ path: "coord/docs/stable.md", content,
    sha256: crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
    byte_length: Buffer.byteLength(content, "utf8") }];
  const marker = buildDispatchCachePrefixMarker(["coord/docs/stable.md"], resolved);
  assert.match(renderDispatchCachePrefix(marker), /Stable content without a final newline\n\n$/);
  assert.throws(() => buildDispatchCachePrefixMarker(["coord/docs/stable.md"], [{
    ...resolved[0], path: "coord/docs/other.md",
  }]), /digests must match/);
  assert.throws(() => renderDispatchCachePrefix({ shared_references: ["coord/docs/stable.md"], resolved_references: [{ path: "coord/docs/stable.md" }] }),
    /digests must match/);
});
