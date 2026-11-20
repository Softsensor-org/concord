"use strict";

// COORD-930 — generic provider hook registration.
//
// Engine code is provider-neutral. Which hook events a coding-agent provider runs,
// and the settings file that carries them, live in a per-provider TEMPLATE under
// coord/engine/provider-hook-templates/<provider>.json. This module only validates
// a template and merges its hook registration into that provider's settings object.
// It contains no provider name, no settings path and no event list of its own.
//
// Template shape:
//   { "provider": "<id>", "settingsPath": "<workspace-relative path>",
//     "hooks": { "<EventName>": [ { "matcher"?: "<pattern>", "hooks": [ { "type": "command",
//       "command": "node <workspace-relative engine script>", "description": "..." } ] } ] } }
//
// Commands must be `node <relative path>` with no absolute path and no `..` segment,
// so a registration can never point the hook at a location outside the workspace.

const path = require("node:path");

const COMMAND_PATTERN = /^node (?!\/)[A-Za-z0-9_.\/-]+( [A-Za-z0-9_.=\/-]+)*( 2>\/dev\/null)?(\s*\|\|\s*echo "[^"]*")?$/;
const PARENT_SEGMENT = /(^|[\/\s])\.\.(\/|\s|$)/;

function validateProviderTemplate(template) {
  const problems = [];
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    return ["template must be a JSON object"];
  }
  if (typeof template.provider !== "string" || !/^[a-z][a-z0-9-]*$/.test(template.provider)) {
    problems.push("provider must be a lowercase identifier");
  }
  if (typeof template.settingsPath !== "string" || path.posix.isAbsolute(template.settingsPath) || template.settingsPath.split("/").includes("..")) {
    problems.push("settingsPath must be a workspace-relative path with no '..' segment");
  }
  if (!template.hooks || typeof template.hooks !== "object" || Array.isArray(template.hooks)) {
    problems.push("hooks must be an object keyed by event name");
    return problems;
  }
  for (const [event, groups] of Object.entries(template.hooks)) {
    if (!Array.isArray(groups)) {
      problems.push(`event ${event} must be an array of hook groups`);
      continue;
    }
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        problems.push(`event ${event} has a group without a hooks array`);
        continue;
      }
      for (const hook of group.hooks) {
        if (!hook || hook.type !== "command" || typeof hook.command !== "string") {
          problems.push(`event ${event} has a hook that is not a command`);
          continue;
        }
        if (!COMMAND_PATTERN.test(hook.command) || PARENT_SEGMENT.test(hook.command)) {
          problems.push(`event ${event} command is not a workspace-relative node invocation: ${hook.command}`);
        }
      }
    }
  }
  return problems;
}

// Render the registration that a template contributes. Throws on an invalid
// template, so a broken template can never be installed silently.
function renderProviderRegistration(template) {
  const problems = validateProviderTemplate(template);
  if (problems.length) throw new Error(`invalid provider hook template: ${problems.join("; ")}`);
  return { provider: template.provider, settingsPath: template.settingsPath, hooks: JSON.parse(JSON.stringify(template.hooks)) };
}

// Merge a rendered registration into an existing provider settings object. Only the
// `hooks` key is replaced; every other key (permissions, env, ...) is preserved.
function mergeProviderRegistration(settings, template) {
  const rendered = renderProviderRegistration(template);
  const base = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  return { ...base, hooks: rendered.hooks };
}

module.exports = { validateProviderTemplate, renderProviderRegistration, mergeProviderRegistration };
