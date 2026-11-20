"use strict";

function createCommandReference() {
  function isAdvanced(command) {
    return command.maturity !== "stable"
      || command.namespace !== "product"
      || command.role !== "operator";
  }

  function filterCommandMetadata(commands, options = {}) {
    if (!Array.isArray(commands)) throw new TypeError("commands must be an array");
    const filters = ["maturity", "namespace", "role", "safety"]
      .filter((key) => options[key] != null && options[key] !== "")
      .map((key) => [key, String(options[key])]);
    return commands
      .filter((command) => options.includeAdvanced === true || !isAdvanced(command))
      .filter((command) => filters.every(([key, value]) => command[key] === value))
      .map((command) => ({ ...command, advanced: isAdvanced(command) }))
      .sort((a, b) => `${a.namespace}:${a.name}`.localeCompare(`${b.namespace}:${b.name}`));
  }

  function renderCommandReference(commands) {
    const documented = commands.filter((command) => command.maturity !== "planned_surface");
    const lines = [
      "# Concord Command Reference",
      "",
      "Generated from the Concord command registry. Regenerate with `bash coord/scripts/coord commands --all > coord/engine/docs/COMMAND_REFERENCE.md`.",
      "",
      "Role labels are discovery metadata, not authorization: operator covers common project operations, maintainer covers specialized project workflows, and admin covers governance lifecycle operations.",
      "",
    ];
    for (const command of documented) {
      lines.push(`## ${command.namespace}:${command.name}`, "");
      lines.push(`Maturity: ${command.maturity}`);
      lines.push(`Role: ${command.role}`);
      lines.push(`Safety: ${command.safety}`);
      lines.push(`Summary: ${command.summary}`);
      lines.push(`Docs: ${command.docs}`);
      lines.push(`UI palette: ${command.ui_palette ? "yes" : "no"}`);
      lines.push(`Entry point: ${command.entrypoint}`);
      if (command.example) {
        lines.push("", "Example:", "", "```sh", command.example, "```");
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  }

  return { filterCommandMetadata, renderCommandReference };
}

module.exports = { createCommandReference };
