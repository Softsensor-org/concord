"use strict";

// COORD-909: the shared provider-complete identity list. Product gates and the coord
// runner both scrub through this module, so its behaviour is pinned here directly.
const test = require("node:test");
const assert = require("node:assert/strict");
const { STRIPPED_ENV_VARS, IDENTITY_ENV_PATTERN, isIdentityEnvVar, scrubIdentityEnv, identityEnvNamesIn } = require("./agent-identity-env.js");

test("COORD-909: scrubIdentityEnv removes every enumerated identity variable from a copy", () => {
  const env = {};
  for (const name of STRIPPED_ENV_VARS) env[name] = `ambient-${name}`;
  env.PATH = "/usr/bin";
  assert.deepEqual(identityEnvNamesIn(env), [...STRIPPED_ENV_VARS].sort());
  const scrubbed = scrubIdentityEnv(env);
  for (const name of STRIPPED_ENV_VARS) assert.equal(Object.hasOwn(scrubbed, name), false, `${name} must be removed`);
  assert.equal(scrubbed.PATH, "/usr/bin");
  // A copy: the input object keeps its identity so the governance process is unaffected.
  for (const name of STRIPPED_ENV_VARS) assert.equal(env[name], `ambient-${name}`);
});

test("COORD-909: the shape sweep removes a provider identity variable that is not enumerated", () => {
  assert.equal(IDENTITY_ENV_PATTERN.test("FUTURE_PROVIDER_THREAD_ID"), true);
  assert.equal(isIdentityEnvVar("FUTURE_PROVIDER_THREAD_ID"), true);
  const scrubbed = scrubIdentityEnv({ FUTURE_PROVIDER_THREAD_ID: "x", TERM_SESSION_ID: "y", KEEP_ME: "z" });
  assert.deepEqual(scrubbed, { KEEP_ME: "z" });
});

test("COORD-909: credentials, proxy and network, PATH and toolchain variables are preserved", () => {
  const preserved = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/fixture",
    HTTPS_PROXY: "http://proxy.fixture.invalid:3128",
    HTTP_PROXY: "http://proxy.fixture.invalid:3128",
    NO_PROXY: "localhost,127.0.0.1",
    SSL_CERT_FILE: "/fixture/ca.pem",
    NODE_EXTRA_CA_CERTS: "/fixture/extra-ca.pem",
    GITHUB_TOKEN: "fake-token",
    NPM_TOKEN: "fake-npm-token",
    NODE_OPTIONS: "--max-old-space-size=4096",
    COORD_PROJECT_CONFIG: "/fixture/project.config.js",
  };
  const scrubbed = scrubIdentityEnv({ ...preserved, COORD_SESSION_ID: "a1" });
  assert.deepEqual(scrubbed, preserved);
});

test("COORD-909: the list keeps the coord runner's provider-complete entries", () => {
  for (const name of ["COORD_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "GEMINI_THREAD_ID", "GROK_THREAD_ID", "AGENT_THREAD_ID", "GOVERNANCE_MCP_THREAD_ID", "CLAUDECODE", "GEMINI_AGENT", "GROK_AGENT"]) {
    assert.ok(STRIPPED_ENV_VARS.includes(name), `${name} must stay in the shared list`);
  }
});
