"use strict";

const crypto = require("node:crypto");

const RANGE_VALUE = /^(functions|branches):range:(\d+):(\d+):(\d+):(\d+):([0-9a-f]{64}):([0-9a-f]{64}):(\d+)$/;
const LINE_VALUE = /^lines:[0-9a-f]{20}:\d+$/;

function sourceLines(source) {
  let offset = 0;
  return (source.match(/[^\n]*\n|[^\n]+$/g) || []).map((text) => {
    const line = { text, start: offset, end: offset + text.length };
    offset = line.end;
    return line;
  });
}

// Retain each unique match and mark ambiguous keys without choosing a winner.
function uniqueBy(items, keyOf) {
  const matches = new Map();
  items.forEach((item, index) => {
    const key = keyOf(item, index);
    matches.set(key, matches.has(key) ? null : { item, index });
  });
  return matches;
}

function uniqueAnchors(baselineLines, currentLines) {
  const baselineIndex = uniqueBy(baselineLines, (line) => line.text);
  const currentIndex = uniqueBy(currentLines, (line) => line.text);
  const anchors = [];
  for (const [line, baseline] of baselineIndex) {
    const current = currentIndex.get(line);
    if (baseline && current) anchors.push({ baselineLine: baseline.index, currentLine: current.index });
  }
  return anchors;
}

function addUnchangedSpan(spans, baselineSource, currentSource, baselineStart, baselineEnd, currentStart, currentEnd) {
  if (baselineEnd <= baselineStart || currentEnd <= currentStart) return;
  if (baselineSource.slice(baselineStart, baselineEnd) !== currentSource.slice(currentStart, currentEnd)) return;
  spans.push({ baselineStart, baselineEnd, currentStart, currentEnd });
}

function anchorSpans(anchors, baselineLines, currentLines, baselineSource, currentSource) {
  const spans = [];
  for (const anchor of anchors) {
    const baselineLine = baselineLines[anchor.baselineLine];
    const currentLine = currentLines[anchor.currentLine];
    addUnchangedSpan(spans, baselineSource, currentSource,
      baselineLine.start, baselineLine.end, currentLine.start, currentLine.end);
  }
  return spans;
}

function betweenAnchorSpans(anchors, currentRank, baselineLines, currentLines, baselineSource, currentSource) {
  const spans = [];
  for (let index = 0; index + 1 < anchors.length; index++) {
    const left = anchors[index];
    const right = anchors[index + 1];
    if (currentRank.get(right.currentLine) !== currentRank.get(left.currentLine) + 1) continue;
    addUnchangedSpan(spans, baselineSource, currentSource,
      baselineLines[left.baselineLine].end,
      baselineLines[right.baselineLine].start,
      currentLines[left.currentLine].end,
      currentLines[right.currentLine].start,
    );
  }
  return spans;
}

function edgeAnchorSpans(anchors, currentOrder, baselineLines, currentLines, baselineSource, currentSource) {
  const spans = [];
  if (anchors.length > 0) {
    const first = anchors[0];
    if (currentOrder[0]?.currentLine === first.currentLine) {
      addUnchangedSpan(spans, baselineSource, currentSource,
        0, baselineLines[first.baselineLine].start, 0, currentLines[first.currentLine].start);
    }
    const last = anchors.at(-1);
    if (currentOrder.at(-1)?.currentLine === last.currentLine) {
      addUnchangedSpan(spans, baselineSource, currentSource,
        baselineLines[last.baselineLine].end,
        baselineSource.length,
        currentLines[last.currentLine].end,
        currentSource.length,
      );
    }
  }
  return spans;
}

function mergeUnchangedSpans(spans) {
  // Spans come from disjoint source lines and monotone adjacent-anchor pairs.
  // After merging contiguous spans, this global overlap check rejects tied or
  // crossing spans before any range can be mapped.
  spans.sort((left, right) => left.currentStart - right.currentStart);
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && previous.baselineEnd === span.baselineStart && previous.currentEnd === span.currentStart) {
      previous.baselineEnd = span.baselineEnd;
      previous.currentEnd = span.currentEnd;
    } else {
      merged.push({ ...span });
    }
  }

  const baselineSorted = [...merged].sort((left, right) => left.baselineStart - right.baselineStart);
  const overlaps = (items, endKey, startKey) => items.some((span, index) =>
    index > 0 && items[index - 1][endKey] > span[startKey]);
  return overlaps(merged, "currentEnd", "currentStart") ||
    overlaps(baselineSorted, "baselineEnd", "baselineStart") ? [] : merged;
}

function buildUnchangedSpans(baselineSource, currentSource) {
  if (typeof baselineSource !== "string" || typeof currentSource !== "string") return [];
  const baselineLines = sourceLines(baselineSource);
  const currentLines = sourceLines(currentSource);
  const anchors = uniqueAnchors(baselineLines, currentLines);
  if (anchors.length === 0) return [];
  const currentOrder = [...anchors].sort((left, right) => left.currentLine - right.currentLine);
  const currentRank = new Map(currentOrder.map((anchor, rank) => [anchor.currentLine, rank]));
  return mergeUnchangedSpans([
    ...anchorSpans(anchors, baselineLines, currentLines, baselineSource, currentSource),
    ...betweenAnchorSpans(anchors, currentRank, baselineLines, currentLines, baselineSource, currentSource),
    ...edgeAnchorSpans(anchors, currentOrder, baselineLines, currentLines, baselineSource, currentSource),
  ]);
}

function mapRange(spans, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  const matches = spans.filter((span) => start >= span.currentStart && end <= span.currentEnd);
  if (matches.length !== 1) return null;
  const span = matches[0];
  const baselineStart = start + span.baselineStart - span.currentStart;
  const baselineEnd = end + span.baselineStart - span.currentStart;
  // buildUnchangedSpans only returns non-overlapping spans bounded by source
  // lengths; translating both in-span endpoints by one delta preserves length.
  return { start: baselineStart, end: baselineEnd };
}

// A whole-line span can stop on a repeated closing brace when material after
// the function changed. Extend the proof only for a unique byte-identical
// owner that agrees with every overlapping anchor in both sources.
function mapAnchoredOwner(spans, start, end, baselineSource, currentSource) {
  const overlapsCurrent = (span) => span.currentStart < end && start < span.currentEnd;
  const anchor = spans.find(overlapsCurrent);
  if (!anchor) return null;
  const delta = anchor.baselineStart - anchor.currentStart;
  const baselineStart = start + delta;
  const baselineEnd = end + delta;
  const owner = currentSource.slice(start, end);
  if (baselineStart < 0 || baselineEnd > baselineSource.length ||
      baselineSource.slice(baselineStart, baselineEnd) !== owner) return null;
  if (currentSource.indexOf(owner) !== currentSource.lastIndexOf(owner) ||
      baselineSource.indexOf(owner) !== baselineSource.lastIndexOf(owner)) return null;
  const conflictingAnchor = spans.some((span) =>
    (overlapsCurrent(span) || (span.baselineStart < baselineEnd && baselineStart < span.baselineEnd)) &&
    span.baselineStart - span.currentStart !== delta);
  return conflictingAnchor ? null : { start: baselineStart, end: baselineEnd };
}

function parseRangeFinding(finding) {
  if (!finding || typeof finding.file !== "string" || typeof finding.value !== "string") return null;
  const match = RANGE_VALUE.exec(finding.value);
  if (!match) return null;
  const [, kind, ownerStart, ownerEnd, siteStart, siteEnd, sliceHash, identityDigest, occurrence] = match;
  const parsed = {
    file: finding.file,
    kind,
    ownerStart: Number(ownerStart),
    ownerEnd: Number(ownerEnd),
    siteStart: Number(siteStart),
    siteEnd: Number(siteEnd),
    sliceHash,
    identityDigest,
    occurrence: Number(occurrence),
  };
  if (![parsed.ownerStart, parsed.ownerEnd, parsed.siteStart, parsed.siteEnd, parsed.occurrence]
    .every(Number.isSafeInteger) || parsed.ownerStart < 0 || parsed.ownerEnd <= parsed.ownerStart ||
      parsed.siteStart < parsed.ownerStart || parsed.siteEnd > parsed.ownerEnd || parsed.siteEnd <= parsed.siteStart ||
      (kind === "functions" && (parsed.siteStart !== parsed.ownerStart || parsed.siteEnd !== parsed.ownerEnd))) {
    return null;
  }
  return parsed;
}

function tupleKey(parsed) {
  return [parsed.file, parsed.kind, parsed.ownerStart, parsed.ownerEnd,
    parsed.siteStart, parsed.siteEnd, parsed.sliceHash].join("\0");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function findRelocatedUncovered(currentFindings, baselineFindings, { file, baselineSource, currentSource }) {
  if (typeof file !== "string" || typeof baselineSource !== "string" || typeof currentSource !== "string") {
    return { relocated: [], spans: [] };
  }
  const spans = buildUnchangedSpans(baselineSource, currentSource);
  const baselineRows = baselineFindings.map((finding) => ({ finding, parsed: parseRangeFinding(finding) }))
    .filter(({ parsed }) => parsed?.file === file && parsed.ownerEnd <= baselineSource.length);
  const baselineByTuple = uniqueBy(baselineRows, ({ parsed }) => tupleKey(parsed));

  const proposals = [];
  for (const finding of currentFindings) {
    const current = parseRangeFinding(finding);
    if (!current || current.file !== file || current.ownerEnd > currentSource.length || current.siteEnd > currentSource.length) continue;
    const owner = mapRange(spans, current.ownerStart, current.ownerEnd) ||
      mapAnchoredOwner(spans, current.ownerStart, current.ownerEnd, baselineSource, currentSource);
    if (!owner) continue;
    const delta = owner.start - current.ownerStart;
    const site = { start: current.siteStart + delta, end: current.siteEnd + delta };
    const currentOwner = currentSource.slice(current.ownerStart, current.ownerEnd);
    const baselineOwner = baselineSource.slice(owner.start, owner.end);
    const currentSite = currentSource.slice(current.siteStart, current.siteEnd);
    const baselineSite = baselineSource.slice(site.start, site.end);
    if (currentOwner !== baselineOwner || currentSite !== baselineSite || sha256(currentSite) !== current.sliceHash) continue;
    const candidate = {
      ...current,
      ownerStart: owner.start,
      ownerEnd: owner.end,
      siteStart: site.start,
      siteEnd: site.end,
    };
    const match = baselineByTuple.get(tupleKey(candidate));
    if (match) proposals.push({ finding, baselineFinding: match.item.finding, current, baseline: match.item.parsed });
  }

  const unique = uniqueBy(proposals, (proposal) => tupleKey(proposal.baseline));
  const relocated = proposals.filter((proposal) => unique.get(tupleKey(proposal.baseline)));
  return { relocated, spans };
}

function isLineFinding(finding) {
  return typeof finding?.file === "string" && typeof finding.value === "string" && LINE_VALUE.test(finding.value);
}

function lineLocations(source) {
  const occurrences = new Map();
  return sourceLines(source).map((line) => {
    // Match the existing measured line identity, but recover its exact source
    // coordinates before granting credit. Ordinals alone are not locations.
    const hash = sha256(line.text.trim().replace(/\s+/g, " ")).slice(0, 20);
    const occurrence = occurrences.get(hash) || 0;
    occurrences.set(hash, occurrence + 1);
    return { ...line, kind: "lines", occurrence, siteStart: line.start,
      siteEnd: line.end, value: `lines:${hash}:${occurrence}` };
  });
}

function findRelocatedLines(currentFindings, baselineFindings, { file, baselineSource, currentSource }) {
  if (typeof file !== "string" || typeof baselineSource !== "string" || typeof currentSource !== "string") return [];
  const spans = buildUnchangedSpans(baselineSource, currentSource);
  const currentByValue = new Map(lineLocations(currentSource).map((line) => [line.value, line]));
  const baselineBySite = new Map(lineLocations(baselineSource).map((line) => [`${line.start}:${line.end}`, line]));
  const baselineByValue = uniqueBy(baselineFindings.filter((finding) =>
    isLineFinding(finding) && finding.file === file), (finding) => finding.value);
  const proposals = [];
  for (const finding of currentFindings) {
    if (!isLineFinding(finding) || finding.file !== file) continue;
    const current = currentByValue.get(finding.value);
    if (!current) continue;
    const mapped = mapRange(spans, current.start, current.end);
    if (!mapped) continue;
    // Every unchanged span starts/ends on source-line boundaries and proves
    // byte equality. Mapping a complete current line therefore selects exactly
    // one complete baseline line with identical text, including its newline.
    const baseline = baselineBySite.get(`${mapped.start}:${mapped.end}`);
    const match = baselineByValue.get(baseline.value);
    if (match) proposals.push({ finding, baselineFinding: match.item, current, baseline });
  }
  const unique = uniqueBy(proposals, (proposal) => proposal.baseline.value);
  return proposals.filter((proposal) => unique.get(proposal.baseline.value));
}

module.exports = { buildUnchangedSpans, mergeUnchangedSpans, mapRange, parseRangeFinding,
  findRelocatedUncovered, isLineFinding, findRelocatedLines };

// COORD-881: range relocation proves a finding unchanged only against the bytes
// its baseline row was measured on. A scoped splice (COORD-864..868) records a
// moved file's range findings on a later commit than source_commit, so range
// relocation uses the first offered source whose bytes reproduce every baseline
// range digest recorded for the file. Line identities carry no offsets and keep
// relocating from the source_commit blob.
function baselineSourceMatches(source, findings) {
  return typeof source === "string" && findings.every((parsed) =>
    parsed.ownerEnd <= source.length && sha256(source.slice(parsed.siteStart, parsed.siteEnd)) === parsed.sliceHash);
}

function selectBaselineSources(sources, file, baselineFindings) {
  if (typeof sources?.baselineSource !== "string") return sources;
  const findings = baselineFindings.map(parseRangeFinding).filter((parsed) => parsed?.file === file);
  let candidates = [sources.baselineSource];
  if (typeof sources.baselineHistory === "function" && !baselineSourceMatches(sources.baselineSource, findings)) {
    try {
      candidates = candidates.concat(sources.baselineHistory());
    } catch {
      // An unreadable history leaves only the source_commit blob, which fails closed.
    }
  }
  const match = candidates.find((candidate) => baselineSourceMatches(candidate, findings));
  return { ...sources, rangeBaselineSource: match === undefined ? sources.baselineSource : match };
}
module.exports.baselineSourceMatches = baselineSourceMatches;
module.exports.selectBaselineSources = selectBaselineSources;
