"use strict";

// COORD-909: the ONE provider-complete list of agent and session identity variables.
// Two consumers share it:
//   * coord/engine/scripts/test-runner.js strips these from every governance test child
//     (COORD-480/606/880/883), and
//   * coord/engine/scripts/gate-runtime.js strips them from every product test or gate
//     child (dependency install, `bash scripts/gate.sh <lane>`, and the package
//     manager gate script).
// Only a CHILD environment copy is scrubbed. The governance process keeps its own
// identity, which is what records the gate. Credentials, proxy and network settings
// (HTTP(S)_PROXY, NO_PROXY, SSL/CA variables), PATH and toolchain settings are not
// identity and are preserved: the shape pattern below matches only *_SESSION_ID,
// *_THREAD_ID and *_INSTANCE_ID names.

// Ambient session identity stripped from every test or gate child process. See
// coord/GOVERNANCE.md section 10.3 and the COORD_SESSION_ID ownership-test footgun.
//
// COORD-606: this list is PROVIDER-COMPLETE. Every `envThread` + `envThreadAliases`
// value in the governance-session PROVIDER_REGISTRY must appear here;
// test-runner.test.js reads that registry and FAILS when a provider adapter exists
// without a matching stripped variable, so the enumeration cannot silently rot.
const STRIPPED_ENV_VARS = Object.freeze([
  // coord identity
  "COORD_SESSION_ID",
  "COORD_PROVIDER_SESSION_ID",
  "COORD_INSTANCE_ID",
  // provider thread identity (PROVIDER_REGISTRY, governance-session.js)
  "CODEX_THREAD_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "GEMINI_THREAD_ID",
  "GROK_THREAD_ID",
  // provider-neutral fallbacks honored by the identity resolver
  "AGENT_THREAD_ID",
  "GOVERNANCE_MCP_THREAD_ID",
  // runtime detection flags (COORD-880, COORD-883): each alone makes detectRuntimeProvider()
  // name its provider (anthropic, google, xai); detection tests set them in their own fixture env.
  "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT",
]);

// Shape-based backstop for the enumeration above: any variable whose NAME has the
// documented identity shape is also removed, so a provider variable that lands in the
// registry before this list is updated cannot leak. This also covers the ambient
// terminal identity (TERM_SESSION_ID) that feeds session fingerprinting.
const IDENTITY_ENV_PATTERN = /^[A-Z][A-Z0-9_]*_(?:SESSION|THREAD|INSTANCE)_ID$/;

function isIdentityEnvVar(name) {
  return STRIPPED_ENV_VARS.includes(name) || IDENTITY_ENV_PATTERN.test(name);
}

// Returns a COPY of `env` without identity variables. The input is never mutated, so
// the governance process keeps its own identity. Preserved names (credentials, proxy,
// PATH, toolchain) pass through unchanged.
function scrubIdentityEnv(env = process.env) {
  const copy = { ...env };
  for (const name of Object.keys(copy)) {
    if (isIdentityEnvVar(name)) delete copy[name];
  }
  return copy;
}

// Names of the identity variables present in `env`, sorted. Used for reporting only.
function identityEnvNamesIn(env = process.env) {
  return Object.keys(env).filter(isIdentityEnvVar).sort();
}

module.exports = {
  STRIPPED_ENV_VARS,
  IDENTITY_ENV_PATTERN,
  isIdentityEnvVar,
  scrubIdentityEnv,
  identityEnvNamesIn,
};
