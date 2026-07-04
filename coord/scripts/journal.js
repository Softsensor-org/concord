"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { state } = require("./governance-context.js");
const {
  HASH_ALG_SHA1,
  HASH_ALG_SHA256,
  CHAIN_MIGRATION_COMMAND,
  CHAIN_VERIFIER_VERSION,
  CHAIN_ANCHOR_COMMAND,
  CHAIN_GENESIS_PREV,
  sha1,
  sha256,
  hashWithAlg,
  eventHashAlg,
  stableStringify,
  canonicalEventSerialization,
  hashGovernanceEventRecord,
  hashGovernanceEventContent,
  hashGovernanceEventLine,
  isChainedEvent,
  buildChainAnchorEvent,
  verifyGovernanceChain,
} = require("./journal-chain.js");
const { createJournalSnapshots } = require("./journal-snapshots.js");
const { isRuntimeLedgerDriftPath } = require("./journal-seal.js");
const { createJournalRepair } = require("./journal-repair.js");
const {
  transitionPayload,
  verifyTransitionSignature,
} = require("./chain-migration-signing.js");

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
  const {
    governanceSnapshotArtifactPath,
  } = createJournalSnapshots({ path, state });
  const {
    governanceChainRepairBackupPath,
  } = createJournalRepair({ state });

  const {
    // COORD-289: OPTIONAL signer for the hash-alg-migration bridge event. When
    // injected (lifecycle composition root), `migrateGovernanceChainHash` signs
    // the transition payload with the conformance ed25519 keypair. Absent in the
    // pure test/`createJournal({})` path — the verb then fails closed rather than
    // forging an unsigned bridge.
    signChainTransition,
  } = deps;

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

  function collectGovernedSnapshotFilePaths() {
    const files = new Set([
      state.BOARD_PATH,
      state.PLAN_PATH,
      state.QUESTIONS_PATH,
      state.AGENTS_PATH,
      state.AGENT_SESSIONS_PATH,
    ]);

    function collectDirectoryFiles(dirPath, pattern = null) {
      if (!fs.existsSync(dirPath)) {
        return;
      }
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      )) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          collectDirectoryFiles(entryPath, pattern);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (pattern && !pattern.test(entry.name)) {
          continue;
        }
        files.add(entryPath);
      }
    }

    for (const [dirPath, pattern] of [
      [state.PLAN_RECORDS_DIR, /\.json$/i],
      [state.PROMPTS_DIR, null],
      [state.RENDERED_DIR, null],
      ...existingLockDirs().map((dirPath) => [dirPath, /\.lock$/i]),
    ]) {
      collectDirectoryFiles(dirPath, pattern);
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
  
  // COORD-223: idempotency-on-retry support.
  //
  // A governed mutation may be retried after a partial/crashed attempt (the caller
  // re-invokes the same logical command). Crash rollback (COORD-033/220) already makes
  // the FILE state safe: a crashed mutation is rolled back to its pre-state before the
  // retry re-applies. The remaining double-apply hazard is the JOURNAL: a retry that
  // re-runs `fn` would append a SECOND succeeded event for the same logical intent
  // (and, for non-file-diffing effects, could re-do work). When a caller stamps a
  // stable `metadata.idempotencyKey`, we make the retry a clean no-op-or-resume: if a
  // succeeded event already carries that key, the logical mutation already committed,
  // so we skip `fn` entirely and return without appending a duplicate event.
  //
  // The key must be derived from the LOGICAL intent (e.g. ticket + command + a caller
  // request id), NOT from wall-clock time, so the retry computes the same key.
  function findCommittedMutationByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) {
      return null;
    }
    const events = readGovernanceEventLog();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (
        event &&
        event.result === "succeeded" &&
        event.details &&
        event.details.idempotency_key === idempotencyKey
      ) {
        return event;
      }
    }
    return null;
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
  
  // COORD-279 (item 3): every ticket id that has EVER appeared in the journal —
  // the historical-ID set. `nextTicketId` reserves against the MAX of the LIVE
  // board rows AND this set, so an id can never be reissued after its board row
  // was removed (the COORD-198/225 historical-reuse class: a removed row left its
  // id only in the immutable journal, so a max+1 over live rows alone could
  // collide with history). Read-only scan over the append-only event log; every
  // governed mutation that touches a ticket records `event.ticket`, so a filed /
  // started / finalized / removed ticket is all captured here.
  function journalHistoricalTicketIds() {
    const ids = new Set();
    for (const event of readGovernanceEventLog()) {
      const ticket = event && typeof event.ticket === "string" ? event.ticket.trim() : "";
      if (ticket) {
        ids.add(ticket);
      }
    }
    return ids;
  }

  function parseGovernanceEventLogLine(line) {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`Invalid governance event log entry in ${relativeCoordPath(state.GOVERNANCE_EVENT_LOG_PATH)}: ${error.message}`);
    }
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
      // COORD-279 (item 4): the snapshot artifact may have been PRUNED
      // (snapshots are prunable by design — COORD-105/108). Tolerate a missing
      // artifact instead of hard-failing (which bricked every `gov` command);
      // fall back to the legacy inline snapshot / checkpoint, and if nothing is
      // recoverable, surface `pruned` so the caller can gracefully re-baseline.
      const eventArtifact = readGovernanceSnapshotArtifact(latestEvent.snapshot_digest, {
        allowMissing: true,
      });
      if (eventArtifact) {
        return { latestEvent, snapshot: eventArtifact, source: "event-artifact" };
      }
      if (latestEvent.snapshot) {
        return { latestEvent, snapshot: latestEvent.snapshot, source: "legacy-event" };
      }
      const checkpointArtifact = checkpoint?.digest
        ? readGovernanceSnapshotArtifact(checkpoint.digest, { allowMissing: true })
        : null;
      if (checkpointArtifact) {
        return { latestEvent, snapshot: checkpointArtifact, source: "checkpoint" };
      }
      return { latestEvent, snapshot: null, source: null, pruned: true };
    }
    if (latestEvent?.snapshot) {
      return {
        latestEvent,
        snapshot: latestEvent.snapshot,
        source: "legacy-event",
      };
    }
    if (checkpoint?.digest) {
      // COORD-279 (item 4): same pruned-artifact tolerance for the
      // checkpoint-only path.
      const checkpointArtifact = readGovernanceSnapshotArtifact(checkpoint.digest, {
        allowMissing: true,
      });
      if (checkpointArtifact) {
        return { latestEvent, snapshot: checkpointArtifact, source: "checkpoint" };
      }
      return { latestEvent, snapshot: null, source: null, pruned: true };
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

  // COORD-273: detect whether governed COORDINATION state already exists on disk.
  // Used by the uninitialized-journal baseline guard to distinguish a genuine
  // FRESH init (empty/new project: no board ticket rows, no plan records, no
  // prompts, no rendered artifacts) from a project that already HAS live
  // coordination state. The latter, combined with an ABSENT journal, is the
  // signature of a deleted/lost journal over live state (the COORD-273 seal-bypass
  // attack: hand-edit `tasks.json`, `rm` the events log, let the next `gov` command
  // anchor the tampered state as a legitimate genesis). A fresh init has NONE of
  // these surfaces and must still auto-baseline cleanly.
  function directoryContainsAnyFile(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return false;
    }
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (directoryContainsAnyFile(path.join(dirPath, entry.name))) {
          return true;
        }
      } else if (entry.isFile()) {
        return true;
      }
    }
    return false;
  }

  function governedCoordinationStateExists() {
    // The board carrying at least one real ticket row is the strongest signal of
    // live coordination state. A fresh board is structurally empty (no rows).
    try {
      if (fs.existsSync(state.BOARD_PATH)) {
        const board = JSON.parse(fs.readFileSync(state.BOARD_PATH, "utf8"));
        const sections = Array.isArray(board?.sections) ? board.sections : [];
        const rowCount = sections.reduce(
          (total, section) =>
            total + (Array.isArray(section?.rows) ? section.rows.length : 0),
          0
        );
        if (rowCount > 0) {
          return true;
        }
      }
    } catch {
      // A board file that EXISTS but cannot be parsed, sitting over a MISSING
      // journal, is itself anomalous — treat it as existing state and refuse to
      // silently anchor it as a fresh genesis.
      return true;
    }
    // Plan records / prompt mappings / rendered board artifacts present on disk
    // are likewise coordination state that a fresh init does not have.
    for (const dirPath of [state.PLAN_RECORDS_DIR, state.PROMPTS_DIR, state.RENDERED_DIR]) {
      if (directoryContainsAnyFile(dirPath)) {
        return true;
      }
    }
    return false;
  }

  function formatJournalLostOverExistingStateMessage() {
    return (
      "Refusing to auto-baseline the governance journal: the journal is " +
      "absent/uninitialized, but governed coordination state already exists on disk " +
      "(board ticket rows, plan records, prompts, or rendered board artifacts). " +
      "This is the signature of a LOST or DELETED journal over LIVE coordination " +
      "state — including possible tampering (an out-of-band board edit with the " +
      "events log removed to hide it) — NOT a fresh init. Silently anchoring " +
      "whatever is currently on disk as a new genesis baseline would launder that " +
      "state with no evidence of the loss. " +
      "Investigate the missing journal first (`coord/scripts/gov doctor`). " +
      "If you deliberately intend to re-establish a baseline over the existing " +
      "coordination state, use an explicit recovery path that carries recovery " +
      "intent: `coord/scripts/gov recover <ticket-id>` or " +
      "`coord/scripts/gov reconcile --reason \"<why>\"`."
    );
  }

  // COORD-246: advance the provenance baseline to absorb a just-completed
  // governed mutation's OWN post-journal artifact sync.
  //
  // A governed mutation appends its journal event (with a snapshot) at the end of
  // `withGovernanceMutation`, but several terminal lifecycle verbs (finalize /
  // mark-done / finish / land) sync derived coordination-state artifacts AFTER the
  // wrapper returns: the canonical plan record (`updateCanonicalPlanState`), the
  // re-rendered board (`autoSyncAfterLifecycle` -> `runBoardSync`), and the
  // QUESTIONS file. That post-journal sync leaves the on-disk coordination state
  // AHEAD of the journal's latest snapshot. Without this advance, the NEXT
  // independent governed mutation's entry-check (`detectOutOfBandBoardMutation`)
  // mistakes that residual for an out-of-band hand-edit and (once the seal is
  // fail-closed again) REFUSES — which is exactly the COORD-220 over-fire that
  // blocked all post-finalize governed work.
  //
  // Called by the lifecycle auto-sync chokepoint AFTER the full artifact sync, this
  // appends a single `journal-baseline` event whose snapshot reflects the FINAL
  // post-sync on-disk state, but ONLY when coordination-state drift actually
  // remains (so a clean, no-residual mutation stays a no-op and the journal does
  // not gain noise events). The result: after any successful governed mutation,
  // `detectOutOfBandBoardMutation()` returns clean with no manual `gov reconcile`,
  // while a GENUINE out-of-band edit made AFTER this advance still trips the seal.
  // COORD-275: classify whether an out-of-band drift path falls within the set
  // of derived paths the just-completed lifecycle sync was authorized to rewrite.
  // `scopePaths` are coord-relative pathspecs (the canonical synced-artifact set);
  // a drift path is in-scope when it equals a pathspec exactly OR sits under a
  // directory pathspec. The board file matches exactly, the plan-records /
  // prompts-index / rendered files match by their explicit path, and the durable
  // plan-records directory matches by prefix — exactly the granularity the sync
  // actually writes. Anything OUTSIDE this set (e.g. a hand-edited prompt source
  // file, or another ticket's coordination-state row touched in the race window)
  // is NOT the mutation's own output and must stay detectable.
  function isPathWithinSyncScope(relativePath, scopePaths) {
    const value = String(relativePath || "");
    if (!Array.isArray(scopePaths)) {
      return false;
    }
    for (const raw of scopePaths) {
      const spec = String(raw || "");
      if (!spec) {
        continue;
      }
      if (value === spec) {
        return true;
      }
      const dirPrefix = spec.endsWith("/") ? spec : `${spec}/`;
      if (value.startsWith(dirPrefix)) {
        return true;
      }
    }
    return false;
  }

  function advanceGovernanceProvenanceBaseline(reason = "post-mutation-sync", options = {}) {
    // COORD-275: when the lifecycle caller supplies the exact derived-path set its
    // sync just rewrote, constrain the baseline advance to ONLY those paths. A
    // genuine concurrent hand-edit that lands in the window BETWEEN the mutation
    // completing and this advance running shows up as out-of-band coordination
    // drift OUTSIDE that set; absorbing it (the COORD-246 behaviour was "re-baseline
    // whatever drift exists") would silently legitimize a single-writer bypass.
    // Scoping closes that fail-open hole. When no scope is supplied, the legacy
    // (unscoped) absorb-any-drift behaviour is retained for compatibility.
    const scopePaths =
      options && Array.isArray(options.scopePaths) ? options.scopePaths : null;
    return withGovernanceRuntimeLock(() => {
      const provenance = detectGovernanceProvenanceDrift();
      if (provenance.uninitialized) {
        return false;
      }
      // Only advance for residual COORD coordination-state drift (board / plan
      // records / prompts / rendered). Non-material runtime-ledger churn is
      // already excluded by detectGovernanceProvenanceDrift; here we further scope
      // to the same out-of-band classes the seal cares about, so an unrelated
      // tracked-but-non-coordination drift never silently re-baselines.
      const outOfBand = detectOutOfBandBoardMutation(provenance);
      if (!outOfBand.detected) {
        return false;
      }
      // COORD-275: refuse the advance entirely if ANY out-of-band path lies
      // outside the just-synced scope. Leaving it un-baselined keeps it as
      // detectable drift so the next governed command's entry seal / `gov conform`
      // still flags the concurrent edit instead of laundering it as clean.
      if (scopePaths) {
        const outOfScope = outOfBand.paths.filter(
          (driftPath) => !isPathWithinSyncScope(driftPath, scopePaths)
        );
        if (outOfScope.length > 0) {
          console.warn(
            `[gov sync] post-mutation provenance baseline advance (${reason}) was NOT applied: ` +
            `${outOfScope.length} out-of-band coordination-state path(s) lie OUTSIDE the just-synced ` +
            `derived-artifact scope and were NOT produced by this mutation's sync: ${outOfScope.join(", ")}. ` +
            `This drift is preserved as detectable so the next governed command's seal / \`gov conform\` ` +
            `flags it. Reconcile it through a governed mutation (or revert the out-of-band edit).`
          );
          return false;
        }
      }
      appendGovernanceEvent({
        ts: new Date().toISOString(),
        command: "journal-baseline",
        ticket: null,
        before_status: null,
        after_status: null,
        identity: null,
        details: { reason, advanced_paths: outOfBand.paths },
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
  // Drift paths are relativeCoordPath-style (relative to the coord dir), which
  // is the parent of the runtime dir; run check-ignore from there so the
  // relative paths resolve correctly. `runCheckIgnore` is injectable for tests.
  function runGitCheckIgnore(candidates) {
    const coordDir = path.dirname(state.RUNTIME_DIR);
    return spawnSync("git", ["check-ignore", "--stdin"], {
      cwd: coordDir,
      input: `${candidates.join("\n")}\n`,
      encoding: "utf8",
      timeout: 5000,
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
      // COORD-279 (item 4): the journal EXISTS (a latest event is present) but its
      // referenced snapshot artifact was PRUNED, so there is no baseline to diff
      // against. Previously this hard-failed and bricked EVERY `gov` command.
      // Instead, report this distinctly (`snapshotPruned`) with no detectable
      // drift, so read-only callers (doctor/conform) keep working and the mutation
      // path can gracefully re-baseline. This is NOT the COORD-273 hole: that one
      // is the journal being ABSENT over live state (`latestEvent === null` =>
      // `uninitialized: true` above), which still fails closed. Here the
      // journal/chain is intact and present — only a prunable cache artifact is
      // gone — so re-establishing a baseline is safe and is recorded as its own
      // auditable journal event by the mutation path.
      if (latestEvent) {
        return {
          latestEvent,
          currentSnapshot,
          drift: [],
          uninitialized: false,
          snapshotPruned: true,
        };
      }
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
  
  // --- COORD-220: single-writer board protocol -- out-of-band bypass detector ----
  // Coordination-state mutations (the board, plan records, prompt mappings, and
  // rendered board artifacts) are only legitimate when they flow through the
  // journaled board transaction (`withBoardTransaction` -> `withGovernanceMutation`),
  // which appends exactly one journal event + snapshot per mutation. A working-tree
  // change to any of those files whose digest differs from the journal's last
  // committed snapshot has NO corresponding journaled transaction: it was made by a
  // direct edit or an ad-hoc script that bypassed the governed path. This is the
  // COORD-198/199..208 + 225/226/227-vs-REQ class of incident (IDs hand-edited and
  // raced on max+1).
  //
  // The detector is a PURE classification over provenance drift: it filters the
  // drift set down to coordination-state classes (material/blocking drift, which
  // `splitGovernanceProvenanceDrift` already separates from non-material runtime
  // ledger churn) and reports them as out-of-band. It deliberately does NOT fire on
  // a clean governed mutation: a governed mutation re-reads the board UNDER the lock
  // and its own write lands as a journaled snapshot, so at mutation entry (before
  // the mutation's own writes) the snapshot matches the journal and the out-of-band
  // set is empty. Non-material runtime drift (agent_sessions, session-threads) is
  // never treated as an out-of-band board mutation.
  // Build the coordination-state matchers from the LIVE configured paths (not
  // hardcoded string prefixes) so the classifier is correct under both the real
  // coord/ layout and redirected test sandboxes. Drift entries are
  // `relativeCoordPath`-form, so compare against the same form of each canonical
  // surface: the board file (exact match) and the plan-records / prompts / rendered
  // directories (prefix match).
  function coordinationStateMatchers() {
    const fileMatch = relativeCoordPath(state.BOARD_PATH);
    const dirMatches = [state.PLAN_RECORDS_DIR, state.PROMPTS_DIR, state.RENDERED_DIR]
      .filter(Boolean)
      .map((dir) => {
        const rel = relativeCoordPath(dir);
        return rel.endsWith("/") ? rel : `${rel}/`;
      });
    return { fileMatch, dirMatches };
  }

  function isCoordinationStatePath(relativePath) {
    const value = String(relativePath || "");
    const { fileMatch, dirMatches } = coordinationStateMatchers();
    if (value === fileMatch) {
      return true;
    }
    return dirMatches.some((prefix) => value.startsWith(prefix));
  }

  // Pure detector. Given an optional precomputed provenance result (so callers
  // already holding one under the runtime lock do not pay for a second snapshot),
  // return the out-of-band coordination-state mutation report.
  function detectOutOfBandBoardMutation(provenance) {
    const resolved = provenance || detectGovernanceProvenanceDrift();
    if (resolved.uninitialized) {
      return { detected: false, uninitialized: true, paths: [], latestEvent: resolved.latestEvent || null };
    }
    // Only material/blocking drift is a candidate; runtime-ledger churn is not a
    // board mutation. Of the blocking drift, keep only coordination-state classes.
    const { blocking } = splitGovernanceProvenanceDrift(resolved.drift || []);
    const paths = blocking.filter(isCoordinationStatePath);
    return {
      detected: paths.length > 0,
      uninitialized: false,
      paths,
      latestEvent: resolved.latestEvent || null,
    };
  }

  function formatOutOfBandBoardMutationMessage(report) {
    const changed = (report.paths || []).join(", ");
    return (
      `Refusing to run a governed board mutation on top of an out-of-band coordination-state change ` +
      `(no journaled transaction since ${report.latestEvent?.ts || "unknown time"}): ${changed}. ` +
      "Direct edits / ad-hoc scripts must NOT mutate the board, plan records, prompts, or rendered artifacts — " +
      "the governed transaction (gov open-followup / gov start / gov move-review / gov finalize) is the only sanctioned path. " +
      "Run `coord/scripts/gov doctor` to inspect it, then reconcile the manual edit (revert it, or land it through a governed mutation) before retrying. " +
      "Recovery for lock/session drift: `coord/scripts/gov recover <ticket-id>`."
    );
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

    // COORD-289: determine the current hash-algorithm era from the surviving
    // tip. Once the `hash-alg-migration` bridge has landed, the tip carries
    // `hash_alg: "sha256"` and so does every event after it — so a post-migration
    // repo is detectable from the tip alone (no full-log scan). Pre-migration the
    // tip has no `hash_alg`, the new event gets NO `hash_alg` field, and the link
    // is sha1 — byte-identical to the historical behaviour.
    const postMigration =
      Boolean(tip) && eventHashAlg(tip) === HASH_ALG_SHA256;

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
      // COORD-289: in the SHA-256 era, stamp `hash_alg` BEFORE hashing so the
      // record's own canonical hash (which becomes the next event's prev-link) is
      // computed under sha256. A record that already declares its algorithm (the
      // migration bridge event itself) is never overridden.
      if (postMigration && !Object.prototype.hasOwnProperty.call(record, "hash_alg")) {
        record.hash_alg = HASH_ALG_SHA256;
      }
      if (!Object.prototype.hasOwnProperty.call(record, "prev_event_hash")) {
        record.prev_event_hash = prevHash;
      }
      lines.push(JSON.stringify(record));
      prevHash = hashGovernanceEventRecord(record);
    }
    // COORD-033: append through an explicit fd + fsync so a journaled event is
    // durable, not just buffered in the page cache.
    // COORD-434: write each record of the batch with its OWN append, not one
    // combined write. A single write of a multi-record batch (legacy anchor /
    // tail-repair marker / the event) could tear an INTERIOR record on a crash,
    // and the reader + repairTornGovernanceEventLogTail only forgive a torn
    // TRAILING line — so an interior tear would brick every gov command. Appending
    // per record guarantees a crash leaves a complete prefix plus at most one torn
    // TRAILING line (recoverable), and a partial batch (e.g. anchor written, event
    // not) is idempotently re-driven on the retry.
    const fd = fs.openSync(state.GOVERNANCE_EVENT_LOG_PATH, "a");
    try {
      for (const line of lines) fs.writeFileSync(fd, `${line}\n`, "utf8");
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
  // COORD-289: the verifier is ERA-AWARE. Each chained event[i] links to its
  // predecessor under a LINKING algorithm chosen as:
  //   - the `hash-alg-migration` BRIDGE event links via sha1 (continuity: the old
  //     SHA-1 chain still verifies end-to-end up to it), even though it itself
  //     carries hash_alg:"sha256";
  //   - every other event links under its OWN era (`eventHashAlg`): sha256 once it
  //     carries hash_alg:"sha256", else sha1.
  // The migration event additionally proves (a) details.sha1_chain_head equals the
  // sha1 head accumulated up to its predecessor (the bridge is rooted at the real
  // old head) and (b) its embedded ed25519 signature verifies over the transition
  // payload — and, when a trust anchor is configured (COORD-272 composition), that
  // the signer is pinned (a forged re-signature is rejected). The chain `head` is
  // the hash of the last chained event under ITS era's algorithm (`headAlg`).
  function verifyGovernanceChain(events = readGovernanceEventLog(), options = {}) {
    const broken = [];
    let preChainCount = 0;
    let chainedCount = 0;
    let sha1ChainedCount = 0;
    let sha256ChainedCount = 0;
    let migrationIndex = null;
    let chainStarted = false;
    let head = null;
    let headAlg = null;

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
      const isMigration = record.command === CHAIN_MIGRATION_COMMAND;
      // The bridge links via sha1; all other events link under their own era.
      const linkAlg = isMigration ? HASH_ALG_SHA1 : eventHashAlg(record);
      const expectedPrev = chainStarted
        ? hashWithAlg(canonicalEventSerialization(events[index - 1]), linkAlg)
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

      if (isMigration) {
        migrationIndex = index;
        const details = (record && record.details) || {};
        // (a) The bridge must be rooted at the real prior SHA-1 head.
        const sha1HeadBefore = chainStarted
          ? hashWithAlg(canonicalEventSerialization(events[index - 1]), HASH_ALG_SHA1)
          : CHAIN_GENESIS_PREV;
        if (details.sha1_chain_head !== sha1HeadBefore) {
          broken.push({
            index,
            reason: "migration-sha1-head-mismatch",
            expected: sha1HeadBefore,
            actual: details.sha1_chain_head ?? null,
            command: record.command || null,
            ts: record.ts || null,
          });
        }
        // (b) The transition signature must verify over the transition payload
        //     (integrity — detects any tamper of the signed fields or signature),
        //     and, when a trust anchor is configured, the signer must be pinned
        //     (authenticity — a forged re-signature is rejected).
        const payload = transitionPayload({
          migrated_at: details.migrated_at,
          sha1_chain_head: details.sha1_chain_head,
          verifier_version: details.verifier_version,
        });
        const sigResult = verifyTransitionSignature(payload, details.signature, {
          trustAnchors: options.trustAnchors,
        });
        if (!sigResult.signature_checked || !sigResult.signature_valid) {
          broken.push({
            index,
            reason: "migration-signature-invalid",
            command: record.command || null,
            ts: record.ts || null,
          });
        } else if (sigResult.trust_checked && !sigResult.trusted) {
          broken.push({
            index,
            reason: "migration-signature-untrusted",
            actual: sigResult.fingerprint,
            command: record.command || null,
            ts: record.ts || null,
          });
        }
      }

      chainStarted = true;
      chainedCount += 1;
      if (eventHashAlg(record) === HASH_ALG_SHA256) {
        sha256ChainedCount += 1;
      } else {
        sha1ChainedCount += 1;
      }
      headAlg = eventHashAlg(record);
      head = hashWithAlg(canonicalEventSerialization(record), headAlg);
    }

    return {
      ok: broken.length === 0,
      total: events.length,
      preChainCount,
      chainedCount,
      // COORD-289: per-era breakdown + the migration boundary. `chainedCount`
      // stays sha1+sha256 chained for back-compat with existing consumers.
      sha1ChainedCount,
      sha256ChainedCount,
      migrationIndex,
      broken,
      // The chain head is the canonical hash of the last chained event under its
      // OWN era's algorithm — the attestation input a central re-hash service
      // (ENT-007) would compare. `headAlg` names that algorithm explicitly.
      head,
      headAlg,
    };
  }

  // --- COORD-124: guarded, auditable journal hash-chain repair ------------------
  // Concurrent governed appends can cross `prev_event_hash` links (two agents read
  // the same tip, then append in an interleaved order so each event's recorded
  // prev-link points at the wrong stored neighbour). The event CONTENT is intact;
  // only the linkage field is crossed, and the canonical truth is the on-disk
  // (append) order. `repairGovernanceChain` re-stamps `prev_event_hash` for every
  // chained event from the FIRST broken link forward to the tip, in current file
  // order, reusing the canonical `hashGovernanceEventRecord` — it never alters any
  // event's semantic content, only the linkage field.
  //
  // The repair is GUARDED + AUDITABLE and MUST NOT become a tamper-laundering tool:
  //   - dry-run (no confirm) reports what WOULD be repaired and writes nothing;
  //   - apply requires an explicit confirm + a human reason;
  //   - apply backs the pre-repair journal up to a timestamped sidecar (off-chain
  //     evidence of the original broken state);
  //   - apply appends an explicit on-chain `chain-repair` marker capturing the
  //     broken-link evidence (offending indices/ids, claimed-vs-expected prev-hash,
  //     count, reason, actor, ts) so an auditor permanently sees a repair happened,
  //     where, and why — repair is visible, never silent;
  //   - the marker does NOT relax the verifier: the chain only validates because it
  //     was genuinely re-linked. A chain broken WITHOUT a recorded repair (i.e. one
  //     nobody re-stamped) still fails `verifyGovernanceChain`, so the marker cannot
  //     be used to wave through an unexplained break.
  const CHAIN_REPAIR_COMMAND = "chain-repair";

  function collectChainRepairEvidence(events, chain) {
    return (chain.broken || []).map((link) => {
      const record = events[link.index];
      return {
        index: link.index,
        reason: link.reason,
        command: record?.command ?? null,
        ts: record?.ts ?? null,
        claimed_prev_event_hash: record?.prev_event_hash ?? null,
        expected_prev_event_hash:
          Object.prototype.hasOwnProperty.call(link, "expected") ? link.expected : null,
      };
    });
  }

  // Pure planner: given the current events + verification, return the repair plan
  // (no I/O). `firstBrokenIndex` is where re-stamping begins; every chained event
  // from there to the tip is re-linked in file order. Legacy pre-chain events and
  // every chained event BEFORE the first break are left byte-stable.
  function planGovernanceChainRepair(events = readGovernanceEventLog()) {
    const chain = verifyGovernanceChain(events);
    if (chain.ok) {
      return { needsRepair: false, chain, evidence: [], firstBrokenIndex: null };
    }
    const firstBrokenIndex = chain.broken.reduce(
      (min, link) => (link.index < min ? link.index : min),
      chain.broken[0].index
    );
    return {
      needsRepair: true,
      chain,
      evidence: collectChainRepairEvidence(events, chain),
      firstBrokenIndex,
    };
  }

  // Re-stamp `prev_event_hash` across `events` from `fromIndex` forward, in array
  // (file) order, reusing the canonical hasher. Mutates copies, returns the new
  // array. The event at `fromIndex` links to the canonical hash of its predecessor
  // (events[fromIndex-1]); each later chained event links to the freshly-restamped
  // prior record. Non-chained (legacy pre-chain) events are never restamped.
  function restampGovernanceChainFrom(events, fromIndex) {
    const next = events.map((record) => ({ ...record }));
    // COORD-289: track the freshly-restamped predecessor so the re-link uses the
    // SAME per-event linking algorithm the verifier expects (the migration bridge
    // links via sha1; every other event links under its own era).
    let prevRecord = fromIndex > 0 ? next[fromIndex - 1] : null;
    for (let index = fromIndex; index < next.length; index += 1) {
      const record = next[index];
      if (!isChainedEvent(record)) {
        // A legacy pre-chain event cannot appear inside the chained run; the
        // verifier already flags that as a distinct break. Leave it untouched and
        // do not advance the link off it.
        continue;
      }
      const linkAlg =
        record.command === CHAIN_MIGRATION_COMMAND ? HASH_ALG_SHA1 : eventHashAlg(record);
      record.prev_event_hash = prevRecord
        ? hashWithAlg(canonicalEventSerialization(prevRecord), linkAlg)
        : CHAIN_GENESIS_PREV;
      prevRecord = record;
    }
    return next;
  }

  function buildChainRepairMarkerEvent({ reason, evidence, identity, ts, brokenCount }) {
    return {
      ts,
      command: CHAIN_REPAIR_COMMAND,
      ticket: null,
      before_status: null,
      after_status: null,
      identity: summarizeIdentityForEvent(identity),
      result: "repaired",
      details: {
        reason,
        broken_link_count: brokenCount,
        broken_links: evidence,
        repaired_at: ts,
      },
      changed_paths: [],
      // Placeholder so the marker is a CHAINED event (isChainedEvent === true) and
      // the re-stamp pass links it off its predecessor (the prior tip). The real
      // value is written by restampGovernanceChainFrom.
      prev_event_hash: CHAIN_GENESIS_PREV,
    };
  }

  // COORD-274: repair-chain MUST be a pure RE-LINK and must never launder a content
  // edit (or an added / removed event body) into a valid-looking chain. repair-chain
  // is only meant to heal a crossed / stale `prev_event_hash` LINKAGE — never to bless
  // changed CONTENT. We distinguish the two by combining the break SHAPE with whether
  // the attested predecessor is still PRESENT:
  //
  //   - A LINKAGE break that CASCADES (every later link broken through to the tip) is a
  //     crossed pointer whose own record hash changed; re-stamping legitimately heals
  //     it. (Two governed agents appending concurrently model this.) Allowed.
  //   - An ISOLATED broken link at index b (its immediate successor link b+1 is still
  //     VALID, so events[b] and the whole tail vouch for themselves) is REFUSED only
  //     when ALL of the following hold — the precise fingerprint of an altered/removed
  //     body that a re-stamp would launder, never a re-linkable linkage break:
  //       * the broken link's CLAIMED prev_event_hash matches NO record-hash present in
  //         the journal — the attested predecessor record has VANISHED (a crossing or
  //         reorder merely RELOCATES the predecessor, which stays present), AND
  //       * the predecessor events[b-1]'s OWN inbound link is VALID (b-1 is not itself a
  //         broken link). If the predecessor's own prev was crossed, ITS record hash
  //         changed for a pure-linkage reason (body intact) and the vanished attestation
  //         is benign; only a VALID predecessor link leaves a changed BODY as the sole
  //         explanation for the vanished attestation.
  //
  // Returns the index of the broken link whose attested predecessor body changed/
  // vanished, or null when every break is a re-linkable linkage break.
  function detectLaunderingContentBreak(events, chain) {
    if (!chain || chain.ok) {
      return null;
    }
    const brokenAt = new Set(
      (chain.broken || [])
        .filter((link) => link.reason === "prev-hash-mismatch")
        .map((link) => link.index)
    );
    if (brokenAt.size === 0) {
      return null;
    }
    // Every record hash actually present in the journal. A relocation/crossing keeps
    // the attested predecessor in this set; an altered/removed body drops it.
    const presentHashes = new Set(events.map(hashGovernanceEventRecord));
    for (const index of brokenAt) {
      const successorIndex = index + 1;
      if (successorIndex >= events.length || !isChainedEvent(events[successorIndex])) {
        // Tip-adjacent broken link: no surviving downstream attestation to corroborate
        // it, so a crossed pointer and a tip-edit are inherently indistinguishable.
        // Not the laundering vector guarded here.
        continue;
      }
      if (brokenAt.has(successorIndex)) {
        // Cascading break -> crossed-pointer linkage corruption; re-linkable.
        continue;
      }
      const claimedPrev = events[index] ? events[index].prev_event_hash : null;
      const attestationPresent =
        claimedPrev === CHAIN_GENESIS_PREV || presentHashes.has(claimedPrev);
      if (attestationPresent) {
        // The attested predecessor is still present (relocated, not changed). Re-linkable.
        continue;
      }
      if (brokenAt.has(index - 1)) {
        // The predecessor's OWN prev was crossed (its inbound link is also broken), so
        // its record hash changed for a linkage reason with its body intact. Benign.
        continue;
      }
      // Isolated break, attested predecessor vanished, predecessor's own link intact ->
      // the only explanation is that events[b-1]'s BODY was altered or removed.
      return index;
    }
    return null;
  }

  function assertLaunderingContentBreak(events, chain) {
    const brokenIndex = detectLaunderingContentBreak(events, chain);
    if (brokenIndex === null) {
      return;
    }
    const record = events[brokenIndex] || {};
    const where =
      `the broken link at event #${brokenIndex}` +
      (record.command ? ` [${record.command}]` : "") +
      (record.ts ? ` @ ${record.ts}` : "");
    fail(
      "repair-chain is re-link-ONLY: a chained event's CONTENT changed — " +
      `${where} attests a predecessor record that is no longer present in the journal ` +
      "(its body was altered in place or removed), not merely a crossed prev_event_hash " +
      "link. Re-stamping would launder the tampering into a chain that falsely passes " +
      "verification, so the repair is REFUSED and nothing was written. repair-chain only " +
      "heals crossed linkage (a cascading break) or a pure relocation (the attested " +
      "predecessor is still present); a single isolated broken link whose attested " +
      "predecessor has vanished is the fingerprint of an added / removed / altered event " +
      "body. For genuine content recovery restore the authentic journal from a trusted " +
      "backup (the `.pre-repair-*` sidecar of a prior repair) or use " +
      "`gov recover <ticket-id>` / `gov reconcile --reason \"...\"` — never repair-chain."
    );
  }

  // Guarded entry point. options:
  //   confirm  (boolean)  — required to actually rewrite; otherwise DRY-RUN.
  //   reason   (string)   — required with confirm; recorded in the marker.
  //   ts       (string)   — ISO timestamp for the marker + backup sidecar name.
  //                         Defaults to now (engine runtime, where Date.now is ok).
  //   identity (object)   — actor identity for the marker.
  // Returns a structured result; performs I/O only on a confirmed apply.
  function repairGovernanceChain(options = {}) {
    const confirm = options.confirm === true;
    const reason = typeof options.reason === "string" ? options.reason.trim() : "";
    const ts = options.ts || new Date().toISOString();

    const events = readGovernanceEventLog();
    const plan = planGovernanceChainRepair(events);

    if (!plan.needsRepair) {
      return {
        status: "already-valid",
        applied: false,
        dry_run: !confirm,
        broken_link_count: 0,
        broken_links: [],
        chain_head: plan.chain.head,
        backup_path: null,
        marker_index: null,
      };
    }

    // COORD-274: refuse to launder a content edit through a re-link, in BOTH dry-run
    // and apply, so an operator never even sees an actionable "re-run with --confirm".
    assertLaunderingContentBreak(events, plan.chain);

    if (!confirm) {
      return {
        status: "dry-run",
        applied: false,
        dry_run: true,
        broken_link_count: plan.evidence.length,
        broken_links: plan.evidence,
        first_broken_index: plan.firstBrokenIndex,
        chain_head: plan.chain.head,
        backup_path: null,
        marker_index: null,
      };
    }

    if (!reason) {
      fail(
        "repair-chain --confirm requires a non-empty --reason describing why the " +
        "chain is being re-linked (the reason is recorded in the on-chain repair marker)."
      );
    }

    return withGovernanceRuntimeLock(() => {
      // Re-read under the lock so a concurrent append cannot race the repair.
      const lockedEvents = readGovernanceEventLog();
      const lockedPlan = planGovernanceChainRepair(lockedEvents);
      if (!lockedPlan.needsRepair) {
        return {
          status: "already-valid",
          applied: false,
          dry_run: false,
          broken_link_count: 0,
          broken_links: [],
          chain_head: lockedPlan.chain.head,
          backup_path: null,
          marker_index: null,
        };
      }

      // COORD-274: re-assert under the lock (events were re-read) before any write.
      assertLaunderingContentBreak(lockedEvents, lockedPlan.chain);

      // 1. Preserve the original broken journal off-chain (timestamped sidecar).
      const backupPath = governanceChainRepairBackupPath(ts);
      const rawJournal = fs.existsSync(state.GOVERNANCE_EVENT_LOG_PATH)
        ? fs.readFileSync(state.GOVERNANCE_EVENT_LOG_PATH, "utf8")
        : "";
      writeFileAtomicSync(backupPath, rawJournal);

      // 2. Append the explicit, on-chain repair marker capturing the evidence,
      //    then re-stamp the whole chained run from the first broken link forward
      //    (the marker is the new tip and gets stamped last) so the chain is
      //    GENUINELY re-linked — not merely waved through.
      const marker = buildChainRepairMarkerEvent({
        reason,
        evidence: lockedPlan.evidence,
        identity: options.identity,
        ts,
        brokenCount: lockedPlan.evidence.length,
      });
      // COORD-289: a repair marker appended in the SHA-256 era must itself carry
      // hash_alg:"sha256" so it links via sha256 and the chain head stays in the
      // new era (the marker is the new tip). Determined from the surviving tip's
      // era — pre-migration repos leave the marker SHA-1 (byte-identical).
      const repairTip = lockedEvents[lockedEvents.length - 1];
      if (repairTip && eventHashAlg(repairTip) === HASH_ALG_SHA256) {
        marker.hash_alg = HASH_ALG_SHA256;
      }
      const withMarker = [...lockedEvents, marker];
      const restamped = restampGovernanceChainFrom(withMarker, lockedPlan.firstBrokenIndex);

      // COORD-274: defence-in-depth — the re-stamp transform may ONLY rewrite
      // prev_event_hash, never any event body. Assert the per-event CONTENT multiset
      // (content excludes the linkage field) is byte-identical before vs after the
      // re-link (modulo the one appended marker), so no body was added/dropped/altered.
      const contentMultisetBefore = lockedEvents.map(hashGovernanceEventContent).sort();
      const contentMultisetAfter = restamped
        .slice(0, restamped.length - 1)
        .map(hashGovernanceEventContent)
        .sort();
      if (
        contentMultisetBefore.length !== contentMultisetAfter.length ||
        contentMultisetBefore.some((hash, idx) => hash !== contentMultisetAfter[idx])
      ) {
        fail(
          "repair-chain integrity violation: the re-link changed event CONTENT (the " +
          "per-event content multiset differs before vs after re-stamp). Refusing to " +
          "write. The original journal is intact; no changes were made."
        );
      }

      // 3. Verify the re-linked chain BEFORE committing it to disk. If the repair
      //    did not actually heal the chain, refuse to write (fail closed).
      const verified = verifyGovernanceChain(restamped);
      if (!verified.ok) {
        fail(
          `Chain repair did not produce a valid chain (${verified.broken.length} link(s) still broken). ` +
          `No changes written; the original journal is intact. Backup at ${relativeCoordPath(backupPath)}.`
        );
      }

      // 4. Commit atomically + durably (fsync), matching the append path.
      const serialized = `${restamped.map((record) => JSON.stringify(record)).join("\n")}\n`;
      const fd = fs.openSync(state.GOVERNANCE_EVENT_LOG_PATH, "w");
      try {
        fs.writeFileSync(fd, serialized, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      return {
        status: "repaired",
        applied: true,
        dry_run: false,
        broken_link_count: lockedPlan.evidence.length,
        broken_links: lockedPlan.evidence,
        first_broken_index: lockedPlan.firstBrokenIndex,
        reason,
        chain_head: verified.head,
        backup_path: relativeCoordPath(backupPath),
        backup_abs_path: backupPath,
        marker_index: restamped.length - 1,
        marker_command: CHAIN_REPAIR_COMMAND,
        total_events: verified.total,
      };
    });
  }

  // COORD-289: the governed `hash-alg-migration` bridge. Appends the SINGLE,
  // signed migration event that hinges the SHA-1 era to the SHA-256 era WITHOUT
  // re-hashing or re-chaining any historical event:
  //   - PRECONDITION: the live chain verifies `ok` (refuse to migrate a broken
  //     chain) and there are chained events to bridge off.
  //   - IDEMPOTENT: refuse if a migration event already exists (no double-migrate).
  //   - the event is SHA-1-linked to the prior tip (continuity), carries
  //     hash_alg:"sha256", and embeds details{ sha1_chain_head, migrated_at,
  //     verifier_version, signature } where signature is an ed25519 signature over
  //     the transition payload, produced with the conformance keypair via the
  //     injected `signChainTransition`. Its own sha256 record-hash is the new-era
  //     checkpoint genesis.
  // Dry-run (no confirm) reports what WOULD happen and writes nothing; apply
  // (confirm) runs under the runtime lock (re-reads + re-checks before any write).
  function migrateGovernanceChainHash(options = {}) {
    const confirm = options.confirm === true;
    const identity = options.identity || null;

    const events = readGovernanceEventLog();
    const chain = verifyGovernanceChain(events);
    const alreadyMigrated = events.some(
      (record) => record && record.command === CHAIN_MIGRATION_COMMAND
    );

    if (alreadyMigrated) {
      return {
        status: "already-migrated",
        applied: false,
        dry_run: !confirm,
        head: chain.head,
        head_alg: chain.headAlg,
        migration_index: chain.migrationIndex,
        sha1_chained: chain.sha1ChainedCount,
        sha256_chained: chain.sha256ChainedCount,
        total_events: chain.total,
      };
    }

    if (!chain.ok) {
      fail(
        `Refusing to migrate the hash-chain: it does not currently verify ` +
        `(${chain.broken.length} broken link(s)). Repair the chain first ` +
        `(gov repair-chain), then re-run the migration.`
      );
    }
    if (!chain.head || chain.headAlg !== HASH_ALG_SHA1) {
      fail(
        "Refusing to migrate the hash-chain: no SHA-1 chained head to bridge off " +
        "(the chain has no chained events, or is not in the SHA-1 era)."
      );
    }

    const sha1ChainHead = chain.head;
    if (!confirm) {
      return {
        status: "dry-run",
        applied: false,
        dry_run: true,
        sha1_chain_head: sha1ChainHead,
        verifier_version: CHAIN_VERIFIER_VERSION,
        chained_events: chain.chainedCount,
        total_events: chain.total,
        message:
          "DRY-RUN: would append a signed hash-alg-migration bridge event. " +
          "Re-run with --confirm to apply (irreversible).",
      };
    }

    if (typeof signChainTransition !== "function") {
      fail(
        "Cannot sign the hash-alg-migration event: no transition signer is " +
        "configured (signChainTransition dependency missing)."
      );
    }

    return withGovernanceRuntimeLock(() => {
      // Re-read + re-check under the lock so a concurrent append cannot race.
      const lockedEvents = readGovernanceEventLog();
      const lockedChain = verifyGovernanceChain(lockedEvents);
      if (lockedEvents.some((r) => r && r.command === CHAIN_MIGRATION_COMMAND)) {
        return {
          status: "already-migrated",
          applied: false,
          dry_run: false,
          head: lockedChain.head,
          head_alg: lockedChain.headAlg,
          migration_index: lockedChain.migrationIndex,
          total_events: lockedChain.total,
        };
      }
      if (!lockedChain.ok || !lockedChain.head || lockedChain.headAlg !== HASH_ALG_SHA1) {
        fail(
          "Refusing to migrate the hash-chain under lock: the chain no longer " +
          "presents a clean SHA-1 head to bridge off."
        );
      }
      const migratedAt = new Date().toISOString();
      const lockedSha1Head = lockedChain.head;
      const payload = transitionPayload({
        migrated_at: migratedAt,
        sha1_chain_head: lockedSha1Head,
        verifier_version: CHAIN_VERIFIER_VERSION,
      });
      const signature = signChainTransition(payload);

      const migrationEvent = {
        ts: migratedAt,
        command: CHAIN_MIGRATION_COMMAND,
        ticket: options.ticket || null,
        before_status: null,
        after_status: null,
        identity: summarizeIdentityForEvent(identity),
        result: "migrated",
        hash_alg: HASH_ALG_SHA256,
        details: {
          sha1_chain_head: lockedSha1Head,
          migrated_at: migratedAt,
          verifier_version: CHAIN_VERIFIER_VERSION,
          signature,
        },
        changed_paths: [],
        // The BRIDGE link: sha1 of the prior tip (== sha1_chain_head). The old
        // SHA-1 chain still verifies end-to-end up to this point.
        prev_event_hash: lockedSha1Head,
      };

      appendGovernanceEvent(migrationEvent);

      const verified = verifyGovernanceChain(readGovernanceEventLog());
      if (!verified.ok) {
        fail(
          `Migration produced an invalid chain (${verified.broken.length} broken ` +
          `link(s)). This should never happen — inspect the journal immediately.`
        );
      }
      return {
        status: "migrated",
        applied: true,
        dry_run: false,
        sha1_chain_head: lockedSha1Head,
        migrated_at: migratedAt,
        verifier_version: CHAIN_VERIFIER_VERSION,
        signature_fingerprint: signature.key_fingerprint,
        head: verified.head,
        head_alg: verified.headAlg,
        migration_index: verified.migrationIndex,
        sha1_chained: verified.sha1ChainedCount,
        sha256_chained: verified.sha256ChainedCount,
        total_events: verified.total,
      };
    });
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
  
  // COORD-223: AUDITED collision events.
  //
  // When a governed write DETECTS a race — a reserved-ID duplicate, a stale-write /
  // ownership-fence rejection, or the COORD-222 co-located-session refusal — the
  // detection site historically only `fail()`ed, leaving the race invisible after the
  // process exited. `recordGovernanceCollision` turns each such detection into a
  // journaled, queryable `collision-detected` event so a race becomes an on-chain
  // record surfaced by `gov recent` / `gov explain` (which read the same event log).
  //
  // The event is appended DIRECTLY (not through the mutation diff path): the governed
  // file snapshot is unchanged at a pure detection, and the event log is NOT part of
  // the rollback snapshot set, so this record survives the rollback that the following
  // `fail()` triggers. Emission is best-effort and never masks the real refusal — an
  // audit-write failure must not convert a hard collision refusal into a crash.
  //
  // `conflict_type` is one of: "reserved-id-duplicate", "stale-write-fence",
  // "co-located-session". `contenders` carries the contending identities/ids so an
  // operator can disambiguate without reading lock files by hand.
  function recordGovernanceCollision(detail = {}) {
    try {
      appendGovernanceEvent({
        ts: new Date().toISOString(),
        command: "collision-detected",
        ticket: detail.ticket || null,
        before_status: null,
        after_status: null,
        identity: detail.identity ? summarizeIdentityForEvent(detail.identity) : null,
        result: "detected",
        details: {
          conflict_type: detail.conflictType || "unknown",
          verb: detail.verb || null,
          contenders: Array.isArray(detail.contenders) ? detail.contenders : [],
          ...(detail.extra && typeof detail.extra === "object" ? detail.extra : {}),
        },
        changed_paths: [],
        snapshot: buildGovernanceSnapshot(),
      });
      return { logged: true };
    } catch (error) {
      // Never let an audit-emit failure mask the underlying collision refusal.
      return { logged: false, error: error?.message || String(error) };
    }
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
      // COORD-223: idempotency-on-retry. If this logical mutation already committed
      // under the same idempotency key (a prior attempt that crashed AFTER its event
      // landed, then was retried), do NOT re-run `fn` or append a duplicate event —
      // the mutation is a clean no-op resume. Crash recovery above has already
      // reconciled any partial FILE writes from the interrupted attempt.
      if (metadata.idempotencyKey) {
        const alreadyCommitted = findCommittedMutationByIdempotencyKey(metadata.idempotencyKey);
        if (alreadyCommitted) {
          const committedAfterStatus = alreadyCommitted.after_status || null;
          if (
            metadata.ticket &&
            committedAfterStatus &&
            inferTicketStatus(metadata.ticket) !== committedAfterStatus
          ) {
            // The same logical key existed in history, but the ticket has since
            // moved away from that committed result. Treat this as a new cycle,
            // not a retry of the old mutation.
          } else {
            return metadata.idempotentResult !== undefined ? metadata.idempotentResult : undefined;
          }
        }
      }
      const provenanceBefore = detectGovernanceProvenanceDrift();
      // COORD-273: seal the journal-deletion bypass. When the journal is
      // absent/uninitialized AND governed coordination state already exists on
      // disk, REFUSE to silently anchor a fresh genesis — that combination is the
      // signature of a lost/deleted journal over live state (or an attacker who
      // hand-edited the board and `rm`-ed the events log to launder the tamper as a
      // legitimate baseline). A genuinely fresh project (no board rows / plan
      // records / prompts / rendered) has no coordination state and still
      // auto-baselines below. Explicit recovery/reconcile paths legitimately
      // re-anchor a baseline over existing state and opt out via the existing
      // recovery-intent flag (`metadata.allowProvenanceDrift === true`) — the same
      // marker used by recover / reconcile / rebuild-board / doctor-fix — so real
      // repair is never bricked.
      if (
        provenanceBefore.uninitialized &&
        metadata.ensureBaseline !== false &&
        metadata.allowProvenanceDrift !== true &&
        governedCoordinationStateExists()
      ) {
        fail(formatJournalLostOverExistingStateMessage());
      }
      const journalBootstrapped =
        provenanceBefore.uninitialized && metadata.ensureBaseline !== false
          ? ensureGovernanceJournalBaseline(metadata.baselineReason || "mutation")
          : false;
      let provenance = detectGovernanceProvenanceDrift();
      // COORD-279 (item 4): the journal is present but its latest snapshot
      // artifact was pruned (a prunable cache, COORD-105/108) — there is no
      // baseline to diff against. Rather than bricking the mutation, re-establish
      // a fresh baseline by appending an explicit, auditable `journal-baseline`
      // recovery event capturing the CURRENT on-disk state, then re-derive
      // provenance against it. Distinct from the COORD-273 seal above (journal
      // ABSENT over live state still fails closed); here the chain is intact and
      // the recovery is itself journaled/git-tracked, so it is auditable rather
      // than a laundering bypass.
      if (provenance.snapshotPruned && metadata.ensureBaseline !== false) {
        appendGovernanceEvent({
          ts: new Date().toISOString(),
          command: "journal-baseline",
          ticket: metadata.ticket || null,
          before_status: null,
          after_status: null,
          identity: null,
          details: { reason: "snapshot-pruned-recovery" },
          changed_paths: [],
          snapshot: buildGovernanceSnapshot(),
        });
        provenance = detectGovernanceProvenanceDrift();
      }
      if (provenance.uninitialized && metadata.ensureBaseline === false) {
        fail(formatGovernanceJournalUninitializedMessage());
      }
      // COORD-220 bypass seal: FAIL CLOSED when a governed board mutation is about
      // to proceed on top of an out-of-band coordination-state change (a working-tree
      // edit to the board / plan records / prompts / rendered artifacts with no
      // corresponding journaled transaction). This makes the governed transaction the
      // ONLY path. Recovery/reconciliation paths that legitimately operate on drifted
      // state opt out with the existing `metadata.allowProvenanceDrift === true` marker
      // (doctor-fix, recover, manual-reconcile, audit-landings, record-cost, precheck)
      // — the same flag that already suppresses the drift QUESTIONS note for those
      // commands. The detector never fires on a clean governed mutation: by entry the
      // snapshot matches the journal, so the out-of-band set is empty.
      if (metadata.allowProvenanceDrift !== true && !provenance.uninitialized) {
        const outOfBand = detectOutOfBandBoardMutation(provenance);
        if (outOfBand.detected) {
          // COORD-246: FAIL CLOSED on a genuine out-of-band coordination-state edit.
          // The earlier over-fire (a governed finalize's OWN post-journal artifact
          // sync — plan record / rendered / QUESTIONS — left residual drift that the
          // next mutation flagged as out-of-band) is now fixed at the source:
          // `advanceGovernanceProvenanceBaseline()` runs at the lifecycle auto-sync
          // chokepoint and re-baselines the journal to the FINAL post-sync state, so a
          // clean completed mutation leaves NO residual here. Any drift that survives
          // to this entry-check is therefore a real bypass and is refused.
          fail(formatOutOfBandBoardMutationMessage(outOfBand));
        }
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
        // COORD-223: a keyed mutation always records its succeeded event (even with no
        // file diff) so the idempotency key is durably journaled for a future retry.
        if (changedPaths.length > 0 || metadata.forceLog === true || metadata.idempotencyKey) {
          let details = metadata.details ? { ...metadata.details } : null;
          const externalSideEffects = [...state.activeGovernanceMutationContext.externalSideEffects];
          if (metadata.idempotencyKey) {
            details = { ...(details || {}), idempotency_key: metadata.idempotencyKey };
          }
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
    findCommittedMutationByIdempotencyKey,
    diffGovernanceSnapshots,
    readGovernanceEventLog,
    journalHistoricalTicketIds,
    parseGovernanceEventLogLine,
    governanceSnapshotArtifactPath,
    readGovernanceSnapshotArtifact,
    writeGovernanceSnapshotArtifact,
    readGovernanceSnapshotCheckpoint,
    writeGovernanceSnapshotCheckpoint,
    readLatestGovernanceSnapshotSource,
    readLatestGovernanceEvent,
    ensureGovernanceJournalBaseline,
    advanceGovernanceProvenanceBaseline,
    detectGovernanceProvenanceDrift,
    detectOutOfBandBoardMutation,
    isCoordinationStatePath,
    isPathWithinSyncScope,
    formatOutOfBandBoardMutationMessage,
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
    planGovernanceChainRepair,
    restampGovernanceChainFrom,
    repairGovernanceChain,
    migrateGovernanceChainHash,
    sha256,
    hashWithAlg,
    eventHashAlg,
    HASH_ALG_SHA1,
    HASH_ALG_SHA256,
    CHAIN_MIGRATION_COMMAND,
    CHAIN_VERIFIER_VERSION,
    governanceChainRepairBackupPath,
    summarizeIdentityForEvent,
    recordGovernanceExternalSideEffect,
    recordGovernanceCollision,
    formatGovernanceExternalSideEffect,
    withGovernanceMutation,
    inferTicketStatus,
    appendGovernanceProvenanceIssues,
  };
};
