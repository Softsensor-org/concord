"use strict";

// COORD-660 — proofs for the hook payload acquisition seam.
//
// These run against the PURE, INJECTABLE module rather than against a live,
// wired safety hook: `pre-bash-guard.js` is enforced on every Bash tool call,
// so a defect proven only in-process there is a defect proven by locking the
// workspace out of its own recovery path.
//
// The behaviour under test is the one the old `readStdinSafe()` got wrong:
// a payload that could not be read must be DISTINGUISHABLE from a payload that
// was empty, and neither may be reported as success.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const seam = require("./hook-stdin.js");

test("LAZY: a sufficient env payload means stdin is never opened at all", async () => {
  let opened = 0;
  const result = await seam.acquireHookPayload({
    env: { TOOL_INPUT: "git status" },
    needs: ["TOOL_INPUT"],
    openStdin: () => {
      opened += 1;
      return null;
    },
  });
  assert.equal(opened, 0, "fd 0 must not be touched when env already answers");
  assert.equal(result.stdinConsulted, false);
  assert.equal(result.stdinReason, "not-consulted");
  assert.equal(result.ok, true);
  assert.equal(result.source, "env");
});

test("LAZY: a partially satisfied env payload still consults stdin", async () => {
  let opened = 0;
  await seam.acquireHookPayload({
    env: { TOOL_INPUT: "gov land COORD-1" },
    needs: ["TOOL_INPUT", "TOOL_OUTPUT"],
    openStdin: () => {
      opened += 1;
      return null;
    },
  });
  assert.equal(opened, 1, "a need the env does not cover must fall through to stdin");
});

test("an env var that is empty or whitespace is ABSENT, never an empty command", async () => {
  for (const value of ["", "   ", "\n"]) {
    assert.equal(seam.envText({ TOOL_INPUT: value }, "TOOL_INPUT"), "");
    assert.equal(seam.envSatisfies({ TOOL_INPUT: value }, ["TOOL_INPUT"]), false);
  }
});

// The property: the read WAITS for delivery instead of sampling fd 0 once and
// treating "nothing yet" as "nothing at all". That is a HAPPENS-BEFORE claim,
// and it is asserted as one — did the read settle before the payload was
// delivered? — not as an elapsed-time threshold. An earlier version of this
// test asserted `Date.now() - started >= delay - 25`, which passed in isolation
// and FAILED in the canonical aggregate run, where six other modules compete
// for CPU. A wall-clock tolerance is not evidence of ordering; under load it is
// noise, and a proof that is noisy under load is the same category of defect as
// the fail-open this ticket closes: a test reporting on something other than
// what it claims to check.
//
// The delays are kept because they genuinely exercise late delivery. They are
// simply no longer the thing being asserted, so no amount of scheduling jitter
// can move the verdict.
test("LATE DELIVERY IS DELIVERY: the read stays PENDING until the payload arrives", async () => {
  for (const delay of [0, 100, 300, 800]) {
    const payload = JSON.stringify({ tool_input: { command: "x" } });
    const stream = new Readable({ read() {} });

    let delivered = false;
    let settledBeforeDelivery = false;
    const read = seam.readStreamBounded(stream, { timeoutMs: 5000 }).then((value) => {
      if (!delivered) settledBeforeDelivery = true;
      return value;
    });

    await new Promise((resolve) => setTimeout(resolve, delay));
    delivered = true;
    stream.push(payload);
    stream.push(null);

    const result = await read;
    assert.equal(
      settledBeforeDelivery,
      false,
      `delay=${delay}ms: the read must WAIT for delivery, not sample fd 0 and give up`
    );
    assert.equal(result.ok, true, `delay=${delay}ms must still yield the payload`);
    assert.equal(result.text, payload, `delay=${delay}ms must yield the EXACT payload`);
  }
});

test("a complete JSON document ends the read without waiting for the writer to close", async () => {
  const stream = new Readable({ read() {} });
  const payload = JSON.stringify({ tool_input: { command: "y" } });
  setTimeout(() => stream.push(payload), 10); // deliberately never pushes null
  const result = await seam.readStreamBounded(stream, { timeoutMs: 5000 });
  assert.equal(result.reason, "complete");
  assert.equal(result.ok, true);
});

test("a chunked JSON document keeps waiting until it parses, then completes", async () => {
  const stream = new Readable({ read() {} });
  setTimeout(() => stream.push('{"tool_input":'), 10);
  setTimeout(() => stream.push('{"command":"z"}}'), 60);
  const result = await seam.readStreamBounded(stream, { timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "complete");
  assert.equal(JSON.parse(result.text).tool_input.command, "z");
});

test("EOF WITH NO BYTES IS `empty`, AND IT IS NOT ok — the whole point of the ticket", async () => {
  const stream = new Readable({ read() {} });
  stream.push(null);
  const result = await seam.readStreamBounded(stream, { timeoutMs: 500 });
  assert.equal(result.ok, false, "an empty read must never be reported as a successful payload");
  assert.equal(result.reason, "empty");
  assert.equal(result.text, "");
});

test("EAGAIN is a READ FAILURE, not an empty payload", async () => {
  const stream = new Readable({ read() {} });
  const error = new Error("resource temporarily unavailable");
  error.code = "EAGAIN";
  setTimeout(() => stream.emit("error", error), 10);
  const result = await seam.readStreamBounded(stream, { timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "error:EAGAIN");
  assert.match(seam.explainStdinReason(result.reason), /reading stdin failed \(EAGAIN\)/);
});

// Same discipline: the claim is "the wait is bounded by an explicit deadline,
// and the read does not give up before that deadline fires". Both halves are
// asserted through the INJECTED timer seam rather than by watching a clock, so
// the proof is exact and load-independent — and it is strictly stronger, since
// it also pins the deadline the reader actually arms.
test("a writer that never writes and never closes hits the BOUNDED deadline and reports timeout", async () => {
  const stream = new Readable({ read() {} }); // never pushes, never ends
  let armedMs = null;
  let fireDeadline = null;
  const read = seam.readStreamBounded(stream, {
    timeoutMs: 4242,
    setTimeout: (fn, ms) => {
      armedMs = ms;
      fireDeadline = fn;
      return { fake: true };
    },
    clearTimeout: () => {},
  });

  assert.equal(armedMs, 4242, "the wait must be armed with the EXPLICIT configured deadline");

  let settled = false;
  read.then(() => {
    settled = true;
  });
  // Give the event loop several turns: with no data, no EOF and no deadline
  // fired, nothing may resolve this read.
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the read must not give up before its deadline fires");

  fireDeadline();
  const result = await read;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout", "the wait must be bounded, not indefinite");
  assert.equal(result.text, "", "a timed-out read reports no payload, and reports it as a failure");
});

test("no readable stdin at all is reported as no-stdin, never as success", async () => {
  const result = await seam.readStreamBounded(null, { timeoutMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-stdin");
  const viaTty = seam.openProcessStdin({ stdin: { isTTY: true, on() {} } });
  assert.equal(viaTty, null, "a terminal is not a hook payload channel");
});

test("an oversized payload is refused rather than accumulated", async () => {
  const stream = new Readable({ read() {} });
  setTimeout(() => stream.push("x".repeat(2048)), 5);
  const result = await seam.readStreamBounded(stream, { timeoutMs: 500, maxBytes: 512 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-large");
});

test("every failure reason produces an operator-actionable explanation", () => {
  for (const reason of ["no-stdin", "empty", "timeout", "too-large", "error:EPIPE", "not-consulted"]) {
    const text = seam.explainStdinReason(reason);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 10, `reason ${reason} must explain itself`);
  }
});
