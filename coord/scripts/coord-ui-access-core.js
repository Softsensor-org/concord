"use strict";

// SEC-001 — coord-ui access-control baseline (pure, runtime-agnostic core).
//
// coord-ui is a STRICTLY READ-ONLY governance mirror, but when served it exposes
// board rows, ticket specs, governance events, git/worktree state, runtime locks,
// process metadata (PIDs/cmdlines), evidence, and cost data. With no auth and no
// deployment boundary that is a real disclosure surface. This module is the single
// source of truth for the access-control decision and for role-aware redaction.
//
// Design tenets:
//   - Zero dependencies, NO node builtins, NO filesystem/process/network access. It is a
//     pure decision function over request facts, so it runs identically in the
//     Next.js edge middleware, in a server component, and in the node:test suite
//     (coord/scripts/coord-ui-access-core.test.js). This mirrors the zero-dep CJS
//     pattern of gate-proc-registry.js, which coord-ui already loads in-process.
//   - FAIL CLOSED in production. Localhost/dev is ergonomic (the documented primary
//     mode); anything that is NOT a trusted local request must present a configured
//     trusted identity (a reverse-proxy header the operator vouches for, or a shared
//     bearer) or it is DENIED. The default-deny is the security property.
//   - READ-ONLY is preserved: this module grants/denies *reads* and redacts fields.
//     It never authorizes a mutation because the web tier has no mutation surface.
//
// Role model (least-privilege ordered):
//   viewer   — lowest. Sees non-sensitive aggregate governance state. Sensitive
//              fields (absolute paths, PIDs/cmdlines, session/owner identifiers,
//              PR refs, cost details) are REDACTED for this role.
//   operator — sees sensitive operational detail (runtime/git/process internals)
//              needed to operate the system, including cost.
//   admin    — full access (superset of operator). Reserved for the deployment
//              owner.
//   local    — the implicit full-access role for localhost development. Treated as
//              admin-equivalent for redaction so local dev is unredacted/ergonomic.

const ROLES = Object.freeze(["viewer", "operator", "admin", "local"]);

// Privilege rank: higher sees more. `local` ranks with admin (full local trust).
const ROLE_RANK = Object.freeze({
  viewer: 1,
  operator: 2,
  admin: 3,
  local: 3,
});

// Roles that may see sensitive operational fields without redaction.
// viewer is intentionally excluded → viewer views are redacted.
const PRIVILEGED_ROLES = Object.freeze(["operator", "admin", "local"]);

const DEFAULT_TRUSTED_HEADER = "x-coord-role";

function isRole(value) {
  return typeof value === "string" && ROLES.indexOf(value) !== -1;
}

// Normalize an arbitrary header/config value into a known role, or null.
function coerceRole(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return isRole(v) && v !== "local" ? v : null; // `local` is never accepted from a header
}

function roleRank(role) {
  return ROLE_RANK[role] || 0;
}

// A request is "local" iff its host resolves to loopback. We classify on the host
// the app sees (hostname only, port stripped). Conservative allow-list — anything
// not provably loopback is treated as remote (fail-closed bias).
const LOOPBACK_HOSTS = Object.freeze([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0", // dev servers sometimes bind here; only honored in dev (see below)
]);

function stripPort(host) {
  if (typeof host !== "string") return "";
  const h = host.trim().toLowerCase();
  // IPv6 in brackets: [::1]:3002 -> [::1]
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    return close === -1 ? h : h.slice(0, close + 1);
  }
  const colon = h.indexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.indexOf(stripPort(host)) !== -1;
}

/**
 * Decide access for a single request.
 *
 * @param {object} req
 * @param {string} [req.host]            Host header the app sees (e.g. "localhost:3002").
 * @param {string|null} [req.roleHeader] Value of the trusted role header (operator-set by proxy).
 * @param {string|null} [req.authToken]  Bearer/shared-secret presented by the request.
 * @param {object} env  Operator configuration (already read from process.env by the caller).
 * @param {string} [env.nodeEnv]            process.env.NODE_ENV.
 * @param {string} [env.authMode]           COORD_UI_AUTH_MODE: "localhost-dev" | "proxy-header" | "shared-token".
 * @param {string} [env.trustedHeader]      COORD_UI_TRUSTED_ROLE_HEADER (default x-coord-role).
 * @param {string} [env.sharedToken]        COORD_UI_AUTH_TOKEN (required when authMode === "shared-token").
 * @param {string} [env.defaultRole]        COORD_UI_DEFAULT_ROLE for authenticated-but-unroled requests.
 * @param {boolean} [env.trustLoopback]     COORD_UI_TRUST_LOOPBACK; defaults true in dev, false in prod.
 * @returns {{allowed: boolean, role: string|null, reason: string, mode: string, redact: boolean}}
 */
function decideAccess(req, env) {
  req = req || {};
  env = env || {};

  const isProd = String(env.nodeEnv || "").toLowerCase() === "production";
  // In dev, loopback is trusted by default (ergonomic). In prod, loopback trust is
  // OFF unless the operator explicitly opts in — a prod deploy behind a proxy should
  // authenticate, not lean on a spoofable host header.
  const trustLoopback =
    env.trustLoopback === undefined ? !isProd : Boolean(env.trustLoopback);

  const declaredMode = String(env.authMode || "").toLowerCase();
  const mode =
    declaredMode || (isProd ? "proxy-header" : "localhost-dev");

  // 1) Localhost/dev ergonomic path: trusted loopback → full local role, no auth.
  if (trustLoopback && isLoopbackHost(req.host)) {
    return {
      allowed: true,
      role: "local",
      reason: "trusted loopback request (localhost-dev)",
      mode,
      redact: false,
    };
  }

  // 2) Shared-token mode: a configured bearer must match. Default-deny otherwise.
  if (mode === "shared-token") {
    if (!env.sharedToken) {
      return deny(mode, "shared-token mode configured but COORD_UI_AUTH_TOKEN is unset");
    }
    if (!req.authToken || !constantishEquals(req.authToken, env.sharedToken)) {
      return deny(mode, "missing or invalid bearer token");
    }
    const role = coerceRole(req.roleHeader) || coerceRole(env.defaultRole) || "viewer";
    return grant(role, mode, "valid shared token");
  }

  // 3) Proxy-header mode (and the prod default): the operator's trusted reverse
  //    proxy sets the role header. We only honor it as a known role; absence or an
  //    unknown value is DENIED in production. (In dev a remote request also lands
  //    here and is denied unless a valid role header is present — fail-closed.)
  const headerRole = coerceRole(req.roleHeader);
  if (headerRole) {
    return grant(headerRole, mode, "trusted proxy role header");
  }

  return deny(
    mode,
    isProd
      ? "production request without a trusted role header or token — denied (fail-closed)"
      : "non-loopback request without a trusted role header — denied (fail-closed)"
  );
}

function grant(role, mode, reason) {
  return {
    allowed: true,
    role,
    reason,
    mode,
    redact: !PRIVILEGED_ROLES.includes(role),
  };
}

function deny(mode, reason) {
  return { allowed: false, role: null, reason, mode, redact: true };
}

// Length-aware non-short-circuit string compare. Not a hardened constant-time
// primitive (JS strings make that impossible without WebCrypto), but it avoids the
// trivial early-return length/character leak. Good enough for a shared dev token.
function constantishEquals(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// --- role-aware redaction ----------------------------------------------------
//
// A view is redacted for any role NOT in PRIVILEGED_ROLES (i.e. viewer, or an
// unauthenticated/denied request). Redaction is fail-safe: unknown/null role → redact.

const REDACTED = "[redacted]";

function shouldRedactForRole(role) {
  return !PRIVILEGED_ROLES.includes(role);
}

// Redact an absolute filesystem path to its basename only (drops the directory
// chain that leaks host layout / usernames). Relative paths pass through.
function redactPath(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  const isAbs = value[0] === "/" || /^[A-Za-z]:[\\/]/.test(value);
  if (!isAbs) return value;
  const parts = value.split(/[\\/]/).filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : value;
  return ".../" + base;
}

function redactString(value) {
  return value == null || value === "" ? value : REDACTED;
}

// Apply redaction to a structured field by kind. Pure; returns a new value.
//   kind: 'path' | 'pid' | 'cmdline' | 'identity' | 'pr' | 'cost'
function redactField(kind, value, role) {
  if (!shouldRedactForRole(role)) return value;
  switch (kind) {
    case "path":
      return redactPath(value);
    case "pid":
      return value == null ? value : REDACTED;
    case "cmdline":
      return redactString(value);
    case "identity": // session ids, owner handles, agent ids
      return redactString(value);
    case "pr": // PR refs / urls
      return redactString(value);
    case "cost": // dollar / token detail
      return value == null ? value : REDACTED;
    default:
      return value;
  }
}

module.exports = {
  ROLES,
  ROLE_RANK,
  PRIVILEGED_ROLES,
  DEFAULT_TRUSTED_HEADER,
  REDACTED,
  isRole,
  coerceRole,
  roleRank,
  isLoopbackHost,
  stripPort,
  decideAccess,
  shouldRedactForRole,
  redactPath,
  redactField,
  constantishEquals,
};
