"use strict";
// GCV-1 — v2 identity: owner-lease authority core.
//
// Session-identity model: see coord/docs/IDENTITY_RUNTIME_EXTRACT.md
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

const fs = require("node:fs");
const path = require("node:path");

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
  return now - hb <= ttlMs;
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

function readRegistry(runtimeDir) {
  try {
    return normalizeRegistry(
      JSON.parse(fs.readFileSync(registryPath(runtimeDir), "utf8"))
    );
  } catch {
    return emptyRegistry();
  }
}

function writeRegistry(runtimeDir, reg) {
  const p = registryPath(runtimeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(normalizeRegistry(reg), null, 2) + "\n", "utf8");
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  ttlMsFromEnv,
  readEnvIdentity,
  emptyRegistry,
  normalizeRegistry,
  isFresh,
  reapStale,
  freshOwnerInstances,
  registerAndAcquire,
  assertCanMutate,
  registryPath,
  readRegistry,
  writeRegistry,
};
