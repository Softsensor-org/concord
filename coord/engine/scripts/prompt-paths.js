"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Prompt-index references use the installed workspace, not its Git root.
function resolvePromptPath(rawPath, options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot || path.join(__dirname, "../../.."));
  const coordDir = path.resolve(options.coordDir || path.join(workspaceRoot, "coord"));
  const cwd = path.resolve(options.cwd || process.cwd());
  const fail = options.fail || (message => { throw new Error(message); });
  let absPath;
  if (rawPath === undefined || rawPath === null) {
    absPath = path.resolve(options.defaultPath || path.join(coordDir, "prompts", "tickets", `${options.ticketId}.md`));
  } else {
    const raw = String(rawPath).trim().replace(/\\/g, "/");
    if (!raw) fail("prompt path cannot be blank.");
    const explicit = path.isAbsolute(raw) || raw.startsWith("./") || raw.startsWith("../");
    const canonical = !explicit && (raw === "coord/prompts" || raw.startsWith("coord/prompts/"));
    if (canonical) {
      absPath = path.resolve(workspaceRoot, raw);
      const within = path.relative(path.join(workspaceRoot, "coord", "prompts"), absPath);
      if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
        fail("Canonical prompt reference escapes coord/prompts; use an explicit ./, ../ or absolute path.");
      }
      const callerPath = path.resolve(cwd, raw);
      if (callerPath !== absPath && fs.existsSync(callerPath)) {
        fail(`Ambiguous prompt reference "${raw}": installed target ${absPath} conflicts with caller target ${callerPath}. Use ./ or an absolute path to select explicitly.`);
      }
    } else {
      absPath = path.resolve(cwd, raw);
    }
  }
  return { absPath, relPath: path.relative(workspaceRoot, absPath).replace(/\\/g, "/") };
}

module.exports = { resolvePromptPath };
