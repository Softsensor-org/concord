"use strict";

const { readEnvIdentity, isFresh, freshOwnerInstances, ttlMsFromEnv } = require("./identity-v2.js");

// Read-only resolution: hook events cannot register, renew, or transfer leases.
// The opaque envelope session is the live instance, never a legacy lock token.
function resolveSubagentParent(lock, registry, env = process.env, now = Date.now()) {
  const deny = code => ({ ok: false, code: `subagent_identity_${code}`,
    reason: `Cannot attribute subagent activity to the live owner lease. Restore the provider SessionStart identity channel, then run gov claim ${lock.ticket} --owner ${lock.owner}; resolve any competing live instance through the governed handoff workflow` });
  const identity = readEnvIdentity(env);
  if (!identity.present) return deny("missing_channel");
  if (!registry || !Array.isArray(registry.instances) || !registry.leases ||
      typeof registry.leases !== "object" || Array.isArray(registry.leases) ||
      registry.instances.some(i => !i || typeof i !== "object")) return deny("invalid_registry");
  const matches = registry.instances.filter(i => i.instance_id === identity.instanceId);
  if (matches.length !== 1) return deny("unresolved_instance");
  const instance = matches[0];
  if (!lock.owner || instance.owner !== lock.owner || instance.provider !== identity.provider) return deny("owner_mismatch");
  const ttl = ttlMsFromEnv(env);
  if (!isFresh(instance, ttl, now)) return deny("inactive_instance");
  if (registry.leases[lock.owner]?.instance_id !== instance.instance_id) return deny("lease_mismatch");
  if (freshOwnerInstances(registry, lock.owner, ttl, now).length !== 1) return deny("split_brain");
  return { ok: true, session: instance.instance_id, provider: instance.provider };
}

module.exports = { resolveSubagentParent };
