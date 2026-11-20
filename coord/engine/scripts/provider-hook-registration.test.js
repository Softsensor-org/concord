"use strict";

// COORD-930 — install tests for provider hook registration.
//
// Each provider template under coord/engine/provider-hook-templates is an install
// surface: its rendered registration must be exactly what the workspace's provider
// settings file carries, and merging it must not disturb the rest of that file.
// The engine code under test contains no provider name (asserted below).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  validateProviderTemplate,
  renderProviderRegistration,
  mergeProviderRegistration,
} = require("./provider-hook-registration.js");

const WORKSPACE = path.resolve(__dirname, "..", "..", "..");
const TEMPLATES = path.resolve(__dirname, "..", "provider-hook-templates");

function loadTemplates() {
  return fs
    .readdirSync(TEMPLATES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, template: JSON.parse(fs.readFileSync(path.join(TEMPLATES, name), "utf8")) }));
}

test("every shipped provider template is valid and renders", () => {
  const templates = loadTemplates();
  assert.ok(templates.length >= 1, "at least one provider template ships");
  for (const { name, template } of templates) {
    assert.deepEqual(validateProviderTemplate(template), [], `${name} must validate`);
    const rendered = renderProviderRegistration(template);
    assert.equal(rendered.provider, template.provider);
    assert.equal(rendered.settingsPath, template.settingsPath);
  }
});

test("install test per provider: the workspace settings carry exactly the rendered registration", () => {
  for (const { name, template } of loadTemplates()) {
    const settingsFile = path.join(WORKSPACE, template.settingsPath);
    assert.ok(fs.existsSync(settingsFile), `${name}: ${template.settingsPath} must exist in the workspace`);
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const rendered = renderProviderRegistration(template);
    assert.deepEqual(settings.hooks, rendered.hooks, `${name}: installed hooks must equal the rendered template`);
  }
});

test("install preserves every non-hook key of the provider settings file", () => {
  for (const { name, template } of loadTemplates()) {
    const settings = JSON.parse(fs.readFileSync(path.join(WORKSPACE, template.settingsPath), "utf8"));
    const merged = mergeProviderRegistration(settings, template);
    for (const key of Object.keys(settings)) {
      if (key === "hooks") continue;
      assert.deepEqual(merged[key], settings[key], `${name}: ${key} must be preserved`);
    }
    assert.deepEqual(merged.hooks, renderProviderRegistration(template).hooks);
  }
});

test("a registration may only point at a workspace-relative node engine script", () => {
  const base = { provider: "example", settingsPath: "cfg/settings.json" };
  const hook = (command) => ({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } });
  assert.deepEqual(validateProviderTemplate({ ...base, ...hook("node coord/engine/scripts/hooks/pre-bash-guard.js") }), []);
  assert.deepEqual(validateProviderTemplate({ ...base, ...hook("node coord/scripts/governance.js code-index --git 2>/dev/null || echo \"advisory\"") }), []);
  for (const bad of [
    "node /usr/local/bin/guard.js",
    "node ../../outside/guard.js",
    "node coord/../../outside.js",
    "sh -c 'node coord/x.js'",
    "node coord/x.js; rm -rf /",
  ]) {
    const problems = validateProviderTemplate({ ...base, ...hook(bad) });
    assert.ok(problems.length > 0, `must refuse: ${bad}`);
    assert.throws(() => renderProviderRegistration({ ...base, ...hook(bad) }), /invalid provider hook template/);
  }
});

test("a template with a bad provider id or an escaping settings path is refused", () => {
  const hooks = { PreToolUse: [] };
  assert.ok(validateProviderTemplate({ provider: "Bad Name", settingsPath: "s.json", hooks }).length > 0);
  assert.ok(validateProviderTemplate({ provider: "ok", settingsPath: "/etc/settings.json", hooks }).length > 0);
  assert.ok(validateProviderTemplate({ provider: "ok", settingsPath: "../settings.json", hooks }).length > 0);
  assert.deepEqual(validateProviderTemplate({ provider: "ok", settingsPath: "s.json", hooks }), []);
});

test("the registration engine code names no agent provider", () => {
  const source = fs.readFileSync(path.join(__dirname, "provider-hook-registration.js"), "utf8");
  assert.doesNotMatch(source, /claude|codex|gemini|grok|anthropic|openai/i, "provider specifics belong in templates, not engine code");
});

test("COORD-1052: malformed hook templates refuse installation without changing existing settings", () => {
  const valid = { provider: "fixture", settingsPath: ".fixture/settings.json", hooks: { Before: [{ hooks: [{ type: "command", command: "node coord/hooks/check.js" }] }] } };
  const settings = { permissions: { allow: ["read"] }, hooks: { Existing: [{ preserved: true }] } };
  const before = JSON.stringify(settings);
  const cases = [
    [null, /JSON object/], [[], /JSON object/],
    [{ ...valid, hooks: [] }, /hooks must be an object/],
    [{ ...valid, hooks: { Before: {} } }, /must be an array of hook groups/],
    [{ ...valid, hooks: { Before: [null] } }, /group without a hooks array/],
    [{ ...valid, hooks: { Before: [{ hooks: [null] }] } }, /not a command/],
    [{ ...valid, hooks: { Before: [{ hooks: [{ type: "command", command: "node ../outside.js" }] }] } }, /not a workspace-relative node invocation/],
  ];
  for (const [template, expected] of cases) {
    assert.match(validateProviderTemplate(template).join("; "), expected);
    assert.throws(() => mergeProviderRegistration(settings, template), expected);
    assert.equal(JSON.stringify(settings), before);
  }
  const rendered = mergeProviderRegistration(null, valid);
  assert.deepEqual(rendered, { hooks: valid.hooks });
  rendered.hooks.Before[0].hooks[0].command = "node changed.js";
  assert.equal(valid.hooks.Before[0].hooks[0].command, "node coord/hooks/check.js", "rendered registration owns its hook objects");
});
