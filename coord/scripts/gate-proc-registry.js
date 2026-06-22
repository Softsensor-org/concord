"use strict";

// COORD-092: gate process-orphan containment + provenance-scoped reaper — the
// missing THIRD leg of orphan governance, next to disk-orphan cleanup
// (worktree-ops.js auditCoordWorktrees / cleanup + doctor reaping) and
// session-stub reaping (reapIdleAutoClaimedProviderStubs).
//
// PROBLEM: heavy gate lanes (full/ci) spawn runtime children — vite dev-servers,
// chromium/playwright workers, node test workers. On clean exit they are torn
// down; on crash / OOM-kill they ORPHAN and accumulate until the host exhausts
// RAM. Coord governs disk orphans but not process orphans.
//
// MECHANISM (three pieces; this module owns the registry + reaper, the gate.sh
// scripts own the spawn-side trap):
//   1. SPAWN-SIDE (gate.sh): heavy children launch in a tracked process GROUP
//      (setsid) and the run records ONE registry entry per gate-run under
//      coord/.runtime/gate-procs/<gate-run-id>.json capturing gate-run-id,
//      owning ticket, repo, lane, the child PIDs + PGID, each PID's process
//      START-TIME fingerprint (from /proc/<pid>/stat field 22, the PID-reuse
//      guard), and a created-at timestamp. A `trap cleanup EXIT` tears the group
//      down + removes the entry on NORMAL completion, so a clean run NEVER leaks.
//   2. DETECT (doctor-report.js, READ-ONLY): surface a warning-class diagnostic
//      listing orphaned entries — owning gate-run gone (no live PID matching the
//      recorded PID+start-time) or owning ticket no longer doing.
//   3. REAP (doctor-recovery.js / `gov reap-gate-procs`, MUTATING): kill ONLY
//      processes recorded in the registry whose owner is gone, AND only after a
//      PID-REUSE GUARD confirms the live PID's start-time still matches the
//      recorded entry. Then remove the entry.
//
// NON-NEGOTIABLE SAFETY: provenance-scoped strictly by RECORDED pid + start-time.
// NEVER a process-name scan. This module is structurally incapable of touching a
// process coord did not record: it only ever reads PIDs out of registry files it
// wrote, and refuses to signal any PID whose live start-time fingerprint does not
// byte-match the recorded one (the reused-PID case).
//
// LANE-DISCIPLINE POSTURE (documented, not enforced): heavy lanes (full/ci)
// carry the resource-heavy steps and SHOULD NOT be run concurrently on a
// memory-constrained host; the default lane stays the lean local check. There is
// deliberately NO scheduler / resource-aware lease/broker (declined in the
// COORD-075..082 lane-control decision) — this is containment + recovery, not
// admission control.

const fs = require("fs");
const path = require("path");
const { DEFAULT_PATHS, isProcessAlive } = require("./governance-context.js");

const REGISTRY_SCHEMA = "coord.gate-proc-registry/v1";

function defaultRegistryDir() {
  return DEFAULT_PATHS.gateProcsDir;
}

// Read a live PID's start-time fingerprint. On Linux this is field 22 of
// /proc/<pid>/stat (starttime, in clock ticks since boot) — stable for the life
// of the process and DIFFERENT for a recycled PID, so it is the PID-reuse guard.
// The comm field (field 2) is wrapped in parentheses and may itself contain
// spaces/parentheses, so we parse from the LAST ")" to avoid mis-splitting.
// Returns null when /proc is unavailable (non-Linux) or the pid is gone.
function readProcStartTime(pid, procRoot = "/proc") {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw;
  try {
    raw = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
  } catch {
    return null;
  }
  const rparen = raw.lastIndexOf(")");
  if (rparen === -1) return null;
  // Fields after comm: state is field 3; starttime is field 22. After the last
  // ")" the remaining whitespace-split tokens start at field 3 (index 0), so
  // starttime is at index 22 - 3 = 19.
  const rest = raw.slice(rparen + 1).trim().split(/\s+/);
  const starttime = rest[19];
  return starttime !== undefined && /^\d+$/.test(starttime) ? starttime : null;
}

// Read a live PID's cmdline (NUL-separated argv joined with spaces). Used as a
// secondary, advisory fingerprint in the registry; the start-time is the
// authoritative reuse guard. Returns null when unavailable.
function readProcCmdline(pid, procRoot = "/proc") {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"));
    const text = raw.toString("utf8").replace(/\0+$/, "").replace(/\0/g, " ").trim();
    return text || null;
  } catch {
    return null;
  }
}

// Build the recorded fingerprint for a PID at registration time. Captures the
// pid, its start-time (the reuse guard) and an advisory cmdline.
function captureProcFingerprint(pid, procRoot = "/proc") {
  return {
    pid,
    start_time: readProcStartTime(pid, procRoot),
    cmdline: readProcCmdline(pid, procRoot),
  };
}

function registryPathFor(gateRunId, registryDir = defaultRegistryDir()) {
  // gate-run-id is caller-controlled; sanitize to a safe filename so a hostile
  // or accidental id can never escape the registry dir.
  const safe = String(gateRunId).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe) throw new Error("gate-run-id must be a non-empty string");
  return path.join(registryDir, `${safe}.json`);
}

// Build a registry entry object. Pure (no IO beyond the fingerprint capture the
// caller provides via `procs`). Callers normally pass PIDs and let writeEntry
// capture fingerprints, but this is exported for unit tests.
function buildEntry({ gateRunId, ticket = null, repo = null, lane = null, pgid = null, procs = [], createdAt = null }) {
  if (!gateRunId) throw new Error("gateRunId is required");
  return {
    schema: REGISTRY_SCHEMA,
    gate_run_id: String(gateRunId),
    ticket: ticket ? String(ticket) : null,
    repo: repo ? String(repo) : null,
    lane: lane ? String(lane) : null,
    pgid: Number.isInteger(pgid) ? pgid : (pgid != null ? Number(pgid) || null : null),
    procs: procs.map((p) => ({
      pid: p.pid,
      start_time: p.start_time != null ? String(p.start_time) : null,
      cmdline: p.cmdline || null,
    })),
    created_at: createdAt || new Date().toISOString(),
  };
}

// Write (register) an entry, capturing each PID's live fingerprint now.
// `pids` is an array of integers. Returns the written entry.
function writeEntry({ gateRunId, ticket, repo, lane, pgid, pids = [] }, options = {}) {
  const registryDir = options.registryDir || defaultRegistryDir();
  const procRoot = options.procRoot || "/proc";
  fs.mkdirSync(registryDir, { recursive: true });
  const procs = pids
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => captureProcFingerprint(pid, procRoot));
  const entry = buildEntry({ gateRunId, ticket, repo, lane, pgid, procs });
  fs.writeFileSync(registryPathFor(gateRunId, registryDir), JSON.stringify(entry, null, 2) + "\n", "utf8");
  return entry;
}

function readEntry(gateRunId, options = {}) {
  const registryDir = options.registryDir || defaultRegistryDir();
  try {
    return JSON.parse(fs.readFileSync(registryPathFor(gateRunId, registryDir), "utf8"));
  } catch {
    return null;
  }
}

function removeEntry(gateRunId, options = {}) {
  const registryDir = options.registryDir || defaultRegistryDir();
  try {
    fs.rmSync(registryPathFor(gateRunId, registryDir));
    return true;
  } catch {
    return false;
  }
}

function listEntries(options = {}) {
  const registryDir = options.registryDir || defaultRegistryDir();
  let names;
  try {
    names = fs.readdirSync(registryDir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(registryDir, name), "utf8"));
      if (entry && entry.gate_run_id) entries.push(entry);
    } catch {
      // Skip unreadable/corrupt entries rather than aborting the scan.
    }
  }
  return entries.sort((a, b) => String(a.gate_run_id).localeCompare(String(b.gate_run_id)));
}

// The PID-REUSE GUARD. A recorded proc still "matches" the live process iff the
// PID is alive AND its live start-time fingerprint byte-matches the recorded
// one. A recycled PID (different process now holding the same number) has a
// DIFFERENT start-time and therefore does NOT match — so it is never signaled.
// If the recorded entry has no start-time (e.g. registered on a non-Linux host
// with no /proc), we conservatively report NO match: without a reuse guard we
// refuse to kill (fail-safe — never kill what we cannot verify).
function procMatchesLive(recorded, options = {}) {
  const procRoot = options.procRoot || "/proc";
  if (!recorded || !Number.isInteger(recorded.pid) || recorded.pid <= 0) return false;
  if (!isProcessAliveImpl(recorded.pid, options)) return false;
  if (recorded.start_time == null) return false;
  const liveStart = readProcStartTime(recorded.pid, procRoot);
  if (liveStart == null) return false;
  return String(liveStart) === String(recorded.start_time);
}

// Indirection so tests can inject a fake aliveness probe alongside a fake
// procRoot; defaults to the shared governance-context isProcessAlive.
function isProcessAliveImpl(pid, options = {}) {
  if (typeof options.isProcessAlive === "function") return options.isProcessAlive(pid);
  return isProcessAlive(pid);
}

// Classify a single registry entry. Returns:
//   { entry, gateRunId, ownerLive, matchedProcs, orphan, reason }
// ownerLive is true iff the owning gate-run is still considered live: at least
// one recorded proc still matches a live process (PID-reuse-guarded) AND, when
// an `isTicketDoing` predicate is supplied and the entry names a ticket, that
// ticket is still doing. An entry is an ORPHAN when the owner is gone.
function classifyEntry(entry, options = {}) {
  const matchedProcs = (entry.procs || []).filter((p) => procMatchesLive(p, options));
  const anyProcLive = matchedProcs.length > 0;
  let ticketDoing = null;
  if (typeof options.isTicketDoing === "function" && entry.ticket) {
    ticketDoing = Boolean(options.isTicketDoing(entry.ticket));
  }
  // Owner is live if a recorded process is still verifiably running. If no proc
  // is live, the gate-run is gone regardless of ticket state. If procs are live
  // but the owning ticket is explicitly no longer doing, the run is also an
  // orphan (gate outlived its ticket).
  let orphan;
  let reason;
  if (!anyProcLive) {
    orphan = true;
    reason = "no recorded process is still live (gate-run gone)";
  } else if (ticketDoing === false) {
    orphan = true;
    reason = `recorded processes live but owning ticket ${entry.ticket} is no longer doing`;
  } else {
    orphan = false;
    reason = "owner still live";
  }
  return {
    entry,
    gateRunId: entry.gate_run_id,
    ownerLive: !orphan,
    matchedProcs,
    orphan,
    reason,
  };
}

// READ-ONLY detection used by doctor-report. Returns the list of orphaned
// entries (with classification) — never signals anything.
function detectOrphans(options = {}) {
  const entries = listEntries(options);
  const orphans = [];
  for (const entry of entries) {
    const verdict = classifyEntry(entry, options);
    if (verdict.orphan) orphans.push(verdict);
  }
  return orphans;
}

// Send a signal to a process group if a pgid is recorded, else to each matched
// PID individually. Returns the list of pids/pgids actually signaled. Injectable
// `kill` for tests (defaults to process.kill).
function signalMatched(verdict, signal, options = {}) {
  const killFn = options.kill || ((target, sig) => process.kill(target, sig));
  const signaled = [];
  // We ALWAYS signal only PID-reuse-guarded matched procs individually — even
  // when a pgid is recorded — so we can never blast a recycled-PID group. The
  // pgid is retained in the registry for diagnostics/manual recovery only.
  for (const proc of verdict.matchedProcs) {
    try {
      killFn(proc.pid, signal);
      signaled.push(proc.pid);
    } catch {
      // ESRCH (already gone) or EPERM — treat as best-effort; the entry removal
      // below still cleans up the registry residue.
    }
  }
  return signaled;
}

// MUTATING reaper used by doctor-recovery / `gov reap-gate-procs`. For each
// ORPHANED entry: signal ONLY the PID-reuse-guarded matched procs (SIGTERM),
// then remove the registry entry. Returns a structured result. The reaper is a
// no-op for non-orphan entries and for orphan entries whose recorded PIDs no
// longer match a live process (already dead, or reused by another process).
function reapOrphans(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const signal = options.signal || "SIGTERM";
  const orphans = detectOrphans(options);
  const reaped = [];
  for (const verdict of orphans) {
    const signaled = dryRun ? verdict.matchedProcs.map((p) => p.pid) : signalMatched(verdict, signal, options);
    if (!dryRun) removeEntry(verdict.gateRunId, options);
    reaped.push({
      gate_run_id: verdict.gateRunId,
      ticket: verdict.entry.ticket || null,
      repo: verdict.entry.repo || null,
      lane: verdict.entry.lane || null,
      reason: verdict.reason,
      signaled_pids: signaled,
      removed_entry: !dryRun,
    });
  }
  return { reaped, scanned: listEntries(options).length, dry_run: dryRun };
}

// CLI surface used by the template gate.sh runners (zero-dependency shell can
// shell out to `node gate-proc-registry.js register ...` to record/cleanup an
// entry without inlining JS). Verbs:
//   register --gate-run-id <id> [--ticket <t>] [--repo <r>] [--lane <l>]
//            [--pgid <n>] --pids <csv>     -> writes the entry
//   cleanup  --gate-run-id <id>            -> removes the entry (trap EXIT)
//   list                                   -> prints all entries (JSON)
//   detect                                 -> prints orphan verdicts (JSON)
function parseCliArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return flags;
}

function main(argv = process.argv.slice(2)) {
  const verb = argv[0];
  const flags = parseCliArgs(argv.slice(1));
  switch (verb) {
    case "register": {
      const pids = String(flags.pids || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const entry = writeEntry({
        gateRunId: flags["gate-run-id"],
        ticket: flags.ticket || null,
        repo: flags.repo || null,
        lane: flags.lane || null,
        pgid: flags.pgid != null ? Number(flags.pgid) : null,
        pids,
      });
      process.stdout.write(JSON.stringify(entry) + "\n");
      return 0;
    }
    case "cleanup": {
      const removed = removeEntry(flags["gate-run-id"]);
      process.stdout.write(JSON.stringify({ removed, gate_run_id: flags["gate-run-id"] }) + "\n");
      return 0;
    }
    case "list":
      process.stdout.write(JSON.stringify(listEntries(), null, 2) + "\n");
      return 0;
    case "detect":
      process.stdout.write(JSON.stringify(detectOrphans(), null, 2) + "\n");
      return 0;
    default:
      process.stderr.write(`Unknown verb "${verb || ""}". Expected: register | cleanup | list | detect.\n`);
      return 2;
  }
}

module.exports = {
  REGISTRY_SCHEMA,
  defaultRegistryDir,
  readProcStartTime,
  readProcCmdline,
  captureProcFingerprint,
  registryPathFor,
  buildEntry,
  writeEntry,
  readEntry,
  removeEntry,
  listEntries,
  procMatchesLive,
  classifyEntry,
  detectOrphans,
  signalMatched,
  reapOrphans,
  parseCliArgs,
  main,
};

if (require.main === module) {
  process.exit(main());
}
