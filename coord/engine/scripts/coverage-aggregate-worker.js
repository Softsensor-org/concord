"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { fileURLToPath } = require("node:url");

function fail(message) { throw new Error(message); }
function relativeInRoot(root, candidate) {
  const rel = path.relative(root, candidate);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}
function nodeOptions(cwd, includeGlobs) {
  return { cwd, sourceMaps: false, coverageExcludeGlobs: [], coverageIncludeGlobs: includeGlobs };
}
function newTestCoverage(TestCoverage, directory, cwd, options, nodeMajor) {
  if (nodeMajor === 22) {
    return new TestCoverage(directory, undefined, cwd,
      options.coverageExcludeGlobs, options.coverageIncludeGlobs);
  }
  return new TestCoverage(directory, undefined, options);
}
function memoizeFileCoverageFilter(coverage, literalFiles) {
  const nativeFilter = coverage.shouldSkipFileCoverage;
  if (typeof nativeFilter !== "function") fail("native coverage filter is unavailable");
  const boundNativeFilter = nativeFilter.bind(coverage);
  const decisions = new Map();
  coverage.shouldSkipFileCoverage = (url) => {
    // Node's native filter accepts non-file internal URLs and marks them
    // skipped. Do the same before converting file URLs; malformed file URLs
    // still throw rather than being silently treated as an excluded source.
    if (!url.startsWith("file:")) return true;
    const absolute = path.resolve(fileURLToPath(url));
    // coverageIncludeGlobs treats characters such as [slug] as glob syntax.
    // LCOV SF records are literal paths, so compare their resolved file names
    // directly before applying Node's ordinary exclusions.
    if (!literalFiles.has(absolute)) return true;
    if (!decisions.has(url)) decisions.set(url, boundNativeFilter(url));
    return decisions.get(url);
  };
  return coverage;
}
function makeCoverage(directory, cwd, includeFiles) {
  const { TestCoverage } = require("internal/test_runner/coverage");
  const literalFiles = new Set(includeFiles.map((file) => path.resolve(cwd, file)));
  // Keep Node's built-in exclusions, but apply the module's LCOV source census
  // as a literal set in shouldSkipFileCoverage rather than as include globs.
  const options = nodeOptions(cwd, []);
  return memoizeFileCoverageFilter(newTestCoverage(TestCoverage, directory, cwd, options,
    Number(process.versions.node.split(".")[0])), literalFiles);
}
function sourceFiles(lcovText, cwd) {
  const files = [];
  for (const row of lcovText.split(/\r?\n/)) {
    if (!row.startsWith("SF:")) continue;
    const file = row.slice(3);
    files.push(file);
  }
  if (files.length === 0 || new Set(files).size !== files.length) fail("module LCOV has an empty or duplicate source census");
  return files;
}
function lcov(summary) {
  const LcovReporter = require("internal/test_runner/reporter/lcov");
  return new Promise((resolve, reject) => {
    const reporter = new LcovReporter();
    const chunks = [];
    reporter.on("data", (chunk) => chunks.push(chunk));
    reporter.once("error", reject);
    reporter.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    reporter.write({ type: "test:coverage", data: { summary } });
    reporter.end();
  });
}
function lineAt(source, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) return null;
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}
function rangeHash(source, range, context = {}) {
  if (!Number.isSafeInteger(range.startOffset) || !Number.isSafeInteger(range.endOffset) ||
      range.startOffset < 0 || range.endOffset <= range.startOffset || range.endOffset > source.length) {
    fail("invalid raw source-range offsets: " + JSON.stringify({ ...context,
      start_offset: range.startOffset, end_offset: range.endOffset, source_length: source.length }));
  }
  return crypto.createHash("sha256").update(source.slice(range.startOffset, range.endOffset)).digest("hex");
}
function validateWitnessFiles(cwd, files) {
  if (!Array.isArray(files)) fail("production witness-file census must be an array");
  const accepted = new Set();
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0 || file.includes("\\") ||
        path.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes(":") ||
        file.split("/").some((part) => part === "" || part === "." || part === "..")) {
      fail("invalid production witness-file path: " + JSON.stringify(file));
    }
    const absolute = path.resolve(cwd, ...file.split("/"));
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch { fail("missing production witness-file path: " + file); }
    if (!stat.isFile()) fail("production witness-file path is not a regular file: " + file);
    if (accepted.has(file)) fail("duplicate production witness-file path: " + file);
    accepted.add(file);
  }
  return accepted;
}
function reportSites(report) {
  const files = new Map();
  let rel = null, functions = [], branches = [];
  const flush = () => { if (rel) files.set(rel, { functions, branches }); rel = null; functions = []; branches = []; };
  for (const row of report.split(/\r?\n/)) {
    if (row.startsWith("SF:")) { flush(); rel = row.slice(3); }
    else if (row.startsWith("FN:")) {
      const comma = row.indexOf(",");
      functions.push({ line: Number(row.slice(3, comma)), name: row.slice(comma + 1) });
    } else if (row.startsWith("BRDA:")) {
      const [line, block, branch] = row.slice(5).split(",");
      branches.push(`${line}:${block}:${branch}`);
    } else if (row === "end_of_record") flush();
  }
  flush();
  return files;
}
function rangeContains(outer, inner) {
  return outer.startOffset <= inner.startOffset && inner.endOffset <= outer.endOffset;
}
// Elementary-segment evaluation. Cut a function's source at every range
// boundary any snapshot reports; the resulting segments are disjoint, and in
// each snapshot every segment lies wholly inside or wholly outside each listed
// range, so the snapshot's count for a segment is the count of its innermost
// listed range containing it (ranges[0], the function range, contains all).
// That is exact even when V8's MergeConsecutiveRanges joined different
// neighbours in different processes, which leaves union ranges that overlap
// without nesting.
//
// A union range's count in a snapshot is the count of the segment at its start
// offset (the range's own count when the snapshot lists it). V8 block counters
// count entries into the code at a range's start; a later part of the range
// can differ only through a range starting inside it, and that is the other
// range's count. Because no boundary lies inside the start segment, its
// innermost container is the innermost listed range R with R.start <= start <
// R.end. Taking the maximum over the range's segments instead would credit a
// block with code after it that another process merged into the same range
// (learned-rule-promotion.js 607:114).
function countWithin(ranges, target) {
  let innermost = ranges[0];
  for (const range of ranges) {
    if (range.startOffset === target.startOffset && range.endOffset === target.endOffset) return range.count;
    if (range.startOffset <= target.startOffset && target.startOffset < range.endOffset &&
        rangeContains(innermost, range)) innermost = range;
  }
  return innermost.count;
}
// observations: [{ ranges, isBlockCoverage, times }], where times counts the
// snapshots that reported exactly this function shape.
function mergeFunctionObservations(functionName, observations) {
  const union = new Map();
  for (const fn of observations) {
    for (const range of fn.ranges) {
      union.set(range.startOffset + ":" + range.endOffset, { startOffset: range.startOffset, endOffset: range.endOffset });
    }
  }
  const ranges = [...union.values()]
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
    .map((range) => ({ ...range,
      count: observations.reduce((sum, fn) => sum + fn.times * countWithin(fn.ranges, range), 0) }));
  return { functionName, ranges, isBlockCoverage: observations.some((fn) => fn.isBlockCoverage) };
}
function byFunctionOrder(a, b) {
  return a.ranges[0].startOffset - b.ranges[0].startOffset || b.ranges[0].endOffset - a.ranges[0].endOffset ||
    a.functionName.localeCompare(b.functionName);
}
function byRangeOrder(a, b) {
  return a.startOffset - b.startOffset || b.endOffset - a.endOffset;
}
// Line counts. Node's reporter gives a line the count of the last range, in
// function then range order, that covers the whole line; on one snapshot's
// properly nested ranges that is the innermost listed range containing the
// line's segments. Applied to union ranges that overlap without nesting, the
// rule lets one process's merged range overwrite lines another process ran
// (create-concord.js 240-248), so the merger applies Node's rule to each
// snapshot on its own, in the merged output's order, and sums the results. A
// line no snapshot's range covers keeps Node's initial count (1 when empty).
function lineIndexAt(table, offset) {
  let low = 0, high = table.starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (table.starts[mid] < offset) low = mid + 1; else high = mid;
  }
  return low;
}
function addSnapshotLines(table, functions) {
  table.stamp++;
  for (const fn of [...functions].sort(byFunctionOrder)) {
    for (const range of [...fn.ranges].sort(byRangeOrder)) {
      for (let i = lineIndexAt(table, range.startOffset);
        i < table.starts.length && table.starts[i] < range.endOffset && table.ends[i] <= range.endOffset; i++) {
        table.scratch[i] = range.count;
        table.seen[i] = table.stamp;
      }
    }
  }
  for (let i = 0; i < table.starts.length; i++) {
    if (table.seen[i] !== table.stamp) continue;
    table.counts[i] += table.scratch[i];
    table.covered[i] = 1;
  }
}
function lineTableFor(lines) {
  const table = { starts: new Float64Array(lines.length), ends: new Float64Array(lines.length),
    counts: new Float64Array(lines.length), covered: new Uint8Array(lines.length),
    scratch: new Float64Array(lines.length), seen: new Float64Array(lines.length), stamp: 0 };
  for (let i = 0; i < lines.length; i++) {
    table.starts[i] = lines[i].startOffset;
    table.ends[i] = lines[i].endOffset;
  }
  return table;
}
// Merge raw V8 script coverage from every snapshot. Each range in the union of
// all snapshots' ranges gets the sum of its per-snapshot counts, so a range
// stays uncovered exactly when no snapshot executed it, and the result does
// not depend on snapshot order. Node's pairwise mergeCoverage drops a
// zero-count range unless the next snapshot repeats it, which made the merged
// census depend on snapshot file names (process IDs).
//
// Snapshots are added one at a time: skipped scripts are dropped as each
// snapshot is read, each function is grouped under its key at once with
// identical shapes stored once and counted, and line counts are summed into a
// per-script table, so no snapshot is retained after add() returns.
// sourceLines(url) returns Node's line table for a script, or null to skip
// line counting for it.
function createRawCoverageMerger(shouldSkip, sourceLines = () => null) {
  const scripts = new Map();
  const lineTables = new Map();
  return {
    add(result) {
      for (const script of result) {
        if (shouldSkip(script.url)) continue;
        let functions = scripts.get(script.url);
        if (!functions) {
          scripts.set(script.url, functions = new Map());
          const lines = sourceLines(script.url);
          if (lines) lineTables.set(script.url, lineTableFor(lines));
        }
        for (const fn of script.functions) {
          const key = JSON.stringify([fn.functionName, fn.ranges[0].startOffset, fn.ranges[0].endOffset]);
          let group = functions.get(key);
          if (!group) functions.set(key, group = { functionName: fn.functionName, shapes: new Map() });
          const ranges = fn.ranges.map((range) => ({ startOffset: range.startOffset, endOffset: range.endOffset, count: range.count }));
          const shapeKey = JSON.stringify([fn.isBlockCoverage === true, ranges.map((range) => [range.startOffset, range.endOffset, range.count])]);
          const shape = group.shapes.get(shapeKey);
          if (shape) shape.times++;
          else group.shapes.set(shapeKey, { ranges, isBlockCoverage: fn.isBlockCoverage, times: 1 });
        }
        const table = lineTables.get(script.url);
        if (table) addSnapshotLines(table, script.functions);
      }
    },
    result() {
      return [...scripts.keys()].sort((a, b) => a.localeCompare(b)).map((url) => ({
        url,
        functions: [...scripts.get(url).values()].map((group) =>
          mergeFunctionObservations(group.functionName, [...group.shapes.values()])).sort(byFunctionOrder),
      }));
    },
    // url -> per-line counts (index 0 is line 1).
    lineCounts() {
      const counts = new Map();
      for (const [url, table] of lineTables) {
        counts.set(url, Array.from(table.counts, (count, i) =>
          table.covered[i] ? count : (table.starts[i] === table.ends[i] ? 1 : 0)));
      }
      return counts;
    },
  };
}
function mergeRawCoverage(results, shouldSkip) {
  const merger = createRawCoverageMerger(shouldSkip);
  for (const result of results) merger.add(result);
  return merger.result();
}
// Replace the line counts Node derived from the merged union ranges with the
// per-snapshot sums, keeping Node's line census, ignore comments and covered
// rule (count > 0, or ignored).
function applyLineCounts(summary, lineCounts) {
  const byPath = new Map([...lineCounts].map(([url, counts]) => [fileURLToPath(url), counts]));
  const totals = summary.totals;
  totals.coveredLineCount = 0;
  for (const file of summary.files) {
    const counts = byPath.get(file.path);
    if (counts) {
      for (const line of file.lines) line.count = counts[line.line - 1];
      file.coveredLineCount = file.totalLineCount - file.lines.length + file.lines.filter((line) => line.count > 0).length;
      file.coveredLinePercent = file.totalLineCount === 0 ? 100 : (file.coveredLineCount / file.totalLineCount) * 100;
    }
    totals.coveredLineCount += file.coveredLineCount;
  }
  totals.coveredLinePercent = totals.totalLineCount === 0 ? 100 : (totals.coveredLineCount / totals.totalLineCount) * 100;
  return summary;
}
// The governance-suite baseline-capture job names a file in
// COORD_COVERAGE_MERGED_LCOV so the merged report is uploaded next to the
// baseline. An aggregation started inside a node:test file (NODE_TEST_CONTEXT
// set) is a test fixture and never writes it.
function writeMergedLcov(report, env) {
  const target = env.COORD_COVERAGE_MERGED_LCOV;
  if (!target || env.NODE_TEST_CONTEXT) return null;
  const absolute = path.resolve(target);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, report);
  return absolute;
}
function createWitnesses(scripts, summary, cwd, report, witnessFiles) {
  const allowed = validateWitnessFiles(cwd, witnessFiles);
  const sitesByPath = reportSites(report);
  const byPath = new Map();
  for (const script of scripts) {
    if (!script.url.startsWith("file:")) continue;
    const rel = relativeInRoot(cwd, fileURLToPath(script.url));
    if (rel === null) continue;
    if (!allowed.has(rel)) continue;
    if (byPath.has(rel)) fail("ambiguous merged raw script path: " + rel);
    byPath.set(rel, script);
  }
  const witnesses = {};
  for (const file of summary.files) {
    const rel = relativeInRoot(cwd, file.path);
    if (rel === null) continue;
    if (!allowed.has(rel)) continue;
    const script = byPath.get(rel);
    if (!script) fail("summary file has no raw V8 witness: " + rel);
    const source = fs.readFileSync(file.path, "utf8");
    const functions = [];
    const branches = [];
    const reportSitesForFile = sitesByPath.get(rel) || { functions: [], branches: [] };
    const functionIdentities = new Set();
    const branchIdentities = new Set();
    for (let i = 0; i < script.functions.length; i++) {
      const fn = script.functions[i];
      if (!Array.isArray(fn.ranges) || fn.ranges.length === 0) fail("raw function has no ranges: " + rel);
      const ownerRange = fn.ranges[0];
      const context = { file: rel, phase: "merged-native-witness", function_index: i,
        function_name: fn.functionName || "<anonymous>" };
      const owner = { name: fn.functionName || "", start: ownerRange.startOffset, end: ownerRange.endOffset,
        slice_hash: rangeHash(source, ownerRange, { ...context, range_index: 0, range_role: "owner" }) };
      if (fn.isBlockCoverage) {
        for (let rangeIndex = 0; rangeIndex < fn.ranges.length; rangeIndex++) {
          const range = fn.ranges[rangeIndex];
          const slice_hash = rangeHash(source, range, { ...context, range_index: rangeIndex, range_role: "branch" });
          const identity = crypto.createHash("sha256").update(JSON.stringify({ kind: "branch", owner,
            start: range.startOffset, end: range.endOffset, slice_hash })).digest("hex");
          if (branchIdentities.has(identity)) fail("ambiguous duplicate branch range identity: " + rel);
          branchIdentities.add(identity);
          const site = reportSitesForFile.branches[branches.length];
          if (!site) fail("raw branch has no emitted LCOV site: " + rel);
          branches.push({ site, line: range.lines?.[0]?.line, count: range.count,
            owner, start: range.startOffset, end: range.endOffset, slice_hash, identity });
        }
      }
      if (i > 0) {
        const identity = crypto.createHash("sha256").update(JSON.stringify({ kind: "function", owner })).digest("hex");
        if (functionIdentities.has(identity)) fail("ambiguous duplicate function range identity: " + rel);
        functionIdentities.add(identity);
        const reported = reportSitesForFile.functions[functions.length];
        if (!reported) fail("raw function has no emitted LCOV site: " + rel);
        functions.push({
          site: `${reported.line}:${reported.name}:${reportSitesForFile.functions.slice(0, functions.length).filter((item) => item.name === reported.name).length}`,
          name: fn.functionName || "anonymous_" + functions.length,
          line: fn.ranges[0].lines?.[0]?.line,
          count: Math.max(...fn.ranges.map((range) => range.count)),
          start: fn.ranges[0].startOffset,
          end: fn.ranges[0].endOffset,
          owner,
          slice_hash: owner.slice_hash,
          identity,
        });
      }
    }
    if (functions.length !== file.functions.length || branches.length !== file.branches.length) {
      fail("native summary/raw witness census mismatch: " + rel);
    }
    for (let i = 0; i < functions.length; i++) {
      const actual = functions[i], expected = file.functions[i];
      if (actual.name !== (expected.name || "anonymous_" + i) || actual.line !== expected.line || actual.count !== expected.count ||
          actual.line !== lineAt(source, actual.start)) fail("native summary/raw function mismatch: " + rel + " row " + i);
    }
    for (let i = 0; i < branches.length; i++) {
      const actual = branches[i], expected = file.branches[i];
      if (actual.line !== expected.line || actual.count !== expected.count ||
          actual.line !== lineAt(source, actual.start)) fail("native summary/raw branch mismatch: " + rel + " row " + i);
    }
    witnesses[rel] = { functions, branches };
  }
  return witnesses;
}

async function main() {
  const cwdArg = process.argv[2];
  const cwd = path.resolve(cwdArg);
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid native coverage aggregation manifest");
  const modules = input.modules;
  const witnessFiles = validateWitnessFiles(cwd, input.witnessFiles);
  const major = Number(process.versions.node.split(".")[0]);
  if (![22, 24].includes(major)) fail("raw V8 coverage aggregation supports Node 22.x and 24.x; found " + process.version);
  if (!Array.isArray(modules) || modules.length === 0) fail("no module raw coverage reports supplied");
  const seenNames = new Set();
  const inputs = [];
  for (const module of modules) {
    if (!module || typeof module.name !== "string" || typeof module.rawDirectory !== "string" || typeof module.lcov !== "string") {
      fail("invalid module raw coverage record");
    }
    const directory = path.resolve(module.rawDirectory);
    if (!fs.statSync(directory).isDirectory()) fail("raw coverage path is not a directory: " + directory);
    const entries = fs.readdirSync(directory).sort();
    const jsonFiles = entries.filter((name) => /^coverage-\d+-\d{13}-\d+\.json$/.test(name));
    if (jsonFiles.length === 0 || jsonFiles.length !== entries.length) fail("missing or unexpected raw coverage entries for module " + module.name);
    for (const name of jsonFiles) {
      if (seenNames.has(name)) fail("duplicate raw coverage snapshot name: " + name);
      seenNames.add(name);
      inputs.push({ module: module.name, path: path.join(directory, name) });
    }
    // Prove that every module's LCOV came from these raw snapshots using the
    // same runtime implementation before combining modules.
    const moduleFiles = sourceFiles(module.lcov, cwd);
    const moduleCoverage = makeCoverage(directory, cwd, moduleFiles);
    const moduleReport = await lcov(moduleCoverage.summary());
    if (moduleReport !== module.lcov) {
      let at = 0; while (at < moduleReport.length && moduleReport[at] === module.lcov[at]) at++;
      fail("module LCOV/raw coverage mismatch for " + module.name + " (" + moduleReport.length + " vs " +
        module.lcov.length + "; first diff " + at + ": " + JSON.stringify(moduleReport.slice(at, at + 80)) + " vs " +
        JSON.stringify(module.lcov.slice(at, at + 80)) + ")");
    }
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "coord-coverage-aggregate-"));
  try {
    const aggregateFiles = [...new Set(modules.flatMap((module) => sourceFiles(module.lcov, cwd)))].sort();
    const aggregateCoverage = makeCoverage(temp, cwd, aggregateFiles);
    const merger = createRawCoverageMerger((url) => aggregateCoverage.shouldSkipFileCoverage(url),
      (url) => aggregateCoverage.getLines(url) || null);
    for (const input of inputs) {
      merger.add(aggregateCoverage.mapCoverageWithSourceMap(JSON.parse(fs.readFileSync(input.path, "utf8"))));
    }
    const scripts = merger.result();
    aggregateCoverage.getCoverageFromDirectory = () => scripts;
    const summary = applyLineCounts(aggregateCoverage.summary(), merger.lineCounts());
    const report = await lcov(summary);
    const witnesses = createWitnesses(scripts, summary, cwd, report, [...witnessFiles]);
    writeMergedLcov(report, process.env);
    process.stdout.write(JSON.stringify({ report, witnesses, node_version: process.version,
      module_count: modules.length, raw_snapshot_count: inputs.length }) + "\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write("native coverage aggregation: " + error.message + "\n"); process.exitCode = 2; });
}

module.exports = { main, sourceFiles, makeCoverage, newTestCoverage, memoizeFileCoverageFilter, validateWitnessFiles,
  createWitnesses, rangeHash, lineAt, mergeRawCoverage, createRawCoverageMerger,
  applyLineCounts, writeMergedLcov };
