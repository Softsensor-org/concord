"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { state } = require("./governance-context.js");

module.exports = function createJournal(deps = {}) {
  const {
    fail,
    relativeCoordPath,
    existingLockDirs,
    writeFileAtomicSync,
    readJsonFileState,
    formatJsonFileIssue,
    readLastNonEmptyLine,
    withGovernanceRuntimeLock,
    readCanonicalTextFile,
    writeCanonicalTextFile,
    buildQuestionRow,
    appendQuestionRowText,
    parseQuestionRow,
    escapeTable,
    ensureCurrentAgentIdentity,
    resolveEffectiveThreadId,
    readAgentSessions,
    readCanonicalJsonFile,
    getRows,
    formatGovernanceJournalUninitializedMessage,
    splitGovernanceProvenanceDrift,
    GovernanceError,
  } = deps;

  function sha1(value) {
    return crypto.createHash("sha1").update(value).digest("hex");
  }

  // --- ENT-002: tamper-evident journal hash-chain --------------------------------
  // Each appended event records `prev_event_hash` = the canonical hash of the
  // immediately-preceding STORED event record. Reorder / tamper / drop of any
  // chained event breaks a `prev_event_hash` link and is detectable by
  // `verifyGovernanceChain` (surfaced via `gov doctor` and the read-only
  // `gov conform` verb).
  //
  // Migration is NON-DESTRUCTIVE. The durable journal (ENT-001) already holds many
  // pre-chain events with no `prev_event_hash`. We do NOT rewrite history. Instead
  // the first chained append on a legacy log writes an explicit, auditable
  // `chain-anchor` event; events before the anchor validate as "pre-chain /
  // unverified" (never a false tamper alarm), events from the anchor onward form a
  // verified hash-chain. An explicit anchor is preferred over silent backfill so
  // the ENT-001 history stays byte-stable + auditable.

  const CHAIN_ANCHOR_COMMAND = "chain-anchor";
  // The genesis link value for the anchor event (and the very first event in a
  // brand-new log). Distinguishable from any real sha1 (which is 40 hex chars).
  const CHAIN_GENESIS_PREV = "genesis";

  // Canonical hash of a STORED event record. The on-disk journal line is itself
  // canonical (it is the exact string produced by JSON.stringify(record) at
  // append time), so hashing the verbatim line is both deterministic and exactly
  // reproducible by any later reader (including ENT-007's central re-hash). We
  // also expose an object form that re-serializes with stable key order for the
  // append path, where we hold the record object rather than its stored line.
  function canonicalEventSerialization(record) {
    return stableStringify(record);
  }

  function hashGovernanceEventRecord(record) {
    return sha1(canonicalEventSerialization(record));
  }

  function hashGovernanceEventLine(line) {
    return sha1(String(line));
  }

  // Deterministic JSON: object keys sorted recursively so two records with the
  // same content always serialize identically regardless of insertion order.
  function stableStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  function collectGovernedSnapshotFilePaths() {
    const files = new Set([
      state.BOARD_PATH,
      state.PLAN_PATH,
      state.QUESTIONS_PATH,
      state.AGENTS_PATH,
      state.AGENT_SESSIONS_PATH,
    ]);
    for (const [dirPath, pattern] of [
      [state.PLAN_RECORDS_DIR, /\.json$/i],
      ...existingLockDirs().map((dirPath) => [dirPath, /\.lock$/i]),
    ]) {
      if (!fs.existsSync(dirPath)) {
        continue;
      }
      for (const entry of fs.readdirSync(dirPath).sort()) {
        if (!pattern.test(entry)) {
          continue;
        }
        files.add(path.join(dirPath, entry));
      }
    }
    return [...files].sort((left, right) => relativeCoordPath(left).localeCompare(relativeCoordPath(right)));
  }
  
  function buildGovernanceSnapshot() {
    const files = collectGovernedSnapshotFilePaths().map((filePath) => {
      const exists = fs.existsSync(filePath);
      const raw = exists ? fs.readFileSync(filePath, "utf8") : "";
      return {
        path: relativeCoordPath(filePath),
        exists,
        digest: sha1(raw),
      };
    });
    return {
      recorded_at: new Date().toISOString(),
      digest: sha1(JSON.stringify(files)),
      files,
    };
  }
  
  function captureGovernanceRestorePoint() {
    return collectGovernedSnapshotFilePaths().map((filePath) => {
      const exists = fs.existsSync(filePath);
      return {
        path: filePath,
        exists,
        raw: exists ? fs.readFileSync(filePath, "utf8") : null,
      };
    });
  }
  
  function restoreGovernanceRestorePoint(restorePoint) {
    const restoredPaths = new Set();
    for (const entry of restorePoint || []) {
      restoredPaths.add(entry.path);
      if (entry.exists) {
        writeFileAtomicSync(entry.path, entry.raw ?? "");
      } else if (fs.existsSync(entry.path)) {
        fs.rmSync(entry.path, { force: true });
      }
    }
  
    for (const filePath of collectGovernedSnapshotFilePaths()) {
      if (restoredPaths.has(filePath)) {
        continue;
      }
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    }
  }
  
  // --- COORD-033: crash-persistent restore points -------------------------------
  // The in-memory restore point dies with a killed process. Persisting it (atomic
  // write, BEFORE the mutation touches any governed file) lets the NEXT govern
  // invocation roll back a crash-interrupted mutation automatically instead of
  // surfacing a drift question for manual reconcile.
  
  function governanceRestorePointPath() {
    return path.join(state.RUNTIME_DIR, "governance-restore-point.json");
  }
  
  function persistGovernanceRestorePoint(restorePoint, metadata = {}) {
    writeFileAtomicSync(
      governanceRestorePointPath(),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        command: metadata.command || null,
        ticket: metadata.ticket || null,
        files: restorePoint,
      }, null, 2)}\n`
    );
  }
  
  function clearPersistedGovernanceRestorePoint() {
    fs.rmSync(governanceRestorePointPath(), { force: true });
  }
  
  function recoverCrashedGovernanceMutation() {
    const restorePath = governanceRestorePointPath();
    if (!fs.existsSync(restorePath)) {
      return null;
    }
    let persisted = null;
    try {
      persisted = JSON.parse(fs.readFileSync(restorePath, "utf8"));
    } catch {
      // The restore point itself is torn. It is written atomically BEFORE the
      // mutation writes any governed file, so a torn restore point means the
      // interrupted command never started writing: safe to discard.
      fs.rmSync(restorePath, { force: true });
      return { action: "discarded_torn" };
    }
    const provenance = detectGovernanceProvenanceDrift();
    if (!provenance.uninitialized && provenance.drift.length === 0) {
      // Governed files match the journal checkpoint: the interrupted mutation
      // either fully committed (its event landed) or never wrote. Nothing to undo.
      fs.rmSync(restorePath, { force: true });
      return { action: "discarded_consistent" };
    }
    restoreGovernanceRestorePoint(persisted.files || []);
    fs.rmSync(restorePath, { force: true });
    appendGovernanceEvent({
      ts: new Date().toISOString(),
      command: "crash-rollback",
      ticket: persisted.ticket || null,
      before_status: null,
      after_status: null,
      identity: null,
      result: "restored",
      details: {
        interrupted_command: persisted.command || null,
        interrupted_at: persisted.ts || null,
        drifted_paths: provenance.uninitialized ? null : provenance.drift,
      },
      changed_paths: [],
      snapshot: buildGovernanceSnapshot(),
    });
    return { action: "restored", interruptedCommand: persisted.command || null };
  }
  
  function diffGovernanceSnapshots(left, right) {
    const leftFiles = new Map((left?.files || []).map((entry) => [entry.path, entry]));
    const rightFiles = new Map((right?.files || []).map((entry) => [entry.path, entry]));
    const allPaths = new Set([...leftFiles.keys(), ...rightFiles.keys()]);
    const changed = [];
    for (const filePath of [...allPaths].sort()) {
      const leftEntry = leftFiles.get(filePath) || null;
      const rightEntry = rightFiles.get(filePath) || null;
      if (!leftEntry || !rightEntry || leftEntry.exists !== rightEntry.exists || leftEntry.digest !== rightEntry.digest) {
        changed.push(filePath);
      }
    }
    return changed;
  }
  
  function readGovernanceEventLog() {
    if (!fs.existsSync(state.GOVERNANCE_EVENT_LOG_PATH)) {
      return [];
    }
    const lines = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      try {
        events.push(JSON.parse(lines[index]));
      } catch (error) {
        if (index === lines.length - 1) {
          // COORD-033: a crash mid-append leaves exactly one torn trailing line.
          // The journal is the recovery substrate, so readers tolerate the torn
          // tail; the next append repairs it (repairTornGovernanceEventLogTail).
          break;
        }
        fail(`Invalid governance event log entry in ${relativeCoordPath(state.GOVERNANCE_EVENT_LOG_PATH)}: ${error.message}`);
      }
    }
    return events;
  }
  
  function parseGovernanceEventLogLine(line) {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`Invalid governance event log entry in ${relativeCoordPath(state.GOVERNANCE_EVENT_LOG_PATH)}: ${error.message}`);
    }
  }
  
  function governanceSnapshotArtifactPath(digest) {
    return path.join(state.GOVERNANCE_SNAPSHOTS_DIR, `${digest}.json`);
  }
  
  function readGovernanceSnapshotArtifact(digest, options = {}) {
    if (!digest) {
      if (options.allowMissing === true) {
        return null;
      }
      fail("Governance snapshot artifact digest is required.");
    }
    const artifactPath = governanceSnapshotArtifactPath(digest);
    const state = readJsonFileState(artifactPath);
    if (!state.exists) {
      if (options.allowMissing === true) {
        return null;
      }
      fail(`Governance snapshot artifact ${relativeCoordPath(artifactPath)} is missing.`);
    }
    if (state.error) {
      fail(formatJsonFileIssue(artifactPath, "governance snapshot artifact", state));
    }
    if (!state.value || typeof state.value !== "object" || !Array.isArray(state.value.files)) {
      fail(`Invalid governance snapshot artifact at ${relativeCoordPath(artifactPath)}.`);
    }
    return state.value;
  }
  
  function writeGovernanceSnapshotArtifact(snapshot) {
    if (!snapshot?.digest) {
      fail("Governance snapshot artifacts require a digest.");
    }
    fs.mkdirSync(state.GOVERNANCE_SNAPSHOTS_DIR, { recursive: true });
    const artifactPath = governanceSnapshotArtifactPath(snapshot.digest);
    if (!fs.existsSync(artifactPath)) {
      writeFileAtomicSync(artifactPath, JSON.stringify(snapshot, null, 2));
    }
    return artifactPath;
  }
  
  function readGovernanceSnapshotCheckpoint(options = {}) {
    const checkpointState = readJsonFileState(state.GOVERNANCE_SNAPSHOT_PATH);
    if (!checkpointState.exists) {
      if (options.allowMissing === true) {
        return null;
      }
      fail(`Governance snapshot checkpoint ${relativeCoordPath(state.GOVERNANCE_SNAPSHOT_PATH)} is missing.`);
    }
    if (checkpointState.error) {
      fail(formatJsonFileIssue(state.GOVERNANCE_SNAPSHOT_PATH, "governance snapshot checkpoint", checkpointState));
    }
    if (!checkpointState.value || typeof checkpointState.value !== "object" || typeof checkpointState.value.digest !== "string" || checkpointState.value.digest.trim() === "") {
      fail(`Invalid governance snapshot checkpoint at ${relativeCoordPath(state.GOVERNANCE_SNAPSHOT_PATH)}.`);
    }
    return checkpointState.value;
  }
  
  function writeGovernanceSnapshotCheckpoint(snapshot, metadata = {}) {
    writeFileAtomicSync(
      state.GOVERNANCE_SNAPSHOT_PATH,
      JSON.stringify({
        digest: snapshot.digest,
        recorded_at: snapshot.recorded_at || null,
        ts: metadata.ts || null,
        command: metadata.command || null,
        ticket: metadata.ticket || null,
      }, null, 2)
    );
  }
  
  function readLatestGovernanceSnapshotSource() {
    const checkpoint = readGovernanceSnapshotCheckpoint({ allowMissing: true });
    const latestEvent = readLatestGovernanceEvent();
    if (checkpoint?.digest) {
      const snapshot = readGovernanceSnapshotArtifact(checkpoint.digest, { allowMissing: true });
      if (snapshot) {
        if (!latestEvent?.snapshot_digest || latestEvent.snapshot_digest === checkpoint.digest) {
          return {
            latestEvent,
            snapshot,
            source: "checkpoint",
          };
        }
      }
    }
    if (latestEvent?.snapshot_digest) {
      return {
        latestEvent,
        snapshot: readGovernanceSnapshotArtifact(latestEvent.snapshot_digest),
        source: "event-artifact",
      };
    }
    if (latestEvent?.snapshot) {
      return {
        latestEvent,
        snapshot: latestEvent.snapshot,
        source: "legacy-event",
      };
    }
    if (checkpoint?.digest) {
      return {
        latestEvent,
        snapshot: readGovernanceSnapshotArtifact(checkpoint.digest),
        source: "checkpoint",
      };
    }
    return {
      latestEvent,
      snapshot: null,
      source: null,
    };
  }
  
  function readLatestGovernanceEvent() {
    const lastLine = readLastNonEmptyLine(state.GOVERNANCE_EVENT_LOG_PATH);
    if (!lastLine) {
      return null;
    }
    try {
      return JSON.parse(lastLine);
    } catch {
      // COORD-033: torn tail from a crash mid-append — fall back to the last
      // complete entry instead of failing the whole governance surface.
      const events = readGovernanceEventLog();
      return events.length ? events[events.length - 1] : null;
    }
  }
  
  function ensureGovernanceJournalBaseline(reason = "baseline") {
    return withGovernanceRuntimeLock(() => {
      const latest = readLatestGovernanceEvent();
      if (latest?.snapshot_digest || latest?.snapshot) {
        return false;
      }
      appendGovernanceEvent({
        ts: new Date().toISOString(),
        command: "journal-baseline",
        ticket: null,
        before_status: null,
        after_status: null,
        identity: null,
        details: { reason },
        changed_paths: [],
        snapshot: buildGovernanceSnapshot(),
      });
      return true;
    });
  }
  
  // COORD-068: the governed snapshot intentionally tracks runtime ledgers under
  // `.runtime/` (e.g. agent_sessions.json) so a crash mid-mutation can be rolled
  // back. Those ledgers are gitignored yet rewritten every session, so they can
  // never be committed and must not be reported as outstanding governance drift.
  // We filter the drift set by what git actually ignores (the principled, general
  // rule), and fall back to a known runtime-ledger prefix list when git is
  // unavailable (no git binary / not a work tree) so detection degrades safely.
  const RUNTIME_LEDGER_DRIFT_PREFIXES = [".runtime/"];

  function isRuntimeLedgerDriftPath(relativePath) {
    return RUNTIME_LEDGER_DRIFT_PREFIXES.some((prefix) =>
      String(relativePath || "").startsWith(prefix)
    );
  }

  // Drift paths are relativeCoordPath-style (relative to the coord dir), which
  // is the parent of the runtime dir; run check-ignore from there so the
  // relative paths resolve correctly. `runCheckIgnore` is injectable for tests.
  function runGitCheckIgnore(candidates) {
    const coordDir = path.dirname(state.RUNTIME_DIR);
    return spawnSync("git", ["check-ignore", "--stdin"], {
      cwd: coordDir,
      input: `${candidates.join("\n")}\n`,
      encoding: "utf8",
    });
  }

  function gitIgnoredDriftPaths(relativePaths, runCheckIgnore = runGitCheckIgnore) {
    const candidates = [...new Set(relativePaths.filter(Boolean))];
    if (candidates.length === 0) {
      return new Set();
    }
    try {
      const result = runCheckIgnore(candidates);
      // check-ignore exits 0 when >=1 path is ignored, 1 when none are ignored.
      // Any other code (128 = not a git work tree, ENOENT = no git binary) means
      // we cannot trust the result and fall back to the runtime-ledger heuristic.
      if (!result || result.error || (result.status !== 0 && result.status !== 1)) {
        return new Set(candidates.filter((entry) => isRuntimeLedgerDriftPath(entry)));
      }
      return new Set(
        String(result.stdout || "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      );
    } catch {
      return new Set(candidates.filter((entry) => isRuntimeLedgerDriftPath(entry)));
    }
  }

  function detectGovernanceProvenanceDrift() {
    const { latestEvent, snapshot: latestSnapshot } = readLatestGovernanceSnapshotSource();
    const currentSnapshot = buildGovernanceSnapshot();
    if (!latestEvent && !latestSnapshot) {
      return {
        latestEvent: null,
        currentSnapshot,
        drift: [],
        uninitialized: true,
      };
    }
    if (!latestSnapshot) {
      fail(
        `Governance journal latest snapshot is unavailable. ` +
        `Expected ${relativeCoordPath(state.GOVERNANCE_SNAPSHOT_PATH)} or a snapshot artifact for the latest event.`
      );
    }
    const latestPaths = new Set((latestSnapshot.files || []).map((entry) => entry.path));
    const compatibilityIgnoredDrift = new Set();
    const questionsRelativePath = relativeCoordPath(state.QUESTIONS_PATH);
    if (!latestPaths.has(questionsRelativePath) && currentSnapshot.files.some((entry) => entry.path === questionsRelativePath)) {
      compatibilityIgnoredDrift.add(questionsRelativePath);
    }
    const rawDrift = diffGovernanceSnapshots(latestSnapshot, currentSnapshot)
      .filter((filePath) => !compatibilityIgnoredDrift.has(filePath));
    // Drop drift on gitignored runtime ledgers: they are intentionally untracked
    // and rewritten every session, so they can never be reconciled into git and
    // must not surface as outstanding governance drift (COORD-068). Tracked
    // governance artifacts (board, plans, rendered docs) are NOT gitignored and
    // therefore remain in the drift report.
    const ignoredPaths = gitIgnoredDriftPaths(rawDrift);
    return {
      latestEvent,
      currentSnapshot,
      drift: rawDrift.filter((filePath) => !ignoredPaths.has(filePath)),
      uninitialized: false,
    };
  }
  
  function formatGovernanceDriftMessage(latestEvent, drift) {
    const changed = drift.join(", ");
    return (
      `Governed state changed without a journaled gov mutation since ${latestEvent?.ts || "unknown time"}: ${changed}. ` +
      "Run `coord/scripts/gov doctor` to inspect the drift, then use `coord/scripts/gov recover <ticket-id>` for safe lock/session repair or reconcile the manual edit before continuing."
    );
  }
  
  function describeGovernanceMutation(metadata = {}) {
    return [metadata.command, metadata.ticket].filter(Boolean).join(" ").trim() || "governance mutation";
  }
  
  function detectGovernanceQuestionAuthor(metadata = {}) {
    if (metadata.identity?.agent?.handle) {
      return metadata.identity.agent.handle;
    }
    try {
      return ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false }).agent.handle;
    } catch {
      return "governance";
    }
  }
  
  function buildGovernanceDriftQuestion(metadata, provenance) {
    const commandLabel = describeGovernanceMutation(metadata);
    const driftLabel = provenance.drift.join(", ");
    return {
      from: detectGovernanceQuestionAuthor(metadata),
      to: "orchestrator",
      question: `Governance drift observed while running ${commandLabel}: ${driftLabel}`,
      answer:
        `Detected unjournaled governed-state drift since ${provenance.latestEvent?.ts || "unknown time"}. ` +
        `Continued ${commandLabel} and delegated reconciliation to orchestrator.`,
      resolved: "no",
    };
  }
  
  function appendGovernanceDriftQuestion(metadata, provenance) {
    if (!provenance || provenance.uninitialized || provenance.drift.length === 0 || !fs.existsSync(state.QUESTIONS_PATH)) {
      return { logged: false, error: null };
    }
    const row = buildQuestionRow(buildGovernanceDriftQuestion(metadata, provenance));
    try {
      const raw = readCanonicalTextFile(state.QUESTIONS_PATH);
      if (raw.includes(`${row}\n`) || raw.endsWith(row)) {
        return { logged: false, error: null };
      }
      appendQuestionRowText(row);
      return { logged: true, error: null };
    } catch (error) {
      return {
        logged: false,
        error: error?.message || String(error),
      };
    }
  }
  
  function extractDriftSinceTimestamp(answer) {
    const match = /Detected unjournaled governed-state drift since (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(
      String(answer || "")
    );
    if (!match) {
      return null;
    }
    const candidate = String(match[1] || "").trim();
    return Number.isFinite(Date.parse(candidate)) ? candidate : null;
  }
  
  function planStaleDriftNoteRetirement({ questionsText, latestBaselineTs, now = new Date() } = {}) {
    const lines = String(questionsText || "").split(/\r?\n/);
    const retired = [];
    const skipped = [];
    let changed = false;
    const baselineMs = latestBaselineTs ? Date.parse(latestBaselineTs) : NaN;
  
    const nextLines = lines.map((line) => {
      const parsed = parseQuestionRow(line, now);
      if (!parsed || parsed.operational_type !== "drift-note" || parsed.resolved === "yes") {
        return line;
      }
      const sinceTs = extractDriftSinceTimestamp(parsed.answer);
      if (!sinceTs) {
        skipped.push({ date: parsed.date, reason: "no-since-timestamp" });
        return line;
      }
      if (!Number.isFinite(baselineMs) || baselineMs <= Date.parse(sinceTs)) {
        skipped.push({ date: parsed.date, since: sinceTs, reason: "baseline-not-advanced" });
        return line;
      }
      const retiredAnswer =
        `${parsed.answer} Retired by gov retire-stale-drift-notes at ${now.toISOString()}: ` +
        `governance journal baseline advanced to ${latestBaselineTs}, absorbing the drift reported since ${sinceTs}.`;
      changed = true;
      retired.push({ date: parsed.date, since: sinceTs, baseline_ts: latestBaselineTs });
      return `| ${parsed.date} | ${parsed.from} | ${parsed.to} | ${parsed.question} | ${escapeTable(retiredAnswer)} | yes |`;
    });
  
    return {
      text: nextLines.join("\n"),
      changed,
      retired,
      skipped,
    };
  }
  
  function findLatestGovernanceBaselineTimestamp() {
    const event = readLatestGovernanceEvent();
    if (!event || !event.ts) {
      return null;
    }
    if (!event.snapshot_digest && !event.snapshot) {
      return null;
    }
    return event.ts;
  }
  
  function retireStaleDriftNotes(options = {}) {
    const mutation = {
      command: "retire-stale-drift-notes",
      allowProvenanceDrift: true,
    };
    return withGovernanceMutation(mutation, () => {
      const result = applyRetireStaleDriftNotes({ dryRun: options.dryRun === true, now: options.now });
      console.log(JSON.stringify({
        status: result.retired.length > 0 ? (options.dryRun ? "dry-run" : "retired") : "noop",
        dry_run: options.dryRun === true,
        latest_baseline_ts: result.latestBaselineTs,
        retired: result.retired,
        skipped: result.skipped,
      }, null, 2));
      return result;
    });
  }
  
  function applyRetireStaleDriftNotes({ dryRun = false, now = new Date() } = {}) {
    if (!fs.existsSync(state.QUESTIONS_PATH)) {
      return { retired: [], skipped: [], latestBaselineTs: null };
    }
    const latestBaselineTs = findLatestGovernanceBaselineTimestamp();
    if (!latestBaselineTs) {
      return { retired: [], skipped: [], latestBaselineTs: null };
    }
    const raw = readCanonicalTextFile(state.QUESTIONS_PATH);
    const plan = planStaleDriftNoteRetirement({ questionsText: raw, latestBaselineTs, now });
    if (plan.changed && !dryRun) {
      writeCanonicalTextFile(state.QUESTIONS_PATH, plan.text, { expectedRaw: raw });
    }
    return {
      retired: plan.retired,
      skipped: plan.skipped,
      latestBaselineTs,
    };
  }
  
  // Has this stored record joined the hash-chain? An event is "chained" once it
  // carries a `prev_event_hash` link (legacy pre-chain events do not).
  function isChainedEvent(record) {
    return Boolean(record) && typeof record.prev_event_hash === "string" && record.prev_event_hash.length > 0;
  }

  // Build the anchor event that re-roots the chain. Emitted (a) the first time a
  // chained append lands on a legacy (pre-chain) log, and (b) after a torn-tail
  // repair, so a legitimately-repaired tail re-anchors explicitly + auditably
  // instead of reading as a broken link / tamper.
  function buildChainAnchorEvent(reason, extraDetails = {}) {
    return {
      ts: new Date().toISOString(),
      command: CHAIN_ANCHOR_COMMAND,
      ticket: null,
      before_status: null,
      after_status: null,
      identity: null,
      result: "anchored",
      details: { reason, ...extraDetails },
      changed_paths: [],
      prev_event_hash: CHAIN_GENESIS_PREV,
    };
  }

  function appendGovernanceEvent(event) {
    fs.mkdirSync(state.RUNTIME_DIR, { recursive: true });
    const serialized = { ...event };
    if (event.snapshot) {
      writeGovernanceSnapshotArtifact(event.snapshot);
      serialized.snapshot_digest = event.snapshot.digest;
      delete serialized.snapshot;
    }
    const repaired = repairTornGovernanceEventLogTail();
    // The chain tip is the last surviving stored record AFTER any torn-tail
    // truncation. The records we are about to append each link to the previous
    // one; the first of them links to the tip (or re-anchors when the tip is
    // legacy / absent).
    const tip = readLatestGovernanceEvent();
    const records = [];
    // ENT-002: a torn-tail repair re-anchors the chain explicitly. The repair
    // marker is the first NEW chained record; it links off the surviving tip
    // when that tip is already chained, otherwise it carries the genesis anchor.
    if (repaired) {
      records.push({
        ts: new Date().toISOString(),
        command: "journal-tail-repair",
        ticket: null,
        before_status: null,
        after_status: null,
        identity: null,
        result: "repaired",
        details: { discarded_fragment: repaired.fragment, reanchored: true },
        changed_paths: [],
      });
    }
    // ENT-002: first chained append on a legacy log (a tip exists but is not yet
    // chained) inserts an explicit, auditable anchor so pre-chain events are not
    // misread as a broken link. A brand-new log starts directly at genesis.
    if (!repaired && tip && !isChainedEvent(tip)) {
      records.unshift(buildChainAnchorEvent("legacy-pre-chain-migration"));
    }
    records.push(serialized);

    // Stamp prev_event_hash across the records we are appending, in order. The
    // first record links to the surviving tip when that tip is chained; a repair
    // marker / legacy anchor instead re-roots at genesis.
    let prevHash;
    if (isChainedEvent(tip)) {
      prevHash = hashGovernanceEventRecord(tip);
    } else {
      prevHash = CHAIN_GENESIS_PREV;
    }
    const lines = [];
    for (const record of records) {
      if (!Object.prototype.hasOwnProperty.call(record, "prev_event_hash")) {
        record.prev_event_hash = prevHash;
      }
      lines.push(JSON.stringify(record));
      prevHash = hashGovernanceEventRecord(record);
    }
    // COORD-033: append through an explicit fd + fsync so a journaled event is
    // durable, not just buffered in the page cache.
    const fd = fs.openSync(state.GOVERNANCE_EVENT_LOG_PATH, "a");
    try {
      fs.writeFileSync(fd, `${lines.join("\n")}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (event.snapshot) {
      writeGovernanceSnapshotCheckpoint(event.snapshot, event);
    }
  }
  
  // COORD-033: a crash mid-append can leave one torn trailing line. Detect it,
  // truncate it away ATOMICALLY, and surface the discarded fragment so the next
  // append journals a `journal-tail-repair` event for the audit trail.
  function repairTornGovernanceEventLogTail() {
    if (!fs.existsSync(state.GOVERNANCE_EVENT_LOG_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8");
    const lines = raw.split("\n");
    let lastIndex = lines.length - 1;
    while (lastIndex >= 0 && lines[lastIndex].trim() === "") {
      lastIndex -= 1;
    }
    if (lastIndex < 0) {
      return null;
    }
    const candidate = lines[lastIndex].trim();
    try {
      JSON.parse(candidate);
      return null;
    } catch {
      const kept = lines.slice(0, lastIndex).filter((line) => line.trim() !== "");
      writeFileAtomicSync(state.GOVERNANCE_EVENT_LOG_PATH, kept.length ? `${kept.join("\n")}\n` : "");
      return { fragment: candidate.slice(0, 512) };
    }
  }
  
  // ENT-002: verify the journal hash-chain end-to-end. Walks the log in order,
  // splitting it into a leading "pre-chain" legacy run (events with no
  // prev_event_hash, accepted-but-unverified) and the chained run that begins at
  // the first event carrying a prev_event_hash. Within the chained run each
  // event's prev_event_hash must equal the canonical hash of the prior STORED
  // record; the chained run's first event must anchor at genesis. Any mismatch
  // (tamper / reorder / drop) is reported as a broken link. Pure + read-only.
  function verifyGovernanceChain(events = readGovernanceEventLog()) {
    const broken = [];
    let preChainCount = 0;
    let chainedCount = 0;
    let chainStarted = false;
    let head = null;

    for (let index = 0; index < events.length; index += 1) {
      const record = events[index];
      const chained = isChainedEvent(record);
      if (!chainStarted && !chained) {
        // Leading legacy pre-chain event: accepted, unverified.
        preChainCount += 1;
        continue;
      }
      if (!chained) {
        // A non-chained event appearing AFTER the chain began means a chained
        // event was dropped/replaced with a legacy-shaped one: a broken link.
        broken.push({
          index,
          reason: "unchained-event-after-chain-start",
          command: record?.command || null,
          ts: record?.ts || null,
        });
        continue;
      }
      const expectedPrev = chainStarted
        ? hashGovernanceEventRecord(events[index - 1])
        : CHAIN_GENESIS_PREV;
      // The first chained event must anchor at genesis. (The migration anchor and
      // the very first event of a fresh log both carry the genesis marker.)
      if (!chainStarted && record.prev_event_hash !== CHAIN_GENESIS_PREV) {
        broken.push({
          index,
          reason: "chain-start-not-anchored",
          expected: CHAIN_GENESIS_PREV,
          actual: record.prev_event_hash,
          command: record.command || null,
          ts: record.ts || null,
        });
      } else if (chainStarted && record.prev_event_hash !== expectedPrev) {
        broken.push({
          index,
          reason: "prev-hash-mismatch",
          expected: expectedPrev,
          actual: record.prev_event_hash,
          command: record.command || null,
          ts: record.ts || null,
        });
      }
      chainStarted = true;
      chainedCount += 1;
      head = hashGovernanceEventRecord(record);
    }

    return {
      ok: broken.length === 0,
      total: events.length,
      preChainCount,
      chainedCount,
      broken,
      // The chain head is the canonical hash of the last chained event — the
      // attestation input a central re-hash service (ENT-007) would compare.
      head,
    };
  }

  function summarizeIdentityForEvent(identity) {
    return {
      agent_id: identity?.agent?.id || null,
      owner: identity?.agent?.handle || null,
      session_id: identity?.session?.session_id || null,
      thread_id: identity?.session?.thread_id || resolveEffectiveThreadId() || null,
      auto_claimed: identity?.autoClaimed === true,
    };
  }
  
  function recordGovernanceExternalSideEffect(effect) {
    if (!state.activeGovernanceMutationContext || !effect || typeof effect !== "object") {
      return;
    }
    state.activeGovernanceMutationContext.externalSideEffects.push({
      ...effect,
      recorded_at: new Date().toISOString(),
    });
  }
  
  function formatGovernanceExternalSideEffect(effect) {
    if (!effect || typeof effect !== "object") {
      return "unknown external side effect";
    }
    if (effect.type === "github_pr_merge") {
      const parts = [
        effect.pr_url || "GitHub PR",
        effect.method ? `method=${effect.method}` : null,
        effect.merged_at ? `merged_at=${effect.merged_at}` : null,
        effect.delete_branch ? "delete_branch=true" : null,
      ].filter(Boolean);
      return `github_pr_merge(${parts.join(", ")})`;
    }
    return effect.type || "external side effect";
  }
  
  function withGovernanceMutation(metadata, fn) {
    if (state.activeGovernanceMutationContext) {
      state.activeGovernanceMutationContext.depth += 1;
      try {
        return fn();
      } finally {
        state.activeGovernanceMutationContext.depth -= 1;
      }
    }
  
    return withGovernanceRuntimeLock(() => {
      recoverCrashedGovernanceMutation();
      const provenanceBefore = detectGovernanceProvenanceDrift();
      const journalBootstrapped =
        provenanceBefore.uninitialized && metadata.ensureBaseline !== false
          ? ensureGovernanceJournalBaseline(metadata.baselineReason || "mutation")
          : false;
      const provenance = detectGovernanceProvenanceDrift();
      if (provenance.uninitialized && metadata.ensureBaseline === false) {
        fail(formatGovernanceJournalUninitializedMessage());
      }
      const preexistingProvenanceDrift =
        metadata.allowProvenanceDrift === true || provenance.uninitialized
          ? []
          : provenance.drift;
      const driftQuestion = appendGovernanceDriftQuestion(metadata, {
        ...provenance,
        drift: preexistingProvenanceDrift,
      });
      const restorePoint = captureGovernanceRestorePoint();
      persistGovernanceRestorePoint(restorePoint, metadata);
      const beforeSnapshot = buildGovernanceSnapshot();
      state.activeGovernanceMutationContext = {
        depth: 1,
        metadata,
        beforeSnapshot,
        externalSideEffects: [],
      };
      try {
        readAgentSessions();
        let result;
        try {
          result = fn();
        } catch (error) {
          const externalSideEffects = [...state.activeGovernanceMutationContext.externalSideEffects];
          try {
            restoreGovernanceRestorePoint(restorePoint);
          } catch (restoreError) {
            const message =
              `${error?.message || String(error)}\n` +
              `Governance rollback failed: ${restoreError?.message || String(restoreError)}`;
            if (error instanceof GovernanceError) {
              error.message = message;
              throw error;
            }
            throw new GovernanceError(message);
          }
          clearPersistedGovernanceRestorePoint();
          if (externalSideEffects.length > 0) {
            const restoredSnapshot = buildGovernanceSnapshot();
            appendGovernanceEvent({
              ts: new Date().toISOString(),
              command: metadata.command,
              ticket: metadata.ticket || null,
              before_status: metadata.beforeStatus || null,
              after_status: inferTicketStatus(metadata.ticket),
              identity: summarizeIdentityForEvent(metadata.identity),
              result: "failed",
              details: {
                error: error?.message || String(error),
                rollback: {
                  status: "restored",
                },
                external_side_effects: externalSideEffects,
              },
              changed_paths: [],
              snapshot: restoredSnapshot,
            });
            const effectLabel = externalSideEffects.map(formatGovernanceExternalSideEffect).join(", ");
            const hasPrMerge = externalSideEffects.some((e) => e.type === "github_pr_merge" || (typeof e === "string" && /pr.*merge/i.test(e)));
            const recoveryLines = [
              `Governed files were rolled back, but external side effects already occurred: ${effectLabel}`,
            ];
            if (hasPrMerge) {
              recoveryLines.push(
                "Recovery: the PR was already merged. Retry the same gov land command to complete the ticket state update.",
                "If retrying fails, use: gov mark-done <ticket-id> --landed \"<commit sha and evidence>\"",
              );
            } else {
              recoveryLines.push(
                "Recovery: retry the same governance command. If it fails again, use gov recover <ticket-id> to diagnose.",
              );
            }
            const message =
              `${error?.message || String(error)}\n` +
              recoveryLines.join("\n");
            if (error instanceof GovernanceError) {
              error.message = message;
              throw error;
            }
            throw new GovernanceError(message);
          }
          throw error;
        }
        const afterSnapshot = buildGovernanceSnapshot();
        const changedPaths = diffGovernanceSnapshots(beforeSnapshot, afterSnapshot);
        if (changedPaths.length > 0 || metadata.forceLog === true) {
          let details = metadata.details ? { ...metadata.details } : null;
          const externalSideEffects = [...state.activeGovernanceMutationContext.externalSideEffects];
          if (journalBootstrapped) {
            details = { ...(details || {}), journal_bootstrapped: true };
          }
          if (preexistingProvenanceDrift.length > 0) {
            details = {
              ...(details || {}),
              preexisting_drift: preexistingProvenanceDrift,
              preexisting_drift_logged_to_questions: driftQuestion.logged === true,
            };
            if (driftQuestion.error) {
              details.preexisting_drift_question_log_error = driftQuestion.error;
            }
          }
          if (externalSideEffects.length > 0) {
            details = {
              ...(details || {}),
              external_side_effects: externalSideEffects,
            };
          }
          appendGovernanceEvent({
            ts: new Date().toISOString(),
            command: metadata.command,
            ticket: metadata.ticket || null,
            before_status: metadata.beforeStatus || null,
            after_status: metadata.afterStatus || inferTicketStatus(metadata.ticket),
            identity: summarizeIdentityForEvent(metadata.identity),
            result: "succeeded",
            details,
            changed_paths: changedPaths,
            snapshot: afterSnapshot,
          });
        }
        clearPersistedGovernanceRestorePoint();
        return result;
      } finally {
        state.activeGovernanceMutationContext = null;
      }
    });
  }
  
  function inferTicketStatus(ticketId) {
    if (!ticketId || !fs.existsSync(state.BOARD_PATH)) {
      return null;
    }
    try {
      const board = readCanonicalJsonFile(state.BOARD_PATH, { allowMissing: true });
      const row = (getRows(board || {}).find((candidate) => candidate.ID === ticketId)) || null;
      return row?.Status || null;
    } catch {
      return null;
    }
  }
  
  function appendGovernanceProvenanceIssues(errors, warnings = []) {
    const { latestEvent, drift, uninitialized } = detectGovernanceProvenanceDrift();
    if (uninitialized) {
      errors.push(formatGovernanceJournalUninitializedMessage());
      return;
    }
    if (drift.length === 0) {
      return;
    }
    const classified = splitGovernanceProvenanceDrift(drift);
    if (classified.blocking.length > 0) {
      errors.push(formatGovernanceDriftMessage(latestEvent, classified.blocking));
    }
    if (classified.warnings.length > 0) {
      warnings.push(
        `Non-material governance drift remains since ${latestEvent?.ts || "unknown time"}: ${classified.warnings.join(", ")}. ` +
        "Track it as warning-class debt and reconcile when convenient."
      );
    }
  }
  

  return {
    collectGovernedSnapshotFilePaths,
    buildGovernanceSnapshot,
    captureGovernanceRestorePoint,
    restoreGovernanceRestorePoint,
    governanceRestorePointPath,
    persistGovernanceRestorePoint,
    clearPersistedGovernanceRestorePoint,
    recoverCrashedGovernanceMutation,
    diffGovernanceSnapshots,
    readGovernanceEventLog,
    parseGovernanceEventLogLine,
    governanceSnapshotArtifactPath,
    readGovernanceSnapshotArtifact,
    writeGovernanceSnapshotArtifact,
    readGovernanceSnapshotCheckpoint,
    writeGovernanceSnapshotCheckpoint,
    readLatestGovernanceSnapshotSource,
    readLatestGovernanceEvent,
    ensureGovernanceJournalBaseline,
    detectGovernanceProvenanceDrift,
    gitIgnoredDriftPaths,
    isRuntimeLedgerDriftPath,
    formatGovernanceDriftMessage,
    describeGovernanceMutation,
    detectGovernanceQuestionAuthor,
    buildGovernanceDriftQuestion,
    appendGovernanceDriftQuestion,
    extractDriftSinceTimestamp,
    planStaleDriftNoteRetirement,
    findLatestGovernanceBaselineTimestamp,
    retireStaleDriftNotes,
    applyRetireStaleDriftNotes,
    appendGovernanceEvent,
    repairTornGovernanceEventLogTail,
    hashGovernanceEventRecord,
    hashGovernanceEventLine,
    canonicalEventSerialization,
    isChainedEvent,
    verifyGovernanceChain,
    summarizeIdentityForEvent,
    recordGovernanceExternalSideEffect,
    formatGovernanceExternalSideEffect,
    withGovernanceMutation,
    inferTicketStatus,
    appendGovernanceProvenanceIssues,
  };
};
