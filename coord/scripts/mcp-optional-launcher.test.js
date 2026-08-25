"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const launcher = require("./mcp-optional-launcher.js");

test("COORD-483: every optional package is pinned to an immutable version", () => {
  for (const [name, connector] of Object.entries(launcher.OPTIONAL_CONNECTORS)) {
    const packageSpecs = connector.args.filter((arg) => arg.startsWith("@"));
    assert.ok(packageSpecs.length > 0, `${name} must name a package`);
    for (const spec of packageSpecs) {
      assert.match(spec, /^@[^/]+\/[^@]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
      assert.doesNotMatch(spec, /@latest$/i);
    }
  }
});

test("COORD-483: missing credentials fail before npx can start", () => {
  let spawned = false;
  let message = "";
  const code = launcher.run(["sentry"], {
    env: {},
    spawnSync() {
      spawned = true;
      return { status: 0 };
    },
    err: { write(chunk) { message += chunk; } },
  });
  assert.equal(code, 2);
  assert.equal(spawned, false);
  assert.match(message, /SENTRY_ACCESS_TOKEN/);
});

test("COORD-483: explicit credentialed activation launches the pinned package", () => {
  let call = null;
  const env = { SENTRY_ACCESS_TOKEN: "test-token" };
  const code = launcher.run(["sentry"], {
    env,
    spawnSync(command, args, options) {
      call = { command, args, options };
      return { status: 0 };
    },
    err: { write() {} },
  });
  assert.equal(code, 0);
  assert.equal(call.command, "npx");
  assert.deepEqual(call.args, ["--yes", "@sentry/mcp-server@0.37.0"]);
  assert.equal(call.options.env, env);
  assert.equal(call.options.stdio, "inherit");
});

test("COORD-483: unknown connectors fail closed without spawning", () => {
  let spawned = false;
  const code = launcher.run(["not-registered"], {
    env: {},
    spawnSync() { spawned = true; },
    err: { write() {} },
  });
  assert.equal(code, 2);
  assert.equal(spawned, false);
});
