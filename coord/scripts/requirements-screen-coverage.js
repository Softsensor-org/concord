#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function allScreens(screenIndex) {
  const screens = [];
  for (const app of screenIndex.apps || []) {
    for (const screen of app.screens || []) {
      screens.push({
        app: app.app || null,
        framework: app.framework || null,
        id: screen.id,
        route: screen.route || null,
        title: screen.title || "",
        source: screen.source || "",
        requirement_refs: screen.requirement_refs || [],
      });
    }
  }
  return screens.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function registryAnchors(registry) {
  return (registry.requirements || [])
    .map((req) => ({
      requirement_id: String(req.id || "").toUpperCase(),
      anchor: req.source && req.source.anchor ? String(req.source.anchor) : null,
      title: req.title || "",
    }))
    .filter((item) => item.anchor)
    .sort((a, b) => a.anchor.localeCompare(b.anchor));
}

function analyzeScreenCoverage(screenIndex, registry = {}, options = {}) {
  const screens = allScreens(screenIndex);
  const anchors = registryAnchors(registry);
  const refs = [];
  for (const screen of screens) {
    for (const ref of screen.requirement_refs || []) {
      refs.push({
        screen_id: screen.id,
        route: screen.route,
        doc: ref.doc || null,
        anchor: ref.anchor || null,
        confidence: ref.confidence || "inferred",
      });
    }
  }
  const linkedAnchors = new Set(refs.map((ref) => ref.anchor).filter(Boolean));
  const requirementAnchors = anchors.length
    ? anchors.map((item) => item.anchor)
    : ((screenIndex.requirements && screenIndex.requirements.headings) || []).map((heading) => heading.anchor).filter(Boolean);
  const requirementsWithoutScreen = Array.from(new Set(requirementAnchors.filter((anchor) => !linkedAnchors.has(anchor)))).sort();
  const screensWithoutRequirement = screens
    .filter((screen) => !screen.requirement_refs || screen.requirement_refs.length === 0)
    .map((screen) => ({ screen_id: screen.id, route: screen.route, title: screen.title, source: screen.source }));
  const inferredLinksNeedingConfirmation = refs
    .filter((ref) => ref.confidence !== "explicit")
    .sort((a, b) => `${a.anchor}:${a.screen_id}`.localeCompare(`${b.anchor}:${b.screen_id}`));

  return {
    kind: "concord.requirements.screen_coverage",
    schema_version: 1,
    generated_at_utc: options.generatedAtUtc || "1970-01-01T00:00:00.000Z",
    source: {
      screen_index: options.screenIndexPath || "coord/.runtime/screen-index.json",
      registry: options.registryPath || null,
    },
    requirements_without_screen: requirementsWithoutScreen,
    screens_without_requirement: screensWithoutRequirement,
    inferred_links_needing_confirmation: inferredLinksNeedingConfirmation,
    explicit_links: refs.filter((ref) => ref.confidence === "explicit"),
    summary: {
      screens: screens.length,
      linked_screens: screens.filter((screen) => (screen.requirement_refs || []).length > 0).length,
      requirement_anchors: requirementAnchors.length,
      requirements_without_screen: requirementsWithoutScreen.length,
      screens_without_requirement: screensWithoutRequirement.length,
      inferred_links_needing_confirmation: inferredLinksNeedingConfirmation.length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Requirements Screen Coverage");
  lines.push("");
  lines.push(`Screens: ${report.summary.screens}`);
  lines.push(`Linked screens: ${report.summary.linked_screens}`);
  lines.push(`Requirement anchors: ${report.summary.requirement_anchors}`);
  lines.push(`Requirements without screen: ${report.summary.requirements_without_screen}`);
  lines.push(`Screens without requirement: ${report.summary.screens_without_requirement}`);
  lines.push(`Inferred links needing confirmation: ${report.summary.inferred_links_needing_confirmation}`);
  lines.push("");
  lines.push("## Requirements Without Screen");
  if (report.requirements_without_screen.length === 0) lines.push("None.");
  for (const anchor of report.requirements_without_screen) lines.push(`- ${anchor}`);
  lines.push("");
  lines.push("## Screens Without Requirement");
  if (report.screens_without_requirement.length === 0) lines.push("None.");
  for (const screen of report.screens_without_requirement) lines.push(`- ${screen.screen_id}: ${screen.route || screen.source}`);
  lines.push("");
  lines.push("## Inferred Links Needing Confirmation");
  if (report.inferred_links_needing_confirmation.length === 0) lines.push("None.");
  for (const ref of report.inferred_links_needing_confirmation) lines.push(`- ${ref.screen_id} -> ${ref.anchor}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: process.cwd(),
    screenIndex: "coord/.runtime/screen-index.json",
    registry: null,
    output: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true, options };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--screen-index") {
      options.screenIndex = argv[++i];
      if (!options.screenIndex) return { error: "--screen-index requires a path" };
      continue;
    }
    if (["--dir", "--registry", "--output"].includes(arg)) {
      const key = arg.slice(2);
      options[key] = argv[++i];
      if (!options[key]) return { error: `${arg} requires a value` };
      continue;
    }
    return { error: `Unexpected argument: ${arg}` };
  }
  return { options };
}

function run(argv = [], deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log || ((line) => console.log(line));
  if (parsed.error) {
    log(`requirements-screen-coverage: ${parsed.error}`);
    return { code: 1 };
  }
  if (parsed.help) {
    log("Usage: requirements-screen-coverage [--dir <root>] [--screen-index <path>] [--registry <path>] [--output <path>] [--json]");
    return { code: 0 };
  }
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  const root = path.resolve(cwd, parsed.options.dir);
  const screenIndexPath = path.resolve(root, parsed.options.screenIndex);
  if (!fsImpl.existsSync(screenIndexPath)) {
    log(`requirements-screen-coverage: screen index not found: ${parsed.options.screenIndex}`);
    return { code: 1 };
  }
  let screenIndex;
  try {
    screenIndex = JSON.parse(fsImpl.readFileSync(screenIndexPath, "utf8"));
  } catch (err) {
    log(`requirements-screen-coverage: malformed JSON in screen index ${parsed.options.screenIndex}: ${err.message}`);
    return { code: 1 };
  }
  const registryPath = parsed.options.registry ? path.resolve(root, parsed.options.registry) : null;
  let registry = {};
  if (registryPath && fsImpl.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fsImpl.readFileSync(registryPath, "utf8"));
    } catch (err) {
      log(`requirements-screen-coverage: malformed JSON in registry ${parsed.options.registry}: ${err.message}`);
      return { code: 1 };
    }
  }
  const report = analyzeScreenCoverage(screenIndex, registry, {
    screenIndexPath: parsed.options.screenIndex,
    registryPath: parsed.options.registry,
  });
  const body = parsed.options.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (parsed.options.output) {
    const outputPath = path.resolve(root, parsed.options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${body}\n`);
  } else {
    log(body);
  }
  return { code: 0, report };
}

module.exports = {
  analyzeScreenCoverage,
  renderMarkdown,
  run,
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.exit(result && typeof result.code === "number" ? result.code : 0);
}
