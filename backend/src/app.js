"use strict";
// Application composition root (BE-001).
//
// Wires the shared seams (config, auth) and feature modules together. This is
// the single place that knows how the pieces connect; modules stay unaware of
// each other. A derived project swaps the HTTP layer (Express/Fastify/Koa/...)
// but keeps this composition shape.

const { loadEnv } = require("./config/env.js");
const { createAuth } = require("./auth/index.js");
const { getHealth } = require("./modules/health/index.js");

function createApp(source = process.env) {
  const config = loadEnv(source);
  const auth = createAuth(config);

  // Minimal framework-agnostic router: maps (method, path) -> handler.
  // A derived project replaces this with its web framework.
  const routes = {
    "GET /health": (_req) => ({ status: 200, body: getHealth() }),
    "GET /whoami": (req) => {
      const principal = auth.authenticate(req);
      return principal
        ? { status: 200, body: principal }
        : { status: 401, body: { error: "unauthenticated" } };
    },
  };

  function handle(method, path, req = { headers: {} }) {
    const route = routes[`${method} ${path}`];
    if (!route) return { status: 404, body: { error: "not found" } };
    return route(req);
  }

  return { config, auth, handle, routes: Object.keys(routes) };
}

module.exports = { createApp };
