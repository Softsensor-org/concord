"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function splitFileArgs(value) {
  return toArray(value)
    .flatMap((entry) => String(entry || "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function planFiles(ticketId, root = ROOT) {
  const plan = readJson(path.join(root, "coord", ".runtime", "plans", `${ticketId}.json`), {});
  return [
    ...toArray(plan.intended_files),
    ...toArray(plan.gate_plan?.declared_files),
    ...toArray(plan.gate_plan?.changed_files),
  ].map((entry) => String(entry || "").trim()).filter(Boolean);
}

function classifyPublishability(files = []) {
  const normalized = files.map((file) => file.replace(/\\/g, "/"));
  const canonical = normalized.some((file) => /^coord\/(board|product|docs|prompts|scripts|GOVERNANCE|AGENTS|VERB_CONTRACT|DIRECTORY)/.test(file));
  const docs = normalized.some((file) => /(^|\/)(README|QUICKSTART|CHANGELOG|.*\.md)$/.test(file));
  const release = normalized.some((file) => /^release\//.test(file));
  const engine = normalized.some((file) => /^coord\/scripts\//.test(file));
  const needs = canonical || docs || release || engine;
  return {
    needs_publishability: needs,
    reasons: [
      canonical ? "canonical coord surface" : null,
      docs ? "docs surface" : null,
      release ? "release surface" : null,
      engine ? "engine script surface" : null,
    ].filter(Boolean),
    commands: needs
      ? [
        "coord/scripts/check-template-sync.sh",
        "node coord/scripts/arch-checks.js --prodloc",
        "release/scan-donor-refs.sh .",
        "release/scan-secrets.sh .",
        release || docs ? "release/verify-dual-release.sh" : null,
      ].filter(Boolean)
      : ["No publishability gate required from declared files."],
  };
}

function buildPublishabilityReport(input = {}) {
  const ticketId = input.ticketId;
  if (!ticketId) throw new Error("publishability-check requires a ticket id");
  const files = input.files && input.files.length ? input.files : planFiles(ticketId, input.root);
  const classification = classifyPublishability(files);
  return {
    kind: "concord.publishability_check",
    schema_version: 1,
    ticket_id: ticketId,
    files,
    ...classification,
  };
}

function renderPublishability(report) {
  const lines = [
    "# Publishability Check",
    "",
    `Ticket: ${report.ticket_id}`,
    `Required: ${report.needs_publishability ? "yes" : "no"}`,
    "",
    "## Reasons",
    ...(report.reasons.length ? report.reasons.map((r) => `- ${r}`) : ["- none"]),
    "",
    "## Commands",
    ...report.commands.map((cmd) => `- \`${cmd}\``),
  ];
  return `${lines.join("\n")}\n`;
}

function publishabilityCheckCommand(ticketId, options = {}) {
  const report = buildPublishabilityReport({
    ticketId,
    root: options.root,
    files: splitFileArgs(options.files),
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(renderPublishability(report));
  }
  return report;
}

module.exports = {
  buildPublishabilityReport,
  classifyPublishability,
  publishabilityCheckCommand,
  renderPublishability,
  splitFileArgs,
};
