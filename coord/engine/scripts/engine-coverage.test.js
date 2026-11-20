"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const coverage = require("./engine-coverage.js");
const { renderShimSource } = require("../../paths.js");
const coverageRelocation = require("./coverage-relocation.js");

test("COORD-720 line relocation resolves exact-looking ordinals before spending baseline credit", () => {
  const file = "scripts/lines.js";
  const baselineSource = 'const before = "😀";\n{\n}\nconst stable = 1;\nfunction first() {\n  fail("first");\n}\nfunction second() {\n  fail("second");\n}\nconst after = 2;\n';
  const currentSource = baselineSource.replace("{\n}\n", "");
  const braceHash = sourceHash("}").slice(0, 20);
  const line = (occurrence) => ({ check: "engine_coverage", file,
    value: `lines:${braceHash}:${occurrence}`, severity: "fail" });
  const measurement = { identity_format: "raw-v8-source-range-v1", production_file_count: 1,
    findings: [line(0), line(1)] };
  const baseline = { identity_version: 4, identity_format: "raw-v8-source-range-v1",
    source_commit: "a".repeat(40), findings: [line(1), line(2)] };
  const sources = { file, baselineSource, currentSource };
  const options = { sourceProvider: () => sources };
  const result = coverage.ratchet(measurement, baseline, options);
  assert.equal(result.result, "pass");
  assert.equal(result.new_uncovered.length, 0);
  assert.deepEqual(result.relocated_uncovered.map((item) => [item.current_occurrence, item.baseline_occurrence]),
    [[0, 1], [1, 2]], "an exact-looking ordinal must follow its physical source line");
  assert.ok(result.relocated_uncovered.every((item) => item.kind === "lines" && item.current_owner === null));

  const coveredSwap = coverage.ratchet(measurement, { ...baseline, findings: [line(1)] }, options);
  assert.equal(coveredSwap.result, "fail");
  assert.equal(coveredSwap.inherited_uncovered, 1);
  assert.deepEqual(coveredSwap.new_uncovered.map((item) => item.value), [line(1).value],
    "the apparently exact second line cannot reuse the first line's baseline credit");
  const identicalIdsDifferentSites = coverage.ratchet({ ...measurement, findings: [line(1)] },
    { ...baseline, findings: [line(1)] }, options);
  assert.equal(identicalIdsDifferentSites.result, "fail",
    "an unchanged ID set must not conceal newly uncovered physical source after an edit");
  assert.equal(identicalIdsDifferentSites.inherited_uncovered, 0);
  const unchanged = coverage.ratchet({ ...measurement, findings: [line(1)] },
    { ...baseline, findings: [line(1)] }, {
      sourceProvider: () => ({ baselineSource, currentSource: baselineSource }),
    });
  assert.equal(unchanged.result, "pass", "identical source keeps the original exact identity contract");

  for (const sourceProvider of [() => null, () => { throw new Error("immutable source unavailable"); }]) {
    const unavailable = coverage.ratchet(measurement, baseline, { sourceProvider });
    assert.equal(unavailable.new_uncovered.length, 2, "unverifiable ordinal matches receive no source-location credit");
    assert.equal(unavailable.inherited_uncovered, 0);
  }
  const changed = coverage.ratchet(measurement, baseline, {
    sourceProvider: () => ({ ...sources, currentSource: currentSource.replace('fail("first")', 'changed("first")') }),
  });
  assert.ok(changed.new_uncovered.some((item) => item.value === line(0).value),
    "a repeated brace in a changed interval is not mapped by text coincidence");

  const duplicateCurrent = coverageRelocation.findRelocatedLines([line(0), line(0)], baseline.findings, sources);
  assert.equal(duplicateCurrent.length, 0);
  const duplicateBaseline = coverageRelocation.findRelocatedLines([line(0)], [line(1), line(1)], sources);
  assert.equal(duplicateBaseline.length, 0);
  assert.equal(coverageRelocation.findRelocatedLines([line(999)], baseline.findings, sources).length, 0);
  assert.equal(coverageRelocation.findRelocatedLines([line(0)], [line(1)], {
    file, baselineSource: "}\n}\n", currentSource: "}\n",
  }).length, 0, "unanchored repeated lines cannot be distinguished");
  assert.equal(coverageRelocation.findRelocatedLines([line(0)], baseline.findings, {
    ...sources, currentSource: currentSource.replaceAll("\n", "\r\n"),
  }).length, 0, "normalization cannot replace exact byte equality");
  assert.deepEqual(coverageRelocation.findRelocatedLines([], [], { file, baselineSource: null, currentSource }), []);
  assert.deepEqual(coverageRelocation.findRelocatedLines([], [], { file: null, baselineSource, currentSource }), []);
  assert.deepEqual(coverageRelocation.findRelocatedLines([], [], { file, baselineSource, currentSource: null }), []);
  const trailingEmpty = { ...line(0), value: `lines:${sourceHash("").slice(0, 20)}:0` };
  assert.deepEqual(coverageRelocation.findRelocatedLines([trailingEmpty], [trailingEmpty], {
    file, baselineSource: "anchor\n", currentSource: "prefix\nanchor\n",
  }), [], "a zero-width trailing line has no full byte range and gets no inferred relocation credit");
  for (const invalid of [null, {}, { file }, { file, value: 3 }, { file, value: "lines:bad:0" }]) {
    assert.equal(coverageRelocation.isLineFinding(invalid), false);
  }
  assert.deepEqual(coverageRelocation.findRelocatedLines([line(0), { ...line(0), file: "other.js" }, {}],
    [line(1), { ...line(1), file: "other.js" }, {}], sources).map((item) => item.current.occurrence), [0]);
});
const coverageAggregate = require("./coverage-aggregate.js");
const coverageWorker = require("./coverage-aggregate-worker.js");
const childEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith("NODE_TEST_") && name !== "COORD_COVERAGE_MERGED_LCOV"));
const nativeCoverageUnsupported = ![22, 24].includes(Number(process.versions.node.split(".")[0]));
const nativeCoverageSkip = nativeCoverageUnsupported
  ? `native TestCoverage aggregation supports Node 22.x/24.x, found ${process.version}` : false;

test("COORD-800 span normalization merges contiguous proof and rejects overlapping or crossing spans", () => {
  assert.deepEqual(coverageRelocation.mergeUnchangedSpans([
    { baselineStart: 0, baselineEnd: 3, currentStart: 0, currentEnd: 3 },
    { baselineStart: 3, baselineEnd: 6, currentStart: 3, currentEnd: 6 },
  ]), [{ baselineStart: 0, baselineEnd: 6, currentStart: 0, currentEnd: 6 }]);
  assert.deepEqual(coverageRelocation.mergeUnchangedSpans([
    { baselineStart: 0, baselineEnd: 4, currentStart: 0, currentEnd: 4 },
    { baselineStart: 4, baselineEnd: 6, currentStart: 3, currentEnd: 5 },
  ]), [], "overlap in current-source coordinates invalidates the span proof");
  assert.deepEqual(coverageRelocation.mergeUnchangedSpans([
    { baselineStart: 0, baselineEnd: 4, currentStart: 0, currentEnd: 4 },
    { baselineStart: 3, baselineEnd: 5, currentStart: 4, currentEnd: 6 },
  ]), [], "crossing baseline-source coordinates invalidate the span proof");
});

function rangeFinding(file, kind, ownerStart, ownerEnd, siteStart, siteEnd, sliceHash, occurrence = 0, digest = "a".repeat(64)) {
  return {
    check: "engine_coverage",
    file,
    value: `${kind}:range:${ownerStart}:${ownerEnd}:${siteStart}:${siteEnd}:${sliceHash}:${digest}:${occurrence}`,
    severity: "fail",
    message: `${kind} uncovered at fixture`,
  };
}

function sourceHash(source) {
  return require("node:crypto").createHash("sha256").update(source).digest("hex");
}

test("COORD-800 maps exact unchanged owner/site spans across insertion and extraction", () => {
  const baselineSource = [
    "const stableBoundary = true;",
    "function demo(flag) {",
    "  if (flag) {",
    "    run();",
    "    run();",
    "  }",
    "}",
    "function later() { return 2; }",
    "module.exports = { demo, later };",
    "",
  ].join("\n");
  const extractedSource = [
    "const insertedBefore = 1;",
    "const stableBoundary = true;",
    "function demo(flag) {",
    "  if (flag) {",
    "    run();",
    "    run();",
    "  }",
    "}",
    "function later() { return 2; }",
    "module.exports = { demo, later };",
    "",
  ].join("\n");
  const baselineOwnerStart = baselineSource.indexOf("function demo");
  const baselineOwnerEnd = baselineSource.indexOf("\n}\n", baselineOwnerStart) + 2;
  const currentOwnerStart = extractedSource.indexOf("function demo");
  const currentOwnerEnd = extractedSource.indexOf("\n}\n", currentOwnerStart) + 2;
  const baselineSiteStart = baselineSource.indexOf("    run();", baselineOwnerStart);
  const currentSiteStart = extractedSource.indexOf("    run();", currentOwnerStart);
  const siteLength = "    run();".length;
  const siteHash = sourceHash(baselineSource.slice(baselineSiteStart, baselineSiteStart + siteLength));
  const baselineFinding = rangeFinding("scripts/demo.js", "branches", baselineOwnerStart, baselineOwnerEnd,
    baselineSiteStart, baselineSiteStart + siteLength, siteHash);
  const currentFinding = rangeFinding("scripts/demo.js", "branches", currentOwnerStart, currentOwnerEnd,
    currentSiteStart, currentSiteStart + siteLength, siteHash, 2, "b".repeat(64));
  const result = coverageRelocation.findRelocatedUncovered([currentFinding], [baselineFinding], {
    file: "scripts/demo.js", baselineSource, currentSource: extractedSource,
  });
  assert.equal(result.relocated.length, 1);
  assert.equal(result.relocated[0].current.occurrence, 2);
  assert.equal(result.relocated[0].baseline.occurrence, 0);
  assert.equal(result.relocated[0].baseline.siteStart, baselineSiteStart);
  assert.equal(extractedSource.slice(currentSiteStart, currentSiteStart + siteLength),
    baselineSource.slice(baselineSiteStart, baselineSiteStart + siteLength));
  assert.ok(result.spans.length > 0);
  assert.deepEqual(coverageRelocation.buildUnchangedSpans("", ""), [],
    "empty source has no anchored spans");
  assert.deepEqual(coverageRelocation.buildUnchangedSpans("same\nsame\n", "same\nsame\n"), [],
    "a file with no globally unique anchor receives no source mapping");
  assert.deepEqual(coverageRelocation.buildUnchangedSpans(null, extractedSource), []);
  assert.equal(coverageRelocation.mapRange([
    { baselineStart: 0, baselineEnd: 10, currentStart: 0, currentEnd: 10 },
    { baselineStart: 20, baselineEnd: 30, currentStart: 0, currentEnd: 10 },
  ], 2, 4), null, "overlapping mappings are ambiguous and cannot map a range");
});

test("COORD-800 relocation rejects malformed ranges and changed anchor spans", () => {
  const baselineSource = "left boundary\nfunction demo() {\n  run();\n}\nright boundary\n";
  const changedAnchorSource = "left boundary\nfunction demo() {\n  skip();\n}\nright boundary\n";
  assert.deepEqual(coverageRelocation.buildUnchangedSpans(baselineSource, changedAnchorSource).length > 0, true,
    "unchanged unique anchors remain available around edited source");
  assert.equal(coverageRelocation.mapRange([], 0, 1), null);
  assert.equal(coverageRelocation.mapRange([{ baselineStart: 0, baselineEnd: 3, currentStart: 0, currentEnd: 3 }], -1, 1), null);
  assert.equal(coverageRelocation.mapRange([{ baselineStart: 0, baselineEnd: 3, currentStart: 0, currentEnd: 3 }], 2, 2), null);
  assert.equal(coverageRelocation.parseRangeFinding(null), null);
  assert.equal(coverageRelocation.parseRangeFinding({ file: 3, value: "branches:range:0:1:0:1:" + "a".repeat(64) + ":" + "b".repeat(64) + ":0" }), null);

  const ownerStart = baselineSource.indexOf("function demo");
  const ownerEnd = baselineSource.indexOf("\n}\n", ownerStart) + 2;
  const siteStart = baselineSource.indexOf("  run();", ownerStart);
  const siteEnd = siteStart + "  run();".length;
  const hash = sourceHash(baselineSource.slice(siteStart, siteEnd));
  const baselineFinding = rangeFinding("scripts/demo.js", "branches", ownerStart, ownerEnd, siteStart, siteEnd, hash);
  const malformedCurrent = rangeFinding("scripts/demo.js", "branches", 999, 1000, 999, 1000, hash);
  const invalidSourceRange = coverageRelocation.findRelocatedUncovered(
    [null, { file: "scripts/demo.js", value: "invalid" }, malformedCurrent],
    [null, { file: "scripts/demo.js", value: "invalid" }, baselineFinding],
    { file: "scripts/demo.js", baselineSource, currentSource: baselineSource },
  );
  assert.equal(invalidSourceRange.relocated.length, 0);

  const changedFinding = rangeFinding("scripts/demo.js", "branches", ownerStart, ownerEnd, siteStart, siteEnd, "c".repeat(64));
  assert.equal(coverageRelocation.findRelocatedUncovered([changedFinding], [baselineFinding], {
    file: "scripts/demo.js", baselineSource, currentSource: changedAnchorSource,
  }).relocated.length, 0, "range hashes and source bytes must agree before a match is inherited");
  assert.deepEqual(coverageRelocation.findRelocatedUncovered([], [], {
    file: null, baselineSource: 1, currentSource: baselineSource,
  }), { relocated: [], spans: [] });
});

test("COORD-800 rejects a range hash that disagrees with exact unchanged source", () => {
  const source = "left boundary\nfunction demo() {\n  run();\n}\nright boundary\n";
  const changedSameLength = source.replace("run();", "tan();");
  const contentSpans = coverageRelocation.buildUnchangedSpans(source, changedSameLength);
  assert.ok(contentSpans.length > 0);
  assert.ok(contentSpans.every((span) =>
    source.slice(span.baselineStart, span.baselineEnd) === changedSameLength.slice(span.currentStart, span.currentEnd)),
  "equal-length edited content is excluded while unchanged surrounding anchors remain");
  const ownerStart = source.indexOf("function demo");
  const ownerEnd = source.indexOf("\n}\n", ownerStart) + 2;
  const siteStart = source.indexOf("  run();", ownerStart);
  const siteEnd = siteStart + "  run();".length;
  const honestHash = sourceHash(source.slice(siteStart, siteEnd));
  const baseline = rangeFinding("scripts/demo.js", "branches", ownerStart, ownerEnd,
    siteStart, siteEnd, honestHash, 0, "a".repeat(64));
  const falseCurrentHash = rangeFinding("scripts/demo.js", "branches", ownerStart, ownerEnd,
    siteStart, siteEnd, "b".repeat(64), 1, "c".repeat(64));

  assert.equal(coverageRelocation.findRelocatedUncovered([falseCurrentHash], [baseline], {
    file: "scripts/demo.js", baselineSource: source, currentSource: source,
  }).relocated.length, 0,
  "matching coordinates and owner text do not inherit credit when the measured site digest is false");
});

test("COORD-800 refuses ambiguous duplicate insertions, removals, reordered ranges, and changed text", () => {
  const oneCopy = "left boundary\nfunction same() {\n  run();\n}\nright boundary\n";
  const twoCopies = "left boundary\nfunction same() {\n  run();\n}\nfunction same() {\n  run();\n}\nright boundary\n";
  const ownerStart = oneCopy.indexOf("function same");
  const ownerEnd = oneCopy.indexOf("\n}\n", ownerStart) + 2;
  const siteStart = oneCopy.indexOf("  run();", ownerStart);
  const hash = sourceHash(oneCopy.slice(siteStart, siteStart + "  run();".length));
  const baseline = rangeFinding("scripts/demo.js", "branches", ownerStart, ownerEnd,
    siteStart, siteStart + "  run();".length, hash);
  const insertedOwner = twoCopies.indexOf("function same");
  const insertedSite = twoCopies.indexOf("  run();", insertedOwner);
  const inserted = rangeFinding("scripts/demo.js", "branches", insertedOwner,
    twoCopies.indexOf("\n}\n", insertedOwner) + 2, insertedSite, insertedSite + "  run();".length, hash);
  assert.equal(coverageRelocation.findRelocatedUncovered([inserted], [baseline], {
    file: "scripts/demo.js", baselineSource: oneCopy, currentSource: twoCopies,
  }).relocated.length, 0);

  const removedOwner = oneCopy.indexOf("function same");
  const removedSite = oneCopy.indexOf("  run();", removedOwner);
  const removedFinding = rangeFinding("scripts/demo.js", "branches", removedOwner,
    oneCopy.indexOf("\n}\n", removedOwner) + 2, removedSite, removedSite + "  run();".length, hash);
  assert.equal(coverageRelocation.findRelocatedUncovered([removedFinding], [baseline, baseline], {
    file: "scripts/demo.js", baselineSource: twoCopies, currentSource: oneCopy,
  }).relocated.length, 0, "duplicate baseline coordinates fail closed");

  const beforeReorder = "left\nalpha unique\nbeta unique\nright\n";
  const afterReorder = "left\nbeta unique\nalpha unique\nright\n";
  const reorderedStart = afterReorder.indexOf("beta unique");
  assert.equal(coverageRelocation.mapRange(coverageRelocation.buildUnchangedSpans(beforeReorder, afterReorder),
    reorderedStart, afterReorder.indexOf("right")), null);

  const changedSource = oneCopy.replace("  run();", "  skip();");
  const changedSite = changedSource.indexOf("  skip();");
  const changedFinding = rangeFinding("scripts/demo.js", "branches", changedSource.indexOf("function same"),
    changedSource.indexOf("\n}\n") + 2, changedSite, changedSite + "  skip();".length,
    sourceHash(changedSource.slice(changedSite, changedSite + "  skip();".length)));
  assert.equal(coverageRelocation.findRelocatedUncovered([changedFinding], [baseline], {
    file: "scripts/demo.js", baselineSource: oneCopy, currentSource: changedSource,
  }).relocated.length, 0);
});

test("COORD-1052 proves an unchanged coverage owner through repeated closing lines next to an edit", () => {
  const owner = [
    "function checkLimit(total) {",
    "  if (total > 20) return false;",
    "  return true;",
    "}",
  ].join("\n");
  const other = "function reset() {\n  resetCounter();\n}\n";
  const footer = "module.exports = { checkLimit, reset };\n";
  const baselineSource = `${other}${owner}\nconst mode = "original";\n${footer}`;
  const currentSource = `// updated configuration\n${other}${owner}\nconst mode = "verbose";\n${footer}`;
  const file = "scripts/limit.js";
  const site = "return false;";
  function finding(source, ownerText = owner) {
    const start = source.indexOf(ownerText);
    const siteStart = source.indexOf(site, start);
    return rangeFinding(file, "branches", start, start + ownerText.length,
      siteStart, siteStart + site.length, sourceHash(site));
  }
  const baseline = finding(baselineSource);
  const current = finding(currentSource);
  const { ownerStart, ownerEnd } = coverageRelocation.parseRangeFinding(current);
  assert.equal(coverageRelocation.mapRange(
    coverageRelocation.buildUnchangedSpans(baselineSource, currentSource), ownerStart, ownerEnd), null);
  const match = coverageRelocation.findRelocatedUncovered([current], [baseline], {
    file, baselineSource, currentSource,
  });
  assert.deepEqual(match.relocated.map((entry) => entry.baselineFinding), [baseline]);
  const crossBoundarySite = rangeFinding(file, "branches", ownerStart, ownerEnd,
    ownerEnd - 1, ownerEnd + 1, sourceHash("}\n"));
  assert.equal(coverageRelocation.parseRangeFinding(crossBoundarySite), null);
  assert.equal(coverageRelocation.findRelocatedUncovered([crossBoundarySite], [baseline], {
    file, baselineSource, currentSource,
  }).relocated.length, 0);
  assert.equal(coverageRelocation.findRelocatedUncovered([current], [{ ...baseline, file: "scripts/other.js" }], {
    file, baselineSource, currentSource,
  }).relocated.length, 0, "the same owner in another file cannot supply credit");

  // The old opening line now anchors to another function. The inner lines
  // still anchor to the byte-identical owner, but those proofs conflict.
  const conflictingSource = currentSource.replace(owner, `const checker = ${owner};`) +
    owner.replace("return false;", "return null;") + "\n";
  const conflictingSpans = coverageRelocation.buildUnchangedSpans(baselineSource, conflictingSource);
  const oldOwnerStart = baselineSource.indexOf(owner);
  const newOwnerStart = conflictingSource.indexOf(owner);
  assert.ok(conflictingSpans.some((span) => span.baselineStart === oldOwnerStart && span.currentStart > newOwnerStart + owner.length));
  assert.ok(conflictingSpans.some((span) => span.currentStart > newOwnerStart && span.currentStart < newOwnerStart + owner.length));
  assert.equal(coverageRelocation.findRelocatedUncovered([finding(conflictingSource)], [baseline], {
    file, baselineSource, currentSource: conflictingSource,
  }).relocated.length, 0, "conflicting anchors cannot supply a whole-owner proof");

  const changedOwner = owner.replace("total > 20", "total > 25");
  const changedSource = currentSource.replace(owner, changedOwner);
  assert.equal(coverageRelocation.findRelocatedUncovered([finding(changedSource, changedOwner)], [baseline], {
    file, baselineSource, currentSource: changedSource,
  }).relocated.length, 0, "the unchanged branch body cannot inherit credit with a changed owning function");

  const duplicateSource = `${currentSource}const extra = ${owner};\n`;
  assert.equal(coverageRelocation.findRelocatedUncovered([finding(duplicateSource)], [baseline], {
    file, baselineSource, currentSource: duplicateSource,
  }).relocated.length, 0, "duplicate current owners have no unique relocation proof");
  const duplicateBaseline = `${baselineSource}const extra = ${owner};\n`;
  assert.equal(coverageRelocation.findRelocatedUncovered([current], [baseline], {
    file, baselineSource: duplicateBaseline, currentSource,
  }).relocated.length, 0, "one recorded tuple cannot disambiguate duplicate baseline owners");
});

test("COORD-800 duplicate covered/uncovered sites do not swap inherited credit and UTF-16 CRLF ranges stay exact", () => {
  const source = "\uFEFFconst marker = '🪐';\r\nfunction demo() {\r\n  run();\r\n  run();\r\n}\r\n";
  assert.equal(source.charCodeAt(0), 0xfeff, "the leading BOM remains part of the UTF-16 source offset space");
  const baselineOwnerStart = source.indexOf("function demo");
  const baselineOwnerEnd = source.indexOf("\r\n}\r\n", baselineOwnerStart) + 3;
  const firstSite = source.indexOf("  run();", baselineOwnerStart);
  const secondSite = source.indexOf("  run();", firstSite + 1);
  const hash = sourceHash(source.slice(secondSite, secondSite + "  run();".length));
  const baselineUncovered = rangeFinding("scripts/demo.js", "branches", baselineOwnerStart, baselineOwnerEnd,
    secondSite, secondSite + "  run();".length, hash, 1);
  const currentUncovered = rangeFinding("scripts/demo.js", "branches", baselineOwnerStart, baselineOwnerEnd,
    firstSite, firstSite + "  run();".length, hash, 0, "c".repeat(64));
  assert.equal(coverageRelocation.findRelocatedUncovered([currentUncovered], [baselineUncovered], {
    file: "scripts/demo.js", baselineSource: source, currentSource: source,
  }).relocated.length, 0);

  const shifted = "const prefix = 1;\r\n" + source;
  const shiftedOwnerStart = shifted.indexOf("function demo");
  const shiftedOwnerEnd = shifted.indexOf("\r\n}\r\n", shiftedOwnerStart) + 3;
  const shiftedSite = shifted.indexOf("  run();", shiftedOwnerStart);
  const shiftedFinding = rangeFinding("scripts/demo.js", "functions", shiftedOwnerStart, shiftedOwnerEnd,
    shiftedOwnerStart, shiftedOwnerEnd, sourceHash(source.slice(baselineOwnerStart, baselineOwnerEnd)), 0, "d".repeat(64));
  const mapped = coverageRelocation.findRelocatedUncovered([shiftedFinding], [
    rangeFinding("scripts/demo.js", "functions", baselineOwnerStart, baselineOwnerEnd,
      baselineOwnerStart, baselineOwnerEnd, sourceHash(source.slice(baselineOwnerStart, baselineOwnerEnd))),
  ], { file: "scripts/demo.js", baselineSource: source, currentSource: shifted });
  assert.equal(mapped.relocated.length, 1);
  assert.equal(source.slice(mapped.relocated[0].baseline.ownerStart, mapped.relocated[0].baseline.ownerEnd),
    shifted.slice(shiftedOwnerStart, shiftedOwnerEnd));
  assert.equal(shiftedSite, shiftedOwnerStart + (firstSite - baselineOwnerStart));
});

test("COORD-800 raw range ratchet inherits only the uniquely relocated baseline site", () => {
  const baselineSource = "const before = 1;\nfunction demo(flag) {\n  if (flag) run();\n}\n";
  const currentSource = "// inserted without changing the measured function\n" + baselineSource;
  const baselineOwnerStart = baselineSource.indexOf("function demo");
  const baselineOwnerEnd = baselineSource.indexOf("\n}\n", baselineOwnerStart) + 2;
  const baselineSiteStart = baselineSource.indexOf("  if (flag)", baselineOwnerStart);
  const siteLength = "  if (flag)".length;
  const currentOwnerStart = currentSource.indexOf("function demo");
  const currentOwnerEnd = currentSource.indexOf("\n}\n", currentOwnerStart) + 2;
  const currentSiteStart = currentSource.indexOf("  if (flag)", currentOwnerStart);
  const sliceHash = sourceHash(baselineSource.slice(baselineSiteStart, baselineSiteStart + siteLength));
  const malformedRanges = [
    `branches:range:9:3:9:10:${sliceHash}:${"a".repeat(64)}:0`,
    `branches:range:0:2:3:4:${sliceHash}:${"a".repeat(64)}:0`,
    `branches:range:0:9007199254740992:0:1:${sliceHash}:${"a".repeat(64)}:0`,
    `functions:range:0:4:1:3:${sliceHash}:${"a".repeat(64)}:0`,
  ];
  for (const value of malformedRanges) assert.equal(coverageRelocation.parseRangeFinding({ file: "scripts/demo.js", value }), null);
  assert.deepEqual(coverageRelocation.findRelocatedUncovered([], [], {
    file: null, baselineSource, currentSource,
  }), { relocated: [], spans: [] }, "invalid source-provider inputs fail closed");
  const baselineFinding = rangeFinding("scripts/demo.js", "branches", baselineOwnerStart, baselineOwnerEnd,
    baselineSiteStart, baselineSiteStart + siteLength, sliceHash, 0, "e".repeat(64));
  const currentFinding = rangeFinding("scripts/demo.js", "branches", currentOwnerStart, currentOwnerEnd,
    currentSiteStart, currentSiteStart + siteLength, sliceHash, 1, "f".repeat(64));
  const baseline = { identity_version: 4, identity_format: "raw-v8-source-range-v1", source_commit: "a".repeat(40),
    findings: [baselineFinding] };
  const measurement = { identity_format: "raw-v8-source-range-v1", production_file_count: 1,
    findings: [currentFinding] };
  const relocated = coverage.ratchet(measurement, baseline, {
    sourceProvider: () => ({ baselineSource, currentSource }),
  });
  assert.equal(relocated.result, "pass");
  assert.equal(relocated.new_uncovered.length, 0);
  assert.equal(relocated.inherited_uncovered, 1);
  assert.deepEqual(relocated.relocated_uncovered, [{
    file: "scripts/demo.js", kind: "branches", current_occurrence: 1, baseline_occurrence: 0,
    current_owner: [currentOwnerStart, currentOwnerEnd], baseline_owner: [baselineOwnerStart, baselineOwnerEnd],
    current_site: [currentSiteStart, currentSiteStart + siteLength],
    baseline_site: [baselineSiteStart, baselineSiteStart + siteLength],
  }]);

  const changed = currentSource.replace("run();", "skip();");
  const changedFinding = rangeFinding("scripts/demo.js", "branches", currentOwnerStart,
    currentSource.indexOf("\n}\n", currentOwnerStart) + 2, currentSiteStart,
    currentSiteStart + siteLength, sourceHash(currentSource.slice(currentSiteStart, currentSiteStart + siteLength)),
    1, "f".repeat(64));
  const rejected = coverage.ratchet({ ...measurement, findings: [changedFinding] }, baseline, {
    sourceProvider: () => ({ baselineSource, currentSource: changed }),
  });
  assert.equal(rejected.result, "fail");
  assert.equal(rejected.new_uncovered.length, 1);
  assert.equal(rejected.inherited_uncovered, 0);

  const duplicateClaim = coverage.ratchet({ ...measurement, findings: [baselineFinding, currentFinding] }, baseline, {
    sourceProvider: () => ({ baselineSource, currentSource }),
  });
  assert.equal(duplicateClaim.result, "fail",
    "a baseline site consumed by an exact finding cannot also back a distinct relocation claim");
  assert.equal(duplicateClaim.inherited_uncovered, 1);
  assert.equal(duplicateClaim.new_uncovered.length, 1);

  const duplicateBaseline = coverage.ratchet(measurement, { ...baseline, findings: [baselineFinding, { ...baselineFinding }] }, {
    sourceProvider: () => ({ baselineSource, currentSource }),
  });
  assert.equal(duplicateBaseline.result, "fail",
    "multiple baseline rows for the same mapped site are ambiguous even when their coordinates match");
  assert.equal(duplicateBaseline.new_uncovered.length, 1);

  const unavailable = coverage.ratchet(measurement, baseline, { sourceProvider: () => null });
  assert.equal(unavailable.result, "fail", "a missing immutable Git source grants no inherited credit");
  assert.equal(unavailable.new_uncovered.length, 1);
  assert.deepEqual(unavailable.relocation_unavailable, [{
    file: "scripts/demo.js", reason: "exact current or baseline source is unavailable",
  }]);
  const thrown = coverage.ratchet(measurement, baseline, { sourceProvider: () => { throw new Error("fixture failure"); } });
  assert.equal(thrown.result, "fail", "source-provider errors fail closed without changing the ratchet result");
});

test("COORD-800 raw coverage rejects missing witnesses and invalid aggregate shapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord800-witness-contract-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "function demo() { return 1; }\n");
    const lcov = "SF:scripts/demo.js\nFN:1,demo\nFNDA:0,demo\nDA:1,0\nend_of_record\n";
    assert.throws(() => coverage.measure(root, [lcov, lcov], { rangeWitnesses: {} }),
      /source-range coverage identity requires one native aggregate LCOV report/);
    assert.throws(() => coverage.measure(root, [lcov], { rangeWitnesses: {} }),
      /source-range witnesses are missing scripts\/demo\.js/);
    assert.throws(() => coverage.ratchet({ identity_format: "raw-v8-source-range-v1", findings: [] }, { findings: [] }),
      /requires identity version 4 baseline/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-800 rejects malformed LCOV source lines and covers stable anonymous identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord800-lcov-boundaries-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "function anonymous_7() { return 1; }\n");
    assert.throws(() => coverage.measure(root, [
      "SF:scripts/demo.js\nDA:,0\nend_of_record\n",
    ]), /LCOV site  is outside scripts\/demo\.js/,
    "an empty line identity is rejected at the external LCOV parsing boundary");
    assert.throws(() => coverage.measure(root, [
      "SF:scripts/demo.js\nDA:99,0\nend_of_record\n",
    ]), /LCOV site 99 is outside scripts\/demo\.js/,
    "a numeric LCOV line outside the exact source is rejected");

    const anonymous = coverage.measure(root, [
      "SF:scripts/demo.js\nFN:1,anonymous_7\nFNDA:0,anonymous_7\nDA:1,0\nend_of_record\n",
    ], { stableAnonymousFunctions: true });
    assert.ok(anonymous.findings.some((finding) => finding.value.startsWith("functions:anonymous:0:")),
      "stable anonymous identity mode is exercised through the public LCOV measure API");

    assert.throws(() => coverage.ratchet({ findings: [] }, null),
      /measured engine coverage baseline is required/,
    "the legacy public ratchet API refuses a missing baseline");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-676 exclusion contract is exact and production discovery cannot silently widen it", () => {
  assert.deepEqual(coverage.EXCLUSIONS, [
    "**/*.test.js",
    "**/__fixtures__/**",
    "**/fixtures/**",
    "scripts/governance-test-utils.js",
    "scripts/session-lifecycle-test-utils.js",
    "scripts/business-context-pack-test-fixtures.js",
    "scripts/test-isolation-guard.js",
  ]);
  for (const rel of [
    "scripts/feature.test.js", "scripts/__fixtures__/fixture.js",
    "scripts/fixtures/example.js", ...coverage.EXCLUSIONS.slice(3),
  ]) assert.equal(coverage.isProductionPath(rel), false, rel);
  assert.equal(coverage.isProductionPath("scripts/adapters/new-production.js"), true);
  assert.equal(coverage.isProductionPath("engine/scripts/coverage-aggregate-worker.js"), true);
  assert.ok(coverage.productionFiles(path.resolve(__dirname, "../.."))
    .includes("engine/scripts/coverage-aggregate-worker.js"));
  assert.ok(coverageWorker.lineAt("one\ntwo", 4) === 2, "worker source is exercised and measured by this test module");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-canonical-fingerprint-"));
  try {
    fs.mkdirSync(path.join(root, "engine", "scripts"), { recursive: true });
    const canonical = path.join(root, "engine", "scripts", "worker.js");
    fs.writeFileSync(canonical, "module.exports = 1;\n");
    const before = coverage.fingerprintProductionSources(root);
    fs.writeFileSync(canonical, "module.exports = 2;\n");
    const after = coverage.fingerprintProductionSources(root);
    assert.deepEqual(coverage.changedProductionSources(before, after), ["engine/scripts/worker.js"]);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "worker.js"), "module.exports = 2;\n");
    assert.throws(() => coverage.productionFiles(root), /duplicate legacy\/canonical engine module/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-863 the census keeps registered shims out and still refuses an unregistered duplicate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord863-census-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "engine", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "engine", "scripts", "moved.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(root, "scripts", "moved.js"), renderShimSource("scripts/moved.js", { deprecated: true }));
    fs.writeFileSync(path.join(root, "scripts", "kept.js"), "module.exports = 2;\n");
    assert.throws(() => coverage.productionFiles(root), /duplicate legacy\/canonical engine module/);
    const registry = (shims) => fs.writeFileSync(path.join(root, "engine", "shim-registry.json"),
      JSON.stringify({ schema_version: 1, stable_entrypoints: [], shims }));
    registry([{ path: "scripts/moved.js", target: "engine/scripts/moved.js", kind: "removable" }]);
    assert.deepEqual(coverage.productionFiles(root), ["engine/scripts/moved.js", "scripts/kept.js"]);
    assert.deepEqual([...coverage.fingerprintProductionSources(root).keys()], ["engine/scripts/moved.js", "scripts/kept.js"]);
    // COORD-864: a registered path that is not the delegating template is real
    // source, so the census refuses to drop it rather than leave it unmeasured.
    fs.writeFileSync(path.join(root, "scripts", "moved.js"),
      'module.exports = require(resolveEngineModule(root, "engine-only:scripts/moved.js"));\nmodule.exports.extra = 1;\n');
    assert.throws(() => coverage.productionFiles(root), /registered shim scripts\/moved.js does not delegate to engine\/scripts\/moved.js/);
    // A registered shim already deleted from the legacy path leaves only its target.
    fs.rmSync(path.join(root, "scripts", "moved.js"));
    assert.deepEqual(coverage.productionFiles(root), ["engine/scripts/moved.js", "scripts/kept.js"]);
    fs.writeFileSync(path.join(root, "scripts", "moved.js"), renderShimSource("scripts/moved.js", { deprecated: true }));
    // Another divergent same-name pair stays a hard provenance error.
    fs.writeFileSync(path.join(root, "engine", "scripts", "kept.js"), "module.exports = 3;\n");
    assert.throws(() => coverage.productionFiles(root), /duplicate legacy\/canonical engine module: scripts\/kept.js/);
    fs.rmSync(path.join(root, "engine", "scripts", "kept.js"));
    // A shim without its target would leave the module unmeasured.
    fs.rmSync(path.join(root, "engine", "scripts", "moved.js"));
    assert.throws(() => coverage.productionFiles(root), /registered shim scripts\/moved.js has no engine target engine\/scripts\/moved.js/);
    fs.writeFileSync(path.join(root, "engine", "shim-registry.json"), "[]");
    assert.throws(() => coverage.productionFiles(root), /shim registry must be an object/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-676 distinguishes inherited uncovered debt from a newly uncovered branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord676-coverage-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"),
      "function demo(flag) {\n  if (flag) return 1;\n  if (flag === false) return 2;\n  return 3;\n}\nmodule.exports = demo;\n");
    const baseLcov = "SF:coord/scripts/demo.js\nFN:1,demo\nFNDA:1,demo\nDA:1,1\nDA:2,1\nDA:3,0\nBRDA:2,0,0,1\nBRDA:2,0,1,0\nend_of_record\n";
    const currentLcov = baseLcov.replace("BRDA:2,0,1,0", "BRDA:2,0,1,0\nBRDA:3,1,0,0");
    const base = coverage.measure(root, [baseLcov]);
    const now = coverage.measure(root, [currentLcov]);
    assert.equal(base.totals.lines.found, 3);
    assert.equal(base.totals.branches.found, 2);
    assert.equal(base.totals.functions.found, 1);
    const verdict = coverage.ratchet(now, base);
    assert.equal(verdict.result, "fail");
    assert.equal(verdict.new_uncovered.length, 1);
    assert.equal(verdict.inherited_uncovered, 2);
    assert.equal(coverage.ratchet(base, base).result, "pass");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-676 counts every production file, including files unobserved by tests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord676-census-"));
  try {
    fs.mkdirSync(path.join(root, "scripts", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "nested", "new.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(root, "scripts", "nested", "new.test.js"), "");
    const report = coverage.measure(root, []);
    assert.equal(report.production_file_count, 1);
    assert.match(report.findings[0].value, /^unobserved:[0-9a-f]{64}$/);
    assert.equal(coverage.ratchet(report, { findings: [] }).result, "fail");
    fs.writeFileSync(path.join(root, "scripts", "nested", "new.js"), "module.exports = 2;\n");
    const changed = coverage.measure(root, []);
    assert.equal(coverage.ratchet(changed, report).result, "fail");
    assert.equal(coverage.ratchet(changed, report).new_uncovered.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-676 LCOV block renumbering does not create false new branch debt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord676-block-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "if (true) {}\nif (false) {}\n");
    const base = coverage.measure(root, ["SF:scripts/demo.js\nBRDA:2,10,0,0\nend_of_record\n"]);
    const current = coverage.measure(root, ["SF:scripts/demo.js\nBRDA:1,1,0,1\nBRDA:2,99,0,0\nend_of_record\n"]);
    assert.equal(coverage.ratchet(current, base).result, "pass");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 covered-key ordinal drift fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-branch-drift-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "if (flag) work();\n");
    const base = coverage.measure(root, [
      "SF:scripts/demo.js\nBRDA:1,10,0,1\nBRDA:1,10,1,0\nend_of_record\n",
    ]);
    const drifted = coverage.measure(root, [
      "SF:scripts/demo.js\nBRDA:1,2,0,0\nBRDA:1,99,0,1\nBRDA:1,99,1,1\nend_of_record\n",
    ]);
    assert.equal(coverage.ratchet(drifted, base).result, "fail");
    assert.equal(coverage.ratchet(drifted, base).new_uncovered.length, 1);
    const regression = coverage.measure(root, [
      "SF:scripts/demo.js\nBRDA:1,2,0,0\nBRDA:1,3,0,0\nBRDA:1,99,0,1\nend_of_record\n",
    ]);
    const verdict = coverage.ratchet(regression, base);
    assert.equal(verdict.result, "fail");
    assert.equal(verdict.new_uncovered.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 swapping covered and uncovered same-line branch arms is new debt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-branch-swap-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "if (flag) left(); else right();\n");
    const before = coverage.measure(root, [
      "SF:scripts/demo.js\nBRDA:1,1,0,1\nBRDA:1,1,1,0\nend_of_record\n",
    ]);
    const after = coverage.measure(root, [
      "SF:scripts/demo.js\nBRDA:1,1,0,0\nBRDA:1,1,1,1\nend_of_record\n",
    ]);
    const verdict = coverage.ratchet(after, before);
    assert.equal(verdict.result, "fail");
    assert.equal(verdict.new_uncovered.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 range identity v4 rejects inherited unstable-site exception envelopes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-unstable-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    const source = path.join(root, "scripts", "demo.js");
    fs.writeFileSync(source, "if (flag) work();\nif (other) work();\n");
    const captured = coverage.measure(root, [
      "SF:scripts/demo.js\nBRDA:1,1,0,1\nBRDA:2,2,0,1\nend_of_record\n",
    ]);
    const observed = coverage.measure(root, [
      "SF:scripts/demo.js\nBRDA:1,1,0,0\nBRDA:2,2,0,1\nend_of_record\n",
    ]);
    const baseline = { identity_version: 4, findings: captured.findings, unstable_findings: observed.findings };
    assert.throws(() => coverage.ratchet(observed, baseline), /does not accept unstable-site exceptions/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-676 an additional uncovered copy of identical source text is new debt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord676-duplicate-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "function demo() {\n  work();\n  work();\n}\n");
    const base = coverage.measure(root, ["SF:scripts/demo.js\nDA:2,0\nend_of_record\n"]);
    const current = coverage.measure(root, ["SF:scripts/demo.js\nDA:2,0\nDA:3,0\nend_of_record\n"]);
    const verdict = coverage.ratchet(current, base);
    assert.equal(verdict.result, "fail");
    assert.equal(verdict.new_uncovered.length, 1);
    assert.equal(verdict.inherited_uncovered, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-676 coverage swapping between identical lines is new debt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord676-swap-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "function demo() {\n  work();\n  work();\n}\n");
    const baseline = coverage.measure(root, ["SF:scripts/demo.js\nDA:2,0\nDA:3,1\nend_of_record\n"]);
    const changed = coverage.measure(root, ["SF:scripts/demo.js\nDA:2,1\nDA:3,0\nend_of_record\n"]);
    const verdict = coverage.ratchet(changed, baseline);
    assert.equal(verdict.result, "fail");
    assert.equal(verdict.new_uncovered.length, 1);
    assert.equal(verdict.inherited_uncovered, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-676 same-named functions retain distinct coverage sites", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord676-functions-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"),
      "function outer() {\n  function worker() { return 1; }\n  function worker() { return 2; }\n}\n");
    const baseline = coverage.measure(root, [
      "SF:scripts/demo.js\nFN:1,outer\nFN:2,worker\nFN:3,worker\nFNDA:1,outer\nFNDA:1,worker\nFNDA:1,worker\nend_of_record\n",
    ]);
    const changed = coverage.measure(root, [
      "SF:scripts/demo.js\nFN:1,outer\nFN:2,worker\nFN:3,worker\nFNDA:1,outer\nFNDA:1,worker\nFNDA:0,worker\nend_of_record\n",
    ]);
    assert.deepEqual(changed.totals.functions, { found: 3, hit: 2, pct: 66.67 });
    assert.equal(coverage.ratchet(changed, baseline).new_uncovered.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 anonymous function ordinals remain local to a source line", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-anonymous-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "module.exports = [() => 1, () => 2];\n");
    const lcov = (first, second, firstHit, secondHit) =>
      `SF:scripts/demo.js\nFN:1,anonymous_${first}\nFN:1,anonymous_${second}\n` +
      `FNDA:${firstHit},anonymous_${first}\nFNDA:${secondHit},anonymous_${second}\nend_of_record\n`;
    const options = { stableAnonymousFunctions: true };
    const baseline = coverage.measure(root, [lcov(10, 11, 1, 0)], options);
    const renumbered = coverage.measure(root, [lcov(40, 41, 1, 0)], options);
    assert.equal(coverage.ratchet(renumbered, baseline).new_uncovered.length, 0);
    const regressed = coverage.measure(root, [lcov(40, 41, 0, 0)], options);
    const verdict = coverage.ratchet(regressed, baseline);
    assert.equal(verdict.result, "fail");
    assert.equal(verdict.new_uncovered.length, 1);
    assert.equal(verdict.inherited_uncovered, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 named functions on the same line do not shift anonymous identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-mixed-functions-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "module.exports = [function named() {}, () => 1, () => 2];\n");
    const report = (includeNamed) => `SF:scripts/demo.js\n` +
      (includeNamed ? "FN:1,named\nFNDA:1,named\n" : "") +
      "FN:1,anonymous_10\nFN:1,anonymous_11\n" +
      "FNDA:0,anonymous_10\nFNDA:0,anonymous_11\nend_of_record\n";
    const options = { stableAnonymousFunctions: true };
    const baseline = coverage.measure(root, [report(false)], options);
    const withNamed = coverage.measure(root, [report(true)], options);
    assert.equal(coverage.ratchet(withNamed, baseline).new_uncovered.length, 0);
    assert.equal(coverage.ratchet(withNamed, baseline).inherited_uncovered, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 anonymous IDs from separate LCOV reports must match exactly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-merged-functions-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "module.exports = () => 1;\n");
    const lcov = (name, hit) =>
      `SF:scripts/demo.js\nFN:1,anonymous_${name}\nFNDA:${hit},anonymous_${name}\nend_of_record\n`;
    const options = { stableAnonymousFunctions: true };
    const baseline = coverage.measure(root, [lcov(11, 1)], options);
    const merged = coverage.measure(root, [lcov(11, 0), lcov(11, 1)], options);
    assert.deepEqual(merged.totals.functions, { found: 1, hit: 1, pct: 100 });
    assert.equal(coverage.ratchet(merged, baseline).result, "pass");
    assert.throws(() => coverage.measure(root, [lcov(11, 0), lcov(37, 1)], options),
      /anonymous function identities differ across reports/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 same-line anonymous callbacks remain distinct after cross-report merge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-multiple-functions-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "module.exports = [() => 1, () => 2];\n");
    const lcov = (first, second, secondHit) =>
      `SF:scripts/demo.js\nFN:1,anonymous_${first}\nFN:1,anonymous_${second}\n` +
      `FNDA:1,anonymous_${first}\nFNDA:${secondHit},anonymous_${second}\nend_of_record\n`;
    const options = { stableAnonymousFunctions: true };
    const baseline = coverage.measure(root, [lcov(11, 12, 1)], options);
    const regressed = coverage.measure(root, [lcov(11, 12, 0), lcov(11, 12, 0)], options);
    assert.deepEqual(regressed.totals.functions, { found: 2, hit: 1, pct: 50 });
    assert.equal(coverage.ratchet(regressed, baseline).new_uncovered.length, 1);
    assert.throws(() => coverage.measure(root, [lcov(11, 12, 1),
      "SF:scripts/demo.js\nFN:1,anonymous_37\nFNDA:1,anonymous_37\nend_of_record\n"], options),
    /anonymous function identities differ across reports/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 equal-count anonymous reorder fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-anonymous-reorder-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "demo.js"), "module.exports = [() => left(), () => right()];\n");
    const firstOrder = "SF:scripts/demo.js\nFN:1,anonymous_10\nFN:1,anonymous_11\nFNDA:1,anonymous_10\nFNDA:0,anonymous_11\nend_of_record\n";
    // Same census, but reporter encounter order and IDs disagree. The second
    // report says callback 0 is uncovered and callback 1 is covered.
    const reordered = "SF:scripts/demo.js\nFN:1,anonymous_31\nFN:1,anonymous_30\nFNDA:0,anonymous_31\nFNDA:1,anonymous_30\nend_of_record\n";
    assert.throws(() => coverage.measure(root, [firstOrder, reordered], { stableAnonymousFunctions: true }),
      /anonymous function identities differ across reports/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-676 cannot write a baseline from a focused subset", () => {
  const baseline = path.join(__dirname, "engine-coverage-baseline.json");
  const before = fs.existsSync(baseline) ? fs.readFileSync(baseline) : null;
  const child = spawnSync(process.execPath, [path.join(__dirname, "../../scripts/test-runner.js"),
    "--file", __filename, "--write-coverage-baseline"], { encoding: "utf8", env: childEnv() });
  assert.equal(child.status, 2);
  assert.match(child.stdout + child.stderr, /complete aggregate inventory/);
  const after = fs.existsSync(baseline) ? fs.readFileSync(baseline) : null;
  assert.deepEqual(after, before);
  const filtered = spawnSync(process.execPath, [path.join(__dirname, "../../scripts/test-runner.js"),
    "--write-coverage-baseline", "--", "--test-name-pattern=only-one"], { encoding: "utf8", env: childEnv() });
  assert.equal(filtered.status, 2);
  assert.match(filtered.stdout + filtered.stderr, /complete aggregate inventory and all tests/);
  const afterFiltered = fs.existsSync(baseline) ? fs.readFileSync(baseline) : null;
  assert.deepEqual(afterFiltered, before);
});

test("COORD-676 a real new branch in a production module fails the LCOV ratchet", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord676-real-branch-"));
  try {
    const scripts = path.join(root, "scripts");
    fs.mkdirSync(scripts);
    const modulePath = path.join(scripts, "probe.js");
    const testPath = path.join(scripts, "probe.test.js");
    const lcovPath = path.join(root, "coverage.info");
    fs.writeFileSync(testPath,
      "const test=require('node:test');const assert=require('node:assert/strict');const probe=require('./probe');test('normal',()=>assert.equal(probe(true),1));\n");
    const baseSource = "module.exports = function probe(value) {\n  if (value) {\n    return 1;\n  }\n  return 2;\n};\n";
    const changedSource = "module.exports = function probe(value) {\n  if (value) {\n    if (value === 0) return 3;\n    return 1;\n  }\n  return 2;\n};\n";
    const run = (source) => {
      fs.writeFileSync(modulePath, source);
      const child = spawnSync(process.execPath, ["--test", "--experimental-test-coverage",
        "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`, testPath],
      { cwd: root, encoding: "utf8",
        env: childEnv() });
      assert.equal(child.status, 0, child.stderr);
      assert.ok(fs.existsSync(lcovPath), `missing LCOV report: ${child.stderr}\n${child.stdout}`);
      return coverage.measure(root, [fs.readFileSync(lcovPath, "utf8")]);
    };
    const baseline = run(baseSource);
    const changed = run(changedSource);
    const verdict = coverage.ratchet(changed, baseline);
    assert.equal(verdict.result, "fail");
    assert.ok(verdict.new_uncovered.some((f) => f.file === "scripts/probe.js" && /branches/.test(f.value)),
      JSON.stringify({ newer: verdict.new_uncovered, baseline: baseline.findings.filter((f) => /branches/.test(f.value)), current: changed.findings.filter((f) => /branches/.test(f.value)) }));
    assert.ok(verdict.inherited_uncovered > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 raw V8 range witnesses attest unchanged LCOV rows across worker isolates",
  { skip: nativeCoverageSkip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-raw-witness-"));
  try {
    const scripts = path.join(root, "scripts");
    const raw = path.join(root, "raw");
    const lcovPath = path.join(root, "coverage.info");
    fs.mkdirSync(scripts);
    fs.mkdirSync(raw);
    fs.writeFileSync(path.join(scripts, "probe.js"),
      "function choose(flag) { if (flag) return left(); else return right(); }\n" +
      "function left() { return 'L'; }\nfunction right() { return 'R'; }\n" +
      "module.exports = choose;\n");
    fs.writeFileSync(path.join(scripts, "worker.js"),
      "const { parentPort } = require('node:worker_threads');\n" +
      "const choose = require('./probe');\nparentPort.postMessage(choose(false));\n");
    fs.writeFileSync(path.join(scripts, "probe.test.js"),
      "const test=require('node:test');const assert=require('node:assert/strict');" +
      "const {Worker}=require('node:worker_threads');const choose=require('./probe');" +
      "test('main and worker arms',async()=>{assert.equal(choose(true),'L');" +
      "const worker=new Worker(require.resolve('./worker'));" +
      "assert.equal(await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)}),'R')});\n");
    const child = spawnSync(process.execPath, ["--test", "--experimental-test-coverage",
      "--test-concurrency=1", "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`,
      path.join(scripts, "probe.test.js")], {
      cwd: root, encoding: "utf8", env: { ...childEnv(), NODE_V8_COVERAGE: raw },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const lcovText = fs.readFileSync(lcovPath, "utf8");
    const aggregate = coverageAggregate.aggregateRawCoverage([
      { name: "worker-fixture", rawDirectory: raw, lcov: lcovText },
    ], root, ["scripts/probe.js"]);
    const lcovMetrics = coverage.parseLcov(aggregate.report);
    const witnesses = aggregate.witnesses;
    const probe = witnesses["scripts/probe.js"];
    assert.ok(probe);
    assert.equal(probe.branches.length, lcovMetrics.get("scripts/probe.js").branches.size);
    assert.equal(probe.functions.length, lcovMetrics.get("scripts/probe.js").functions.size);
    assert.equal(probe.functions.find((item) => item.name === "left").count, 1);
    assert.equal(probe.functions.find((item) => item.name === "right").count, 1);
    assert.ok(aggregate.raw_snapshot_count >= 2, "expected separate main and worker raw coverage snapshots");

    const tampered = lcovText.replace(/(BRDA:[^,]+,[^,]+,[^,]+,)1(?=\n)/, (_row, prefix) => `${prefix}0`);
    assert.throws(() => coverageAggregate.aggregateRawCoverage([
      { name: "worker-fixture", rawDirectory: raw, lcov: tampered },
    ], root, ["scripts/probe.js"]), /module LCOV\/raw coverage mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-839 native aggregation treats bracketed LCOV source paths literally",
  { skip: nativeCoverageSkip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord839-literal-coverage-path-"));
  try {
    const slugRoute = path.join(root, "requirements", "[slug]");
    const singleCharacterRoute = path.join(root, "requirements", "s");
    const raw = path.join(root, "raw");
    const lcovPath = path.join(root, "coverage.info");
    fs.mkdirSync(slugRoute, { recursive: true });
    fs.mkdirSync(singleCharacterRoute, { recursive: true });
    fs.mkdirSync(raw);
    fs.writeFileSync(path.join(slugRoute, "page.js"),
      "module.exports = (value) => `slug:${value}`;\n");
    fs.writeFileSync(path.join(singleCharacterRoute, "page.js"),
      "module.exports = (value) => `single:${value}`;\n");
    const testPath = path.join(root, "routes.test.js");
    fs.writeFileSync(testPath,
      "const test=require('node:test');const assert=require('node:assert/strict');" +
      "const slug=require('./requirements/[slug]/page.js');" +
      "const single=require('./requirements/s/page.js');" +
      "test('both literal route directories are measured',()=>{" +
      "assert.equal(slug('x'),'slug:x');assert.equal(single('x'),'single:x')});\n");

    const child = spawnSync(process.execPath, ["--test", "--experimental-test-coverage",
      "--test-coverage-exclude=**/*.test.js", "--test-coverage-exclude=**/s/**",
      "--test-concurrency=1", "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`, testPath], {
      cwd: root, encoding: "utf8", env: { ...childEnv(), NODE_V8_COVERAGE: raw },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const lcovText = fs.readFileSync(lcovPath, "utf8");
    assert.match(lcovText, /SF:requirements\/\[slug\]\/page\.js\n/);
    assert.doesNotMatch(lcovText, /SF:requirements\/s\/page\.js\n/,
      "the native LCOV census intentionally excludes the glob-matching sibling");
    const aggregate = coverageAggregate.aggregateRawCoverage([
      { name: "bracketed-route-fixture", rawDirectory: raw, lcov: lcovText },
    ], root, ["requirements/[slug]/page.js"]);
    assert.match(aggregate.report, /SF:requirements\/\[slug\]\/page\.js\n/,
      "the literal bracketed route must remain eligible for aggregation");
    assert.doesNotMatch(aggregate.report, /SF:requirements\/s\/page\.js\n/,
      "the bracket expression must not broaden eligibility to a raw-only glob-matching sibling");

    const literalFilter = coverageWorker.memoizeFileCoverageFilter({ shouldSkipFileCoverage: () => false },
      new Set([path.join(slugRoute, "page.js")]));
    assert.equal(literalFilter.shouldSkipFileCoverage(pathToFileURL(path.join(slugRoute, "page.js")).href), false);
    assert.equal(literalFilter.shouldSkipFileCoverage(pathToFileURL(path.join(singleCharacterRoute, "page.js")).href), true);
    assert.equal(literalFilter.shouldSkipFileCoverage("node:internal/skipped"), true,
      "non-file V8 entries remain excluded without changing the fail-closed source census");
    assert.throws(() => literalFilter.shouldSkipFileCoverage("file:///bad%"),
      "malformed file URLs must fail closed rather than silently disappearing from coverage");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-839 native coverage adapter supports both Node 22 and 24 constructor forms", () => {
  const directory = "/coverage/raw";
  const cwd = "/workspace";
  const options = { cwd, sourceMaps: false, coverageExcludeGlobs: [], coverageIncludeGlobs: [] };
  for (const [major, expected] of [
    [22, [directory, undefined, cwd, options.coverageExcludeGlobs, options.coverageIncludeGlobs]],
    [24, [directory, undefined, options]],
  ]) {
    class CapturingTestCoverage {
      constructor(...args) { this.args = args; }
    }
    const coverage = coverageWorker.newTestCoverage(CapturingTestCoverage, directory, cwd, options, major);
    assert.ok(coverage instanceof CapturingTestCoverage);
    assert.deepEqual(coverage.args, expected, `Node ${major} constructor contract`);
  }
});

test("COORD-786 native aggregate rejects calls without a production witness census", () => {
  assert.throws(() => coverageAggregate.aggregateRawCoverage([], path.resolve(__dirname, "../..")),
    /requires an explicit production witness-file census/);
});

test("COORD-786 measured worker performs native aggregation and fails closed on missing raw inputs",
  { skip: nativeCoverageSkip }, () => {
  const root = path.resolve(__dirname, "../..");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-worker-direct-"));
  try {
    fs.mkdirSync(path.join(fixture, "scripts"));
    fs.writeFileSync(path.join(fixture, "scripts", "subject.js"),
      "module.exports = (flag) => flag ? left() : right();\nfunction left(){return 1}\nfunction right(){return 2}\n");
    const testPath = path.join(fixture, "scripts", "subject.test.js");
    const rawDirectory = path.join(fixture, "raw");
    const lcovPath = path.join(fixture, "module.info");
    fs.mkdirSync(rawDirectory);
    fs.writeFileSync(testPath,
      "const test=require('node:test');const subject=require('./subject');test('subject',()=>subject(true));\n");
    const moduleRun = spawnSync(process.execPath, ["--test", "--experimental-test-coverage", "--test-concurrency=1",
      "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`, testPath], {
      cwd: root, encoding: "utf8", env: { ...childEnv(), NODE_V8_COVERAGE: rawDirectory },
    });
    assert.equal(moduleRun.status, 0, moduleRun.stderr + moduleRun.stdout);
    const manifest = { modules: [{ name: "direct-worker", rawDirectory, lcov: fs.readFileSync(lcovPath, "utf8") }], witnessFiles: [] };
    const worker = path.join(__dirname, "coverage-aggregate-worker.js");
    const workerRaw = path.join(fixture, "worker-raw");
    fs.mkdirSync(workerRaw);
    const direct = spawnSync(process.execPath, ["--expose-internals", worker, root], {
      cwd: root, input: JSON.stringify(manifest), encoding: "utf8",
      env: { ...childEnv(), NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE || workerRaw },
    });
    assert.equal(direct.status, 0, direct.stderr + direct.stdout);
    const output = JSON.parse(direct.stdout);
    assert.ok(output.report.includes("BRDA:"));
    const workerCoverageDir = process.env.NODE_V8_COVERAGE || workerRaw;
    const workerSnapshots = fs.readdirSync(workerCoverageDir).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(workerCoverageDir, name), "utf8")));
    assert.ok(workerSnapshots.some((snapshot) => snapshot.result.some((script) =>
      script.url === require("node:url").pathToFileURL(worker).href)),
    "executing the real worker records its file-backed production source and branches in raw V8 coverage");
    const missing = spawnSync(process.execPath, ["--expose-internals", worker, root], {
      cwd: root, input: JSON.stringify({ ...manifest, modules: [{ ...manifest.modules[0], rawDirectory: path.join(fixture, "missing") }] }),
      encoding: "utf8", env: childEnv(),
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ENOENT|raw coverage/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("COORD-786 memoizes native file-filter decisions per coverage instance", () => {
  assert.throws(() => coverageWorker.memoizeFileCoverageFilter({}), /native coverage filter is unavailable/);
  const url = "file:///workspace/scripts/shared.js";
  const literalFiles = new Set(["/workspace/scripts/shared.js"]);
  let firstCalls = 0;
  let secondCalls = 0;
  const first = coverageWorker.memoizeFileCoverageFilter({
    shouldSkipFileCoverage(candidate) { firstCalls++; return !candidate.endsWith("shared.js"); },
  }, literalFiles);
  const second = coverageWorker.memoizeFileCoverageFilter({
    shouldSkipFileCoverage(candidate) { secondCalls++; return candidate.endsWith("shared.js"); },
  }, literalFiles);

  assert.equal(first.shouldSkipFileCoverage(url), false);
  assert.equal(first.shouldSkipFileCoverage(url), false);
  assert.equal(firstCalls, 1, "a repeated URL delegates to the native filter only once");
  assert.equal(second.shouldSkipFileCoverage(url), true,
    "a distinct instance retains its own include options for the same URL");
  assert.equal(second.shouldSkipFileCoverage(url), true);
  assert.equal(secondCalls, 1);
});

test("COORD-786 invalid raw ranges fail closed with file and offset diagnostics", () => {
  assert.throws(() => coverageWorker.rangeHash("source", { startOffset: 1, endOffset: 99 }, {
    file: "scripts/fixture.js", phase: "merged-native-witness", function_index: 2,
    function_name: "example", range_index: 1,
  }), /invalid raw source-range offsets: .*"file":"scripts\/fixture\.js".*"start_offset":1.*"end_offset":99.*"source_length":6/);
});

test("COORD-786 range witnesses validate only the exact production census in donor and packed layouts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-witness-census-"));
  try {
    for (const layout of ["donor", "packed"]) {
      const contentRoot = layout === "donor" ? path.join(root, "coord") : root;
      const goodRel = layout === "donor" ? "coord/scripts/good.js" : "scripts/good.js";
      const good = path.join(root, ...goodRel.split("/"));
      const transformed = path.join(root, "frontend/apps/coord-ui/lib/transformed.ts");
      fs.mkdirSync(path.dirname(good), { recursive: true });
      fs.mkdirSync(path.dirname(transformed), { recursive: true });
      const goodSource = "function good() { return 1; }";
      const transformedSource = "export const sample: number = 1;";
      fs.writeFileSync(good, goodSource);
      fs.writeFileSync(transformed, transformedSource);
      const scripts = [
        { url: pathToFileURL(transformed).href, functions: [{ functionName: "", ranges: [
          { startOffset: 0, endOffset: transformedSource.length + 5, count: 1 },
        ], isBlockCoverage: false }] },
        { url: pathToFileURL(good).href, functions: [
          { functionName: "", ranges: [{ startOffset: 0, endOffset: goodSource.length, count: 1 }], isBlockCoverage: false },
          { functionName: "good", ranges: [{ startOffset: 0, endOffset: goodSource.length, count: 0,
            lines: [{ line: 1 }] }], isBlockCoverage: false },
        ] },
      ];
      const summary = { files: [
        { path: transformed, functions: [], branches: [] },
        { path: good, functions: [{ name: "good", line: 1, count: 0 }], branches: [] },
      ] };
      const report = `SF:${layout === "donor" ? "coord/" : ""}frontend/apps/coord-ui/lib/transformed.ts\nend_of_record\n` +
        `SF:${goodRel}\nFN:1,good\nend_of_record\n`;
      const witnesses = coverageWorker.createWitnesses(scripts, summary, root, report, [goodRel]);
      assert.deepEqual(Object.keys(witnesses), [goodRel]);
      assert.equal(witnesses[goodRel].functions[0].name, "good");
      assert.throws(() => coverageWorker.validateWitnessFiles(root, [goodRel, goodRel]), /duplicate production witness-file path/);
      assert.throws(() => coverageWorker.validateWitnessFiles(root, ["../escape.js"]), /invalid production witness-file path/);
      assert.throws(() => coverageWorker.validateWitnessFiles(root, ["coord/scripts/missing.js"]), /missing production witness-file path/);
      fs.mkdirSync(path.join(root, "coord/scripts/directory.js"), { recursive: true });
      assert.throws(() => coverageWorker.validateWitnessFiles(root, ["coord/scripts/directory.js"]), /not a regular file/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 allowed summaries require raw witnesses and matching function census", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-witness-guards-"));
  try {
    const rel = "coord/scripts/probe.js";
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const source = "function probe() { return 1; }\n";
    fs.writeFileSync(file, source);
    const summary = { files: [{ path: file, functions: [], branches: [] }] };
    const report = `SF:${rel}\nFN:1,probe\nFNDA:1,probe\nend_of_record\n`;
    assert.throws(() => coverageWorker.createWitnesses([], summary, root, report, [rel]),
      /summary file has no raw V8 witness/);
    const raw = { url: pathToFileURL(file).href, functions: [
      { functionName: "", ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }], isBlockCoverage: false },
      { functionName: "probe", ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }], isBlockCoverage: false },
    ] };
    assert.throws(() => coverageWorker.createWitnesses([raw], summary, root, report, [rel]),
      /native summary\/raw witness census mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 branch witness census must match native summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-branch-census-"));
  try {
    const rel = "coord/scripts/branch.js";
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const source = "function probe(flag) { if (flag) return 1; return 2; }\n";
    fs.writeFileSync(file, source);
    const owner = { startOffset: 0, endOffset: source.length, count: 1, lines: [{ line: 1 }] };
    const first = source.indexOf("return 1");
    const second = source.indexOf("return 2");
    const raw = { url: pathToFileURL(file).href, functions: [
      { functionName: "", ranges: [owner], isBlockCoverage: false },
      { functionName: "probe", ranges: [owner,
        { startOffset: first, endOffset: first + 9, count: 1, lines: [{ line: 1 }] },
        { startOffset: second, endOffset: source.length - 1, count: 0, lines: [{ line: 1 }] }], isBlockCoverage: true },
    ] };
    const summary = { files: [{ path: file, functions: [{ name: "probe", line: 1, count: 1 }], branches: [] }] };
    const report = `SF:${rel}\nFN:1,probe\nFNDA:1,probe\nBRDA:1,0,0,1\nBRDA:1,0,1,1\nBRDA:1,0,2,0\nend_of_record\n`;
    assert.throws(() => coverageWorker.createWitnesses([raw], summary, root, report, [rel]),
      /native summary\/raw witness census mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 an out-of-bounds range still fails when its file is explicitly in the witness census", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-census-invalid-range-"));
  try {
    const rel = "coord/scripts/bad.ts";
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const source = "export const bad: number = 1;";
    fs.writeFileSync(file, source);
    const script = { url: pathToFileURL(file).href, functions: [{ functionName: "", ranges: [
      { startOffset: 0, endOffset: source.length + 7, count: 1 },
    ], isBlockCoverage: false }] };
    assert.throws(() => coverageWorker.createWitnesses([script], { files: [
      { path: file, functions: [], branches: [] },
    ] }, root, `SF:${rel}\nend_of_record\n`, [rel]), /invalid raw source-range offsets: .*"file":"coord\/scripts\/bad\.ts"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-786 source range witnesses expose Node's path-dependent branch census",
  { skip: nativeCoverageSkip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord786-arm-witness-"));
  try {
    const scripts = path.join(root, "scripts");
    fs.mkdirSync(scripts);
    const armsSourcePath = path.join(scripts, "arms.js");
    fs.writeFileSync(armsSourcePath,
      "module.exports = (flag) => flag ? left() : right();\n" +
      "function left() { return 'L'; }\nfunction right() { return 'R'; }\n");
    const baselineArmsSource = fs.readFileSync(armsSourcePath, "utf8");
    const runArm = (name, flag) => {
      const testPath = path.join(scripts, `${name}.test.js`);
      const raw = path.join(root, `${name}-raw`);
      const lcovPath = path.join(root, `${name}.info`);
      fs.mkdirSync(raw);
      fs.writeFileSync(testPath,
        `const test=require('node:test');const assert=require('node:assert/strict');` +
        `const arms=require('./arms');test('${name}',()=>assert.equal(arms(${flag}),'${flag ? "L" : "R"}'));\n`);
      const child = spawnSync(process.execPath, ["--test", "--experimental-test-coverage",
        "--test-concurrency=1", "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`,
        testPath], { cwd: root, encoding: "utf8", env: { ...childEnv(), NODE_V8_COVERAGE: raw } });
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const report = fs.readFileSync(lcovPath, "utf8");
      return { name, rawDirectory: raw, lcov: report };
    };
    const trueRun = runArm("true-arm", true);
    const falseRun = runArm("false-arm", false);
    const witnessFiles = ["scripts/arms.js"];
    const trueAggregate = coverageAggregate.aggregateRawCoverage([trueRun], root, witnessFiles);
    const falseAggregate = coverageAggregate.aggregateRawCoverage([falseRun], root, witnessFiles);
    const before = coverage.measure(root, [trueAggregate.report], { rangeWitnesses: trueAggregate.witnesses });
    const swapped = coverage.measure(root, [falseAggregate.report], { rangeWitnesses: falseAggregate.witnesses });
    assert.equal(before.totals.branches.found, 4);
    assert.equal(swapped.totals.branches.found, 4);
    assert.equal(coverage.ratchet(swapped, { ...before, identity_version: 4,
      identity_format: "raw-v8-source-range-v1" }).result, "fail",
      "source-range identities keep an uncovered arm distinct from its covered sibling");
    assert.ok(coverage.ratchet(swapped, { ...before, identity_version: 4,
      identity_format: "raw-v8-source-range-v1" }).new_uncovered.length > 0);
    const witnessed = { ...swapped, identity_format: "raw-v8-source-range-v1" };
    const badBaseline = { identity_version: 3, findings: [] };
    assert.throws(() => coverage.ratchet(witnessed, badBaseline), /identity version 4/);
    const malformed = structuredClone(falseAggregate.witnesses);
    const branch = malformed["scripts/arms.js"].branches[0];
    branch.start += 1;
    assert.throws(() => coverage.measure(root, [falseAggregate.report], { rangeWitnesses: malformed }),
      /witness mismatch|hash mismatch|identity/);
    const swappedWitness = structuredClone(falseAggregate.witnesses);
    [swappedWitness["scripts/arms.js"].branches[0], swappedWitness["scripts/arms.js"].branches[1]] =
      [swappedWitness["scripts/arms.js"].branches[1], swappedWitness["scripts/arms.js"].branches[0]];
    assert.throws(() => coverage.measure(root, [falseAggregate.report], { rangeWitnesses: swappedWitness }),
      /witness mismatch|identity/);

    const both = coverageAggregate.aggregateRawCoverage([trueRun, falseRun], root, witnessFiles);
    const bothMeasured = coverage.measure(root, [both.report], { rangeWitnesses: both.witnesses });
    assert.deepEqual(bothMeasured.totals.branches, { found: 6, hit: 6, pct: 100 },
      "each run's unexecuted arm is a distinct range the other run executed, so both arms stay in the census");

    const trueAgain = runArm("true-again", true);
    const repeatedTrue = coverageAggregate.aggregateRawCoverage([trueRun, trueAgain], root, witnessFiles);
    const stillMissing = coverage.measure(root, [repeatedTrue.report], { rangeWitnesses: repeatedTrue.witnesses });
    assert.ok(stillMissing.totals.branches.hit < stillMissing.totals.branches.found,
      "native merge preserves a genuine branch that no module covered");
    assert.ok(stillMissing.totals.functions.hit < stillMissing.totals.functions.found,
      "native merge preserves an uncalled function");

    const oldV4Baseline = { identity_version: 4, identity_format: "raw-v8-source-range-v1",
      findings: stillMissing.findings };
    const shiftedArmsSource = "// harmless insertion before existing source ranges\n" + baselineArmsSource;
    fs.writeFileSync(armsSourcePath, shiftedArmsSource);
    const shiftedRun = runArm("shifted-true", true);
    const shifted = coverageAggregate.aggregateRawCoverage([shiftedRun], root, witnessFiles);
    const shiftedMeasured = coverage.measure(root, [shifted.report], { rangeWitnesses: shifted.witnesses });
    assert.equal(coverage.ratchet(shiftedMeasured, oldV4Baseline).result, "fail",
      "v4 absolute source offsets conservatively rekey findings after an earlier insertion");
    assert.ok(coverage.ratchet(shiftedMeasured, oldV4Baseline).new_uncovered.length > 0);
    const relocated = coverage.ratchet(shiftedMeasured, { ...oldV4Baseline, source_commit: "a".repeat(40) }, {
      sourceProvider: () => ({ baselineSource: baselineArmsSource, currentSource: shiftedArmsSource }),
    });
    assert.equal(relocated.result, "pass",
      "actual native raw-V8 witnesses inherit only the unchanged source ranges shifted by the insertion");
    assert.equal(relocated.new_uncovered.length, 0);
    assert.ok(relocated.relocated_uncovered.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// COORD-848: raw V8 ranges of validateWitnessFiles recorded from three real
// Node 22 snapshots: the in-process test module (T), a child whose loop body
// never ran (E) and a child that rejected every path (F). 3732-3787 was the
// unreachable escaping-path arm; Node's pairwise merge kept or dropped it
// depending on snapshot order.
const recordedSnapshotShapes = {
  T: [[3119, 4140, 14], [3192, 3248, 0], [3307, 4119, 16], [3539, 3623, 2], [3623, 3732, 14], [3732, 3787, 0],
    [3787, 3849, 14], [3849, 3913, 2], [3913, 3938, 12], [3938, 4006, 2], [4006, 4035, 10], [4035, 4091, 2],
    [4091, 4119, 8], [4119, 4139, 6]],
  E: [[3119, 4140, 1], [3192, 3248, 0], [3307, 4119, 0]],
  F: [[3119, 4140, 1], [3192, 3248, 0], [3539, 3623, 0], [3732, 3787, 0], [3849, 3913, 0], [3938, 4006, 0],
    [4035, 4091, 0]],
};
const recordedSource = Array.from({ length: 80 }, (_, i) => `// recorded COORD-848 snapshot shape, padding line ${i}`)
  .join("\n") + "\n";
function recordedSnapshot(url, shape) {
  return { result: [{ scriptId: "1", url, functions: [
    { functionName: "", ranges: [{ startOffset: 0, endOffset: recordedSource.length, count: 1 }], isBlockCoverage: true },
    { functionName: "validateWitnessFiles", isBlockCoverage: true,
      ranges: recordedSnapshotShapes[shape].map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })) },
  ] }] };
}
function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

test("COORD-848 merged raw coverage is identical for every permutation of the recorded snapshot shapes", () => {
  const url = "file:///workspace/scripts/witness.js";
  const merges = permutations(["T", "E", "F"]).map((order) => JSON.stringify(coverageWorker.mergeRawCoverage(
    order.map((shape) => recordedSnapshot(url, shape).result), () => false)));
  assert.equal(new Set(merges).size, 1);
  const [script] = JSON.parse(merges[0]).filter((item) => item.url === url);
  const ranges = script.functions.find((fn) => fn.functionName === "validateWitnessFiles").ranges;
  assert.deepEqual(ranges.find((range) => range.startOffset === 3732), { startOffset: 3732, endOffset: 3787, count: 0 });
  assert.deepEqual(ranges.find((range) => range.startOffset === 3307), { startOffset: 3307, endOffset: 4119, count: 17 },
    "a range a snapshot omits takes the count of that snapshot's innermost listed container");
  assert.deepEqual(ranges.find((range) => range.startOffset === 3539), { startOffset: 3539, endOffset: 3623, count: 2 });
});

test("COORD-848 raw merge unions scripts and functions, sums counts and orders output canonically", () => {
  const range = (startOffset, endOffset, count) => ({ startOffset, endOffset, count });
  const first = [
    { url: "file:///w/b.js", functions: [
      { functionName: "", ranges: [range(0, 50, 1)], isBlockCoverage: true },
      { functionName: "late", ranges: [range(10, 20, 0)], isBlockCoverage: false },
      { functionName: "beta", ranges: [range(10, 30, 1), range(12, 18, 0)], isBlockCoverage: true },
    ] },
    { url: "file:///w/skipped.js", functions: [{ functionName: "", ranges: [range(0, 5, 1)], isBlockCoverage: true }] },
  ];
  const second = [
    { url: "file:///w/b.js", functions: [
      { functionName: "", ranges: [range(0, 50, 1)], isBlockCoverage: true },
      { functionName: "late", ranges: [range(10, 20, 2), range(14, 16, 0), range(10, 14, 1)], isBlockCoverage: true },
      { functionName: "alpha", ranges: [range(10, 20, 3)], isBlockCoverage: true },
    ] },
    { url: "file:///w/a.js", functions: [{ functionName: "", ranges: [range(0, 9, 4)], isBlockCoverage: false }] },
  ];
  const merged = coverageWorker.mergeRawCoverage([first, second], (url) => url.endsWith("skipped.js"));
  assert.deepEqual(merged, coverageWorker.mergeRawCoverage([second, first], (url) => url.endsWith("skipped.js")));
  assert.deepEqual(merged, [
    { url: "file:///w/a.js", functions: [{ functionName: "", ranges: [range(0, 9, 4)], isBlockCoverage: false }] },
    { url: "file:///w/b.js", functions: [
      { functionName: "", ranges: [range(0, 50, 2)], isBlockCoverage: true },
      { functionName: "beta", ranges: [range(10, 30, 1), range(12, 18, 0)], isBlockCoverage: true },
      { functionName: "alpha", ranges: [range(10, 20, 3)], isBlockCoverage: true },
      { functionName: "late", ranges: [range(10, 20, 2), range(10, 14, 1), range(14, 16, 0)], isBlockCoverage: true },
    ] },
  ]);
});

test("COORD-848 witness paths that could leave the root are rejected before resolution", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord848-witness-path-"));
  try {
    for (const file of ["c:escape.js", "coord/c:escape.js", "/abs.js", "a\\b.js", "a/./b.js", "a//b.js"]) {
      assert.throws(() => coverageWorker.validateWitnessFiles(root, [file]), /invalid production witness-file path/, file);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-848 native aggregate LCOV is identical for every module order of the recorded snapshot shapes",
  { skip: nativeCoverageSkip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord848-permutation-"));
  try {
    const rel = "scripts/witness.js";
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, recordedSource);
    const lcovScript = "const w=require(process.argv[1]);const R=require('internal/test_runner/reporter/lcov');" +
      "const c=w.makeCoverage(process.argv[2],process.argv[3],[process.argv[4]]);const r=new R();const out=[];" +
      "r.on('data',(d)=>out.push(d));r.on('end',()=>process.stdout.write(Buffer.concat(out)));" +
      "r.write({type:'test:coverage',data:{summary:c.summary()}});r.end();";
    const modules = Object.fromEntries(["T", "E", "F"].map((shape, i) => {
      const rawDirectory = path.join(root, `raw-${shape}`);
      fs.mkdirSync(rawDirectory);
      fs.writeFileSync(path.join(rawDirectory, `coverage-${3 - i}000-1792175635115-0.json`),
        JSON.stringify(recordedSnapshot(pathToFileURL(file).href, shape)));
      const child = spawnSync(process.execPath, ["--expose-internals", "-e", lcovScript,
        path.join(__dirname, "coverage-aggregate-worker.js"), rawDirectory, root, rel], { cwd: root, encoding: "utf8", env: childEnv() });
      assert.equal(child.status, 0, child.stderr);
      return [shape, { name: shape, rawDirectory, lcov: child.stdout }];
    }));
    const reports = permutations(["T", "E", "F"]).map((order) =>
      coverageAggregate.aggregateRawCoverage(order.map((shape) => modules[shape]), root, [rel]));
    assert.equal(new Set(reports.map((aggregate) => aggregate.report)).size, 1,
      "the merged LCOV must not depend on module or snapshot order");
    const escaping = reports[0].witnesses[rel].branches.filter((branch) => branch.start === 3732 && branch.end === 3787);
    assert.equal(escaping.length, 1);
    assert.equal(escaping[0].count, 0, "a range no snapshot executed stays uncovered");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// COORD-849: raw V8 ranges of h() in the COORD-848 review probe (ret.js) from
// three real Node 22 processes. V8's MergeConsecutiveRanges joined different
// neighbours per process: run A merged the `return 1` arm with the code after
// it into [31,63], run B reported the whole continuation [40,114] as one
// range, so the union holds [31,63] and [40,114], which overlap without nesting.
const retProbeRuns = {
  A: [[0, 115, 2], [31, 63, 1], [63, 72, 0], [72, 101, 1], [101, 114, 0]],
  B: [[0, 115, 2], [40, 114, 0]],
  C: [[0, 115, 2], [31, 40, 0], [63, 101, 1], [101, 114, 0]],
};
function retProbeSnapshot(run) {
  return [{ url: "file:///probe/src/ret.js", functions: [{ functionName: "h", isBlockCoverage: true,
    ranges: retProbeRuns[run].map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })) }] }];
}
function retProbeCounts(runs) {
  const [script] = coverageWorker.mergeRawCoverage(runs.map(retProbeSnapshot), () => false);
  return script.functions[0].ranges.map((range) => [range.startOffset, range.endOffset, range.count]);
}

test("COORD-849 a union range counts the segment at its start in every snapshot", () => {
  const twoRuns = retProbeCounts(["A", "B"]);
  assert.deepEqual(twoRuns.find(([start, end]) => start === 40 && end === 114), [40, 114, 1],
    "run A's segment [40,63) lies in [31,63,1], so the function count 2 does not apply");
  assert.deepEqual(twoRuns.find(([start, end]) => start === 31 && end === 63), [31, 63, 3],
    "run B's [40,114,0] starts after 31; run B's segment [31,40) takes the function count 2");
  const merges = permutations(["A", "B", "C"]).map((order) => JSON.stringify(retProbeCounts(order)));
  assert.equal(new Set(merges).size, 1, "the merged counts must not depend on snapshot order");
  assert.deepEqual(JSON.parse(merges[0]), [
    [0, 115, 6], [31, 63, 3], [31, 40, 3], [40, 114, 3], [63, 101, 1], [63, 72, 1], [72, 101, 2], [101, 114, 0],
  ], "[63,101] is entered only in run C; run A's segment [63,72) is the untaken return 2");
});

// COORD-849: runCli of learned-rule-promotion.js in the recorded 2670-snapshot
// suite. Four processes entered the promote block [24407,24835] and threw before
// 24593, so V8 joined the rest of that block with the following code into
// [24593,25739,0]; one process skipped the block; one never ran runCli.
test("COORD-849 a block entered before a merged tail stays covered and the never-entered tail stays uncovered", () => {
  const range = (startOffset, endOffset, count) => ({ startOffset, endOffset, count });
  const runCli = (ranges) => [{ url: "file:///w/learned-rule-promotion.js",
    functions: [{ functionName: "runCli", isBlockCoverage: true, ranges: ranges.map(([s, e, c]) => range(s, e, c)) }] }];
  const threw = runCli([[23562, 25740, 1], [23720, 24117, 0], [24140, 24381, 0], [24593, 25739, 0]]);
  const skipped = runCli([[23562, 25740, 1], [23720, 24117, 0], [24140, 24381, 0], [24407, 24835, 0]]);
  const idle = runCli([[23562, 25740, 0]]);
  const [script] = coverageWorker.mergeRawCoverage([threw, threw, skipped, threw, idle, threw], () => false);
  const counts = script.functions[0].ranges.map((item) => [item.startOffset, item.endOffset, item.count]);
  assert.deepEqual(counts.find(([start]) => start === 24407), [24407, 24835, 4],
    "segment [24407,24593) lies in the function range of the four processes that entered the block");
  assert.deepEqual(counts.find(([start]) => start === 24593), [24593, 25739, 0],
    "segment [24593,24835) lies in [24407,24835,0] for the skipping process; no process reached 24593");
});

// COORD-849: a create-concord.js 240-248-style shape on ten 10-character lines.
// Three processes report [10,45,0] (lines 2-4 never ran), one reports [30,70,0]
// (lines 4-7 never ran), so the union ranges overlap without nesting.
test("COORD-849 lines under overlapping union ranges take each snapshot's own count", () => {
  const range = (startOffset, endOffset, count) => ({ startOffset, endOffset, count });
  const url = "file:///w/c.js";
  const lines = Array.from({ length: 10 }, (_, i) => ({ line: i + 1, startOffset: i * 10, endOffset: i * 10 + 9 }));
  const snapshot = (inner) => [{ url, functions: [
    { functionName: "", isBlockCoverage: true, ranges: [range(0, 100, 1), inner] }] }];
  const early = snapshot(range(10, 45, 0));
  const late = snapshot(range(30, 70, 0));
  const merged = permutations([early, early, early, late]).map((order) => {
    const merger = coverageWorker.createRawCoverageMerger(() => false, (candidate) => candidate === url ? lines : null);
    for (const result of order) merger.add(result);
    return JSON.stringify([merger.result(), [...merger.lineCounts()]]);
  });
  assert.equal(new Set(merged).size, 1);
  const [[script], lineCounts] = JSON.parse(merged[0]);
  assert.deepEqual(script.functions[0].ranges, [range(0, 100, 4), range(10, 45, 1), range(30, 70, 0)],
    "segment [30,45) of [30,70] lies in [10,45,0] for the three early processes");
  assert.deepEqual(lineCounts, [[url, [4, 1, 1, 0, 3, 3, 3, 4, 4, 4]]],
    "line 4 never ran; Node's union rule would give it [30,70]'s count from the early processes");
  const unread = coverageWorker.createRawCoverageMerger(() => false);
  unread.add(early);
  assert.deepEqual([...unread.lineCounts()], [], "a script without a line table is left to Node's line rule");
  const empty = coverageWorker.createRawCoverageMerger(() => false, () => [
    { line: 1, startOffset: 0, endOffset: 9 }, { line: 2, startOffset: 10, endOffset: 10 }, { line: 3, startOffset: 11, endOffset: 20 }]);
  empty.add([{ url, functions: [{ functionName: "", isBlockCoverage: false, ranges: [range(0, 9, 2)] }] }]);
  assert.deepEqual([...empty.lineCounts()], [[url, [2, 1, 0]]], "uncovered lines keep Node's initial count");
});

test("COORD-849 per-snapshot line counts replace Node's union line counts in the summary", () => {
  const url = "file:///w/c.js";
  const summary = {
    totals: { totalLineCount: 7, coveredLineCount: 6, coveredLinePercent: 600 / 7 },
    files: [
      { path: require("node:url").fileURLToPath(url), totalLineCount: 4, coveredLineCount: 4, coveredLinePercent: 100,
        lines: [{ line: 1, count: 4 }, { line: 2, count: 3 }, { line: 4, count: 1 }] },
      { path: "/w/other.js", totalLineCount: 3, coveredLineCount: 2, coveredLinePercent: 200 / 3,
        lines: [{ line: 1, count: 1 }, { line: 2, count: 0 }, { line: 3, count: 1 }] },
      { path: "/w/none.js", totalLineCount: 0, coveredLineCount: 0, coveredLinePercent: 100, lines: [] },
    ],
  };
  coverageWorker.applyLineCounts(summary, new Map([[url, [4, 0, 9, 2]],
    ["file:///w/none.js", []]]));
  assert.deepEqual(summary.files[0].lines, [{ line: 1, count: 4 }, { line: 2, count: 0 }, { line: 4, count: 2 }]);
  assert.equal(summary.files[0].coveredLineCount, 3, "ignored line 3 stays covered");
  assert.equal(summary.files[0].coveredLinePercent, 75);
  assert.equal(summary.files[1].coveredLineCount, 2, "a file without per-snapshot counts keeps Node's");
  assert.equal(summary.files[2].coveredLinePercent, 100);
  assert.equal(summary.totals.coveredLineCount, 5);
  assert.equal(summary.totals.coveredLinePercent, 500 / 7);
  const emptySummary = coverageWorker.applyLineCounts({ totals: { totalLineCount: 0 }, files: [] }, new Map());
  assert.equal(emptySummary.totals.coveredLinePercent, 100);
});

test("COORD-849 streaming merge stores identical function shapes once and counts every snapshot", () => {
  const range = (startOffset, endOffset, count) => ({ startOffset, endOffset, count });
  const snapshot = (count) => [
    { url: "file:///w/a.js", functions: [{ functionName: "f", isBlockCoverage: true, ranges: [range(0, 20, 2), range(5, 9, count)] }] },
    { url: "node:internal/skipped", functions: [{ functionName: "", isBlockCoverage: false, ranges: [range(0, 1, 1)] }] },
  ];
  const merger = coverageWorker.createRawCoverageMerger((url) => url.startsWith("node:"));
  for (const count of [0, 1, 0, 1, 1]) merger.add(snapshot(count));
  const expected = [{ url: "file:///w/a.js", functions: [
    { functionName: "f", ranges: [range(0, 20, 10), range(5, 9, 3)], isBlockCoverage: true }] }];
  assert.deepEqual(merger.result(), expected);
  assert.deepEqual(coverageWorker.mergeRawCoverage([0, 1, 0, 1, 1].map(snapshot), (url) => url.startsWith("node:")), expected);
});

test("COORD-849 merged LCOV is written only when the capture names a file outside node:test", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord849-merged-lcov-"));
  try {
    const target = path.join(root, "nested", "merged.info");
    assert.equal(coverageWorker.writeMergedLcov("TN:\n", {}), null);
    assert.equal(coverageWorker.writeMergedLcov("TN:\n", { COORD_COVERAGE_MERGED_LCOV: target, NODE_TEST_CONTEXT: "child-v8" }), null);
    assert.equal(fs.existsSync(target), false, "a test-fixture aggregation must not write the capture's merged LCOV");
    assert.equal(coverageWorker.writeMergedLcov("TN:\nend_of_record\n", { COORD_COVERAGE_MERGED_LCOV: target }), target);
    assert.equal(fs.readFileSync(target, "utf8"), "TN:\nend_of_record\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// COORD-864 (human-admin decision 2026-10-27): a baseline measured before a
// COORD-589 move has no source at the engine path. Relocation falls back to the
// legacy path at the baseline commit only when the shim registry records that
// move; everything else keeps failing closed.
function movedModuleFixture(t) {
  const { renderShimSource: render } = require("../../paths.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord864-move-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coord = path.join(root, "coord");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const moved = "function moved(flag) {\n  if (flag) return 1;\n  return 2;\n}\nmodule.exports = moved;\n";
  const kept = "module.exports = 1;\n";
  fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(coord, "scripts", "moved.js"), moved);
  fs.writeFileSync(path.join(coord, "scripts", "kept.js"), kept);
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "baseline");
  const baselineCommit = git("rev-parse", "HEAD");
  fs.mkdirSync(path.join(coord, "engine", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(coord, "engine", "scripts", "moved.js"), moved);
  fs.writeFileSync(path.join(coord, "scripts", "moved.js"), render("scripts/moved.js"));
  const registry = (shims) => fs.writeFileSync(path.join(coord, "engine", "shim-registry.json"),
    JSON.stringify({ schema_version: 1, stable_entrypoints: [], shims }));
  const hash = (text) => require("node:crypto").createHash("sha256").update(text).digest("hex");
  const { readBaselineCoverageSources } = require("./coverage-source-provider.js");
  const read = (file, current = moved) => readBaselineCoverageSources({ workspaceRoot: root, contentRoot: coord,
    sourceCommit: baselineCommit, file, expectedCurrentHash: hash(current) });
  return { root, coord, baselineCommit, moved, kept, registry, read, git, hash };
}

const MOVED_SHIM = { path: "scripts/moved.js", target: "engine/scripts/moved.js", kind: "removable" };

test("COORD-864 baseline source lookup follows only a registered move to its legacy path", (t) => {
  const { root, coord, moved, kept, registry, read, git, hash } = movedModuleFixture(t);
  const { registeredLegacyPath } = require("./coverage-source-provider.js");
  // Unregistered (no registry file): the engine path has no baseline source.
  assert.equal(read("engine/scripts/moved.js"), null);
  registry([]);
  assert.equal(read("engine/scripts/moved.js"), null, "an unregistered move grants no relocation source");
  registry([MOVED_SHIM]);
  const { baselineHistory: movedHistory, ...movedSources } = read("engine/scripts/moved.js");
  assert.deepEqual(movedSources, { currentSource: moved, baselineSource: moved });
  assert.deepEqual(movedHistory(), [], "no commit after the baseline touched the moved file");
  assert.equal(registeredLegacyPath(coord, "engine/scripts/moved.js"), "scripts/moved.js");
  // Non-moved files resolve at their own path and never consult the registry.
  const { baselineHistory: keptHistory, ...keptSources } = read("scripts/kept.js", kept);
  assert.deepEqual(keptSources, { currentSource: kept, baselineSource: kept });
  assert.deepEqual(keptHistory(), []);
  assert.equal(registeredLegacyPath(coord, "scripts/kept.js"), null);
  // A registered move whose legacy file did not exist at the baseline commit stays unavailable.
  fs.writeFileSync(path.join(coord, "engine", "scripts", "fresh.js"), moved);
  registry([MOVED_SHIM, { path: "scripts/fresh.js", target: "engine/scripts/fresh.js", kind: "removable" }]);
  assert.equal(read("engine/scripts/fresh.js"), null);
  // A blob that exists at the engine path but is not valid UTF-8 is not "absent":
  // it fails closed instead of falling back to the registered legacy path.
  fs.writeFileSync(path.join(coord, "engine", "scripts", "binary.js"), Buffer.from([0xff, 0xfe, 0x00]));
  fs.writeFileSync(path.join(coord, "scripts", "binary.js"), moved);
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "coord/engine/scripts/binary.js", "coord/scripts/binary.js");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "undecodable engine blob");
  const undecodableCommit = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(coord, "engine", "scripts", "binary.js"), moved);
  registry([MOVED_SHIM, { path: "scripts/binary.js", target: "engine/scripts/binary.js", kind: "removable" }]);
  const { readBaselineCoverageSources } = require("./coverage-source-provider.js");
  assert.equal(readBaselineCoverageSources({ workspaceRoot: root, contentRoot: coord, sourceCommit: undecodableCommit,
    file: "engine/scripts/binary.js", expectedCurrentHash: hash(moved) }), null);
  // An unreadable registry fails closed.
  fs.writeFileSync(path.join(coord, "engine", "shim-registry.json"), "{ not json");
  assert.equal(read("engine/scripts/moved.js"), null);
  assert.equal(registeredLegacyPath(coord, "engine/scripts/moved.js"), null);
});

test("COORD-864 the ratchet credits a registered move's inherited line findings and refuses an unregistered one", (t) => {
  const { root, coord, baselineCommit, moved, registry } = movedModuleFixture(t);
  const { readBaselineCoverageSources } = require("./coverage-source-provider.js");
  const hash = require("node:crypto").createHash("sha256").update(moved).digest("hex");
  const sourceProvider = (file, sourceCommit) => readBaselineCoverageSources({ workspaceRoot: root, contentRoot: coord,
    sourceCommit, file, expectedCurrentHash: hash });
  const finding = { check: "engine_coverage", file: "engine/scripts/moved.js", value: "lines:0123456789abcdef0123:0",
    severity: "fail", message: "lines uncovered at 3" };
  const measurement = { identity_format: "raw-v8-source-range-v1", production_file_count: 1, findings: [finding] };
  const baseline = { identity_version: 4, identity_format: "raw-v8-source-range-v1", source_commit: baselineCommit, findings: [finding] };
  registry([]);
  const refused = coverage.ratchet(measurement, baseline, { sourceProvider });
  assert.equal(refused.new_uncovered.length, 1);
  assert.deepEqual(refused.relocation_unavailable.map((entry) => entry.file), ["engine/scripts/moved.js"]);
  registry([MOVED_SHIM]);
  const credited = coverage.ratchet(measurement, baseline, { sourceProvider });
  assert.deepEqual(credited.new_uncovered, []);
  assert.equal(credited.inherited_uncovered, 1);
  assert.deepEqual(credited.relocation_unavailable, []);
});

// COORD-881: a scoped splice records a file's range findings on bytes later
// than source_commit. Range relocation must anchor on the offered source that
// reproduces those findings, so an edit before or after a range keeps its
// credit and an edit inside the range still loses it.
test("COORD-881 range relocation anchors on the source that reproduces the baseline range digests", () => {
  const legacy = "function demo(flag) {\n  if (flag) return 1;\n  return 2;\n}\nmodule.exports = demo;\n";
  const spliced = "// repointed after the move\n" + legacy;
  const ownerStart = spliced.indexOf("function demo");
  const ownerEnd = spliced.indexOf("\n}\n") + 2;
  const siteStart = spliced.indexOf("return 1;");
  const siteEnd = siteStart + "return 1;".length;
  const finding = rangeFinding("scripts/demo.js", "branches", ownerStart, ownerEnd, siteStart, siteEnd,
    sourceHash(spliced.slice(siteStart, siteEnd)));
  const lineFinding = { check: "engine_coverage", file: "scripts/demo.js", value: "lines:0123456789abcdef0123:0" };
  const otherFile = { ...finding, file: "scripts/other.js" };
  const findings = [finding, lineFinding, otherFile];
  const select = (sources) => coverageRelocation.selectBaselineSources(sources, "scripts/demo.js", findings);

  assert.equal(select(null), null, "a missing source stays missing");
  const invalid = { currentSource: spliced, baselineSource: null };
  assert.equal(select(invalid), invalid);
  assert.equal(select({ currentSource: spliced, baselineSource: spliced }).rangeBaselineSource, spliced,
    "a consistent source_commit blob stays the anchor without consulting history");
  assert.equal(select({ currentSource: spliced, baselineSource: legacy }).rangeBaselineSource, legacy,
    "without history an inconsistent anchor is kept and relocation fails closed");
  let consulted = 0;
  assert.equal(select({ currentSource: spliced, baselineSource: spliced,
    baselineHistory: () => { consulted++; return []; } }).rangeBaselineSource, spliced);
  assert.equal(consulted, 0, "history is read only when the source_commit blob disagrees with the findings");
  const chosen = select({ currentSource: spliced, baselineSource: legacy,
    baselineHistory: () => [null, "short", legacy.replace("return 1;", "return 9;"), spliced] });
  assert.equal(chosen.rangeBaselineSource, spliced, "the first candidate reproducing every range digest wins");
  assert.equal(chosen.baselineSource, legacy, "line relocation keeps the source_commit blob");
  assert.equal(select({ currentSource: spliced, baselineSource: legacy,
    baselineHistory: () => { throw new Error("git unavailable"); } }).rangeBaselineSource, legacy);
  assert.equal(select({ currentSource: spliced, baselineSource: legacy,
    baselineHistory: () => "not a list" }).rangeBaselineSource, legacy);
  assert.equal(coverageRelocation.baselineSourceMatches(spliced, []), true);
  assert.equal(coverageRelocation.baselineSourceMatches(undefined, []), false);
});

function coord881Run(root, scripts, name, calls) {
  const testPath = path.join(scripts, `${name}.test.js`);
  const raw = path.join(root, `${name}-raw`);
  const lcovPath = path.join(root, `${name}.info`);
  fs.mkdirSync(raw);
  fs.writeFileSync(testPath, "const test=require('node:test');const demo=require('./demo');" +
    `test('${name}',()=>{${calls}});\n`);
  const child = spawnSync(process.execPath, ["--test", "--experimental-test-coverage",
    "--test-concurrency=1", "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`,
    testPath], { cwd: root, encoding: "utf8", env: { ...childEnv(), NODE_V8_COVERAGE: raw } });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  return { name, rawDirectory: raw, lcov: fs.readFileSync(lcovPath, "utf8") };
}

test("COORD-881 native range findings survive edits before and after a range and lose credit inside it",
  { skip: nativeCoverageSkip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord881-range-"));
  try {
    const scripts = path.join(root, "scripts");
    fs.mkdirSync(scripts);
    const demoPath = path.join(scripts, "demo.js");
    const body = [
      "function first(flag) {",
      "  if (flag) return \"first\";",
      "  return \"none\";",
      "}",
      "function second(flag) {",
      "  if (flag) return \"second\";",
      "  return \"none\";",
      "}",
      "function never() { return \"never\"; }",
      "module.exports = { first, second, never };",
      "",
    ].join("\n");
    const sourceCommitBlob = body;
    const spliced = "// spliced: measured after the move repointed this module\n" + body;
    const calls = "demo.first(false);demo.second(false);";
    const measureVariant = (name, source) => {
      fs.writeFileSync(demoPath, source);
      const run = coord881Run(root, scripts, name, calls);
      const aggregate = coverageAggregate.aggregateRawCoverage([run], root, ["scripts/demo.js"]);
      return coverage.measure(root, [aggregate.report], { rangeWitnesses: aggregate.witnesses });
    };
    const measured = measureVariant("spliced", spliced);
    const rangeKinds = measured.findings.map((finding) => coverageRelocation.parseRangeFinding(finding)?.kind).filter(Boolean);
    assert.ok(rangeKinds.includes("branches") && rangeKinds.includes("functions"),
      `the fixture yields real ${process.version} branch and function range identities`);
    const baseline = { identity_version: 4, identity_format: "raw-v8-source-range-v1", source_commit: "a".repeat(40),
      findings: measured.findings };
    const ratchetWith = (current, currentSource, history) => coverage.ratchet(current, baseline, {
      sourceProvider: () => ({ currentSource, baselineSource: sourceCommitBlob,
        ...(history ? { baselineHistory: () => [spliced] } : {}) }),
    });

    const beforeSource = spliced.replace("function first", "const insertedBefore = \"a longer line\";\nfunction first");
    const before = measureVariant("before", beforeSource);
    assert.equal(ratchetWith(before, beforeSource, false).result, "fail",
      "the source_commit blob cannot relocate findings measured on spliced bytes");
    const beforeResult = ratchetWith(before, beforeSource, true);
    assert.deepEqual(beforeResult.new_uncovered, [], "an edit before every range keeps all inherited credit");
    assert.equal(beforeResult.result, "pass");
    assert.ok(beforeResult.relocated_uncovered.some((item) => item.kind === "branches"));
    assert.ok(beforeResult.relocated_uncovered.some((item) => item.kind === "functions"));

    const afterSource = spliced.replace("module.exports", "const insertedAfter = 1;\nmodule.exports");
    const after = measureVariant("after", afterSource);
    const afterResult = ratchetWith(after, afterSource, true);
    assert.deepEqual(afterResult.new_uncovered, [], "an edit after the ranges keeps their exact identities");
    assert.equal(afterResult.result, "pass");

    const insideSource = spliced.replace("return \"second\";", "return \"second, edited inside its range\";");
    const inside = measureVariant("inside", insideSource);
    const insideResult = ratchetWith(inside, insideSource, true);
    assert.equal(insideResult.result, "fail", "an edit inside a range loses that range's credit");
    const lost = insideResult.new_uncovered.map((finding) => coverageRelocation.parseRangeFinding(finding))
      .filter(Boolean);
    assert.ok(lost.length > 0);
    assert.ok(lost.every((parsed) => insideSource.slice(parsed.ownerStart, parsed.ownerEnd).includes("edited inside")),
      "only the edited function's ranges lose credit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-881 baseline history offers every committed version of a moved file since source_commit", (t) => {
  const { root, coord, baselineCommit, moved, registry, git } = movedModuleFixture(t);
  const { readBaselineCoverageSources, baselineHistory } = require("./coverage-source-provider.js");
  const commit = (message) => {
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A", "coord");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message);
  };
  const enginePath = path.join(coord, "engine", "scripts", "moved.js");
  const spliced = "// repointed\n" + moved;
  registry([MOVED_SHIM]);
  fs.writeFileSync(enginePath, spliced);
  commit("move and repoint");
  fs.appendFileSync(path.join(coord, "scripts", "moved.js"), "\n");
  commit("touch only the legacy shim");
  fs.rmSync(enginePath);
  fs.rmSync(path.join(coord, "scripts", "moved.js"));
  commit("remove both paths");
  const current = "// edited after the splice\n" + spliced;
  fs.writeFileSync(enginePath, current);
  const sources = readBaselineCoverageSources({ workspaceRoot: root, contentRoot: coord, sourceCommit: baselineCommit,
    file: "engine/scripts/moved.js",
    expectedCurrentHash: require("node:crypto").createHash("sha256").update(current).digest("hex") });
  assert.equal(sources.baselineSource, moved, "the primary anchor is still the registered legacy blob at source_commit");
  assert.deepEqual(sources.baselineHistory(), [spliced],
    "deleted revisions are skipped and an unchanged blob is offered once");
  assert.deepEqual(baselineHistory(root, coord, "f".repeat(40), "coord", "engine/scripts/moved.js"), [],
    "an unknown source_commit offers no history");
});

// COORD-907: the advisory pre-gate classifies a partial (changed-suite) measurement.
test("COORD-907 advisory classification separates text-changed lines from unchanged finer arms", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord907-advisory-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    const write = (source) => fs.writeFileSync(path.join(root, "scripts", "demo.js"), source);
    const baseSource = "function choose(flag) {\n  if (flag) return 'yes';\n  return 'no';\n}\n" +
      "function inner(x) {\n  if (x) return 'a';\n  return 'b';\n}\nmodule.exports = { choose, inner };\n";
    const changedSource = baseSource.replace("return 'no';", "return 'nope';");
    fs.writeFileSync(path.join(root, "scripts", "other.js"), "module.exports = 1;\n");
    // Baseline: only choose(true) ever ran, so inner was never executed.
    write(baseSource);
    const baseLcov = "SF:coord/scripts/demo.js\nFN:1,choose\nFNDA:1,choose\nDA:1,1\nDA:2,1\nDA:3,0\n" +
      "BRDA:2,0,0,1\nBRDA:2,0,1,0\nend_of_record\n";
    const baseline = coverage.measure(root, [baseLcov]);
    // Partial run: a new test executes inner(true) only; choose is not executed.
    write(changedSource);
    const partialLcov = "SF:coord/scripts/demo.js\nFN:1,choose\nFN:5,inner\nFNDA:0,choose\nFNDA:1,inner\n" +
      "DA:1,0\nDA:2,0\nDA:3,0\nDA:5,1\nDA:6,1\nDA:7,0\n" +
      "BRDA:6,0,0,1\nBRDA:6,0,1,0\nend_of_record\n";
    const measurement = coverage.measure(root, [partialLcov]);
    const verdict = coverage.ratchet(measurement, baseline);
    const changedLines = coverage.changedLinesFromDiff(
      "diff --git a/coord/scripts/demo.js b/coord/scripts/demo.js\n--- a/coord/scripts/demo.js\n+++ b/coord/scripts/demo.js\n" +
      "@@ -3 +3 @@\n-  return 'no';\n+  return 'nope';\n", "coord/");
    assert.deepEqual([...changedLines.get("scripts/demo.js")], [3]);
    const advisory = coverage.advisoryReport(verdict, measurement, changedLines);
    assert.equal(advisory.advisory, true);
    assert.equal(advisory.gate_evidence, false);
    assert.equal(advisory.baseline_written, false);
    assert.ok(advisory.text_changed.some((f) => f.file === "scripts/demo.js" && f.line === 3),
      "a changed uncovered line needs real tests");
    assert.ok(!advisory.text_changed.some((f) => f.line !== 3));
    assert.ok(advisory.unchanged_arms.some((f) => f.file === "scripts/demo.js" && f.kind === "branches" && f.line === 6),
      "the finer arm exposed in the newly executed inner function is reported");
    assert.ok(!advisory.unchanged_arms.some((f) => f.line === 3));
    assert.ok(!advisory.candidates.some((f) => f.file === "scripts/other.js" || /unobserved/.test(f.value)),
      "files the partial run did not load are not candidates");
    assert.deepEqual(advisory.unobserved_files, ["scripts/other.js"]);
    assert.equal(advisory.inherited_uncovered, verdict.inherited_uncovered);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-907 diff hunk parsing maps only added lines of content-relative files", () => {
  const diff = "+++ b/coord/scripts/a.js\n@@ -4,0 +5,2 @@\n+x\n+y\n@@ -9 +11 @@\n-z\n+w\n" +
    "+++ b/other/b.js\n@@ -1 +1 @@\n+q\n+++ /dev/null\n@@ -1 +0,0 @@\n";
  const lines = coverage.changedLinesFromDiff(diff, "coord/");
  assert.deepEqual([...lines.get("scripts/a.js")].sort((a, b) => a - b), [5, 6, 11]);
  assert.equal(lines.has("other/b.js"), false, "paths outside the content root are not mapped");
  assert.equal(lines.size, 1);
});
