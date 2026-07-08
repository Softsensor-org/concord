#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const options = { input: null, output: null, issueBucket: "", source: "search-console" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") options.input = argv[++i];
    else if (arg.startsWith("--input=")) options.input = arg.slice("--input=".length);
    else if (arg === "--output") options.output = argv[++i];
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
    else if (arg === "--issue-bucket") options.issueBucket = argv[++i];
    else if (arg.startsWith("--issue-bucket=")) options.issueBucket = arg.slice("--issue-bucket=".length);
    else if (arg === "--source") options.source = argv[++i];
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length);
  }
  return options;
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function csvEscape(value) {
  const text = String(value == null ? "" : value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function findUrl(row) {
  return row.url || row.page || row.page_url || row.landing_page || row.address || "";
}

function normalizeExport(inputText, options = {}) {
  const lines = inputText.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { rows: [], csv: "source,issue_bucket,url,canonical_url,status,raw_status,notes\n" };
  const headers = splitCsvLine(lines[0]).map(normalizeHeader);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((header, idx) => { row[header] = cells[idx] || ""; });
    const url = findUrl(row);
    if (!url) continue;
    rows.push({
      source: options.source || "search-console",
      issue_bucket: options.issueBucket || row.issue || row.reason || row.status || "",
      url,
      canonical_url: row.canonical_url || row.user_declared_canonical || row.google_selected_canonical || "",
      status: "new",
      raw_status: row.status || row.reason || row.validation || "",
      notes: "",
    });
  }
  const header = ["source", "issue_bucket", "url", "canonical_url", "status", "raw_status", "notes"];
  const csv = `${header.join(",")}\n${rows.map((row) => header.map((key) => csvEscape(row[key])).join(",")).join("\n")}${rows.length ? "\n" : ""}`;
  return { rows, csv };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.input || !options.output) {
    process.stderr.write("Usage: normalize-search-console-export --input <csv> --output <csv> [--issue-bucket <name>] [--source <name>]\n");
    return 2;
  }
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const result = normalizeExport(fs.readFileSync(inputPath, "utf8"), options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, result.csv);
  process.stdout.write(`normalized ${result.rows.length} URL rows -> ${outputPath}\n`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { normalizeExport, parseArgs };
