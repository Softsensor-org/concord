"use strict";
// Entrypoint (BE-001). Composes the app and reports readiness. The actual HTTP
// server binding is intentionally left to the derived project's chosen
// framework; this entrypoint proves the composition wires up and fails fast on
// bad configuration.

const { createApp } = require("./app.js");

function main() {
  const app = createApp();
  const health = app.handle("GET", "/health");
  process.stdout.write(
    `backend composed: env=${app.config.APP_ENV} port=${app.config.PORT} ` +
      `auth=${app.auth.name} routes=[${app.routes.join(", ")}] ` +
      `health=${health.body.status}\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`startup failed: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main };
