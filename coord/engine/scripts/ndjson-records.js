"use strict";

// COORD-987 (F-11): the one read-only NDJSON journal reader for consumers that
// display, index or export journal events. It skips only blank lines. Every
// other line is returned as { line, record, index, error }:
//   line    the trimmed line text (the bytes event hashes are computed over)
//   record  the parsed JSON value, or undefined when the line did not parse
//   index   the zero-based PHYSICAL line index in the file (blank lines count)
//   error   null for a parsed line, else the SyntaxError from JSON.parse
// A caller decides what a flagged line means. Chain verification in journal.js
// keeps its own strict reader and never uses this module.

const fs = require("fs");

function readNdjsonRecords(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      entries.push({ line, record: JSON.parse(line), index, error: null });
    } catch (error) {
      entries.push({ line, record: undefined, index, error });
    }
  }
  return entries;
}

module.exports = { readNdjsonRecords };
