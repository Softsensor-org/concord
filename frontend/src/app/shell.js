"use strict";
// Application shell (FE-001).
//
// The composition root for the frontend: loads config, bootstraps auth, and
// resolves a route through the guards. Framework-agnostic so the derived
// project can mount it under any renderer while keeping the shell's wiring.

const { loadEnv } = require("../config/env.js");
const { createAuth } = require("../auth/index.js");
const { evaluateGuard } = require("../routes/guards.js");

// Minimal route table for the reference shell.
const ROUTES = {
  "/": { requiresAuth: false },
  "/login": { requiresAuth: false },
  "/dashboard": { requiresAuth: true },
  "/admin": { requiresAuth: true, roles: ["admin"] },
};

function createShell(source = process.env, deps = {}) {
  const config = loadEnv(source);
  const auth = createAuth(config, deps);
  auth.bootstrap();

  /** Resolve navigation to a route path into an allow/redirect decision. */
  function navigate(pathname) {
    const route = ROUTES[pathname];
    if (!route) return { status: 404, route: pathname };
    const guard = evaluateGuard(auth, route, config);
    if (!guard.allow) return { status: 302, redirectTo: guard.redirectTo, reason: guard.reason };
    return { status: 200, route: pathname };
  }

  return { config, auth, navigate, routes: Object.keys(ROUTES) };
}

module.exports = { createShell, ROUTES };
