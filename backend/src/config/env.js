"use strict";
// Environment loading seam (BE-001).
//
// Reference skeleton: zero-dependency env loader. A derived project replaces or
// extends this with its framework's config system, but the *contract* — a single
// typed, validated entry point for environment configuration — should stay.
//
// Required variables are declared once here and validated at startup so the app
// fails fast with a clear message instead of undefined-at-use-site bugs.
//
// NOTE: keep the authoritative variable list in sync with `.env.example`.

const REQUIRED = [
  // name, description
  ["APP_ENV", "deployment environment: development | staging | production"],
];

const OPTIONAL = [
  ["PORT", "8080", "HTTP port the service listens on"],
  ["LOG_LEVEL", "info", "log verbosity: debug | info | warn | error"],
  ["AUTH_PROVIDER", "noop", "auth seam provider: noop | <your-provider>"],
];

function loadEnv(source = process.env) {
  const missing = [];
  const config = {};

  for (const [name, description] of REQUIRED) {
    const value = source[name];
    if (value === undefined || value === "") {
      missing.push(`${name} (${description})`);
    } else {
      config[name] = value;
    }
  }
  for (const [name, fallback] of OPTIONAL) {
    config[name] = source[name] !== undefined && source[name] !== "" ? source[name] : fallback;
  }

  if (missing.length) {
    throw new Error(
      `Missing required environment variables:\n  - ${missing.join("\n  - ")}\n` +
        `See backend/src/config/env.js and backend/.env.example.`,
    );
  }

  config.PORT = Number.parseInt(config.PORT, 10);
  if (!Number.isInteger(config.PORT) || config.PORT <= 0) {
    throw new Error(`PORT must be a positive integer, got: ${config.PORT}`);
  }
  return config;
}

module.exports = { loadEnv, REQUIRED, OPTIONAL };
