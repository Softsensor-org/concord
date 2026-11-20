"use strict";
// Frontend environment loading seam (FE-001).
//
// Reference skeleton: zero-dependency. In a real bundler (Vite/Next/CRA) these
// come from import.meta.env / process.env at build time; the contract — a single
// validated config entry point with a public/private split — should stay.
//
// IMPORTANT: only NON-secret, client-safe values belong in frontend config.
// Anything secret stays server-side. This loader rejects obviously-secret keys.

const REQUIRED = [
  ["APP_ENV", "development | staging | production"],
  ["API_BASE_URL", "base URL of the backend API"],
];

const OPTIONAL = [
  ["AUTH_MODE", "redirect", "auth bootstrap mode: redirect | token | none"],
  ["LOGIN_ROUTE", "/login", "route to send unauthenticated users to"],
];

function loadEnv(source = process.env) {
  const missing = [];
  const config = {};
  for (const [name, description] of REQUIRED) {
    const v = source[name];
    if (v === undefined || v === "") missing.push(`${name} (${description})`);
    else config[name] = v;
  }
  for (const [name, fallback] of OPTIONAL) {
    config[name] = source[name] !== undefined && source[name] !== "" ? source[name] : fallback;
  }
  if (missing.length) {
    throw new Error(
      `Missing required frontend env variables:\n  - ${missing.join("\n  - ")}\n` +
        `See frontend/src/config/env.js and frontend/.env.example.`,
    );
  }
  // Guard: secrets must never be embedded in the client bundle. Reject any
  // secret-looking key present in the source environment, even if it is not a
  // declared config key — its mere presence in a frontend env is a smell.
  for (const key of Object.keys(source)) {
    if (
      /SECRET|PRIVATE_KEY|PASSWORD/i.test(key) &&
      source[key] !== undefined &&
      source[key] !== ""
    ) {
      throw new Error(`Refusing to load secret-looking key into frontend config: ${key}`);
    }
  }
  return config;
}

module.exports = { loadEnv, REQUIRED, OPTIONAL };
