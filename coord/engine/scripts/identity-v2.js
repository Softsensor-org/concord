"use strict";
// GCV-1 — v2 identity: owner-lease authority core.
//
// Session-identity model: see coord/engine/docs/IDENTITY_RUNTIME_EXTRACT.md
// Invariant: a ticket may be mutated only by its recorded owner, through
// exactly ONE fresh live instance holding that owner's lease.
//
// This module is pure decision logic + a thin JSON registry IO layer.
// governance.js routes mutations through `assertCanMutateTicket` in a
// SEPARATE later commit (Phase-4 routing) — this commit is the core only.
//
// Model:
//   instance = one live attach/process
//     { provider, provider_session_id, instance_id, owner,
//       transcript_path, cwd, started_at, heartbeat_at, ended_at,
//       status: "active" | "ended" | "revoked", revoked_at, revoked_to }
//   lease    = at most one live instance per owner
//     leases[owner] = { instance_id, acquired_at }
//
// provider_session_id / transcript_path / pid are EVIDENCE only — never
// authority (Design 4/7). Authority = owner + the owner-lease holder.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isPlainObject } = require("./lifecycle-utils.js");

const DEFAULT_TTL_SECONDS = 900; // 15m; override COORD_INSTANCE_TTL

function ttlMsFromEnv(env = process.env) {
  const raw = Number(env.COORD_INSTANCE_TTL);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_SECONDS;
  return seconds * 1000;
}

// Identity strictly from the durable channel; never inferred (constraint 6).
function readEnvIdentity(env = process.env) {
  const provider = String(env.COORD_PROVIDER || "").trim();
  const providerSessionId = String(env.COORD_PROVIDER_SESSION_ID || "").trim();
  const instanceId = String(env.COORD_INSTANCE_ID || "").trim();
  const transcriptPath = String(env.COORD_TRANSCRIPT_PATH || "").trim();
  const present = Boolean(provider && instanceId);
  return { provider, providerSessionId, instanceId, transcriptPath, present };
}

function normalizeSsoClaims(claims = {}, opts = {}) {
  const c = claims && typeof claims === "object" ? claims : {};
  const issuer = String(c.iss || c.issuer || opts.issuer || "").trim();
  const subject = String(c.sub || c.oid || c.objectId || "").trim();
  const email = String(c.email || c.preferred_username || c.upn || "").trim().toLowerCase();
  const displayName = String(c.name || c.display_name || email || subject || "").trim();
  const tenantId = String(c.tid || c.tenant_id || opts.tenantId || "").trim();
  const groups = Array.isArray(c.groups)
    ? c.groups.map((group) => String(group).trim()).filter(Boolean)
    : [];
  const present = Boolean(issuer && (subject || email));
  const stableId = present
    ? [
        "sso",
        tenantId || issuer,
        subject || email,
      ].join(":")
    : "";
  return {
    provider: String(opts.provider || "oidc").trim() || "oidc",
    issuer,
    tenant_id: tenantId,
    subject,
    email,
    display_name: displayName,
    groups,
    stable_id: stableId,
    present,
  };
}

function governedActorFromSso(claims = {}, opts = {}) {
  const identity = normalizeSsoClaims(claims, opts);
  if (!identity.present) {
    return {
      present: false,
      actor: null,
      reason: "missing trusted SSO/OIDC issuer and subject/email",
    };
  }
  return {
    present: true,
    actor: {
      kind: "human",
      owner: opts.ownerPrefix
        ? `${opts.ownerPrefix}${identity.email || identity.subject}`
        : identity.email || identity.subject,
      identity_provider: identity.provider,
      identity_issuer: identity.issuer,
      identity_subject: identity.subject,
      identity_email: identity.email,
      display_name: identity.display_name,
      tenant_id: identity.tenant_id,
      groups: identity.groups,
      stable_id: identity.stable_id,
      attribution: {
        actor_type: "human-sso",
        actor_id: identity.stable_id,
        email: identity.email,
        issuer: identity.issuer,
      },
    },
  };
}

function emptyRegistry() {
  return { version: 1, instances: [], leases: {} };
}

function normalizeRegistry(reg) {
  const r = reg && typeof reg === "object" ? reg : {};
  return {
    version: 1,
    instances: Array.isArray(r.instances) ? r.instances : [],
    leases: r.leases && typeof r.leases === "object" ? r.leases : {},
  };
}

function parseTs(v) {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : NaN;
}

function isFresh(instance, ttlMs, now) {
  if (!instance || instance.status !== "active") return false;
  const hb = parseTs(instance.heartbeat_at);
  if (!Number.isFinite(hb)) return false;
  // COORD-951 (human-admin 2026-11-13): symmetric skew tolerance of one TTL. A heartbeat up
  // to one TTL ahead of this clock is fresh; further ahead it is stale, never fresh forever.
  const age = now - hb;
  return age >= -ttlMs && age <= ttlMs;
}

function findInstance(reg, instanceId) {
  return reg.instances.find((i) => i.instance_id === instanceId) || null;
}

// Reap: stale active instances become ended (never block; Design 5).
// Returns the mutated registry (in place) for chaining.
function reapStale(reg, ttlMs, now) {
  for (const inst of reg.instances) {
    if (inst.status === "active" && !isFresh(inst, ttlMs, now)) {
      inst.status = "ended";
      inst.ended_at = inst.ended_at || new Date(now).toISOString();
      inst.ended_reason = "stale-ttl";
    }
  }
  // Drop leases whose holder is no longer a fresh active instance.
  for (const [owner, lease] of Object.entries(reg.leases)) {
    const holder = findInstance(reg, lease.instance_id);
    if (!holder || !isFresh(holder, ttlMs, now)) {
      delete reg.leases[owner];
    }
  }
  return reg;
}

function freshOwnerInstances(reg, owner, ttlMs, now) {
  return reg.instances.filter(
    (i) => i.owner === owner && isFresh(i, ttlMs, now)
  );
}

// COORD-893: whether a live instance OTHER than `instanceId` holds `owner`'s
// lease under the v2 TTL. An expired or absent lease is free crash recovery.
function leaseHeldByOtherLiveInstance(reg0, owner, instanceId, now = Date.now(), ttlMs = ttlMsFromEnv()) {
  const reg = normalizeRegistry(reg0);
  const lease = reg.leases[owner];
  const holder = lease ? findInstance(reg, lease.instance_id) : null;
  return Boolean(holder && holder.instance_id !== instanceId && isFresh(holder, ttlMs, now));
}

// Register or refresh the calling instance, and (re)acquire the owner
// lease per the settled rules. `handoff` is required only to displace a
// LIVE same-owner holder; a stale/absent holder is taken silently.
// Returns { registry, decision }. decision.action ∈
//  no-identity | revoked | split-brain | acquired | held | handoff
function registerAndAcquire(reg0, identity, owner, opts = {}, now = Date.now()) {
  const reg = normalizeRegistry(reg0);
  const ttlMs = opts.ttlMs || ttlMsFromEnv();
  if (!identity || !identity.present || !owner) {
    return {
      registry: reg,
      decision: {
        allowed: false,
        action: "no-identity",
        message:
          "No durable governance identity in this environment " +
          "(COORD_PROVIDER/COORD_INSTANCE_ID absent). This mode is " +
          "explicit-claim-only: run `gov claim --owner <handle>` in a " +
          "session where the SessionStart hook is active, or pass " +
          "identity explicitly. Authority is never inferred.",
      },
    };
  }
  reapStale(reg, ttlMs, now);

  let inst = findInstance(reg, identity.instanceId);
  const nowIso = new Date(now).toISOString();
  if (!inst) {
    inst = {
      provider: identity.provider,
      provider_session_id: identity.providerSessionId,
      instance_id: identity.instanceId,
      owner,
      transcript_path: identity.transcriptPath || "",
      cwd: opts.cwd || "",
      started_at: nowIso,
      heartbeat_at: nowIso,
      ended_at: null,
      status: "active",
    };
    reg.instances.push(inst);
  }

  // A revoked instance never silently regains authority.
  if (inst.status === "revoked") {
    return {
      registry: reg,
      decision: {
        allowed: false,
        action: "revoked",
        message:
          `This instance was revoked at ${inst.revoked_at} (lease handed ` +
          `off to ${inst.revoked_to}). This terminal can no longer mutate; ` +
          `start a fresh session or re-claim with --handoff if appropriate.`,
      },
    };
  }

  inst.owner = owner;
  inst.status = "active";
  inst.heartbeat_at = nowIso;

  const lease = reg.leases[owner];
  const holder = lease ? findInstance(reg, lease.instance_id) : null;
  const holderFresh = holder && isFresh(holder, ttlMs, now);

  if (!holder || !holderFresh || holder.instance_id === inst.instance_id) {
    // Free / stale / already-mine -> acquire (or keep) the lease.
    const had = lease && lease.instance_id === inst.instance_id;
    reg.leases[owner] = { instance_id: inst.instance_id, acquired_at: lease && had ? lease.acquired_at : nowIso };
    return {
      registry: reg,
      decision: { allowed: true, action: had ? "held" : "acquired" },
    };
  }

  // A different FRESH same-owner instance holds the lease.
  if (!opts.handoff) {
    return {
      registry: reg,
      decision: {
        allowed: false,
        action: "split-brain",
        message:
          `Owner "${owner}" lease is held by a live instance ` +
          `${holder.instance_id} (provider session ` +
          `${holder.provider_session_id || "?"}). Two live instances for ` +
          `one owner is split-brain. If this is your own restart, run ` +
          `\`gov claim --owner ${owner} --handoff [--reason <text>]\`; ` +
          `that explicitly transfers the lease (no silent steal).`,
      },
    };
  }

  // Explicit same-owner fast handoff (Design 5a).
  holder.status = "revoked";
  holder.revoked_at = nowIso;
  holder.revoked_to = inst.instance_id;
  reg.leases[owner] = { instance_id: inst.instance_id, acquired_at: nowIso };
  return {
    registry: reg,
    decision: {
      allowed: true,
      action: "handoff",
      handoff: {
        from_instance: holder.instance_id,
        to_instance: inst.instance_id,
        owner,
        reason: String(opts.reason || "").trim() || "<same-owner fast handoff>",
        at: nowIso,
      },
    },
  };
}

// The central mutation gate (pure half). governance.js wraps this with
// ticket/lock lookup + journaling in the Phase-4 routing commit.
//   ticketOwner: owner recorded on the ticket/lock (null if unowned)
//   allowUnownedStart: a `start` may bind an unowned ticket to caller
//   humanAdminOverride: reason string for foreign-owner takeover
// guard:owner-lease
function assertCanMutate(reg0, identity, params = {}, now = Date.now()) {
  const { ticketOwner = null, allowUnownedStart = false } = params;
  const humanAdminOverride = String(params.humanAdminOverride || "").trim();
  const owner = String(params.owner || (identity && identity.owner) || "").trim();

  const acquire = registerAndAcquire(reg0, identity, owner, params, now);
  if (!acquire.decision.allowed) {
    return { registry: acquire.registry, decision: acquire.decision };
  }

  // Owner-lease is held by caller. Now the ticket-owner dimension.
  if (ticketOwner && owner && ticketOwner !== owner) {
    if (humanAdminOverride) {
      return {
        registry: acquire.registry,
        decision: {
          allowed: true,
          action: "foreign-admin-override",
          override_reason: humanAdminOverride,
          lease: acquire.decision.action,
        },
      };
    }
    return {
      registry: acquire.registry,
      decision: {
        allowed: false,
        action: "foreign-owner",
        message:
          `Ticket is owned by "${ticketOwner}" but caller owner is ` +
          `"${owner}". Cross-owner mutation requires ` +
          `--human-admin-override "<reason>".`,
      },
    };
  }
  if (!ticketOwner && !allowUnownedStart && params.requireTicketOwner !== false) {
    // Unowned ticket: only an explicit start may bind it.
    return {
      registry: acquire.registry,
      decision: {
        allowed: false,
        action: "unowned-ticket",
        message:
          "Ticket has no recorded owner; bind it with `gov start` " +
          "(or claim) before mutating.",
      },
    };
  }
  return {
    registry: acquire.registry,
    decision: {
      allowed: true,
      action: acquire.decision.action,
      handoff: acquire.decision.handoff,
      owner,
    },
  };
}

// --- thin IO layer (separated so the logic above stays pure & tested) ---
function registryPath(runtimeDir) {
  return path.join(runtimeDir, "identity", "instances.json");
}

const RECOVERY_VERB = "coord/scripts/gov agents recover-lease-registry";

// COORD-812: typed refusal for a registry that exists but cannot be trusted.
//   OWNER_LEASE_REGISTRY_UNREADABLE  — read failed for any reason but ENOENT
//   OWNER_LEASE_REGISTRY_CORRUPT     — bytes are not JSON (incl. zero-byte)
//   OWNER_LEASE_REGISTRY_UNSUPPORTED — JSON, but not a v1 registry structure
class OwnerLeaseRegistryError extends Error {
  constructor(code, file, problem, cause) {
    super(
      `The v2 owner-lease registry ${file} ${problem}. It was left untouched and ` +
      "is NOT treated as empty: it may record a live lease holder or a revoked " +
      "instance, so no claim, handoff or mutation is authorized from it. Do not " +
      "delete, truncate or re-create it. Preserve a copy, then have a human admin " +
      "restore the last known-good registry (or explicitly approve a reset) as a " +
      "recorded governance decision before retrying, through the governed recovery " +
      "verb (COORD-824), which keeps the corrupt bytes as evidence and lists every " +
      `lease the replacement drops or changes: \`${RECOVERY_VERB} --registry ${file} ` +
      "--expect-sha256 <sha256 of its current bytes> (--restore-from <known-good copy> | " +
      '--approve-empty) --human-admin-override "<reason>"`.'
    );
    this.name = "OwnerLeaseRegistryError";
    this.code = code;
    this.problem = problem;
    this.registryPath = file;
    if (cause) this.cause = cause;
  }
}

function unsupportedRegistryReason(reg) {
  if (!isPlainObject(reg)) return "is not a JSON object";
  if (reg.version !== 1) return `has unsupported version ${JSON.stringify(reg.version)}`;
  if (!Array.isArray(reg.instances)) return "has no instances array";
  if (!reg.instances.every(isPlainObject)) return "has a non-object instance entry";
  if (!isPlainObject(reg.leases)) return "has no leases object";
  if (!Object.values(reg.leases).every(isPlainObject)) return "has a non-object lease entry";
  return null;
}

// Fail closed (COORD-812). Only ENOENT — the registry genuinely does not exist
// yet on a fresh runtime — is the empty first-use state. Every other outcome
// throws OwnerLeaseRegistryError; callers must refuse, never substitute
// emptyRegistry(), because an empty registry authorizes a fresh acquisition.
function readRegistry(runtimeDir) {
  const p = registryPath(runtimeDir);
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyRegistry();
    throw new OwnerLeaseRegistryError(
      "OWNER_LEASE_REGISTRY_UNREADABLE", p,
      `could not be read (${(error && (error.code || error.message)) || "unknown error"})`, error
    );
  }
  return parseRegistryText(raw, p);
}

// The strict half of readRegistry, shared with recovery (COORD-824) so a
// replacement is accepted by exactly the reader every consumer uses.
function parseRegistryText(raw, p) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new OwnerLeaseRegistryError(
      "OWNER_LEASE_REGISTRY_CORRUPT", p,
      raw.length === 0 ? "is corrupt (zero-byte file)" : "is corrupt (not valid JSON)", error
    );
  }
  const unsupported = unsupportedRegistryReason(parsed);
  if (unsupported) {
    throw new OwnerLeaseRegistryError("OWNER_LEASE_REGISTRY_UNSUPPORTED", p, unsupported);
  }
  return normalizeRegistry(parsed);
}

function writeRegistry(runtimeDir, reg) {
  const p = registryPath(runtimeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // COORD-429: atomic write. A crash mid-write must never torn-truncate the
  // owner-lease registry — a partial JSON file is unreadable authority state
  // (readRegistry() refuses it, COORD-812; it used to fall back to
  // emptyRegistry(), silently dropping EVERY registered lease). Write to a
  // temp file in the same directory (so rename stays on one filesystem) and rename
  // into place; rename is atomic on POSIX, so a reader sees either the old or the
  // new complete file, never a torn one. (Concurrent lost-update is already
  // prevented by the withAgentStateLock around the claim read-modify-write.)
  writeRegistryBytes(p, JSON.stringify(normalizeRegistry(reg), null, 2) + "\n");
}

function writeRegistryBytes(p, body) {
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, p);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

// COORD-811: exact-byte restore point for a registry write that must be undone
// when a later step of the same claim/handoff fails (the handoff journal
// append). Bytes, not a parsed copy, so a rollback leaves the durable lease
// state exactly as the prior holder wrote it.
function snapshotRegistry(runtimeDir) {
  try {
    return { exists: true, raw: fs.readFileSync(registryPath(runtimeDir), "utf8") };
  } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, raw: null };
    throw error;
  }
}

function restoreRegistry(runtimeDir, snapshot) {
  const p = registryPath(runtimeDir);
  if (snapshot && snapshot.exists) {
    writeRegistryBytes(p, snapshot.raw);
  } else {
    fs.rmSync(p, { force: true });
  }
}

// --- COORD-824: governed, human-authorised recovery of an untrusted registry ---
// The only path that replaces a registry readRegistry() refuses. It never
// rebuilds or discards entries on its own: the human admin names the exact
// file and the hash of the bytes they inspected, the corrupt bytes are kept as
// evidence first, the replacement must pass the same strict reader, and every
// lease the replacement drops or changes is reported and journaled.
function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function leaseEntries(leases) {
  return Object.keys(leases).sort().map((owner) => ({
    owner,
    instance_id: leases[owner]?.instance_id ?? null,
    acquired_at: leases[owner]?.acquired_at ?? null,
  }));
}

// Best effort: the leases the corrupt bytes still visibly record, or null when
// they do not say (not JSON, or no leases object) -- reported as unknown.
function visibleLeases(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isPlainObject(parsed) && isPlainObject(parsed.leases) ? leaseEntries(parsed.leases) : null;
}

function diffLeases(before, after) {
  if (!before) {
    return {
      before_known: false, before: null, after, dropped: [], changed: [], added: after,
      warning: "The corrupt bytes do not show which leases were held: any lease held before " +
        "recovery and not listed in `after` is dropped, and its holder loses mutation authority.",
    };
  }
  const afterBy = new Map(after.map((lease) => [lease.owner, lease]));
  const beforeOwners = new Set(before.map((lease) => lease.owner));
  const dropped = before.filter((lease) => !afterBy.has(lease.owner));
  const changed = before
    .filter((lease) => afterBy.has(lease.owner))
    .filter((lease) => afterBy.get(lease.owner).instance_id !== lease.instance_id ||
      afterBy.get(lease.owner).acquired_at !== lease.acquired_at)
    .map((lease) => ({ owner: lease.owner, before: lease, after: afterBy.get(lease.owner) }));
  const lost = dropped.length + changed.length;
  return {
    before_known: true, before, after, dropped, changed,
    added: after.filter((lease) => !beforeOwners.has(lease.owner)),
    warning: lost === 0 ? null :
      `${dropped.length} lease(s) dropped and ${changed.length} changed by the replacement; ` +
      "those holders lose (or move) mutation authority.",
  };
}

// A replacement is accepted even when it names a holder the engine does not
// know -- a real backup may predate a registration -- but each such lease is
// listed, never silent: an owner handle missing from the agent registry, or an
// instance_id missing from the replacement's own instances (a dangling lease).
function unknownHolders(registry, knownHandles) {
  const handles = new Set(knownHandles || []);
  const instances = new Set(registry.instances.map((instance) => instance.instance_id));
  const leases = leaseEntries(registry.leases).map((lease) => ({
    ...lease,
    reasons: [
      ...(handles.has(lease.owner) ? [] : ["handle_not_registered"]),
      ...(instances.has(lease.instance_id) ? [] : ["instance_not_registered"]),
    ],
  })).filter((lease) => lease.reasons.length > 0);
  return {
    leases,
    warning: leases.length === 0 ? null :
      `${leases.length} lease(s) in the replacement name a holder the engine does not know (an owner ` +
      "handle not in the agent registry, or an instance_id not in the replacement's instances). The " +
      "replacement was accepted; confirm each listed holder before relying on its authority.",
  };
}

// guard:identity-recovery
function assertRecoveryRequest(request, p) {
  if (!String(request.reason || "").trim()) {
    throw new Error(
      `${RECOVERY_VERB} requires --human-admin-override "<reason>". Replacing the owner-lease ` +
      "registry decides who may mutate; it is a human-admin authority act, never routine agent repair."
    );
  }
  if (!request.registry || path.resolve(request.registry) !== p) {
    throw new Error(`${RECOVERY_VERB} requires --registry naming the exact registry file ${p}.`);
  }
  if (Boolean(request.restoreFrom) === Boolean(request.approveEmpty)) {
    throw new Error(
      `${RECOVERY_VERB} requires exactly one replacement: --restore-from <known-good copy> or ` +
      "--approve-empty (an explicitly approved empty registry that drops every lease)."
    );
  }
}

// The recovery target must exist, be readable as bytes, and be refused by the
// strict reader -- a healthy registry is never "recovered" (use --handoff).
function readRecoveryTarget(p) {
  let bytes;
  try {
    bytes = fs.readFileSync(p);
  } catch (error) {
    // guard:identity-recovery
    throw new Error(
      `The owner-lease registry ${p} could not be read as bytes (${error.code}). Recovery preserves the ` +
      "exact corrupt bytes as evidence before anything else, so it refuses until they are readable." +
      (error.code === "ENOENT" ? " An absent registry is first use, not corruption: nothing to recover." : "")
    );
  }
  try {
    parseRegistryText(bytes.toString("utf8"), p);
  } catch (error) {
    return { bytes, error };
  }
  throw new Error(
    `The owner-lease registry ${p} is valid, so there is nothing to recover. Move a lease with ` +
    "`coord/scripts/gov claim --owner <handle> --handoff`; recovery only replaces a registry every consumer refuses."
  );
}

function readReplacement(request) {
  if (request.approveEmpty) {
    const registry = emptyRegistry();
    return { source: "approved-empty", bytes: Buffer.from(JSON.stringify(registry, null, 2) + "\n"), registry };
  }
  const from = path.resolve(request.restoreFrom);
  let bytes;
  try {
    bytes = fs.readFileSync(from);
  } catch (error) {
    throw new Error(`Replacement registry ${from} could not be read (${error.code}); nothing was changed.`);
  }
  try {
    return { source: from, bytes, registry: parseRegistryText(bytes.toString("utf8"), from) };
  } catch (error) {
    // guard:identity-recovery
    throw new Error(
      `Replacement registry ${from} is not a valid owner-lease registry (${error.code}: ${error.problem}). ` +
      "The strict reader every consumer uses would refuse it, so it was not written; nothing was changed."
    );
  }
}

function preserveRecoveryEvidence(runtimeDir, bytes, record) {
  const stamp = record.recorded_at.replace(/[:.]/g, "-");
  const base = path.join(runtimeDir, "identity", "recovery", `${stamp}-${record.corrupt_sha256.slice(0, 12)}`);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  // Two recoveries of the same bytes in the same millisecond get distinct
  // directories; never reuse, or write over, an earlier recovery's evidence.
  let dir = base;
  for (let n = 1; fs.existsSync(dir); n += 1) dir = `${base}-${n}`;
  fs.mkdirSync(dir);
  const evidence = {
    dir,
    bytes_path: path.join(dir, "instances.json.corrupt"),
    record_path: path.join(dir, "evidence.json"),
  };
  fs.writeFileSync(evidence.bytes_path, bytes, { flag: "wx" });
  fs.writeFileSync(evidence.record_path, JSON.stringify({ ...record, evidence }, null, 2) + "\n", { flag: "wx" });
  return evidence;
}

// request: { registry, expectSha256, restoreFrom | approveEmpty, reason, actor }
// hooks:   { journal(event), now?, knownHandles? } -- journal must append an
//          attributed event; knownHandles are the agent-registry handles.
function recoverRegistry(runtimeDir, request, hooks) {
  const p = registryPath(runtimeDir);
  assertRecoveryRequest(request, p);
  const target = readRecoveryTarget(p);
  const corruptSha = sha256Hex(target.bytes);
  if (String(request.expectSha256 || "").trim().toLowerCase() !== corruptSha) {
    throw new Error(
      `--expect-sha256 must be the sha256 of the registry bytes the human admin inspected; ${p} is now ` +
      `${corruptSha}. Re-inspect the file and re-authorise against its current hash; nothing was changed.`
    );
  }
  const replacement = readReplacement(request);
  const record = {
    command: "owner-lease-registry-recovery",
    registry_path: p,
    corrupt_sha256: corruptSha,
    corrupt_size_bytes: target.bytes.length,
    corrupt_error_code: target.error.code,
    actor: request.actor,
    recorded_at: new Date(hooks.now ?? Date.now()).toISOString(),
    human_admin_override_reason: String(request.reason).trim(),
    replacement: { source: replacement.source, sha256: sha256Hex(replacement.bytes) },
    leases: diffLeases(visibleLeases(target.bytes.toString("utf8")), leaseEntries(replacement.registry.leases)),
    unknown_holders: unknownHolders(replacement.registry, hooks.knownHandles),
  };
  if (typeof hooks.authorize !== "function") {
    throw new Error("Owner-lease registry recovery requires an explicit signed-authorization callback.");
  }
  const authorization = hooks.authorize(record);
  if (!authorization || typeof authorization !== "object") {
    throw new Error("Owner-lease registry recovery authorization did not return verified evidence.");
  }
  record.authorization = authorization;
  const evidence = preserveRecoveryEvidence(runtimeDir, target.bytes, record);
  try {
    writeRegistryBytes(p, replacement.bytes);
  } catch (error) {
    throw new Error(
      `The replacement registry was not written (${error.message}). ${p} still holds the corrupt bytes, ` +
      `also preserved at ${evidence.bytes_path}; no lease changed.`
    );
  }
  const event = { ...record, evidence };
  try {
    hooks.journal(event);
  } catch (error) {
    let rollback = "The replacement was rolled back: the registry holds the original corrupt bytes again.";
    try {
      writeRegistryBytes(p, target.bytes);
    } catch (restoreError) {
      rollback =
        `Rolling the replacement back ALSO failed (${restoreError.message}): ${p} holds an unjournaled ` +
        `replacement; the corrupt bytes are preserved at ${evidence.bytes_path}. Inspect it before any mutation.`;
    }
    throw new Error(`Owner-lease registry recovery could not be journaled (${error.message}). ${rollback}`);
  }
  return event;
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  ttlMsFromEnv,
  readEnvIdentity,
  normalizeSsoClaims,
  governedActorFromSso,
  emptyRegistry,
  normalizeRegistry,
  isFresh,
  reapStale,
  freshOwnerInstances,
  leaseHeldByOtherLiveInstance,
  registerAndAcquire,
  assertCanMutate,
  registryPath,
  OwnerLeaseRegistryError,
  readRegistry,
  writeRegistry,
  snapshotRegistry,
  restoreRegistry,
  RECOVERY_VERB,
  parseRegistryText,
  diffLeases,
  recoverRegistry,
};
