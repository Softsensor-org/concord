"use strict";
// Frontend auth bootstrap seam (FE-001).
//
// Reference skeleton: a session-state holder + bootstrap, not a real identity
// provider. The derived project wires this to its IdP (OIDC redirect, token
// exchange, cookie session, ...). The contract:
//
//   bootstrap()        -> resolves the current session from storage/transport
//   getPrincipal()     -> Principal | null
//   isAuthenticated()  -> boolean
//
// A `none` mode treats everyone as anonymous (dev only); other modes must be
// implemented by the derived project.

/** @typedef {{ id: string, roles: string[] }} Principal */

function createAuth(config, deps = {}) {
  const mode = (config && config.AUTH_MODE) || "redirect";
  // `store` abstracts where the session comes from (cookie, localStorage, ...).
  const store = deps.store || { read: () => null };
  let principal = null;

  return {
    mode,
    bootstrap() {
      if (mode === "none") {
        principal = null;
        return null;
      }
      // Reference: read a pre-resolved principal from the injected store.
      // A real implementation performs the redirect/token exchange here.
      const raw = store.read();
      principal = raw && raw.id ? { id: raw.id, roles: raw.roles || [] } : null;
      return principal;
    },
    getPrincipal() {
      return principal;
    },
    isAuthenticated() {
      return principal !== null;
    },
    hasRole(role) {
      return !!principal && principal.roles.includes(role);
    },
  };
}

module.exports = { createAuth };
