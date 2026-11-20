"use strict";

// COORD-722 test fixture: `gov reconcile --human-admin-override` now refuses
// without `--expect-paths-file <approved packet>`. An isolated fixture plays
// the human administrator, so it approves exactly what `--dry-run` reports
// (the documented inspect -> approve -> bind flow, collapsed). Production code
// never does this: the packet a human approves is a separate reviewed file.

const fs = require("fs");
const os = require("os");
const path = require("path");

const OVERRIDE_IN_COMMAND = /\s--human-admin-override\s+("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/;
let sequence = 0;
let packetDir = null;

function defaultPacketDir() {
  if (!packetDir) {
    packetDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord722-packet-"));
    process.on("exit", () => fs.rmSync(packetDir, { recursive: true, force: true }));
  }
  return packetDir;
}

function writeApprovedPacket(result, dir) {
  const text = String((typeof result === "string" ? result : result?.stdout) || "");
  const report = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (report.requires_expect_paths_file !== true) return null;
  const target = dir || defaultPacketDir();
  sequence += 1;
  const packetFile = path.join(target, `approved-reconcile-${process.pid}-${sequence}.packet`);
  fs.writeFileSync(packetFile, `${report.expect_paths_packet.join("\n")}\n`, "utf8");
  return packetFile;
}

// `args` are reconcile CLI args (an array, with or without the leading
// "reconcile", or one shell command string); `run(args)` executes the same
// shape and returns its stdout (or an object carrying `stdout`).
function withApprovedPacket(args, run, dir = null) {
  if (typeof args === "string") {
    if (!OVERRIDE_IN_COMMAND.test(args) || args.includes("--expect-paths-file")) return args;
    const packetFile = writeApprovedPacket(run(`${args.replace(OVERRIDE_IN_COMMAND, "")} --dry-run`), dir);
    return packetFile ? `${args} --expect-paths-file ${JSON.stringify(packetFile)}` : args;
  }
  const at = args.indexOf("--human-admin-override");
  if (at < 0 || args.includes("--expect-paths-file")) return args;
  const dryArgs = args.filter((_, index) => index !== at && index !== at + 1).concat("--dry-run");
  const packetFile = writeApprovedPacket(run(dryArgs), dir);
  return packetFile ? [...args, "--expect-paths-file", packetFile] : args;
}

module.exports = { withApprovedPacket };
