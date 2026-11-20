"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verbs } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/cli-surface.js"));

function commands(text) {
  const code = [], prose = [];
  let fence = null, fenced = [];
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) { fence = marker[1]; fenced = []; continue; }
    if (marker && marker[1][0] === fence?.[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      code.push(fenced.join("\n")); fence = null; continue;
    }
    if (fence) fenced.push(line);
    else prose.push(line);
  }
  if (fence) code.push(fenced.join("\n"));
  // Multiline inline code and escaped backticks in quoted diagnostic examples
  // remain code. Ordinary prose such as "gov reads the board" is not a command.
  for (const match of prose.join("\n").matchAll(/(?<!\\)(`+)([\s\S]*?)(?<!\\)\1/g)) code.push(match[2]);
  return code.flatMap(block => [...block.replace(/\\\r?\n/g, " ").matchAll(/\bgov\s+([a-z][a-z0-9-]*)\b/g)].map(m => m[1]));
}

function markdownFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = path.join(root, entry.name);
      return entry.isDirectory() ? markdownFiles(file) : entry.isFile() && file.endsWith(".md") ? [file] : [];
    });
}

test("documented governance commands resolve against the generated live surface", () => {
  const known = new Set(verbs());
  const files = markdownFiles(path.join(__dirname, "../docs"));
  assert.ok(files.length > 10, "the actual documentation corpus must be present");
  const unknown = [];
  let count = 0;
  for (const file of files) for (const verb of commands(fs.readFileSync(file, "utf8"))) {
    count++;
    if (!known.has(verb)) unknown.push(`${path.relative(path.join(__dirname, ".."), file)}: gov ${verb}`);
  }
  assert.ok(count > 20, "command extraction must exercise the real corpus");
  assert.deepEqual(unknown, [], "documented commands must exist in gov surface");
});

test("command scan covers short, path-qualified, multiline and fenced examples without treating prose as commands", () => {
  const fixture = "gov reads state. A gov verb is documented below.\n" +
    "`gov claim X` and `coord/scripts/gov recover X`\n" +
    "`gov\n nonexistent-inline X`\n" +
    "```sh\ngov nonexistent-fenced X\ngov \\\nnonexistent-continued X\n```\n" +
    "~~~bash\ncoord/scripts/gov nonexistent-tilde X\n~~~\n" +
    "`Diagnostic: \\`gov nonexistent-nested X\\` is unavailable.`\n";
  assert.deepEqual(commands(fixture), ["nonexistent-fenced", "nonexistent-continued", "nonexistent-tilde", "claim", "recover",
    "nonexistent-inline", "nonexistent-nested"]);
});
