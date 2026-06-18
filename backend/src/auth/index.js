"use strict";
// Authentication seam (BE-001).
//
// Reference skeleton: an auth *seam*, not a concrete identity provider. The
// derived project plugs a real provider (OIDC, session, API key, mTLS, ...)
// behind this interface. The contract is:
//
//   authenticate(request) -> Principal | null
//
// where `request` is a minimal, framework-agnostic shape `{ headers }`.
//
// The default `noop` provider authenticates nobody (returns null). It exists so
// the app composes and tests run before a real provider is chosen — it must NOT
// be used in staging/production.

/** @typedef {{ id: string, roles: string[] }} Principal */

function createNoopProvider() {
  return {
    name: "noop",
    /** @returns {Principal | null} */
    authenticate(_request) {
      return null; // no identity until a real provider is configured
    },
  };
}

const PROVIDERS = {
  noop: createNoopProvider,
};

function createAuth(config) {
  const name = (config && config.AUTH_PROVIDER) || "noop";
  const factory = PROVIDERS[name];
  if (!factory) {
    throw new Error(
      `Unknown AUTH_PROVIDER "${name}". Registered: ${Object.keys(PROVIDERS).join(", ")}. ` +
        `Add your provider to backend/src/auth/index.js.`,
    );
  }
  const provider = factory(config);
  if ((config && config.APP_ENV) !== "development" && provider.name === "noop") {
    // Fail closed: the no-identity provider must not run outside development.
    throw new Error(
      `AUTH_PROVIDER=noop is only allowed when APP_ENV=development. ` +
        `Configure a real auth provider for APP_ENV=${config.APP_ENV}.`,
    );
  }
  return provider;
}

module.exports = { createAuth, PROVIDERS };
