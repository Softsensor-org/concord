"use strict";

const fs = require("node:fs");

const MAX_TEXT_INPUT_BYTES = 4 * 1024 * 1024;

function createSafeTextInput(deps = {}) {
  const io = deps.fs || fs;
  const fail = deps.fail || (message => { throw new Error(message); });

  function readUtf8TextFile(filePath, optionName = "input file") {
    const label = String(optionName || "input file");
    if (typeof filePath !== "string" || !filePath.trim()) {
      return fail(`${label} requires a non-empty file path.`);
    }
    const constants = io.constants || {};
    if (
      typeof constants.O_RDONLY !== "number"
      || typeof constants.O_NOFOLLOW !== "number"
      || typeof constants.O_NONBLOCK !== "number"
    ) {
      return fail(`${label} cannot be read safely on this platform: non-blocking regular-file checks are unavailable.`);
    }

    let fd;
    try {
      fd = io.openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      return fail(`${label} could not be opened safely: ${error.message}`);
    }

    try {
      let stat;
      try {
        stat = io.fstatSync(fd);
      } catch (error) {
        return fail(`${label} could not be inspected: ${error.message}`);
      }
      if (!stat.isFile()) {
        // guard:input-path-safety
        return fail(`${label} must be a regular file; directories, symlinks, FIFOs, and devices are refused.`);
      }
      if (stat.size > MAX_TEXT_INPUT_BYTES) {
        return fail(`${label} exceeds the ${MAX_TEXT_INPUT_BYTES}-byte limit.`);
      }

      const chunks = [];
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      try {
        while (true) {
          const remaining = MAX_TEXT_INPUT_BYTES + 1 - total;
          const count = io.readSync(fd, chunk, 0, Math.min(chunk.length, remaining), total);
          if (count === 0) break;
          total += count;
          if (total > MAX_TEXT_INPUT_BYTES) {
            return fail(`${label} exceeds the ${MAX_TEXT_INPUT_BYTES}-byte limit.`);
          }
          chunks.push(Buffer.from(chunk.subarray(0, count)));
        }
      } catch (error) {
        return fail(`${label} could not be read: ${error.message}`);
      }

      const bytes = Buffer.concat(chunks, total);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) {
        return fail(`${label} must contain valid UTF-8 text.`);
      }
      if (!text.trim()) {
        return fail(`${label} must not be empty or whitespace-only.`);
      }
      return text;
    } finally {
      try {
        io.closeSync(fd);
      } catch {
        // A read/validation failure remains the primary error.
      }
    }
  }

  return { readUtf8TextFile };
}

module.exports = { MAX_TEXT_INPUT_BYTES, createSafeTextInput };
