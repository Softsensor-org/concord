"use strict";

// @coord/shared — Result helpers.
//
// COORD-136 (Component-library convergence). A tiny tagged-result helper of the
// shape `{ ok, value | error }` is the kind of utility every repo re-invents
// (the backend wraps service calls, the frontend wraps fetches, coord-ui wraps
// cockpit loads). Centralizing it here gives those copies one place to converge
// onto. Zero runtime dependencies.

// Construct a success result.
function ok(value) {
  return { ok: true, value };
}

// Construct a failure result. `error` is normalized to a string message-bearing
// shape so callers can rely on `.error` always being present.
function err(error) {
  const message = error instanceof Error ? error.message : String(error == null ? "error" : error);
  return { ok: false, error: message };
}

// Run a function, capturing a thrown error as an `err` result instead of
// propagating it. The canonical "don't hand-roll try/catch-to-result" helper.
function attempt(fn) {
  try {
    return ok(fn());
  } catch (e) {
    return err(e);
  }
}

// Map over the value of a success result, passing failures through untouched.
function mapResult(result, fn) {
  if (result && result.ok) return ok(fn(result.value));
  return result;
}

module.exports = { ok, err, attempt, mapResult };
