"use strict";
// Route guards (FE-001).
//
// Framework-agnostic guard logic. A guard takes the auth state + a route's
// requirements and returns an allow/redirect decision. The derived project
// adapts these decisions into its router (Next middleware, React Router loader,
// Vue navigation guard, ...). Keeping the *decision* pure makes it testable.

/**
 * @param {{ isAuthenticated: () => boolean, hasRole: (r: string) => boolean }} auth
 * @param {{ requiresAuth?: boolean, roles?: string[] }} route
 * @param {{ LOGIN_ROUTE: string }} config
 * @returns {{ allow: true } | { allow: false, redirectTo: string, reason: string }}
 */
function evaluateGuard(auth, route, config) {
  if (!route.requiresAuth) return { allow: true };
  if (!auth.isAuthenticated()) {
    return { allow: false, redirectTo: config.LOGIN_ROUTE, reason: "unauthenticated" };
  }
  if (route.roles && route.roles.length) {
    const ok = route.roles.some((r) => auth.hasRole(r));
    if (!ok) return { allow: false, redirectTo: "/forbidden", reason: "missing-role" };
  }
  return { allow: true };
}

module.exports = { evaluateGuard };
