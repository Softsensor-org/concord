"use strict";

// COORD-710: temporal quality observation contract — canonical form, adapters,
// conformance vectors, run classification and derived series.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const q = require("./quality-observation.js");
const { classifyCoverage } = require("./coverage-policy.js");

const FIXTURES = path.join(__dirname, "fixtures", "quality-observation");
const VECTORS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "vectors.json"), "utf8"));
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function code(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof q.ObservationError, `expected ObservationError, got ${error && error.stack}`);
    return error.code;
  }
  return assert.fail("expected an ObservationError");
}

function run(overrides = {}) {
  return q.normalizeRun({
    format: "jest-json",
    repository: "X",
    suite: "unit",
    commitSha: SHA_A,
    runtime: "node-22",
    attempt: 1,
    ingestedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function jest(results, extra = {}) {
  const assertionResults = results.map(([title, status, duration = 10]) => ({ ancestorTitles: ["S"], title, status, duration }));
  return JSON.stringify({ numTotalTests: assertionResults.length, testResults: [{ name: "a.test.js", assertionResults }], ...extra });
}

// --- canonical form ------------------------------------------------------------------

test("canonical form sorts keys, NFC-normalizes text and refuses non-canonical values", () => {
  assert.equal(q.canonicalize({ b: 1, a: [true, null, "x"], "10": 2, "2": 3 }), "{\"10\":2,\"2\":3,\"a\":[true,null,\"x\"],\"b\":1}");
  assert.equal(q.canonicalize("cafe\u0301"), q.canonicalize("caf\u00e9"));
  assert.equal(q.canonicalize({ "cafe\u0301": 1 }), "{\"caf\u00e9\":1}");
  assert.equal(code(() => q.canonicalize({ "cafe\u0301": 1, "caf\u00e9": 2 })), "non-canonical-value");
  assert.equal(code(() => q.canonicalize(1.5)), "non-canonical-value");
  assert.equal(code(() => q.canonicalize(Number.NaN)), "non-canonical-value");
  assert.equal(code(() => q.canonicalize(undefined)), "non-canonical-value");
  assert.equal(code(() => q.canonicalize(new Date(0))), "non-canonical-value");
  assert.equal(code(() => q.canonicalize("\ud800")), "malformed");
  assert.equal(q.canonicalBytes({ a: 1 }), "{\"a\":1}\n");
  assert.match(q.sha256Hex("x"), /^[0-9a-f]{64}$/);
});

test("durations are exact integer microseconds with round-half-up and no float arithmetic", () => {
  assert.equal(q.decimalToMicros("0.732994", "ms"), 733);
  assert.equal(q.decimalToMicros("0.0005", "ms"), 1);
  assert.equal(q.decimalToMicros("0.0004", "ms"), 0);
  assert.equal(q.decimalToMicros("1.5", "s"), 1500000);
  assert.equal(q.decimalToMicros(" 2 ", "s"), 2000000);
  assert.equal(q.decimalToMicros(1e-7, "s"), 0);
  assert.equal(q.decimalToMicros("5e-7", "s"), 1);
  assert.equal(q.decimalToMicros("1.0E-4", "s"), 100);
  assert.equal(q.decimalToMicros("1e2", "ms"), 100000);
  assert.equal(q.decimalToMicros("3e-60", "s"), 0);
  for (const bad of ["abc", "-1", "", "NaN", "1e999"]) assert.equal(code(() => q.decimalToMicros(bad, "s")), "malformed", bad);
  assert.equal(code(() => q.decimalToMicros("99999999999", "s")), "malformed");
});

test("ratios are fixed four-decimal strings and null when the denominator is zero", () => {
  assert.equal(q.formatRatio(1, 3), "0.3333");
  assert.equal(q.formatRatio(2, 3), "0.6667");
  assert.equal(q.formatRatio(3, 3), "1.0000");
  assert.equal(q.formatRatio(-1, 4), "-0.2500");
  assert.equal(q.formatRatio(0, 0), null);
});

test("locators are made relative to the declared source root and unstable locators are refused", () => {
  assert.equal(q.normalizeLocator("/work/repo/src/a.test.js", "/work/repo/"), "src/a.test.js");
  assert.equal(q.normalizeLocator("C:\\work\\repo\\src\\a.js", "C:\\work\\repo"), "src/a.js");
  assert.equal(q.normalizeLocator("tests/test_a.py", null), "tests/test_a.py");
  for (const bad of ["/elsewhere/a.js", "C:/x/a.js", "../a.js", "src/../../a.js"]) {
    assert.equal(code(() => q.normalizeLocator(bad, "/work/repo")), "unstable-test-identity", bad);
  }
});

// --- conformance vectors ------------------------------------------------------------------------

test("every golden conformance vector reproduces its frozen digest or rejection on this runtime", () => {
  assert.equal(VECTORS.adapter_contract_version, q.ADAPTER_CONTRACT_VERSION);
  assert.ok(VECTORS.vectors.length >= 16);
  const formats = new Set();
  for (const vector of VECTORS.vectors) {
    formats.add(vector.adapter);
    const result = q.runConformanceVector({ ...vector, options: VECTORS.defaults }, fixture(vector.input));
    assert.ok(result.ok, `${vector.name}: ${JSON.stringify(result.actual)} (runtime ${process.version})`);
  }
  for (const adapter of Object.keys(q.ADAPTERS)) assert.ok(formats.has(adapter), `no conformance vector for ${adapter}`);
});

test("conformance reports a mismatch instead of passing and rethrows non-contract errors", () => {
  const vector = { adapter: "jest-json", options: VECTORS.defaults, expect: { rejection: "truncated" } };
  assert.deepEqual(q.runConformanceVector(vector, "{"), { ok: false, actual: { rejection: "malformed" } });
  const wrong = q.runConformanceVector({ ...vector, expect: { content_digest: "0" } }, fixture("jest-basic.json"));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.actual.run_status, "completed");
  assert.throws(() => q.runConformanceVector({ ...vector, adapter: "node-test-tap" }, 42), TypeError);
});

test("node 22 and node 24 TAP shapes of the same run share one content identity", () => {
  const a = run({ format: "node-test-tap", text: fixture("node22-basic.tap") });
  const b = run({ format: "node-test-tap", text: fixture("node24-basic.tap") });
  assert.equal(a.content_digest, b.content_digest);
  assert.notEqual(a.provenance.source_digest, b.provenance.source_digest);
  assert.deepEqual(a.content.tests.map((t) => [t.name_path, t.outcome, t.duration_us]), [
    [["outer suite", "fails # hash"], "failed", 332],
    [["outer suite", "passes"], "passed", 733],
    [["outer suite", "skips"], "skipped", 244],
    [["outer suite", "todo one"], "skipped", 275],
    [["top caf\u00e9"], "passed", 97],
  ]);
  const nfd = run({ format: "node-test-tap", text: fixture("node22-basic.tap").replaceAll("caf\u00e9", "cafe\u0301") });
  assert.equal(nfd.content_digest, a.content_digest, "NFD and NFC spellings are one identity");
});

// --- adapters: edge and malformed input -------------------------------------------------------------

test("node TAP adapter handles escapes, nameless points and parent tests and refuses malformed shapes", () => {
  const tap = (body, tests) => `TAP version 13\n${body}\n1..${body.split("\n").filter((l) => /^(not )?ok/.test(l)).length}\n# tests ${tests}\n`;
  const yaml = "  ---\n  duration_ms: 1\n  ...";
  const parsed = run({ format: "node-test-tap", text: tap(`ok 1 - a\\nb \\\\ c\n${yaml}\nok 2\n${yaml}`, 2) });
  assert.deepEqual(parsed.content.tests.map((t) => t.name_path), [[""], ["a\nb \\ c"]]);
  assert.equal(parsed.provenance.started_at, null);
  assert.equal(code(() => run({ format: "node-test-tap", text: "not tap" })), "malformed");
  assert.equal(code(() => run({ format: "node-test-tap", text: tap("Bail out!", 0) })), "malformed");
  assert.equal(code(() => run({ format: "node-test-tap", text: tap(`  ok 1 - odd indent\n${yaml}`, 1) })), "malformed");
  assert.equal(code(() => run({ format: "node-test-tap", text: tap("ok 1 - no yaml", 1) })), "malformed");
  assert.equal(code(() => run({ format: "node-test-tap", text: tap(`ok 1 - a\n${yaml}`, 3) })), "malformed");
  assert.equal(code(() => run({ format: "node-test-tap", text: `TAP version 13\nok 1 - a\n${yaml}\n# tests 1\n` })), "truncated");
  assert.equal(code(() => run({ format: "node-test-tap", text: `TAP version 13\nok 1 - a\n${yaml}\n1..2\n# tests 1\n` })), "truncated");
  assert.equal(code(() => run({ format: "node-test-tap", text: "TAP version 13\nok 1 - cut at the point line" })), "truncated");
});

test("JUnit adapter reads nested suites, quoting and entities and fails closed on bad XML", () => {
  const parsed = run({
    format: "junit-xml",
    text: "<testsuite name='s'><testsuite><testcase name='a &#65;' time='1'/></testsuite><testcase name=\"untimed\"/></testsuite>trailing",
  });
  assert.deepEqual(parsed.content.tests.map((t) => [t.locator, t.name_path, t.duration_us]), [["", ["a A"], 1000000], ["", ["untimed"], null]]);
  assert.equal(parsed.content.run_status, "completed");
  const untimed = run({ format: "junit-xml", text: "<testsuite><testcase name='x'/></testsuite>" });
  assert.equal(untimed.content.duration_us, null);
  const bad = {
    "<?xml version='1.0'?>": "truncated",
    "<?xml": "truncated",
    "<!-- open": "truncated",
    "<a><![CDATA[x": "truncated",
    "<!DOCTYPE x><a/>": "unsupported-format",
    "<a b=></a>": "malformed",
    "</a>": "malformed",
    "<a></b>": "malformed",
    "<a/><b/>": "malformed",
    "<a>": "truncated",
    "<report/>": "unsupported-format",
    "<testsuite><testcase time='1'/></testsuite>": "malformed",
    "<testsuite><testcase name='&bogus;'/></testsuite>": "malformed",
    "<testsuite><testcase name='a & b'/></testsuite>": "malformed",
    "<testsuite><testcase name='&#x110000;'/></testsuite>": "malformed",
    "<testsuite><testcase name='x' classname='/abs/path'/></testsuite>": "unstable-test-identity",
  };
  for (const [text, expected] of Object.entries(bad)) assert.equal(code(() => run({ format: "junit-xml", text })), expected, text);
});

test("JUnit count metadata must be numeric and cannot contradict the reported testcases", () => {
  for (const text of [
    "<testsuite tests='bogus'><testcase name='x'/></testsuite>",
    "<testsuite tests='-1'><testcase name='x'/></testsuite>",
    "<testsuite tests='9007199254740992'/>",
    "<testsuite tests='0'><testcase name='x'/></testsuite>",
    "<testsuite failures='bogus'><testcase name='x'/></testsuite>",
    "<testsuite errors='9007199254740992'/>",
    "<testsuite tests='1' skipped='2'><testcase name='x'/></testsuite>",
  ]) assert.equal(code(() => run({ format: "junit-xml", text })), "malformed", text);
  const partial = run({ format: "junit-xml", text: "<testsuite tests='2'><testcase name='x'/></testsuite>" });
  assert.equal(partial.content.run_status, "partial", "a valid higher declared total still represents a partial report");
  const complete = run({ format: "junit-xml", text: "<testsuite tests='1' failures='0'><testcase name='x'/></testsuite>" });
  assert.equal(complete.content.run_status, "completed");
  for (const text of [
    "<testsuite tests='1' failures='1'><testcase name='x'/></testsuite>",
    "<testsuite tests='1' skipped='1'><testcase name='x'/></testsuite>",
    "<testsuites tests='1' failures='1'><testsuite tests='1'><testcase name='x'/></testsuite></testsuites>",
  ]) assert.equal(code(() => run({ format: "junit-xml", text })), "malformed", text);
  const partialFailure = run({ format: "junit-xml", text: "<testsuite tests='2' failures='1'><testcase name='x'/></testsuite>" });
  assert.equal(partialFailure.content.run_status, "partial", "a larger aggregate on a declared partial report remains non-passing evidence");
});

test("Jest adapter maps every status, tolerates optional fields and refuses unknown shapes", () => {
  const parsed = run({
    text: JSON.stringify({
      numTotalTests: 3,
      testResults: [{ name: "a.test.js", assertionResults: [
        { title: "bare", status: "disabled" },
        { title: "skip", status: "skipped", ancestorTitles: ["G"] },
      ] }],
    }),
  });
  assert.deepEqual(parsed.content.tests.map((t) => [t.name_path, t.outcome]), [[["G", "skip"], "skipped"], [["bare"], "skipped"]]);
  assert.equal(parsed.content.run_status, "partial", "fewer assertions than numTotalTests is a partial run");
  assert.equal(parsed.provenance.started_at, null);
  for (const text of ["[]", "{\"testResults\":[]}", "{\"numTotalTests\":0}",
    "{\"numTotalTests\":1,\"testResults\":[1]}",
    "{\"numTotalTests\":1,\"testResults\":[{\"name\":\"a\",\"assertionResults\":[1]}]}",
    "{\"numTotalTests\":1,\"testResults\":[{\"name\":\"a\",\"assertionResults\":[{\"title\":\"t\",\"status\":\"focused\"}]}]}",
    "{\"numTotalTests\":1,\"testResults\":[{\"name\":\"a\",\"assertionResults\":[{\"status\":\"passed\"}]}]}"]) {
    assert.equal(code(() => run({ text })), "malformed", text);
  }
  assert.equal(code(() => run({ text: jest([["t", "passed"]]).replace("a.test.js", "/abs/a.test.js") })), "unstable-test-identity");
});

test("Jest metadata types and totals cannot turn malformed reports into completed runs", () => {
  for (const text of [
    jest([["one", "passed"]], { numTotalTests: 0 }),
    jest([["one", "passed"]], { numTotalTests: -1 }),
    jest([["one", "passed"]], { numTotalTests: "1" }),
    jest([["one", "passed"]], { numPassedTests: "bogus" }),
    jest([["one", "passed"]], { numPassedTests: 2 }),
    jest([["one", "passed"]], { numPassedTests: 1, numFailedTests: 1 }),
    jest([["one", "passed"]], { numPassedTests: 0 }),
    jest([["one", "passed"]], { numFailedTestSuites: -1 }),
    jest([], { numTotalTests: 0, numTotalTestSuites: 1, numFailedTestSuites: 2 }),
    JSON.stringify({ numTotalTests: 0, numTotalTestSuites: 1, testResults: [
      { name: "a.test.js", assertionResults: [] },
      { name: "b.test.js", assertionResults: [] },
    ] }),
    JSON.stringify({ numTotalTests: 1, testResults: [{ name: "a.test.js", status: "unknown", assertionResults: [{ title: "one", status: "passed" }] }] }),
    jest([["one", "passed"]], { wasInterrupted: "false" }),
    jest([["one", "passed"]], { success: "false" }),
    jest([["one", "failed"]], { success: true }),
    JSON.stringify({ success: true, numTotalTests: 1, numTotalTestSuites: 1, numFailedTestSuites: 1,
      testResults: [{ name: "a.test.js", status: "failed", assertionResults: [{ title: "one", status: "passed" }] }] }),
    JSON.stringify({ success: true, numTotalTests: 1, numTotalTestSuites: 1, numRuntimeErrorTestSuites: 1,
      testResults: [{ name: "a.test.js", status: "passed", assertionResults: [{ title: "one", status: "passed" }] }] }),
    JSON.stringify({ numTotalTests: 1, testResults: [{ name: "a.test.js", assertionResults: [
      { title: "t", status: "passed", ancestorTitles: "oops" },
    ] }] }),
    JSON.stringify({ numTotalTests: 1, testResults: [{ name: "a.test.js", assertionResults: [
      { title: "t", status: "passed", ancestorTitles: ["suite", 3] },
    ] }] }),
  ]) assert.equal(code(() => run({ text })), "malformed", text);
  const complete = run({ text: jest([["one", "passed"]], { numTotalTests: 1, wasInterrupted: false }) });
  assert.equal(complete.content.run_status, "completed");
  const partial = run({ text: jest([["one", "passed"]], { numTotalTests: 2, numFailedTests: 1 }) });
  assert.equal(partial.content.run_status, "partial");
  assert.equal(q.isPassingEvidence(partial), false);
  const cancelled = run({ text: jest([["one", "passed"]], { numTotalTests: 1, numFailedTests: 1, wasInterrupted: true }) });
  assert.equal(cancelled.content.run_status, "cancelled");
  assert.equal(q.isPassingEvidence(cancelled), false);
  const failedSuite = run({ text: JSON.stringify({
    numTotalTests: 1,
    numTotalTestSuites: 1,
    numFailedTestSuites: 1,
    testResults: [{ name: "a.test.js", status: "failed", assertionResults: [{ title: "one", status: "passed" }] }],
  }) });
  assert.equal(failedSuite.content.run_status, "partial");
  assert.equal(q.isPassingEvidence(failedSuite), false);
  const failedReport = run({ text: jest([["one", "passed"]], { success: false }) });
  assert.equal(failedReport.content.run_status, "partial");
  assert.equal(q.isPassingEvidence(failedReport), false);
  const runtimeError = run({ text: jest([["one", "passed"]], { numTotalTestSuites: 1, numRuntimeErrorTestSuites: 1 }) });
  assert.equal(runtimeError.content.run_status, "partial");
  assert.equal(q.isPassingEvidence(runtimeError), false);
});

test("pytest metadata types and totals cannot turn malformed reports into completed runs", () => {
  const report = (extra = {}) => JSON.stringify({ exitcode: 0, summary: { collected: 1 }, tests: [{ nodeid: "t.py::a", outcome: "passed" }], ...extra });
  for (const text of [
    report({ exitcode: "0" }),
    report({ exitcode: 6 }),
    report({ summary: "oops" }),
    report({ summary: { collected: "1" } }),
    report({ summary: { collected: -1 } }),
    report({ summary: { deselected: 1 } }),
    report({ summary: { collected: 1, deselected: "bogus" } }),
    report({ summary: { collected: 1, deselected: 2 } }),
    report({ summary: { collected: 1, failed: "bogus" } }),
    report({ summary: { collected: 1, passed: 2 } }),
    report({ summary: { collected: 1, total: 2 } }),
    report({ summary: { collected: 2, deselected: 1, total: 2 } }),
    report({ summary: { collected: 1, total: 0 } }),
    report({ summary: { collected: 1, failed: 1, passed: 0 } }),
    report({ exitcode: 1, summary: undefined }),
    JSON.stringify({ exitcode: 1, tests: [{ nodeid: "t.py::a", outcome: "passed" }] }),
    report({ summary: undefined, tests: [{ nodeid: "t.py::a", outcome: "failed" }] }),
    report({ summary: { collected: 0 }, tests: [{ nodeid: "t.py::a", outcome: "passed" }] }),
    report({ exitcode: 5, summary: { collected: 1 } }),
  ]) assert.equal(code(() => run({ format: "pytest-json", text })), "malformed", text);
  const noTests = run({ format: "pytest-json", text: JSON.stringify({ exitcode: 5, summary: { collected: 0, deselected: 0 }, tests: [] }) });
  assert.equal(noTests.content.run_status, "no-tests");
  assert.equal(run({ format: "pytest-json", text: report({ summary: { collected: 1, total: 1 } }) }).content.run_status, "completed");
  const partial = run({
    format: "pytest-json",
    text: JSON.stringify({ exitcode: 3, summary: { collected: 2, total: 2, passed: 1, failed: 1 }, tests: [{ nodeid: "t.py::a", outcome: "passed" }] }),
  });
  assert.equal(partial.content.run_status, "partial");
  assert.equal(q.isPassingEvidence(partial), false);
  const cancelled = run({
    format: "pytest-json",
    text: JSON.stringify({ exitcode: 2, summary: { collected: 1, total: 1, passed: 1, failed: 0 }, tests: [{ nodeid: "t.py::a", outcome: "passed" }] }),
  });
  assert.equal(cancelled.content.run_status, "cancelled");
  assert.equal(q.isPassingEvidence(cancelled), false);
  const setupError = run({
    format: "pytest-json",
    text: JSON.stringify({ exitcode: 1, summary: { collected: 1, total: 1, error: 1, failed: 0 }, tests: [{ nodeid: "t.py::a", outcome: "error", setup: { outcome: "failed" } }] }),
  });
  assert.equal(setupError.content.tests[0].outcome, "failed");
  assert.equal(setupError.content.run_status, "completed");
  assert.equal(q.isPassingEvidence(setupError), false, "pytest setup errors count as errors, not assertion failures");
  assert.equal(code(() => run({
    format: "pytest-json",
    text: JSON.stringify({ exitcode: 1, summary: { collected: 1, total: 1, error: 0, failed: 1 }, tests: [{ nodeid: "t.py::a", outcome: "error" }] }),
  })), "malformed");
});

test("pytest adapter sums stage durations, honors deselection and refuses malformed entries", () => {
  const parsed = run({
    format: "pytest-json",
    text: JSON.stringify({
      exitcode: 0,
      summary: { collected: 3, deselected: 1 },
      tests: [
        { nodeid: "t.py::a", outcome: "xpassed", call: { duration: 0.5 } },
        { nodeid: "t.py::b", outcome: "passed", setup: 1, call: {} },
      ],
    }),
  });
  assert.deepEqual(parsed.content.tests.map((t) => [t.name_path, t.outcome, t.duration_us]), [[["a"], "passed", 500000], [["b"], "passed", 0]]);
  assert.equal(parsed.content.run_status, "completed");
  assert.equal(parsed.provenance.started_at, null);
  const noSummary = run({ format: "pytest-json", text: JSON.stringify({ exitcode: 3, tests: [{ nodeid: "t.py::a", outcome: "passed" }] }) });
  assert.equal(noSummary.content.run_status, "partial");
  const usage = run({ format: "pytest-json", text: JSON.stringify({ exitcode: 4, tests: [{ nodeid: "t.py::a", outcome: "passed" }] }) });
  assert.equal(usage.content.run_status, "partial");
  for (const text of ["{\"tests\":[]}", "{\"exitcode\":0}", "[1]",
    "{\"exitcode\":0,\"tests\":[1]}",
    "{\"exitcode\":0,\"tests\":[{\"nodeid\":\"t.py::a\",\"outcome\":\"rerun\"}]}",
    "{\"exitcode\":0,\"tests\":[{\"nodeid\":\"t.py\",\"outcome\":\"passed\"}]}",
    "{\"exitcode\":0,\"tests\":[{\"nodeid\":7,\"outcome\":\"passed\"}]}"]) {
    assert.equal(code(() => run({ format: "pytest-json", text })), "malformed", text);
  }
});

test("inherited object keys never act as entities, statuses or outcomes", () => {
  assert.equal(code(() => run({ format: "junit-xml", text: "<testsuite><testcase name='&constructor;'/></testsuite>" })), "malformed");
  assert.equal(code(() => run({ format: "junit-xml", text: "<testsuite><testcase name='&toString;'/></testsuite>" })), "malformed");
  assert.equal(code(() => run({ text: jest([["t", "constructor"]]) })), "malformed");
  assert.equal(code(() => run({ text: jest([["t", "__proto__"]]) })), "malformed");
  assert.equal(code(() => run({ format: "pytest-json", text: "{\"exitcode\":0,\"tests\":[{\"nodeid\":\"t.py::a\",\"outcome\":\"hasOwnProperty\"}]}" })), "malformed");
  const escaped = run({ format: "node-test-tap", text: "TAP version 13\nok 1 - a\\constructor\n  ---\n  duration_ms: 1\n  ...\n1..1\n# tests 1\n" });
  assert.deepEqual(escaped.content.tests[0].name_path, ["aconstructor"]);
});

test("out-of-range report timestamps are dropped from provenance instead of crashing", () => {
  const jestRun = run({ text: jest([["t", "passed"]], { startTime: Number.MAX_SAFE_INTEGER }) });
  assert.equal(jestRun.provenance.started_at, null);
  const pytestRun = run({ format: "pytest-json", text: JSON.stringify({ exitcode: 0, created: 1e300, tests: [{ nodeid: "t.py::a", outcome: "passed" }] }) });
  assert.equal(pytestRun.provenance.started_at, null);
});

test("declaring an expectation does not change the identity of a run that was measured", () => {
  const plain = run({ text: jest([["t", "passed"]]) });
  const expected = run({ text: jest([["t", "passed"]]), expectMeasurement: true });
  assert.equal(expected.content_digest, plain.content_digest, "redelivery with --expect-measurement is the same observation");
  assert.deepEqual(plain.content.measurement, { expected: null, reason: null, coord705_result: null });
});

test("unsupported formats and invalid run identity are attributable refusals", () => {
  assert.equal(code(() => run({ format: "toString" })), "unsupported-format");
  assert.equal(code(() => run({ commitSha: "xyz", text: "{}" })), "invalid-run-identity");
  assert.equal(code(() => run({ commitSha: undefined, text: "{}" })), "invalid-run-identity");
  assert.equal(code(() => run({ attempt: 0, text: "{}" })), "invalid-run-identity");
  assert.equal(code(() => run({ attempt: "1.5", text: "{}" })), "invalid-run-identity");
  assert.equal(code(() => run({ repository: " ", text: "{}" })), "invalid-run-identity");
  assert.equal(code(() => run({ runtime: 5, text: "{}" })), "invalid-run-identity");
  assert.equal(code(() => run({ ingestedAt: undefined, text: jest([["t", "passed"]]) })), "invalid-run-identity");
  const defaults = run({ attempt: undefined, commitSha: "C".repeat(64), text: jest([["t", "passed"]]) });
  assert.equal(defaults.content.attempt, 1);
  assert.equal(defaults.content.commit_sha, "c".repeat(64));
});

// --- run classification -------------------------------------------------------------------------------

test("COORD-705: an expected but absent measurement is never a passing observation", () => {
  const absent = run({ text: null, expectMeasurement: true });
  const coord705 = classifyCoverage({ metrics: {}, testsTotal: null, expectMeasurement: true });
  assert.equal(coord705.reason, "measurement-expected-but-absent");
  assert.equal(absent.content.run_status, coord705.reason);
  assert.deepEqual(absent.content.measurement, { expected: true, reason: coord705.reason, coord705_result: "missing" });
  assert.equal(absent.provenance.source_digest, null);
  assert.equal(absent.content.adapter.format_version, null);
  assert.equal(q.isPassingEvidence(absent), false);

  const emptyButExpected = run({ format: "pytest-json", text: fixture("pytest-no-tests.json"), expectMeasurement: true });
  assert.equal(emptyButExpected.content.run_status, "measurement-expected-but-absent");
  assert.equal(q.isPassingEvidence(emptyButExpected), false);

  const noTests = run({ format: "pytest-json", text: fixture("pytest-no-tests.json") });
  assert.equal(noTests.content.run_status, classifyCoverage({ metrics: {}, testsTotal: 0 }).reason);
  assert.equal(noTests.content.duration_us, null);
  assert.equal(q.isPassingEvidence(noTests), false, "no-tests is green under COORD-705 but never passing evidence");

  assert.equal(code(() => run({ text: undefined })), "report-absent", "nothing expected and nothing reported is refused, not recorded");
});

test("passing evidence requires a completed run with no failures or cancellations", () => {
  assert.equal(q.isPassingEvidence(run({ text: jest([["a", "passed"], ["b", "skipped"]]) })), true);
  assert.equal(q.isPassingEvidence(run({ text: jest([["a", "passed"], ["b", "failed"]]) })), false);
  assert.equal(q.isPassingEvidence(run({ format: "node-test-tap", text: fixture("node22-cancelled.tap") })), false);
  assert.equal(q.isPassingEvidence(run({ format: "junit-xml", text: fixture("junit-partial.xml") })), false);
  assert.equal(q.isPassingEvidence(run({ text: fixture("jest-interrupted.json"), sourceRoot: "/work/repo" })), false);
});

test("wall-clock values are provenance only and never change content identity", () => {
  const a = run({ text: fixture("jest-basic.json"), sourceRoot: "/work/repo" });
  const b = run({ text: fixture("jest-basic.json").replace("1760954400000", "1760954999999"), sourceRoot: "/work/repo", ingestedAt: "2026-02-02T00:00:00.000Z" });
  assert.equal(a.content_digest, b.content_digest);
  assert.equal(a.provenance.started_at, "2025-10-20T10:00:00.000Z");
  assert.notEqual(a.provenance.source_digest, b.provenance.source_digest);
  assert.notEqual(q.artifactBytes(a), q.artifactBytes(b));
  const pytest = run({ format: "pytest-json", text: fixture("pytest-basic.json") });
  assert.equal(pytest.provenance.started_at, "2025-10-20T10:00:00.123Z");
  const junit = run({ format: "junit-xml", text: fixture("junit-basic.xml") });
  assert.equal(junit.provenance.started_at, "2026-10-20T10:00:00.000Z");
  const offset = run({ text: jest([ ["a", "passed"] ], { startTime: Date.parse("2026-01-01T01:00:00+01:00") }), ingestedAt: "2026-01-01T02:00:00+02:00" });
  assert.equal(offset.provenance.started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(offset.provenance.ingested_at, "2026-01-01T00:00:00.000Z");
  const dateOnlyQuarantine = q.validateQuarantine({ ...QUARANTINE, createdAt: "2026-01-01", expiresAt: "2026-01-02" });
  assert.equal(dateOnlyQuarantine.created_at, "2026-01-01T00:00:00.000Z");
  const leapDay = run({ text: jest([["a", "passed"]]), ingestedAt: "2024-02-29" });
  assert.equal(leapDay.provenance.ingested_at, "2024-02-29T00:00:00.000Z");
  const centuryLeapDay = run({ text: jest([["a", "passed"]]), ingestedAt: "2000-02-29" });
  assert.equal(centuryLeapDay.provenance.ingested_at, "2000-02-29T00:00:00.000Z");
  assert.equal(code(() => run({ format: "junit-xml", text: "<testsuite timestamp='not-a-timestamp' tests='1'><testcase name='a'/></testsuite>" })), "malformed-timestamp");
  assert.equal(code(() => run({ text: jest([["a", "passed"]]), ingestedAt: "2026-02-30T10:00:00Z" })), "malformed-timestamp");
  assert.equal(code(() => run({ text: jest([["a", "passed"]]), ingestedAt: "2026-13-01" })), "malformed-timestamp");
  assert.equal(code(() => run({ text: jest([["a", "passed"]]), ingestedAt: "2026-01-01T00:00:00+99:99" })), "malformed-timestamp");
});

test("artifact verification detects any change to normalized content", () => {
  const artifact = run({ text: jest([["a", "passed"]]) });
  assert.equal(q.verifyArtifact(artifact), artifact);
  const tampered = JSON.parse(JSON.stringify(artifact));
  tampered.content.tests[0].outcome = "failed";
  assert.equal(code(() => q.verifyArtifact(tampered)), "digest-mismatch");
  assert.equal(code(() => q.verifyArtifact({ schema: "other" })), "digest-mismatch");
  assert.equal(code(() => q.verifyArtifact(null)), "digest-mismatch");
  assert.equal(code(() => q.verifyArtifact({ schema: q.OBSERVATION_SCHEMA, content: [] })), "digest-mismatch");
});

// --- quarantine and receipts -----------------------------------------------------------------------------

const QUARANTINE = {
  repository: "X", suite: "unit", testId: "[\"a.test.js\",\"S\",\"a\"]", owner: "claudea13", reason: "known flake",
  createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-08T00:00:00Z", maxAgeDays: 7,
};

test("quarantine is a governed object with owner, reason, expiry and a bounded maximum age", () => {
  const record = q.validateQuarantine(QUARANTINE);
  assert.equal(record.created_at, "2026-01-01T00:00:00.000Z");
  assert.equal(record.expires_at, "2026-01-08T00:00:00.000Z");
  assert.equal(q.verifyQuarantine(record), record);
  assert.equal(q.validateQuarantine({ ...QUARANTINE }).quarantine_id, record.quarantine_id);
  const invalid = [
    { owner: "" }, { reason: undefined }, { createdAt: "not a date" }, { expiresAt: 5 },
    { maxAgeDays: 0 }, { maxAgeDays: q.MAX_QUARANTINE_AGE_DAYS + 1 }, { maxAgeDays: "x" },
    { expiresAt: QUARANTINE.createdAt }, { maxAgeDays: 6 },
  ];
  for (const change of invalid) assert.equal(code(() => q.validateQuarantine({ ...QUARANTINE, ...change })), "invalid-quarantine", JSON.stringify(change));
  assert.equal(code(() => q.verifyQuarantine({ ...record, owner: "someone else" })), "digest-mismatch");
  assert.equal(code(() => q.verifyQuarantine(null)), "digest-mismatch");
});

test("rejection receipts are attributable and keyed by the refused input, not the clock", () => {
  const error = new q.ObservationError("truncated", "cut off");
  const full = q.buildRejectionReceipt({ error, format: "junit-xml", text: "<a", repository: "X", suite: "unit", commitSha: SHA_A, attempt: 2, actor: "claudea13", rejectedAt: "t1" });
  const later = q.buildRejectionReceipt({ error, format: "junit-xml", text: "<a", repository: "X", suite: "unit", commitSha: SHA_A, attempt: 2, actor: "other", rejectedAt: "t2" });
  assert.equal(full.receipt_key, later.receipt_key);
  assert.equal(full.code, "truncated");
  assert.equal(full.attempt, "2");
  assert.equal(full.actor, "claudea13");
  assert.equal(full.source_digest, q.sha256Hex("<a"));
  const bare = q.buildRejectionReceipt({ error, rejectedAt: "t3" });
  assert.deepEqual([bare.adapter, bare.source_digest, bare.repository, bare.suite, bare.commit_sha, bare.attempt, bare.actor], [null, null, null, null, null, null, null]);
});

// --- derived series ----------------------------------------------------------------------------------------

function at(minute) {
  return `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
}

function suiteOf(series, suite = "unit") {
  return series.suites.find((entry) => entry.suite === suite);
}

function testOf(suite, title) {
  return suite.tests.find((entry) => entry.name_path.at(-1) === title);
}

test("retry success never erases the initial failure and flake rate uses comparable completed attempts", () => {
  const first = run({ text: jest([["a", "failed"], ["b", "passed"]]), ingestedAt: at(1) });
  const retry = run({ text: jest([["a", "passed"], ["b", "passed"]]), attempt: 2, ingestedAt: at(2) });
  const otherRuntime = run({ text: jest([["a", "passed"], ["b", "passed"]]), runtime: "node-24", ingestedAt: at(3) });
  const { series } = q.deriveSeries([first, retry, otherRuntime]);
  const unit = suiteOf(series);
  const a = testOf(unit, "a");
  assert.equal(a.groups.length, 2);
  const [group] = a.groups.filter((g) => g.evaluated);
  assert.deepEqual(group.attempts.map((x) => [x.attempt, x.outcome]), [[1, "failed"], [2, "passed"]]);
  assert.equal(group.initial_outcome, "failed");
  assert.equal(group.final_outcome, "passed");
  assert.equal(group.flaky, true);
  assert.deepEqual(a.flake, { flaky_groups: 1, evaluated_groups: 1, rate: "1.0000" });
  assert.deepEqual(testOf(unit, "b").flake, { flaky_groups: 0, evaluated_groups: 1, rate: "0.0000" });
  assert.deepEqual(unit.flake, { flaky_groups: 1, evaluated_groups: 2, rate: "0.5000" });
  assert.equal(a.observations[0].outcome, "failed", "the initial failure stays in the history");
  assert.deepEqual(unit.runs.map((r) => r.passing_evidence), [false, true, true]);
});

test("attempts from different adapters are not treated as comparable flake evidence", () => {
  const junitFailed = run({
    format: "junit-xml",
    text: "<testsuite tests='1'><testcase classname='a.test.js' name='a' time='0.01'><failure/></testcase></testsuite>",
    attempt: 1,
    ingestedAt: at(1),
  });
  const jestPassed = run({
    text: JSON.stringify({
      numTotalTests: 1,
      testResults: [{ name: "a.test.js", assertionResults: [{ ancestorTitles: [], title: "a", status: "passed", duration: 10 }] }],
    }),
    attempt: 2,
    ingestedAt: at(2),
  });
  const unit = suiteOf(q.deriveSeries([junitFailed, jestPassed]).series);
  const observation = testOf(unit, "a");
  assert.equal(observation.id, q.canonicalize(["a.test.js", "a"]));
  assert.equal(observation.groups.length, 2);
  assert.deepEqual(observation.groups.map((group) => [group.adapter.id, group.evaluated, group.flaky]), [
    ["jest-json", false, false],
    ["junit-xml", false, false],
  ]);
  assert.deepEqual(observation.observations.map((entry) => entry.adapter.id), ["junit-xml", "jest-json"]);
  assert.deepEqual(observation.flake, { flaky_groups: 0, evaluated_groups: 0, rate: null });
});

test("partial, cancelled and absent runs are excluded from flake denominators and passing evidence", () => {
  const base = run({ text: jest([["a", "failed"]]), ingestedAt: at(1) });
  const partial = run({ text: jest([["a", "passed"]], { numTotalTests: 2 }), attempt: 2, ingestedAt: at(2) });
  const cancelled = run({ text: jest([["a", "passed"]], { wasInterrupted: true }), attempt: 3, ingestedAt: at(3) });
  const absent = run({ text: null, expectMeasurement: true, attempt: 4, ingestedAt: at(4) });
  const { series } = q.deriveSeries([base, partial, cancelled, absent]);
  const unit = suiteOf(series);
  assert.deepEqual(unit.runs.map((r) => [r.run_status, r.passing_evidence]), [
    ["completed", false], ["partial", false], ["cancelled", false], ["measurement-expected-but-absent", false],
  ]);
  assert.deepEqual(testOf(unit, "a").flake, { flaky_groups: 0, evaluated_groups: 0, rate: null });
  assert.equal(testOf(unit, "a").groups[0].evaluated, false);
});

test("a renamed or removed test is reported as membership change and never as a flake", () => {
  const before = run({ text: jest([["old name", "failed"], ["kept", "passed"], ["gone", "passed"]]), ingestedAt: at(1) });
  const after = run({ text: jest([["new name", "passed"], ["kept", "passed"]]), attempt: 2, ingestedAt: at(2) });
  const { series } = q.deriveSeries([before, after]);
  const unit = suiteOf(series);
  const id = (title) => q.canonicalize(["a.test.js", "S", title]);
  assert.deepEqual(unit.membership.tests_added, [id("new name")]);
  assert.deepEqual(unit.membership.tests_removed, [id("gone"), id("old name")].sort());
  assert.equal(unit.membership.baseline_run, before.content_digest);
  assert.equal(unit.membership.latest_run, after.content_digest);
  assert.equal(unit.flake.flaky_groups, 0);
  assert.equal(testOf(unit, "new name").first_seen, after.content_digest);
  assert.equal(testOf(unit, "old name").last_seen, before.content_digest);
});

test("new-test detection compares against every earlier completed run, not only the previous one", () => {
  const one = run({ text: jest([["a", "passed"], ["b", "passed"]]), ingestedAt: at(1) });
  const two = run({ text: jest([["a", "passed"]]), commitSha: SHA_B, ingestedAt: at(2) });
  const three = run({ text: jest([["a", "passed"], ["b", "passed"], ["c", "passed"]]), commitSha: "c".repeat(40), ingestedAt: at(3) });
  const unit = suiteOf(q.deriveSeries([one, two, three]).series);
  assert.deepEqual(unit.membership.tests_added, [q.canonicalize(["a.test.js", "S", "c"])]);
  assert.deepEqual(unit.membership.tests_removed, []);
  const single = suiteOf(q.deriveSeries([one]).series);
  assert.deepEqual(single.membership, { baseline_run: null, latest_run: one.content_digest, tests_added: [], tests_removed: [] });
  const none = suiteOf(q.deriveSeries([run({ text: null, expectMeasurement: true })]).series);
  assert.equal(none.membership.latest_run, null);
});

test("suite runtime trend reports direction against the median of the preceding completed runs", () => {
  const timed = (ms, minute, extra = {}) => run({ text: jest([["a", "passed", ms]]), commitSha: SHA_B, attempt: minute, ingestedAt: at(minute), ...extra });
  const trend = (runs) => suiteOf(q.deriveSeries(runs).series).runtime_trend;
  assert.equal(trend([timed(100, 1)]).direction, "insufficient-data");
  const up = trend([timed(100, 1), timed(100, 2), timed(300, 3)]);
  assert.deepEqual([up.latest_us, up.baseline_median_us, up.delta_ratio, up.direction], [300000, 100000, "2.0000", "up"]);
  const down = trend([timed(100, 1), timed(50, 2)]);
  assert.deepEqual([down.delta_ratio, down.direction], ["-0.5000", "down"]);
  assert.equal(trend([timed(100, 1), timed(105, 2)]).direction, "flat");
  assert.equal(trend([timed(0, 1), timed(5, 2)]).direction, "insufficient-data");
  const ignored = trend([timed(100, 1), timed(900, 2, { text: jest([["a", "passed", 900]], { wasInterrupted: true }) }), timed(100, 3)]);
  assert.equal(ignored.points.length, 2, "cancelled runs do not enter the trend");
  const untimed = run({ format: "junit-xml", text: "<testsuite><testcase name='x'/></testsuite>" });
  assert.equal(suiteOf(q.deriveSeries([untimed]).series).runtime_trend.points.length, 0);
});

test("trend and membership follow report execution time when ingestion arrives out of order", () => {
  const earlierExecution = run({
    text: jest([["old", "passed", 100]], { startTime: Date.parse("2026-01-01T10:00:00Z") }),
    commitSha: SHA_A,
    attempt: 1,
    ingestedAt: "2026-01-01T10:30:00Z",
  });
  const laterExecution = run({
    text: jest([["new", "passed", 200]], { startTime: Date.parse("2026-01-01T10:10:00Z") }),
    commitSha: SHA_B,
    attempt: 1,
    ingestedAt: "2026-01-01T10:20:00Z",
  });
  const unit = suiteOf(q.deriveSeries([earlierExecution, laterExecution]).series);
  assert.deepEqual([unit.runtime_trend.latest_us, unit.runtime_trend.direction], [200000, "up"]);
  assert.equal(unit.membership.latest_run, laterExecution.content_digest);
  assert.equal(unit.membership.baseline_run, earlierExecution.content_digest);
  assert.deepEqual(unit.membership.tests_added, [q.canonicalize(["a.test.js", "S", "new"])]);
  assert.deepEqual(unit.membership.tests_removed, [q.canonicalize(["a.test.js", "S", "old"])]);
});

test("quarantine changes the effective outcome only while active and reverts after expiry", () => {
  const quarantine = q.validateQuarantine(QUARANTINE);
  const inside = run({ text: jest([["a", "failed"], ["b", "failed"]]), ingestedAt: "2026-01-02T00:00:00.000Z" });
  const quarantinedPass = run({ text: jest([["a", "passed"], ["b", "passed"]]), attempt: 2, ingestedAt: "2026-01-03T00:00:00.000Z" });
  const afterExpiry = run({ text: jest([["a", "failed"], ["b", "passed"]]), commitSha: SHA_B, ingestedAt: "2026-01-09T00:00:00.000Z" });
  const before = q.deriveSeries([inside, quarantinedPass], [quarantine]).series;
  const unitBefore = suiteOf(before);
  assert.deepEqual(testOf(unitBefore, "a").observations.map((o) => [o.outcome, o.effective_outcome]), [["failed", "quarantined"], ["passed", "quarantined"]]);
  assert.deepEqual(testOf(unitBefore, "a").quarantine, { state: "active", quarantine_ids: [quarantine.quarantine_id] });
  assert.deepEqual(testOf(unitBefore, "b").quarantine, { state: "none", quarantine_ids: [] });
  assert.deepEqual(unitBefore.runs.map((r) => [r.quarantined_failures, r.passing_evidence]), [[1, false], [0, true]]);
  assert.equal(testOf(unitBefore, "a").flake.flaky_groups, 1, "quarantine never hides flakiness from measurement");

  const after = q.deriveSeries([inside, quarantinedPass, afterExpiry], [quarantine, quarantine]).series;
  assert.equal(after.quarantine_count, 1);
  const unitAfter = suiteOf(after);
  const a = testOf(unitAfter, "a");
  assert.equal(a.observations.at(-1).effective_outcome, "failed", "an expired quarantine no longer masks a failure");
  assert.deepEqual(a.quarantine, { state: "expired", quarantine_ids: [quarantine.quarantine_id] });
  assert.equal(unitAfter.runs.at(-1).passing_evidence, false);
  const early = q.deriveSeries([run({ text: jest([["a", "failed"]]), ingestedAt: "2025-12-31T00:00:00.000Z" })], [quarantine]).series;
  assert.equal(testOf(suiteOf(early), "a").quarantine.state, "none", "a quarantine created after the run does not apply");
});

test("quarantine expiry is evaluated at execution time despite delayed report ingestion", () => {
  const execution = (startedAt, ingestedAt, attempt) => run({
    text: jest([["a", "failed"]], { startTime: Date.parse(startedAt) }),
    attempt,
    ingestedAt,
  });
  const before = execution("2025-12-31T12:00:00Z", "2026-01-02T12:00:00Z", 1);
  const during = execution("2026-01-02T12:00:00Z", "2026-01-09T12:00:00Z", 2);
  const after = execution("2026-01-09T12:00:00Z", "2026-01-10T12:00:00Z", 3);
  const unit = suiteOf(q.deriveSeries([before, during, after], [q.validateQuarantine(QUARANTINE)]).series);
  assert.deepEqual(testOf(unit, "a").observations.map((entry) => [entry.outcome, entry.effective_outcome]), [
    ["failed", "failed"],
    ["failed", "quarantined"],
    ["failed", "failed"],
  ]);
  assert.deepEqual(unit.runs.map((entry) => entry.quarantined_failures), [0, 1, 0]);
  assert.equal(testOf(unit, "a").quarantine.state, "expired");
});

test("series derivation is byte-identical regardless of input order and deduplicates repeated artifacts", () => {
  const runs = [
    run({ text: jest([["a", "failed"]]), ingestedAt: at(1) }),
    run({ text: jest([["a", "passed"]]), attempt: 2, ingestedAt: at(1) }),
    run({ text: jest([["a", "passed"]]), suite: "other", ingestedAt: at(1) }),
    run({ text: jest([["a", "passed"]]), repository: "B", ingestedAt: at(1) }),
  ];
  const forward = q.deriveSeries(runs, [q.validateQuarantine(QUARANTINE)]);
  const backward = q.deriveSeries([...runs].reverse().concat(runs[0]), [q.validateQuarantine(QUARANTINE)]);
  assert.equal(forward.bytes, backward.bytes);
  assert.equal(forward.series_digest, backward.series_digest);
  assert.equal(forward.series.run_count, 4);
  assert.deepEqual(forward.series.suites.map((s) => [s.repository, s.suite]), [["B", "unit"], ["X", "other"], ["X", "unit"]]);
  assert.equal(q.deriveSeries([]).series.suites.length, 0);
});

test("two different artifacts for one comparable attempt are refused instead of double-counted", () => {
  const one = run({ text: jest([["a", "failed"]]), ingestedAt: at(1) });
  const clash = run({ text: jest([["a", "passed"]]), ingestedAt: at(2) });
  assert.notEqual(one.content_digest, clash.content_digest);
  assert.equal(code(() => q.deriveSeries([one, clash])), "attempt-conflict");
});
