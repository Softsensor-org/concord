"use strict";

// COORD-955: extends the COORD-007 doc/engine parity check (verb-parity.js) from
// verbs to documented flags and to every operator-facing document. Every
// assertion asks the live engine (cli.js parseFlags, the test-policy and
// selection argv parsers, cli-surface verbs, the coord registry, the integration
// USAGE, the help builder) rather than grepping source. Reviewed exceptions live
// in verb-flag-parity-allowlist.json; each entry carries a reason and a ticket or
// QUESTIONS.md reference, and the last test fails any entry that is stale.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const parity = require("./verb-parity.js");
const cli = require("./cli.js");
const { verbs: governVerbs } = require("./cli-surface.js");
const { buildRegistry } = require("./coord-cli.js");
const { USAGE: INTEGRATION_USAGE } = require("./integration-commands.js");
const { parseArgs: parseTestPolicyArgs } = require("./test-policy-run.js");
const { parseSelectionArgs } = require("./affected-state.js");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const ALLOWLIST = JSON.parse(fs.readFileSync(path.join(__dirname, "verb-flag-parity-allowlist.json"), "utf8"));
// Only a recognized built cut activates donor-source cross-reference exceptions.
// A donor checkout keeps checking those exact source files normally.
const provenancePath = path.join(ROOT, "coord/RELEASE_PROVENANCE.json");
const CUT_EDITION = !require("./test-runner.js").isDonorWorkspace(ROOT, path.join(ROOT, "coord")) && fs.existsSync(provenancePath)
  ? JSON.parse(fs.readFileSync(provenancePath, "utf8")).cut : null;
function pathExceptionApplies(entry, edition = CUT_EDITION) {
  return !entry.cut_editions || entry.cut_editions.includes(edition);
}
function allowedPath(token, docPath, edition = CUT_EDITION) {
  return findEntry(ALLOWLIST.paths, (entry) => pathExceptionApplies(entry, edition) &&
    (entry.path === token || (entry.pattern && new RegExp(entry.pattern).test(token))) &&
    (!entry.docs || entry.docs.includes(docPath)));
}
const { parseFlags } = cli.__testing;
const GOVERN_VERBS = governVerbs();

// Verbs whose argv is parsed by their own module. Each seam is the module's own
// exported parser, so a flag is checked against the parser that really owns it.
// sign-journal (COORD-972) takes its subcommand first; the probe supplies a
// placeholder subcommand so the parser sees the flag under test.
const OWN_PARSERS = Object.freeze({
  "test-policy": parseTestPolicyArgs,
  selection: parseSelectionArgs,
  "sign-journal": (argv) => cli.__testing.parseSignJournalArgs(["sign", ...argv]),
});
const NO_SEAM = new Set((ALLOWLIST.verbsWithoutDrySeam || []).map((entry) => entry.verb));

function parserFor(verb) {
  if (NO_SEAM.has(verb)) return null;
  return OWN_PARSERS[verb] || parseFlags;
}

function readDoc(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function operatorDocs() {
  return parity.operatorDocSources(ROOT)
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    .map((rel) => ({ path: rel, text: readDoc(rel) }));
}

function findEntry(list, predicate) {
  return (list || []).find(predicate);
}

function requireReason(entry, label) {
  assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 20, `${label}: allowlist entry needs a reviewed reason`);
  assert.ok(typeof entry.ref === "string" && entry.ref.trim().length > 0, `${label}: allowlist entry needs a ticket or QUESTIONS.md reference`);
}

function resolvesRepoPath(token, docPath) {
  const candidates = [ROOT, path.join(ROOT, "coord"), path.join(ROOT, path.dirname(docPath))];
  return candidates.some((base) => fs.existsSync(path.join(base, token)));
}

// --- 1. source set -------------------------------------------------------

test("COORD-955: the operator-doc source set is complete and every source exists", () => {
  const missing = parity.OPERATOR_DOC_PATHS.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  assert.deepEqual(missing, [], `operator-facing docs missing from the parity source set: ${missing.join(", ")}`);
  const engineDocs = parity.operatorDocSources(ROOT).filter((rel) => rel.startsWith("coord/engine/docs/"));
  assert.ok(engineDocs.length >= 10, `expected coord/engine/docs/*.md in the source set; got ${engineDocs.length}`);
});

// --- 2. verbs and flags (live parsers) -----------------------------------

test("COORD-955: every documented gov invocation dispatches and every documented flag is accepted by the parser that owns its verb", () => {
  const report = parity.runVerbFlagParityCheck({ docs: operatorDocs(), verbs: GOVERN_VERBS, parserFor });
  assert.ok(report.invocationCount >= 40, `documented gov invocation extraction looks empty: ${report.invocationCount}`);
  const unknownVerbs = report.unknownVerbs.filter((f) =>
    !findEntry(ALLOWLIST.verbs, (e) => e.verb === f.verb && e.docs.includes(f.doc)));
  const unaccepted = report.unacceptedFlags.filter((f) =>
    !findEntry(ALLOWLIST.flags, (e) => e.flag === f.flag && (!e.verb || e.verb === f.verb) && e.docs.includes(f.doc)));
  assert.deepEqual(unknownVerbs.map((f) => `${f.doc}: gov ${f.verb}`), [],
    "documented gov verbs with no dispatch handler (fix the doc, or allowlist with a reason)");
  assert.deepEqual(unaccepted.map((f) => `${f.doc}: gov ${f.verb} ${f.flag}`), [],
    "documented flags the owning parser refuses as unknown (fix the doc, or allowlist with a reason)");
});

test("COORD-955: documented coord product-CLI verbs and node script paths resolve", () => {
  const coordVerbs = new Set([...Object.keys(buildRegistry()), "help"]);
  const problems = [];
  for (const doc of operatorDocs()) {
    for (const segment of parity.documentedCodeSegments(doc.text)) {
      for (const line of segment.split("\n")) {
        const match = /^\s*(?:\$\s+)?coord\s+([a-z][a-z0-9-]*)\b/.exec(line);
        if (match && !coordVerbs.has(match[1]) && !findEntry(ALLOWLIST.coordVerbs, (e) => e.verb === match[1] && e.docs.includes(doc.path))) {
          problems.push(`${doc.path}: coord ${match[1]}`);
        }
      }
    }
    for (const script of parity.documentedNodeScripts(doc.text)) {
      if (!resolvesRepoPath(script, doc.path)) problems.push(`${doc.path}: node ${script}`);
    }
  }
  assert.deepEqual(problems, [], "documented coord verbs or node scripts that do not exist");
});

// --- 3. repo paths ---------------------------------------------------------

test("COORD-955: every backticked repo path in operator docs resolves or is allowlisted with a reason", () => {
  const unresolved = [];
  for (const doc of operatorDocs()) {
    for (const token of parity.documentedBacktickPaths(doc.text)) {
      if (resolvesRepoPath(token, doc.path)) continue;
      const allowed = allowedPath(token, doc.path);
      if (allowed) continue;
      unresolved.push(`${doc.path}: \`${token}\``);
    }
  }
  assert.deepEqual(unresolved, [],
    "backticked repo paths that do not resolve (fix the doc, or allowlist an install-time or runtime-generated path with a reason)");
});

// --- 4. recovery terms -----------------------------------------------------

const RECOVERY_HEADING = /recover|repair|lock|owner|ownership|integration authority/i;

function recoverySectionText(text) {
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (/^#{2,4} /.test(line)) {
      current = { heading: line, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections.filter((s) => RECOVERY_HEADING.test(s.heading)).map((s) => s.body.join("\n")).join("\n");
}

// Recovery flags operators copy from recovery text. Wherever an operator doc names
// one (recovery section or not), the live parser must accept it or it needs a
// reviewed entry.
const RECOVERY_FLAGS = Object.freeze(["--human-admin-override", "--snapshot-restore"]);

test("COORD-955: named recovery verbs, flags and terms in operator-doc recovery sections are checked with or without the gov prefix", () => {
  const failures = [];
  let sectionsChecked = 0;
  for (const doc of operatorDocs()) {
    const text = recoverySectionText(doc.text);
    if (text) sectionsChecked++;
    for (const verb of ["recover", "lock-abandon", "break-runtime-lock"]) {
      if (new RegExp(`\\b${verb}\\b`).test(text) && !GOVERN_VERBS.includes(verb)) failures.push(`${doc.path}: recovery verb ${verb} is not dispatched`);
    }
    if (/\bintegration recover\b/.test(text) && !/\brecover\b/.test(INTEGRATION_USAGE)) failures.push(`${doc.path}: integration recover is named but missing from integration USAGE`);
    for (const flag of RECOVERY_FLAGS) {
      if (!doc.text.includes(flag)) continue;
      const parsers = [parseFlags, ...Object.values(OWN_PARSERS)];
      if (parsers.some((parse) => parity.flagAcceptedByParser(parse, flag))) continue;
      if (!findEntry(ALLOWLIST.flags, (e) => e.flag === flag && e.docs.includes(doc.path))) {
        failures.push(`${doc.path}: recovery text names ${flag}, which no live parser accepts (fix the doc, or allowlist with a reason)`);
      }
    }
    if (/\btakeover\b/.test(text) && !findEntry(ALLOWLIST.terms, (e) => e.term === "takeover" && e.docs.includes(doc.path))) {
      failures.push(`${doc.path}: bare takeover in a recovery section (no such verb; name the real path or allowlist with a reason)`);
    }
  }
  assert.ok(sectionsChecked >= 2, `expected recovery sections in operator docs; checked ${sectionsChecked}`);
  assert.deepEqual(failures, []);

  // takeover is not a verb. It must not be written as a command in any operator doc.
  assert.equal(GOVERN_VERBS.includes("takeover"), false, "takeover must not be a dispatched verb");
  const isTakeoverCommand = (segment) => /^\s*(?:gov\s+)?takeover(?:\s|$)/.test(segment) || /\bgov\s+takeover\b/.test(segment);
  const backticked = operatorDocs()
    .filter((doc) => parity.documentedCodeSegments(doc.text).some(isTakeoverCommand))
    .map((d) => d.path);
  assert.deepEqual(backticked, [], "takeover written as a command in backticks (no such verb; use claim --transfer-to or integration handoff)");
});

// --- 5. configuration-driven help ------------------------------------------

test("COORD-955: test-policy help text states the value of operating_mode.landing_gates in test-policy.json", () => {
  const config = JSON.parse(readDoc("coord/engine/test-policy.json"));
  const value = config.operating_mode.landing_gates;
  assert.ok(["active", "unchanged"].includes(value), `unexpected landing_gates value ${value}`);
  const helpLine = cli.__testing.buildHelpText({ all: true }).split("\n").find((line) => line.includes('"test-policy" (COORD-936)'));
  assert.ok(helpLine, "test-policy help line must exist");
  assert.ok(helpLine.includes(`operating_mode.landing_gates is ${value}`),
    `test-policy help must state operating_mode.landing_gates is ${value} (from coord/engine/test-policy.json)`);
  if (value === "active") {
    assert.doesNotMatch(helpLine, /changes no landing gate/, "help still calls the policy non-gating while landing gates are active");
  }
});

// --- 6. allowlist review ---------------------------------------------------

test("COORD-955: every allowlist entry is reviewed and still describes a live divergence (stale entries fail)", () => {
  const stale = [];
  for (const entry of ALLOWLIST.flags) {
    requireReason(entry, `flag ${entry.flag}`);
    const parse = entry.verb ? parserFor(entry.verb) : parseFlags;
    if (parse && parity.flagAcceptedByParser(parse, entry.flag)) stale.push(`flag ${entry.flag} is now accepted by its parser`);
    for (const doc of entry.docs) if (!readDoc(doc).includes(entry.flag)) stale.push(`flag ${entry.flag} no longer appears in ${doc}`);
  }
  for (const entry of ALLOWLIST.verbs) {
    requireReason(entry, `verb ${entry.verb}`);
    if (GOVERN_VERBS.includes(entry.verb)) stale.push(`verb ${entry.verb} is now dispatched`);
    for (const doc of entry.docs) if (!readDoc(doc).includes(entry.verb)) stale.push(`verb ${entry.verb} no longer appears in ${doc}`);
  }
  const coordVerbs = new Set([...Object.keys(buildRegistry()), "help"]);
  for (const entry of ALLOWLIST.coordVerbs) {
    requireReason(entry, `coord verb ${entry.verb}`);
    if (coordVerbs.has(entry.verb)) stale.push(`coord verb ${entry.verb} is now a product-CLI verb`);
    for (const doc of entry.docs) if (!readDoc(doc).includes(`coord ${entry.verb}`)) stale.push(`coord ${entry.verb} no longer appears in ${doc}`);
  }
  for (const entry of ALLOWLIST.paths) {
    requireReason(entry, `path ${entry.path || entry.pattern}`);
    const docs = entry.docs ? entry.docs.map((d) => ({ path: d, text: readDoc(d) })) : operatorDocs();
    const tokens = docs.flatMap((d) => parity.documentedBacktickPaths(d.text));
    if (entry.path) {
      if (entry.cut_editions) {
        assert.deepEqual(entry.cut_editions, ["Community", "Enterprise"], "cut exceptions must name reviewed editions exactly");
        assert.ok(entry.docs?.length, "cut exceptions must name exact documents");
        assert.equal(entry.pattern, undefined, "donor-source cut exceptions cannot be broad patterns");
      }
      if (pathExceptionApplies(entry)) {
        if (resolvesRepoPath(entry.path, docs[0].path)) stale.push(`path ${entry.path} now resolves`);
      } else if (!resolvesRepoPath(entry.path, docs[0].path)) {
        stale.push(`donor source reference ${entry.path} no longer resolves outside its reviewed cut editions`);
      }
      if (!tokens.includes(entry.path)) stale.push(`path ${entry.path} no longer appears in ${docs.map((d) => d.path).join(", ")}`);
    } else {
      const re = new RegExp(entry.pattern);
      const matches = tokens.filter((t) => re.test(t));
      // Pattern entries cover runtime and installer paths whose existence depends on
      // the workspace, so only the pattern's relevance to the docs is checked.
      if (matches.length === 0) stale.push(`pattern ${entry.pattern} matches no documented path any more`);
    }
  }
  for (const entry of ALLOWLIST.terms) {
    requireReason(entry, `term ${entry.term}`);
    for (const doc of entry.docs) if (!readDoc(doc).includes(entry.term)) stale.push(`term ${entry.term} no longer appears in ${doc}`);
  }
  for (const entry of ALLOWLIST.verbsWithoutDrySeam) {
    requireReason(entry, `verb ${entry.verb} without a dry seam`);
    if (!GOVERN_VERBS.includes(entry.verb)) stale.push(`verb ${entry.verb} is no longer dispatched`);
    if (OWN_PARSERS[entry.verb]) stale.push(`verb ${entry.verb} now has an exported dry seam; drop the exception`);
  }
  assert.deepEqual(stale, [], "stale allowlist entries: remove them or re-review");
});

// --- 7. positive control: the catcher fires on synthetic divergence ---------

test("COORD-955: the parity catcher fires on a synthetic doc with an unknown verb, unknown flag and missing path", () => {
  const fixture = {
    path: "fixture.md",
    text: "`gov recover X --snapshot-restore`\n`gov not-a-verb X`\n`coord/scripts/no-such-file.js`\n`gov test-policy resolve --stage pr`\n",
  };
  // An edition-specific donor cross-reference must not hide a missing installed
  // engine file, an unrelated document, or a broken source checkout reference.
  assert.ok(allowedPath("release/check-public-release.sh", "README.md", "Community"));
  assert.equal(allowedPath("release/check-public-release.sh", "README.md", null), undefined);
  assert.equal(allowedPath("release/check-public-release.sh", "unreviewed.md", "Community"), undefined);
  assert.equal(allowedPath("coord/engine/scripts/missing.js", "README.md", "Community"), undefined);
  const report = parity.runVerbFlagParityCheck({ docs: [fixture], verbs: GOVERN_VERBS, parserFor });
  assert.deepEqual(report.unacceptedFlags, [{ doc: "fixture.md", verb: "recover", flag: "--snapshot-restore" }]);
  assert.deepEqual(report.unknownVerbs, [{ doc: "fixture.md", verb: "not-a-verb" }]);
  assert.deepEqual(parity.documentedBacktickPaths(fixture.text), ["coord/scripts/no-such-file.js"]);
  // A documented test-policy flag is accepted by its own parser, not the shared table.
  assert.equal(parity.flagAcceptedByParser(parserFor("test-policy"), "--stage"), true);
  assert.equal(parity.flagAcceptedByParser(parseFlags, "--stage"), false);
});


test("COORD-1052: inline flag documentation excludes fenced examples and escaped prose spans", () => {
  const doc = [
    "Use `--owner` and `--owner --force --help`.",
    "Escaped \\`--not-code\\` is prose.",
    "~~~sh", "gov claim T-1 --fenced", "```", "~~~",
    "After the fence, `--human-admin-override` is documented.",
    "```sh", "gov claim T-1 --unfinished",
  ].join("\n");
  assert.deepEqual(parity.documentedBacktickFlags(doc), ["--force", "--human-admin-override", "--owner"]);
  assert.deepEqual(parity.documentedBacktickFlags(null), []);
  assert.deepEqual(parity.documentedBacktickPaths(null), []);
  assert.deepEqual(parity.documentedCodeSegments(null), []);
  assert.deepEqual(parity.govInvocations("```sh\ngov claim T-1 --owner fixture"),
    [{ verb: "claim", flags: ["--owner"] }]);
});

test("COORD-1052: documentation parity distinguishes an unknown verb from a known verb without a dry parser", () => {
  const report = parity.runVerbFlagParityCheck({
    docs: [{ path: "operator.md", text: "`gov opaque T-1 --owner fixture`\n`gov opaque T-1`\n`gov missing T-1 --owner fixture`" }],
    verbs: ["opaque"],
    parserFor: (verb) => { assert.equal(verb, "opaque", "unknown verbs must not invoke a parser"); return null; },
  });
  assert.deepEqual(report, { invocationCount: 3,
    unknownVerbs: [{ doc: "operator.md", verb: "missing" }], unacceptedFlags: [],
    unverified: [{ doc: "operator.md", verb: "opaque" }] });
});

test("COORD-1052: flag probes reject exact unknown flags but retain value errors and prefix suggestions", () => {
  const refuses = (message) => (args) => {
    assert.deepEqual(args, ["--owner", "probe"]);
    throw new Error(message);
  };
  assert.equal(parity.flagAcceptedByParser(refuses('Unknown flag "--owner"'), "--owner"), false);
  assert.equal(parity.flagAcceptedByParser(refuses("unknown or valueless argument --owner"), "--owner"), false);
  assert.equal(parity.flagAcceptedByParser(refuses("unknown or valueless argument --owner-extra"), "--owner"), true);
  assert.equal(parity.flagAcceptedByParser(refuses("owner value must name a registered agent"), "--owner"), true);
  assert.equal(parity.flagAcceptedByParser(refuses(""), "--owner"), true);
});

test("COORD-1052: legacy parser inspection ignores flags outside the parser and accepts switch cases", () => {
  // Input text is a minimal parser-format fixture, not a copied implementation.
  const legacy = [
    'const unrelated = { "--outside": true };',
    'function parseFlags(argv) {',
    '  switch (argv[0]) { case "--owner": return argv[1]; }',
    '  if (argv.includes("--plan-update")) throw new Error("Use the plan update command");',
    '}',
    'function other() { return { "--later": true }; }',
  ].join("\n");
  assert.deepEqual([...parity.collectParseFlagsFlags(legacy)], ["--owner", "--plan-update"]);
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "verb-parity-docs-"));
  try {
    assert.deepEqual(parity.operatorDocSources(dir), parity.OPERATOR_DOC_PATHS);
    assert.ok(parity.operatorDocSources(ROOT).includes("coord/engine/docs/COMMAND_REFERENCE.md"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual([...parity.collectParseFlagsFlags(null)], []);
  assert.deepEqual([...parity.collectParseFlagsFlags('const unrelated = { "--outside": true };')], []);
  assert.deepEqual([...parity.collectParseFlagsFlags('function parseFlags() { switch (x) { case "--force": break; } }')], ["--force"]);
});
