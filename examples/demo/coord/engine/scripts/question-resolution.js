"use strict";
const crypto = require("node:crypto");

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const history = record => `\n## Question resolution ${record.original_digest}\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;

function rows(raw, parseQuestionRow, splitQuestionCells) {
  let offset = 0;
  const result = [];
  for (const segment of raw.split("\n")) {
    const line = segment.endsWith("\r") ? segment.slice(0, -1) : segment;
    const parsed = parseQuestionRow(line);
    if (parsed) result.push({ line, offset, parsed, cells: splitQuestionCells(line), digest: digest(line) });
    offset += segment.length + 1;
  }
  return result;
}

module.exports = function createQuestionResolution(deps) {
  const { state, fail, readCanonicalTextFile, writeCanonicalTextFile, parseQuestionRow,
    splitQuestionCells, withGovernanceMutation, readGovernanceEventLog,
    verifyGovernanceChain, detectGovernanceProvenanceDrift, ensureCurrentAgentIdentity } = deps;

  function confirmReplay(record, matches, candidates, raw, expected, evidence) {
    if (matches.length || record.evidence !== evidence) fail("Conflicting question resolution replay; the original row or disposition differs.");
    if (record.schema !== "concord.question-resolution/v1" || digest(record.original_row) !== expected || digest(record.resolved_row) !== record.resolved_digest ||
        candidates.filter(row => row.line === record.resolved_row && row.parsed.resolved === "yes").length !== 1 || raw.split(history(record)).length !== 2) {
      fail("Question resolution history does not match the current resolved row.");
    }
    const provenance = detectGovernanceProvenanceDrift();
    if (provenance.uninitialized || provenance.drift.length || (provenance.snapshotPruned && !provenance.snapshotMatchesCurrent)) {
      fail("Cannot confirm an idempotent question resolution while canonical provenance is unverified or has drift.");
    }
  }

  function inspect(raw, expected, evidence) {
    const candidates = rows(raw, parseQuestionRow, splitQuestionCells);
    const matches = candidates.filter(row => row.digest === expected);
    if (matches.length > 1) fail("Question selector is ambiguous: multiple rows have that digest.");
    const events = readGovernanceEventLog();
    if (events.length && !verifyGovernanceChain(events).ok) fail("Cannot resolve a question using an invalid governance journal chain.");
    const previous = events.filter(event => event.command === "resolve-question" && event.result === "succeeded" && event.details?.question_resolution?.original_digest === expected);
    if (previous.length > 1) fail("Question resolution history is ambiguous for that digest.");
    if (previous.length === 1) {
      const record = previous[0].details.question_resolution;
      confirmReplay(record, matches, candidates, raw, expected, evidence);
      return { already: true, record };
    }
    if (matches.length !== 1) fail("Question row digest is missing or stale; inspect --dry-run and select the current original row.");
    const row = matches[0];
    if (row.cells.length !== 6 || row.parsed.resolved !== "no") fail("Only a valid six-column unresolved question row can be resolved.");
    return { already: false, row };
  }

  function summary(record, status) {
    return { status, row_digest: record.original_digest, resolved_row_digest: record.resolved_digest, actor: record.actor, resolved_at: record.resolved_at };
  }

  function questionInventory(raw, expected) {
    const questions = rows(raw, parseQuestionRow, splitQuestionCells)
      .filter(row => !expected || row.digest === expected)
      .map(row => ({ row_digest: row.digest, ...row.parsed, valid_cells: row.cells.length === 6 }));
    return { status: "dry_run", questions };
  }

  function resolveQuestion(options = {}) {
    for (const key of Object.keys(options)) {
      if (!["dryRun", "expectedRowDigest", "evidence"].includes(key)) fail(`resolve-question does not accept option ${key}.`);
    }
    const expected = options.expectedRowDigest;
    const evidence = Array.isArray(options.evidence) && options.evidence.length === 1 ? options.evidence[0] : undefined;
    if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) fail("--expected-row-digest must be a complete lowercase SHA256 digest.");
    const raw = readCanonicalTextFile(state.QUESTIONS_PATH);
    if (options.dryRun) {
      const result = questionInventory(raw, expected);
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (!expected || typeof evidence !== "string" || !evidence.trim()) fail("resolve-question requires --expected-row-digest and exactly one nonempty --evidence.");
    // Reject missing/stale selectors before a mutation can initialize a journal
    // or normalize identity. Revalidate the same selection under the lock.
    const preflight = inspect(raw, expected, evidence);
    let result;
    if (preflight.already) {
      result = summary(preflight.record, "already_resolved");
    } else {
      const metadata = { command: "resolve-question" };
      result = withGovernanceMutation(metadata, () => {
        const current = readCanonicalTextFile(state.QUESTIONS_PATH);
        const selected = inspect(current, expected, evidence);
        if (selected.already) return summary(selected.record, "already_resolved");
        metadata.identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
        const actor = metadata.identity?.agent?.handle;
        if (!actor) fail("Question resolution requires a bound agent identity.");
        const row = selected.row, cell = row.cells[5];
        const start = cell.start + cell.raw.search(/\S/);
        const resolved = row.line.slice(0, start) + "yes" + row.line.slice(start + cell.raw.trim().length);
        const record = { schema: "concord.question-resolution/v1", original_digest: expected, resolved_digest: digest(resolved), original_row: row.line, resolved_row: resolved,
          actor, resolved_at: new Date().toISOString(), evidence };
        const updated = current.slice(0, row.offset) + resolved + current.slice(row.offset + row.line.length);
        const next = updated + (updated.endsWith("\n") ? "" : "\n") + history(record);
        metadata.details = { question_resolution: record };
        writeCanonicalTextFile(state.QUESTIONS_PATH, next, { expectedRaw: current });
        return summary(record, "resolved");
      });
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  return { resolveQuestion };
};
