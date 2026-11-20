"use strict";

// COORD-710: temporal quality observation contract.
//
// The static quality-dimension model (QUALITY_DIMENSIONS.md section 2) is
// `scan(repoRoot, opts) -> findings[]`: it describes source at ONE commit. This
// module adds the temporal counterpart, `observe(runArtifact) -> series entries`,
// keyed by a stable test identity instead of a file path. It is pure: no file
// system, no clock, no journal. The store and the `gov observe` verb live in
// quality-observation-store.js.
//
// Canonical form (the content identity of every artifact, series and receipt):
//   - JSON with object keys sorted by UTF-16 code unit order (the ECMAScript
//     default sort), no insignificant whitespace, files terminated by "\n";
//   - every string (keys included) NFC-normalized; lone surrogates refused;
//   - numbers are safe integers only. Durations are integer microseconds,
//     ratios are fixed four-decimal strings, so no float formatting enters a
//     digest;
//   - wall-clock values (report timestamps, ingestion time) live in
//     `provenance` and never in `content`, so they never change content_digest.
//
// Stable test identity: id = canonical JSON of [locator, ...name_path]. The
// locator is the runner's own module locator when the format carries one
// (pytest nodeid file part, JUnit classname, Jest file relative to a declared
// source root) and "" for Node TAP. Absolute or escaping locators are refused.
// Identity is exact: a rename is one removed id plus one added id, never a flake.

const crypto = require("node:crypto");
const path = require("node:path");
const { resolveEngineModule } = require("../../paths.js");
// COORD-705 owns the no-measurement distinction. It is reused, not re-typed.
const { classifyCoverage } = require(resolveEngineModule(path.resolve(__dirname, "../.."), "scripts/coverage-policy.js"));

const OBSERVATION_SCHEMA = "concord.quality-observation.run/v1";
const SERIES_SCHEMA = "concord.quality-observation.series/v1";
const QUARANTINE_SCHEMA = "concord.quality-observation.quarantine/v1";
const REJECTION_SCHEMA = "concord.quality-observation.rejection/v1";
const ADAPTER_CONTRACT_VERSION = 1;
const MAX_QUARANTINE_AGE_DAYS = 90;
const RUN_STATUSES = Object.freeze(["completed", "partial", "cancelled", "no-tests", "measurement-expected-but-absent"]);
const TEST_OUTCOMES = Object.freeze(["passed", "failed", "skipped", "cancelled"]);
const EFFECTIVE_OUTCOMES = Object.freeze([...TEST_OUTCOMES, "quarantined"]);

class ObservationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ObservationError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new ObservationError(code, message);
}

// --- canonical form ---------------------------------------------------------

function normalizeText(value) {
  if (!value.isWellFormed()) reject("malformed", "text contains a lone UTF-16 surrogate");
  return value.normalize("NFC");
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(normalizeText(value));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) reject("non-canonical-value", `number ${value} is not a safe integer`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    reject("non-canonical-value", `${typeof value} values have no canonical form`);
  }
  const entries = new Map();
  for (const key of Object.keys(value)) {
    const normalized = normalizeText(key);
    if (entries.has(normalized)) reject("non-canonical-value", `keys collide after NFC normalization: ${normalized}`);
    entries.set(normalized, value[key]);
  }
  const keys = [...entries.keys()].sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(entries.get(key))}`).join(",")}}`;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalBytes(value) {
  return `${canonicalize(value)}\n`;
}

// --- durations ---------------------------------------------------------------

const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const UNIT_EXPONENT = Object.freeze({ s: 6, ms: 3 });

// Exact decimal -> integer microseconds, round half up. A JSON number is read
// through String(), whose shortest round-trip form is fixed by ECMAScript, so
// the same report yields the same microseconds on every supported runtime.
function decimalToMicros(raw, unit) {
  const text = String(raw).trim();
  const match = DECIMAL.exec(text);
  if (!match) reject("malformed", `duration ${JSON.stringify(text)} is not a non-negative decimal`);
  const fraction = match[2] || "";
  const exponent = Number(match[3] || 0) - fraction.length + UNIT_EXPONENT[unit];
  if (exponent > 15) reject("malformed", `duration ${JSON.stringify(text)} is out of range`);
  if (exponent < -40) return 0;
  const digits = BigInt(match[1] + fraction);
  let micros;
  if (exponent >= 0) {
    micros = digits * 10n ** BigInt(exponent);
  } else {
    const divisor = 10n ** BigInt(-exponent);
    micros = (digits * 2n + divisor) / (2n * divisor);
  }
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) reject("malformed", `duration ${JSON.stringify(text)} is out of range`);
  return Number(micros);
}

function formatRatio(numerator, denominator) {
  if (denominator === 0) return null;
  const negative = numerator < 0;
  const scaled = (BigInt(Math.abs(numerator)) * 20000n + BigInt(denominator)) / (2n * BigInt(denominator));
  return `${negative ? "-" : ""}${scaled / 10000n}.${String(scaled % 10000n).padStart(4, "0")}`;
}

// --- locators ----------------------------------------------------------------

function normalizeLocator(raw, sourceRoot) {
  let locator = normalizeText(raw).split("\\").join("/");
  if (sourceRoot) {
    const root = `${normalizeText(sourceRoot).split("\\").join("/").replace(/\/+$/, "")}/`;
    if (locator.startsWith(root)) locator = locator.slice(root.length);
  }
  if (locator.startsWith("/") || /^[A-Za-z]:\//.test(locator) || locator.split("/").includes("..")) {
    reject("unstable-test-identity", `locator ${JSON.stringify(locator)} is absolute or escapes the source root; pass --source-root`);
  }
  return locator;
}

// --- adapter: Node test runner TAP (the template runner's native report) -----

// Lookup tables have no prototype so inherited keys ("constructor", "__proto__")
// can never be mistaken for an entity, a status or an outcome.
const TAP_ESCAPES = Object.freeze({ __proto__: null, n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" });
const TAP_POINT = /^(not ok|ok) \d+(?: - (.*))?$/;

function unescapeTap(text) {
  return text.replace(/\\(.)/g, (_, ch) => TAP_ESCAPES[ch] ?? ch);
}

function splitTapDirective(rest) {
  const match = / # (SKIP|TODO)\b.*$/.exec(rest);
  return match
    ? { name: unescapeTap(rest.slice(0, match.index)), directive: match[1] }
    : { name: unescapeTap(rest), directive: null };
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// Reads the YAML diagnostic block that may follow the test point at `index`.
// Returns the flat key/value pairs Node writes at block level and the index of
// the block's closing "..." line (or `index` itself when there is no block).
function readTapYaml(lines, index, indent, name) {
  const yaml = {};
  if ((lines[index + 1] || "").trim() !== "---") return { yaml, end: index };
  const yamlIndent = indent + 2;
  for (let i = index + 2; i < lines.length; i += 1) {
    if (lines[i].trim() === "..." && indentOf(lines[i]) === yamlIndent) return { yaml, end: i };
    const pair = /^([A-Za-z_]+): '?(.*?)'?$/.exec(lines[i].slice(yamlIndent));
    if (pair) yaml[pair[1]] = pair[2];
  }
  return reject("truncated", `TAP diagnostic block for ${JSON.stringify(name)} is not terminated`);
}

function scanTapLines(lines) {
  const open = [];
  const scan = { points: [], topLevelPlan: null, summaryTests: null };
  for (let i = 1; i < lines.length; i += 1) {
    const indent = indentOf(lines[i]);
    const body = lines[i].trim();
    const depth = indent / 4;
    const plan = /^1\.\.(\d+)$/.exec(body);
    const summary = /^# tests (\d+)$/.exec(body);
    if (body.startsWith("# Subtest: ")) {
      open[depth] = unescapeTap(body.slice("# Subtest: ".length));
      open.length = depth + 1;
    } else if (summary) {
      scan.summaryTests = Number(summary[1]);
    } else if (plan && indent === 0) {
      scan.topLevelPlan = Number(plan[1]);
    } else if (body !== "" && !body.startsWith("#") && !plan) {
      const point = TAP_POINT.exec(body);
      if (!point || !Number.isInteger(depth)) reject("malformed", `unrecognized TAP line ${i + 1}: ${JSON.stringify(body.slice(0, 120))}`);
      const { name, directive } = splitTapDirective(point[2] || "");
      const { yaml, end } = readTapYaml(lines, i, indent, name);
      i = end;
      scan.points.push({ depth, path: [...open.slice(0, depth), name], ok: point[1] === "ok", directive, yaml });
    }
  }
  return scan;
}

function tapPointToTest(point) {
  if (point.yaml.duration_ms === undefined) reject("malformed", `TAP point ${JSON.stringify(point.path.at(-1))} has no duration_ms`);
  let outcome = point.ok ? "passed" : "failed";
  if (point.directive) outcome = "skipped";
  if (point.yaml.failureType === "cancelledByParent") outcome = "cancelled";
  return { locator: "", name_path: point.path, outcome, duration_us: decimalToMicros(point.yaml.duration_ms, "ms") };
}

function parseNodeTap(text) {
  const lines = text.split(/\r?\n/);
  const version = /^TAP version (\S+)$/.exec(lines[0]);
  if (!version) reject("malformed", "missing TAP version header");
  if (version[1] !== "13") reject("unsupported-version", `TAP version ${version[1]} is not supported (adapter accepts 13)`);
  const { points, topLevelPlan, summaryTests } = scanTapLines(lines);
  const topLevel = points.filter((point) => point.depth === 0).length;
  if (topLevelPlan === null || summaryTests === null) reject("truncated", "TAP report has no final plan or test-count summary");
  if (topLevelPlan !== topLevel) reject("truncated", `TAP plan declares ${topLevelPlan} top-level points but ${topLevel} were reported`);
  // Suites are containers. A test with subtests is itself a node:test test and
  // is counted by Node's own summary, so it stays an observation.
  const tests = points.filter((point) => point.yaml.type !== "suite").map(tapPointToTest);
  if (summaryTests !== tests.length) reject("malformed", `TAP summary declares ${summaryTests} tests but ${tests.length} were reported`);
  return {
    format_version: "tap-13",
    tests,
    signals: { cancelled: tests.some((test) => test.outcome === "cancelled"), partial: false },
    wall_clock: { started_at: null },
  };
}

// --- adapter: JUnit XML --------------------------------------------------------

const XML_ENTITIES = Object.freeze({ __proto__: null, lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" });
const XML_TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const XML_ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeXmlEntities(value) {
  return value.replace(/&(?:#x([0-9a-fA-F]{1,6});|#([0-9]{1,7});|([a-z]+);)?/g, (all, hex, dec, named) => {
    const codePoint = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    if (named !== undefined && XML_ENTITIES[named] !== undefined) return XML_ENTITIES[named];
    if ((hex !== undefined || dec !== undefined) && codePoint <= 0x10ffff) return String.fromCodePoint(codePoint);
    return reject("malformed", `invalid XML entity ${JSON.stringify(all)}`);
  });
}

const XML_SKIPPED_MARKUP = Object.freeze([["<?", "?>", "declaration"], ["<!--", "-->", "comment"], ["<![CDATA[", "]]>", "CDATA section"]]);

// Returns the offset after a declaration, comment or CDATA section starting at
// `lt`, or -1 when `lt` starts an element tag.
function skipXmlMarkup(text, lt) {
  for (const [open, close, what] of XML_SKIPPED_MARKUP) {
    if (!text.startsWith(open, lt)) continue;
    const end = text.indexOf(close, lt);
    if (end === -1) reject("truncated", `unterminated XML ${what}`);
    return end + close.length;
  }
  if (text.startsWith("<!", lt)) reject("unsupported-format", "XML DOCTYPE and markup declarations are not supported");
  return -1;
}

function openXmlElement(doc, name, rawAttributes, selfClosing) {
  const attributes = {};
  for (const attribute of rawAttributes.matchAll(XML_ATTRIBUTE)) {
    attributes[attribute[1]] = decodeXmlEntities(attribute[2] ?? attribute[3]);
  }
  const element = { name, attributes, children: [] };
  if (doc.stack.length > 0) doc.stack.at(-1).children.push(element);
  else if (doc.root) reject("malformed", "XML document has more than one root element");
  else doc.root = element;
  if (!selfClosing) doc.stack.push(element);
}

function closeXmlElement(doc, name) {
  const top = doc.stack.pop();
  if (!top || top.name !== name) reject("malformed", `unexpected closing tag </${name}>`);
}

// A deliberately small, strict XML reader: elements and attributes only. Text
// and CDATA are skipped (no JUnit field in the model needs them); DOCTYPE is
// refused so no entity expansion can occur.
function parseXml(text) {
  const doc = { root: null, stack: [] };
  let i = 0;
  for (let lt = text.indexOf("<"); lt !== -1; lt = text.indexOf("<", i)) {
    i = skipXmlMarkup(text, lt);
    if (i !== -1) continue;
    XML_TAG.lastIndex = lt;
    const tag = XML_TAG.exec(text);
    if (!tag) reject(text.indexOf(">", lt) === -1 ? "truncated" : "malformed", `invalid XML tag at offset ${lt}`);
    i = XML_TAG.lastIndex;
    const [, closing, name, rawAttributes, selfClosing] = tag;
    if (closing) closeXmlElement(doc, name);
    else openXmlElement(doc, name, rawAttributes, selfClosing);
  }
  if (!doc.root || doc.stack.length > 0) reject("truncated", "XML document ends before its root element closes");
  return doc.root;
}

function collectJUnitSuite(suite, sourceRoot, tests, flags) {
  const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  let childPartial = false;
  for (const child of suite.children) {
    if (child.name === "testsuite") {
      const nested = collectJUnitSuite(child, sourceRoot, tests, flags);
      for (const field of Object.keys(counts)) counts[field] += nested.counts[field];
      childPartial ||= nested.partial;
    } else if (child.name === "testcase") {
      counts.tests += 1;
      const { name, classname, time } = child.attributes;
      if (!name) reject("malformed", "JUnit testcase has no name attribute");
      const kinds = new Set(child.children.map((element) => element.name));
      let outcome = "passed";
      if (kinds.has("skipped")) outcome = "skipped";
      if (kinds.has("failure") || kinds.has("error")) outcome = "failed";
      if (kinds.has("failure")) counts.failures += 1;
      if (kinds.has("error")) counts.errors += 1;
      if (kinds.has("skipped")) counts.skipped += 1;
      tests.push({
        locator: normalizeLocator(classname || "", sourceRoot),
        name_path: [name],
        outcome,
        duration_us: time === undefined ? null : decimalToMicros(time, "s"),
      });
    }
  }
  const declared = optionalXmlCount(suite.attributes.tests, "tests");
  const incomplete = childPartial || (declared !== undefined && declared > counts.tests);
  const counterLimit = declared === undefined ? counts.tests : declared;
  for (const field of ["failures", "errors", "skipped"]) {
    const value = optionalXmlCount(suite.attributes[field], field);
    if (value !== undefined && value > counterLimit) reject("malformed", `JUnit ${field} exceeds tests in its suite`);
    reconcileOutcomeSummary(counts[field], value, incomplete, `JUnit ${field}`);
  }
  if (declared !== undefined && declared < counts.tests) reject("malformed", `JUnit suite declares ${declared} tests but ${counts.tests} were reported`);
  if (incomplete) flags.partial = true;
  if (flags.startedAt === null && suite.attributes.timestamp) flags.startedAt = suite.attributes.timestamp;
  return { counts, partial: incomplete };
}

function parseJUnitXml(text, { sourceRoot } = {}) {
  const root = parseXml(text);
  if (root.name !== "testsuites" && root.name !== "testsuite") {
    reject("unsupported-format", `JUnit root element <${root.name}> is not <testsuites> or <testsuite>`);
  }
  const tests = [];
  const flags = { partial: false, startedAt: null };
  collectJUnitSuite(root, sourceRoot, tests, flags);
  return {
    format_version: `junit-xml/${root.name}`,
    tests,
    signals: { cancelled: false, partial: flags.partial },
    wall_clock: { started_at: flags.startedAt },
  };
}

// --- adapter: Jest --json --------------------------------------------------------

const JEST_OUTCOMES = Object.freeze({
  __proto__: null,
  passed: "passed", failed: "failed", pending: "skipped", skipped: "skipped", todo: "skipped", disabled: "skipped",
});

// ECMAScript Date range; anything outside it is not a usable report timestamp.
const MAX_DATE_MILLIS = 8.64e15;

function isoFromMillis(millis) {
  return Number.isFinite(millis) && Math.abs(millis) <= MAX_DATE_MILLIS ? new Date(millis).toISOString() : null;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return reject("malformed", `${label} is not valid JSON (${error.name})`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalCount(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) reject("malformed", `${label} must be a non-negative safe integer`);
  return value;
}

function reconcileOutcomeSummary(actual, reported, incomplete, label) {
  if (reported === undefined) return;
  if (reported < actual) reject("malformed", `${label} is lower than the reported test outcomes`);
  if (reported > actual && !incomplete) reject("malformed", `${label} does not match the reported test outcomes`);
}

function optionalXmlCount(value, label) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) reject("malformed", `JUnit ${label} must be a non-negative integer`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) reject("malformed", `JUnit ${label} is out of range`);
  return count;
}

function parseJestJson(text, { sourceRoot } = {}) {
  const report = parseJson(text, "Jest report");
  if (!isPlainObject(report) || !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < 0 || !Array.isArray(report.testResults)) {
    reject("malformed", "Jest report needs numTotalTests and testResults");
  }
  if (report.wasInterrupted !== undefined && typeof report.wasInterrupted !== "boolean") {
    reject("malformed", "Jest wasInterrupted must be a boolean when present");
  }
  if (report.success !== undefined && typeof report.success !== "boolean") {
    reject("malformed", "Jest success must be a boolean when present");
  }
  const summarizedTests = Object.create(null);
  for (const field of ["numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"]) {
    const count = optionalCount(report[field], `Jest ${field}`);
    if (count !== undefined && count > report.numTotalTests) reject("malformed", `Jest ${field} exceeds numTotalTests`);
    summarizedTests[field] = count;
  }
  const reportedTestTotal = ["numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"]
    .reduce((sum, field) => sum + (summarizedTests[field] || 0), 0);
  if (reportedTestTotal > report.numTotalTests) reject("malformed", "Jest outcome counts exceed numTotalTests");
  const summarizedSuites = Object.create(null);
  for (const field of ["numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites", "numRuntimeErrorTestSuites"]) {
    summarizedSuites[field] = optionalCount(report[field], `Jest ${field}`);
    if (summarizedSuites[field] !== undefined && summarizedSuites.numTotalTestSuites !== undefined &&
        summarizedSuites[field] > summarizedSuites.numTotalTestSuites) {
      reject("malformed", `Jest ${field} exceeds numTotalTestSuites`);
    }
  }
  const tests = [];
  const outcomeCounts = { numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
  const suiteCounts = { numPassedTestSuites: 0, numFailedTestSuites: 0, numPendingTestSuites: 0 };
  for (const file of report.testResults) {
    if (!isPlainObject(file) || typeof file.name !== "string" || !Array.isArray(file.assertionResults)) {
      reject("malformed", "Jest testResults entries need name and assertionResults");
    }
    if (file.status !== undefined) {
      if (!["passed", "failed", "pending"].includes(file.status)) reject("malformed", "Jest testResults status must be passed, failed or pending");
      suiteCounts[`num${file.status[0].toUpperCase()}${file.status.slice(1)}TestSuites`] += 1;
    }
    const locator = normalizeLocator(file.name, sourceRoot);
    for (const assertion of file.assertionResults) {
      const outcome = isPlainObject(assertion) ? JEST_OUTCOMES[assertion.status] : undefined;
      if (!outcome || typeof assertion.title !== "string") reject("malformed", "Jest assertion needs a title and a known status");
      if (assertion.ancestorTitles !== undefined && (!Array.isArray(assertion.ancestorTitles) || assertion.ancestorTitles.some((title) => typeof title !== "string"))) {
        reject("malformed", "Jest assertion ancestorTitles must be an array of strings when present");
      }
      if (assertion.status === "passed") outcomeCounts.numPassedTests += 1;
      else if (assertion.status === "failed") outcomeCounts.numFailedTests += 1;
      else if (assertion.status === "todo") outcomeCounts.numTodoTests += 1;
      else outcomeCounts.numPendingTests += 1;
      tests.push({
        locator,
        name_path: [...(assertion.ancestorTitles === undefined ? [] : assertion.ancestorTitles), assertion.title],
        outcome,
        duration_us: assertion.duration == null ? null : decimalToMicros(assertion.duration, "ms"),
      });
    }
  }
  if (tests.length > report.numTotalTests) reject("malformed", `Jest reports ${tests.length} assertions but numTotalTests is ${report.numTotalTests}`);
  const suitesIncomplete = summarizedSuites.numTotalTestSuites !== undefined && report.testResults.length < summarizedSuites.numTotalTestSuites;
  if (summarizedSuites.numTotalTestSuites !== undefined && report.testResults.length > summarizedSuites.numTotalTestSuites) {
    reject("malformed", "Jest testResults exceed numTotalTestSuites");
  }
  const incomplete = report.wasInterrupted === true || tests.length < report.numTotalTests || suitesIncomplete;
  for (const field of Object.keys(outcomeCounts)) reconcileOutcomeSummary(outcomeCounts[field], summarizedTests[field], incomplete, `Jest ${field}`);
  for (const field of Object.keys(suiteCounts)) reconcileOutcomeSummary(suiteCounts[field], summarizedSuites[field], incomplete, `Jest ${field}`);
  const failedSuiteWithoutFailedAssertion = suiteCounts.numFailedTestSuites > 0 && outcomeCounts.numFailedTests === 0;
  const runtimeErrorSuite = (summarizedSuites.numRuntimeErrorTestSuites || 0) > 0;
  const failedSuite = suiteCounts.numFailedTestSuites > 0 || (summarizedSuites.numFailedTestSuites || 0) > 0;
  if (report.success === true && (outcomeCounts.numFailedTests > 0 || failedSuite || runtimeErrorSuite)) {
    reject("malformed", "Jest success=true contradicts failed test or suite results");
  }
  return {
    format_version: "jest-json/1",
    tests,
    signals: { cancelled: report.wasInterrupted === true, partial: tests.length < report.numTotalTests || suitesIncomplete || failedSuiteWithoutFailedAssertion || runtimeErrorSuite || (report.success === false && outcomeCounts.numFailedTests === 0) },
    wall_clock: { started_at: isoFromMillis(report.startTime) },
  };
}

// --- adapter: pytest-json-report -------------------------------------------------

const PYTEST_OUTCOMES = Object.freeze({
  __proto__: null,
  passed: "passed", failed: "failed", error: "failed", skipped: "skipped", xfailed: "skipped", xpassed: "passed",
});

function parsePytestJson(text, { sourceRoot } = {}) {
  const report = parseJson(text, "pytest report");
  if (!isPlainObject(report) || !Array.isArray(report.tests) || !Number.isSafeInteger(report.exitcode) || report.exitcode < 0 || report.exitcode > 5) {
    reject("malformed", "pytest-json-report needs tests and exitcode");
  }
  if (report.summary !== undefined && !isPlainObject(report.summary)) reject("malformed", "pytest summary must be an object when present");
  const tests = [];
  const outcomeCounts = { passed: 0, failed: 0, skipped: 0, xfailed: 0, xpassed: 0, error: 0, total: 0 };
  for (const entry of report.tests) {
    const outcome = isPlainObject(entry) ? PYTEST_OUTCOMES[entry.outcome] : undefined;
    const parts = outcome && typeof entry.nodeid === "string" ? entry.nodeid.split("::") : [];
    if (parts.length < 2) reject("malformed", "pytest test needs a nodeid of the form path::name and a known outcome");
    let duration = 0;
    for (const stage of ["setup", "call", "teardown"]) {
      if (isPlainObject(entry[stage]) && entry[stage].duration !== undefined) duration += decimalToMicros(entry[stage].duration, "s");
    }
    tests.push({ locator: normalizeLocator(parts[0], sourceRoot), name_path: parts.slice(1), outcome, duration_us: duration });
    outcomeCounts[entry.outcome] += 1;
    outcomeCounts.total += 1;
  }
  const summary = report.summary || {};
  const collected = optionalCount(summary.collected, "pytest summary.collected");
  const deselected = optionalCount(summary.deselected, "pytest summary.deselected");
  for (const field of ["passed", "failed", "skipped", "xfailed", "xpassed", "error", "total"]) {
    const count = optionalCount(summary[field], `pytest summary.${field}`);
    if (count !== undefined && collected !== undefined && count > collected) reject("malformed", `pytest summary.${field} exceeds collected`);
  }
  if (deselected !== undefined && collected === undefined) reject("malformed", "pytest summary.deselected requires summary.collected");
  if (collected !== undefined && deselected !== undefined && deselected > collected) reject("malformed", "pytest summary.deselected exceeds collected");
  const expected = collected === undefined ? tests.length : collected - (deselected || 0);
  if (tests.length > expected) reject("malformed", `pytest reports ${tests.length} tests but summary declares ${expected} selected tests`);
  if (summary.total !== undefined && summary.total < tests.length) reject("malformed", "pytest summary.total is smaller than the reported tests");
  if (summary.total !== undefined && summary.total > expected) reject("malformed", "pytest summary.total exceeds the selected test count");
  if (report.exitcode === 5 && (collected > 0 || tests.length > 0)) reject("malformed", "pytest exitcode 5 means no tests were collected");
  if (report.exitcode === 0 && (outcomeCounts.failed > 0 || outcomeCounts.error > 0)) {
    reject("malformed", "pytest exitcode 0 contradicts failed or error test outcomes");
  }
  if (report.exitcode === 1 && outcomeCounts.failed === 0 && outcomeCounts.error === 0) {
    reject("malformed", "pytest exitcode 1 has no failed or error test outcomes");
  }
  const incomplete = report.exitcode === 2 || report.exitcode === 3 || report.exitcode === 4 || expected > tests.length;
  for (const field of Object.keys(outcomeCounts)) reconcileOutcomeSummary(outcomeCounts[field], summary[field], incomplete, `pytest summary.${field}`);
  return {
    format_version: "pytest-json-report/1",
    tests,
    signals: {
      cancelled: report.exitcode === 2,
      partial: report.exitcode === 3 || report.exitcode === 4 || expected > tests.length,
    },
    wall_clock: { started_at: isoFromMillis(Math.round(report.created * 1000)) },
  };
}

// --- adapter contract --------------------------------------------------------------

// Versioned adapter contract (ADAPTER_CONTRACT_VERSION = 1). An adapter is
// { id, contract_version, parse(text, { sourceRoot }) } and parse returns
// { format_version, tests: [{ locator, name_path[], outcome, duration_us|null }],
//   signals: { cancelled, partial }, wall_clock: { started_at|null } }, or throws
// an ObservationError whose code is the attributable rejection reason.
const ADAPTERS = Object.freeze({
  "node-test-tap": Object.freeze({ id: "node-test-tap", contract_version: ADAPTER_CONTRACT_VERSION, parse: parseNodeTap }),
  "junit-xml": Object.freeze({ id: "junit-xml", contract_version: ADAPTER_CONTRACT_VERSION, parse: parseJUnitXml }),
  "jest-json": Object.freeze({ id: "jest-json", contract_version: ADAPTER_CONTRACT_VERSION, parse: parseJestJson }),
  "pytest-json": Object.freeze({ id: "pytest-json", contract_version: ADAPTER_CONTRACT_VERSION, parse: parsePytestJson }),
});

function getAdapter(format) {
  const adapter = Object.hasOwn(ADAPTERS, format) ? ADAPTERS[format] : null;
  if (!adapter) reject("unsupported-format", `no observation adapter for format ${JSON.stringify(format)}; supported: ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}

// --- run normalization ---------------------------------------------------------------

function requireIdentityText(value, label) {
  if (typeof value !== "string" || value.trim() === "") reject("invalid-run-identity", `${label} is required`);
  return normalizeText(value.trim());
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?)?$/i;

function normalizeTimestamp(value, label, errorCode = "malformed-timestamp") {
  if (typeof value !== "string" || value.trim() === "") reject(errorCode, `${label} must be an ISO-8601 timestamp`);
  const text = value.trim();
  const match = ISO_TIMESTAMP.exec(text);
  if (!match) reject(errorCode, `${label} must be an ISO-8601 timestamp`);
  const [, yearText, monthText, dayText, hourText = "00", minuteText = "00", secondText = "00", , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInMonth = daysByMonth[month - 1] || 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    reject(errorCode, `${label} is not a valid calendar timestamp`);
  }
  const normalizedInput = text.includes("T") || text.includes("t")
    ? (zone ? text.replace(/z$/i, "Z") : `${text}Z`)
    : `${text}T00:00:00Z`;
  const millis = Date.parse(normalizedInput);
  if (!Number.isFinite(millis)) reject(errorCode, `${label} is not a valid calendar timestamp`);
  return new Date(millis).toISOString();
}

function validateRunIdentity(input) {
  const commitSha = String(input.commitSha || "").trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)) reject("invalid-run-identity", "commit sha must be 40 or 64 hex characters");
  const attempt = input.attempt === undefined ? 1 : Number(input.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) reject("invalid-run-identity", "attempt must be a positive integer");
  return {
    repository: requireIdentityText(input.repository, "repository"),
    suite: requireIdentityText(input.suite, "suite"),
    commit_sha: commitSha,
    runtime: requireIdentityText(input.runtime, "runtime identity"),
    attempt,
  };
}

function countOutcomes(tests) {
  const counts = { tests: tests.length, passed: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const test of tests) counts[test.outcome] += 1;
  return counts;
}

function classifyRunStatus(tests, signals, measurement) {
  if (measurement.reason !== null) return measurement.reason;
  if (signals.cancelled) return "cancelled";
  if (signals.partial) return "partial";
  return "completed";
}

// observe(runArtifact): normalize one runner report into an immutable artifact.
// `text === null` means the report itself is absent. Zero-measurement outcomes
// are classified by COORD-705 classifyCoverage: a report that is absent, or
// that carries no tests while measurement was expected, is
// "measurement-expected-but-absent" (COORD-705 result "missing"); zero tests with
// nothing expected is "no-tests"; an absent report with nothing expected has
// nothing to observe and is refused.
function normalizeRun(input) {
  const adapter = getAdapter(input.format);
  const identity = validateRunIdentity(input);
  const expectMeasurement = input.expectMeasurement === true;
  const absent = input.text === null || input.text === undefined;
  const parsed = absent
    ? { format_version: null, tests: [], signals: { cancelled: false, partial: false }, wall_clock: { started_at: null } }
    : adapter.parse(input.text, { sourceRoot: input.sourceRoot || null });
  // The expectation is only consulted when nothing was measured, so it only
  // enters content identity when it changes the classification.
  let measurement = { expected: null, reason: null, coord705_result: null };
  if (parsed.tests.length === 0) {
    const coverage = classifyCoverage({ metrics: {}, testsTotal: absent || expectMeasurement ? null : 0, expectMeasurement });
    if (coverage.reason === "no-coverage-data") reject("report-absent", "the report is absent and no measurement was expected; nothing to observe");
    measurement = { expected: expectMeasurement, reason: coverage.reason, coord705_result: coverage.result };
  }
  const tests = parsed.tests
    .map((test) => {
      const locator = normalizeText(test.locator);
      const namePath = test.name_path.map((segment) => normalizeText(segment));
      return { id: canonicalize([locator, ...namePath]), locator, name_path: namePath, outcome: test.outcome, duration_us: test.duration_us };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < tests.length; i += 1) {
    if (tests[i].id === tests[i - 1].id) reject("duplicate-test-identity", `test ${tests[i].id} appears more than once in one run`);
  }
  const durations = tests.map((test) => test.duration_us).filter((value) => value !== null);
  const content = {
    schema: OBSERVATION_SCHEMA,
    adapter: { id: adapter.id, contract_version: adapter.contract_version, format_version: parsed.format_version },
    ...identity,
    run_status: classifyRunStatus(tests, parsed.signals, measurement),
    measurement,
    counts: countOutcomes(tests),
    duration_us: durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) : null,
    tests,
  };
  return {
    schema: OBSERVATION_SCHEMA,
    content_digest: sha256Hex(canonicalize(content)),
    content,
    provenance: {
      source_digest: absent ? null : sha256Hex(input.text),
      source_root: input.sourceRoot || null,
      started_at: parsed.wall_clock.started_at === null
        ? null
        : normalizeTimestamp(parsed.wall_clock.started_at, "report start time"),
      ingested_at: (() => {
        if (typeof input.ingestedAt !== "string" || input.ingestedAt.trim() === "") {
          reject("invalid-run-identity", "ingestion time is required");
        }
        return normalizeTimestamp(input.ingestedAt, "ingestion time");
      })(),
    },
  };
}

function verifyArtifact(artifact) {
  if (!isPlainObject(artifact) || artifact.schema !== OBSERVATION_SCHEMA || !isPlainObject(artifact.content)) {
    reject("digest-mismatch", "artifact is not a quality observation run artifact");
  }
  const recomputed = sha256Hex(canonicalize(artifact.content));
  if (recomputed !== artifact.content_digest) {
    reject("digest-mismatch", `artifact content digest ${artifact.content_digest} does not match recomputed ${recomputed}`);
  }
  return artifact;
}

function artifactBytes(artifact) {
  return canonicalBytes(artifact);
}

// A run is passing evidence only when it completed and nothing failed. No-tests,
// measurement-expected-but-absent, partial and cancelled runs never are.
function isPassingEvidence(artifact) {
  const { content } = artifact;
  return content.run_status === "completed" && content.counts.failed === 0 && content.counts.cancelled === 0;
}

// --- quarantine -----------------------------------------------------------------------

function isoTime(value, label) {
  return normalizeTimestamp(value, label, "invalid-quarantine");
}

function quarantineText(value, label) {
  if (typeof value !== "string" || value.trim() === "") reject("invalid-quarantine", `${label} is required`);
  return normalizeText(value.trim());
}

function validateQuarantine(input) {
  const createdAt = isoTime(input.createdAt, "created_at");
  const expiresAt = isoTime(input.expiresAt, "expires_at");
  const maxAgeDays = Number(input.maxAgeDays);
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > MAX_QUARANTINE_AGE_DAYS) {
    reject("invalid-quarantine", `max_age_days must be an integer from 1 to ${MAX_QUARANTINE_AGE_DAYS}`);
  }
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0) reject("invalid-quarantine", "expires_at must be later than created_at");
  if (lifetime > maxAgeDays * 86400000) reject("invalid-quarantine", `expires_at exceeds the ${maxAgeDays}-day maximum age`);
  const quarantine = {
    schema: QUARANTINE_SCHEMA,
    repository: quarantineText(input.repository, "repository"),
    suite: quarantineText(input.suite, "suite"),
    test_id: quarantineText(input.testId, "test id"),
    owner: quarantineText(input.owner, "owner"),
    reason: quarantineText(input.reason, "reason"),
    created_at: createdAt,
    expires_at: expiresAt,
    max_age_days: maxAgeDays,
  };
  return { ...quarantine, quarantine_id: sha256Hex(canonicalize(quarantine)) };
}

function verifyQuarantine(record) {
  const { quarantine_id: id, ...body } = isPlainObject(record) ? record : {};
  if (body.schema !== QUARANTINE_SCHEMA || sha256Hex(canonicalize(body)) !== id) {
    reject("digest-mismatch", "quarantine record does not match its quarantine_id");
  }
  return record;
}

// --- rejection receipts -------------------------------------------------------------------

function buildRejectionReceipt({ error, format, text, repository, suite, commitSha, attempt, actor, rejectedAt }) {
  const subject = {
    schema: REJECTION_SCHEMA,
    code: error.code,
    adapter: format || null,
    source_digest: typeof text === "string" ? sha256Hex(text) : null,
    repository: repository || null,
    suite: suite || null,
    commit_sha: commitSha || null,
    attempt: attempt === undefined ? null : String(attempt),
  };
  return {
    ...subject,
    receipt_key: sha256Hex(canonicalize(subject)),
    message: error.message,
    actor: actor || null,
    rejected_at: rejectedAt,
  };
}

// --- derived series --------------------------------------------------------------------------

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRuns(a, b) {
  return compareText(a.provenance.started_at || a.provenance.ingested_at, b.provenance.started_at || b.provenance.ingested_at) ||
    a.content.attempt - b.content.attempt ||
    compareText(a.content_digest, b.content_digest);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function runtimeTrend(points) {
  if (points.length < 2) return { points, latest_us: null, baseline_median_us: null, delta_ratio: null, direction: "insufficient-data" };
  const latest = points.at(-1).duration_us;
  const baseline = median(points.slice(-6, -1).map((point) => point.duration_us));
  if (baseline === 0) return { points, latest_us: latest, baseline_median_us: 0, delta_ratio: null, direction: "insufficient-data" };
  const delta = latest - baseline;
  let direction = "flat";
  if (delta * 10 > baseline) direction = "up";
  if (-delta * 10 > baseline) direction = "down";
  return { points, latest_us: latest, baseline_median_us: baseline, delta_ratio: formatRatio(delta, baseline), direction };
}

function activeQuarantines(quarantines, run, testId) {
  const observedAt = run.provenance.started_at || run.provenance.ingested_at;
  return quarantines.filter((q) => q.repository === run.content.repository && q.suite === run.content.suite &&
    q.test_id === testId && q.created_at <= observedAt && observedAt < q.expires_at);
}

function quarantineState(quarantines, run, testId) {
  const observedAt = run.provenance.started_at || run.provenance.ingested_at;
  const matching = quarantines.filter((q) => q.repository === run.content.repository && q.suite === run.content.suite && q.test_id === testId);
  const active = activeQuarantines(matching, run, testId);
  if (active.length > 0) return { state: "active", quarantine_ids: active.map((q) => q.quarantine_id).sort() };
  const expired = matching.filter((q) => q.expires_at <= observedAt);
  if (expired.length > 0) return { state: "expired", quarantine_ids: expired.map((q) => q.quarantine_id).sort() };
  return { state: "none", quarantine_ids: [] };
}

function flakeGroups(observations) {
  const groups = new Map();
  for (const observation of observations) {
    if (observation.run_status !== "completed" || (observation.outcome !== "passed" && observation.outcome !== "failed")) continue;
    const adapter = observation.adapter;
    const key = canonicalize([
      observation.commit_sha,
      observation.runtime,
      adapter.id,
      adapter.contract_version,
      adapter.format_version,
    ]);
    if (!groups.has(key)) {
      groups.set(key, {
        commit_sha: observation.commit_sha,
        runtime: observation.runtime,
        adapter,
        attempts: [],
      });
    }
    const group = groups.get(key);
    if (group.attempts.some((attempt) => attempt.attempt === observation.attempt)) {
      reject("attempt-conflict", `attempt ${observation.attempt} of ${key} is counted twice`);
    }
    group.attempts.push({ attempt: observation.attempt, outcome: observation.outcome, run: observation.run });
  }
  return [...groups.keys()].sort().map((key) => {
    const group = groups.get(key);
    group.attempts.sort((a, b) => a.attempt - b.attempt);
    const outcomes = new Set(group.attempts.map((attempt) => attempt.outcome));
    const evaluated = group.attempts.length >= 2;
    return {
      ...group,
      initial_outcome: group.attempts[0].outcome,
      final_outcome: group.attempts.at(-1).outcome,
      evaluated,
      flaky: evaluated && outcomes.size === 2,
    };
  });
}

function flakeSummary(groups) {
  const evaluated = groups.filter((group) => group.evaluated).length;
  const flaky = groups.filter((group) => group.flaky).length;
  return { flaky_groups: flaky, evaluated_groups: evaluated, rate: formatRatio(flaky, evaluated) };
}

function observeRun(run, quarantines, tests) {
  let quarantinedFailures = 0;
  let effectiveFailures = 0;
  for (const test of run.content.tests) {
    if (!tests.has(test.id)) tests.set(test.id, { id: test.id, locator: test.locator, name_path: test.name_path, observations: [] });
    const quarantined = activeQuarantines(quarantines, run, test.id).length > 0;
    const effective = quarantined ? "quarantined" : test.outcome;
    if (quarantined && test.outcome === "failed") quarantinedFailures += 1;
    if (effective === "failed") effectiveFailures += 1;
    tests.get(test.id).observations.push({
      run: run.content_digest, commit_sha: run.content.commit_sha, runtime: run.content.runtime,
      adapter: run.content.adapter,
      attempt: run.content.attempt, run_status: run.content.run_status, outcome: test.outcome,
      effective_outcome: effective, duration_us: test.duration_us,
    });
  }
  return {
    run: run.content_digest, commit_sha: run.content.commit_sha, runtime: run.content.runtime,
    attempt: run.content.attempt, run_status: run.content.run_status, counts: run.content.counts,
    quarantined_failures: quarantinedFailures, duration_us: run.content.duration_us,
    passing_evidence: run.content.run_status === "completed" && effectiveFailures === 0 && run.content.counts.cancelled === 0,
  };
}

// New tests are ids in the latest completed run that no earlier completed run
// contained. Removed tests are ids of the previous completed run that the latest
// one lacks. A rename is therefore one removal plus one addition.
function suiteMembership(completed) {
  if (completed.length < 2) {
    return { baseline_run: null, latest_run: completed.length > 0 ? completed[0].content_digest : null, tests_added: [], tests_removed: [] };
  }
  const ids = (run) => run.content.tests.map((test) => test.id);
  const earlier = new Set(completed.slice(0, -1).flatMap(ids));
  const latest = ids(completed.at(-1));
  const current = new Set(latest);
  return {
    baseline_run: completed.at(-2).content_digest,
    latest_run: completed.at(-1).content_digest,
    tests_added: latest.filter((id) => !earlier.has(id)),
    tests_removed: ids(completed.at(-2)).filter((id) => !current.has(id)),
  };
}

function deriveSuite(runs, quarantines) {
  const { repository, suite } = runs[0].content;
  const tests = new Map();
  const runRows = runs.map((run) => observeRun(run, quarantines, tests));
  const completed = runs.filter((run) => run.content.run_status === "completed");
  const latestRun = runs.at(-1);
  const allGroups = [];
  const testRows = [...tests.keys()].sort().map((id) => {
    const entry = tests.get(id);
    const groups = flakeGroups(entry.observations);
    allGroups.push(...groups);
    return {
      ...entry,
      first_seen: entry.observations[0].run,
      last_seen: entry.observations.at(-1).run,
      flake: flakeSummary(groups),
      groups,
      quarantine: quarantineState(quarantines, latestRun, id),
    };
  });
  return {
    repository,
    suite,
    runs: runRows,
    flake: flakeSummary(allGroups),
    runtime_trend: runtimeTrend(completed
      .filter((run) => run.content.duration_us !== null)
      .map((run) => ({ run: run.content_digest, duration_us: run.content.duration_us }))),
    membership: suiteMembership(completed),
    tests: testRows,
  };
}

// Pure and order-independent: the same retained artifacts and quarantines always
// rebuild byte-identical series bytes.
function deriveSeries(artifacts, quarantines = []) {
  const unique = new Map();
  for (const artifact of artifacts) unique.set(verifyArtifact(artifact).content_digest, artifact);
  const quarantineById = new Map();
  for (const record of quarantines) quarantineById.set(verifyQuarantine(record).quarantine_id, record);
  const verifiedQuarantines = [...quarantineById.values()];
  const bySuite = new Map();
  for (const run of [...unique.values()].sort(compareRuns)) {
    const key = canonicalize([run.content.repository, run.content.suite]);
    if (!bySuite.has(key)) bySuite.set(key, []);
    bySuite.get(key).push(run);
  }
  const series = {
    schema: SERIES_SCHEMA,
    adapter_contract_version: ADAPTER_CONTRACT_VERSION,
    run_count: unique.size,
    quarantine_count: verifiedQuarantines.length,
    suites: [...bySuite.keys()].sort().map((key) => deriveSuite(bySuite.get(key), verifiedQuarantines)),
  };
  const bytes = canonicalBytes(series);
  return { series, bytes, series_digest: sha256Hex(bytes) };
}

// --- conformance -----------------------------------------------------------------------------

// A conformance vector is { name, adapter, options, expect } where expect is
// either { content_digest, run_status, counts } or { rejection: <code> }.
function runConformanceVector(vector, text) {
  try {
    const artifact = normalizeRun({ ...vector.options, format: vector.adapter, text, ingestedAt: "2026-01-01T00:00:00.000Z" });
    const actual = { content_digest: artifact.content_digest, run_status: artifact.content.run_status, counts: artifact.content.counts };
    return { ok: canonicalize(actual) === canonicalize(vector.expect), actual };
  } catch (error) {
    if (!(error instanceof ObservationError)) throw error;
    const actual = { rejection: error.code };
    return { ok: canonicalize(actual) === canonicalize(vector.expect), actual };
  }
}

module.exports = {
  OBSERVATION_SCHEMA,
  SERIES_SCHEMA,
  QUARANTINE_SCHEMA,
  REJECTION_SCHEMA,
  ADAPTER_CONTRACT_VERSION,
  MAX_QUARANTINE_AGE_DAYS,
  RUN_STATUSES,
  TEST_OUTCOMES,
  EFFECTIVE_OUTCOMES,
  ADAPTERS,
  ObservationError,
  canonicalize,
  canonicalBytes,
  sha256Hex,
  decimalToMicros,
  formatRatio,
  normalizeLocator,
  parseXml,
  getAdapter,
  normalizeRun,
  verifyArtifact,
  artifactBytes,
  isPassingEvidence,
  validateQuarantine,
  verifyQuarantine,
  buildRejectionReceipt,
  deriveSeries,
  runConformanceVector,
};
