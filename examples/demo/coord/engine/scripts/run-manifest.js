#!/usr/bin/env node
"use strict";

// COORD-910: a machine-verifiable run manifest for every test-runner and gate
// run (ADR 0021, decision 3: evidence reuse binds to every input).
//
// On 2026-11-05 one tree needed six gate attempts across two hosts with
// different git versions, umask, TMPDIR backing and suite timeouts, and only
// chat recorded the differences. A manifest records:
//   - inputs (they bind evidence reuse): source commit, tree, base and dirty
//     state; tool revision; policy digest; gate configuration; dependency lock
//     digests; toolchain (Node, Git); edition; OS platform and arch; relevant
//     environment settings (umask, TMPDIR symlink and filesystem type,
//     timeouts, scrubbed-env list);
//   - host facts (recorded and compared, never binding): TMPDIR path and
//     realpath, kernel release;
//   - the shard and selection plan, per-lane exit codes and durations, and
//     the sha256 of every produced artifact and report;
//   - the stacked-evidence policy.
//
//   node coord/engine/scripts/run-manifest.js collect [--base <ref>] [--out <file>]
//   node coord/engine/scripts/run-manifest.js write --out <file> --tool <name> --lane <name>:<exit>:<ms>... [--artifact <file>...] [--base <ref>]
//   node coord/engine/scripts/run-manifest.js validate <manifest>
//   node coord/engine/scripts/run-manifest.js compare <a> <b> [--json]
//   node coord/engine/scripts/run-manifest.js check-reuse <evidence> <current> [--intermediate] [--batching-ruling <text>] [--ticket-commit <sha>]

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SCHEMA_VERSION = 1;
const MANIFEST_KIND = "coord-run-manifest";
const SCHEMA_PATH = path.join(__dirname, "..", "run-manifest.schema.json");
const MOUNT_TABLE = path.join(path.sep, "proc", "self", "mounts");
const POLICY_FILES = Object.freeze([
  ["coord", "GOVERNANCE.md"].join("/"),
  "coord/project.config.js",
  "coord/engine/governance-guards.json",
  "coord/engine/shim-registry.json",
  "coord/engine/test-policy.json",
]);
// Files that configure what a gate checks rather than what the code does.
const GATE_CONFIG_FILES = Object.freeze([
  "coord/engine/scripts/engine-coverage-baseline-node22.json",
  "coord/engine/scripts/engine-coverage-baseline-node24.json",
  "release/suite-inventory.json",
]);
const LOCK_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const TIMEOUT_ENV = /^(?:GOVERNANCE|COORD|CONCORD|NODE_TEST)_[A-Z0-9_]*TIMEOUT[A-Z0-9_]*$/;
const STACKED_RULE = "Evidence from a top-of-stack tree is reused for an intermediate ticket only under a recorded batching ruling, and is invalid if landing changes the tested tree or base.";

function sha256(buffer) { return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`; }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function digestOf(value) { return sha256(canonicalJson(value)); }

function fileDigest(abs) {
  try {
    return sha256(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function gitLine(root, args) {
  const out = git(root, args);
  return out === null ? null : out.trim();
}

// Dirty state: the tracked diff against HEAD plus every untracked file's
// content, so two dirty runs of the same commit compare equal only when their
// working trees are byte-identical.
function dirtyDigest(root, porcelain) {
  const untracked = porcelain.split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3)).sort();
  const parts = [git(root, ["diff", "HEAD", "--binary"]) || ""];
  for (const rel of untracked) parts.push(`${rel}\0${fileDigest(path.join(root, rel))}`);
  return sha256(parts.join("\n"));
}

function sourceFacts(root, base) {
  const commit = gitLine(root, ["rev-parse", "HEAD"]);
  const porcelain = commit ? git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) || "" : "";
  const dirty = porcelain.trim().length > 0;
  return {
    commit,
    tree: commit ? gitLine(root, ["rev-parse", "HEAD^{tree}"]) : null,
    base: base ? gitLine(root, ["rev-parse", `${base}^{commit}`]) || base : null,
    dirty,
    dirty_digest: dirty ? dirtyDigest(root, porcelain) : null,
  };
}

function digestList(root, rels) {
  return rels.map((rel) => ({ path: rel, sha256: fileDigest(path.join(root, rel)) }));
}

function lockFiles(root) {
  const listed = git(root, ["ls-files"]);
  const files = listed === null ? ["package-lock.json", "coord/package-lock.json"] : listed.split("\n");
  return files.filter((f) => LOCK_FILE.test(f) && !/(?:^|\/)node_modules\//.test(f)).sort();
}

function detectEdition(root) {
  if (fs.existsSync(path.join(root, "release", "build-public-release.sh"))) return "donor";
  if (!fs.existsSync(path.join(root, "coord"))) return "engine";
  return fs.existsSync(path.join(root, "coord", "engine", "scripts", "enterprise")) ? "Enterprise" : "Community";
}

// Longest mount-point prefix of `dir` in /proc/self/mounts; "unknown" where
// the platform has no such table.
function filesystemType(dir, mountsText, table = MOUNT_TABLE) {
  let text = mountsText;
  if (text === undefined) {
    try {
      text = fs.readFileSync(table, "utf8");
    } catch {
      return "unknown";
    }
  }
  let best = { point: "", type: "unknown" };
  for (const line of text.split("\n")) {
    const [, point, type] = line.split(" ");
    if (!point || !type) continue;
    const inside = dir === point || dir.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (inside && point.length > best.point.length) best = { point, type };
  }
  return best.type;
}

function tmpdirFacts(dir = os.tmpdir(), mountsText) {
  let symlink = false;
  let real = dir;
  try {
    symlink = fs.lstatSync(dir).isSymbolicLink();
    real = fs.realpathSync(dir);
  } catch {
    real = null;
  }
  return { path: dir, realpath: real, symlink, fs_type: real ? filesystemType(real, mountsText) : "unknown" };
}

function timeoutSettings(env) {
  const out = {};
  for (const name of Object.keys(env).filter((n) => TIMEOUT_ENV.test(n)).sort()) out[name] = env[name];
  return out;
}

function gitVersion(root) {
  const line = gitLine(root, ["--version"]);
  return line ? line.replace(/^git version\s+/, "") : null;
}

function formatUmask(mask) { return mask.toString(8).padStart(4, "0"); }

function currentUmask() {
  // process.umask() with no argument is deprecated; set-and-restore reads it.
  const mask = process.umask(0o022);
  process.umask(mask);
  return formatUmask(mask);
}

// The inputs that bind evidence reuse, and the host facts that do not.
function collectInputs({ root, env = process.env, base = env.COORD_RUN_BASE || null, gateConfig = {}, scrubbedEnv = [], toolFile = null, tmpdir, mountsText } = {}) {
  const tmp = tmpdirFacts(tmpdir, mountsText);
  const inputs = {
    source: sourceFacts(root, base),
    tool_revision: {
      engine_pin: fileDigest(path.join(root, "coord", "engine-pin.json")),
      tool: toolFile ? fileDigest(toolFile) : null,
    },
    policy: { digest: null, files: digestList(root, POLICY_FILES) },
    gate_config: { ...gateConfig, files: digestList(root, GATE_CONFIG_FILES) },
    dependencies: digestList(root, lockFiles(root)),
    toolchain: { node: process.version, git: gitVersion(root) },
    edition: detectEdition(root),
    environment: {
      platform: process.platform,
      arch: process.arch,
      umask: currentUmask(),
      tmpdir_symlink: tmp.symlink,
      tmpdir_fs_type: tmp.fs_type,
      timeouts: timeoutSettings(env),
      scrubbed_env: [...scrubbedEnv].sort(),
    },
  };
  inputs.policy.digest = digestOf(inputs.policy.files);
  const host = { tmpdir: tmp.path, tmpdir_realpath: tmp.realpath, kernel: os.release() };
  return { inputs, host };
}

function defaultEvidencePolicy(env = process.env) {
  return { stacked_reuse: "batching-ruling-required", batching_ruling: env.COORD_BATCHING_RULING || null, rule: STACKED_RULE };
}

function artifactDigests(files) {
  return files.map((file) => {
    let bytes = null;
    try {
      bytes = fs.statSync(file).size;
    } catch {
      // recorded with a null digest: the artifact was not produced
    }
    return { path: file, sha256: fileDigest(file), bytes };
  });
}

function buildManifest({ tool, inputs, host, plan = { shards: [], selection: null }, lanes = [], artifacts = [], evidencePolicy = defaultEvidencePolicy(), qualification = null, generatedAt = new Date().toISOString() }) {
  const executionPass = lanes.length > 0 && lanes.every((l) => l.exit_code === 0);
  const result = !executionPass ? "fail" : qualification === "provisional" ? "provisional" : "pass";
  return {
    schema_version: SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    tool,
    generated_at: generatedAt,
    inputs,
    input_digest: digestOf(inputs),
    host,
    plan,
    evidence_policy: evidencePolicy,
    ...(qualification ? { qualification } : {}),
    lanes,
    artifacts,
    result,
  };
}

function loadSchema() { return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")); }

// Schema shape (the guard registry's JSON-schema subset) plus the semantic
// checks a schema cannot express: the digest matches the inputs, the result
// matches the lanes, and every produced artifact has a digest.
function validateManifest(manifest, schema = loadSchema()) {
  const { validateSchema } = require("./guard-registry.js");
  const errors = validateSchema(schema, manifest);
  if (errors.length) return errors;
  if (digestOf(manifest.inputs) !== manifest.input_digest) errors.push("$.input_digest: does not match the recorded inputs");
  if (digestOf(manifest.inputs.policy.files) !== manifest.inputs.policy.digest) errors.push("$.inputs.policy.digest: does not match the policy files");
  const executionPass = manifest.lanes.length > 0 && manifest.lanes.every((l) => l.exit_code === 0);
  const shardCount = manifest.inputs.gate_config?.shards;
  const hasShardRequest = shardCount === "auto" || Number.isInteger(Number(shardCount)) && Number(shardCount) > 0;
  const provisionalRunner = manifest.tool === "coord/scripts/test-runner.js" && hasShardRequest;
  const provisionalDonorWrapper = manifest.tool === "gov test-policy run" && manifest.inputs.gate_config?.shards &&
    manifest.inputs.gate_config.shards !== null;
  const provisionalAllowed = manifest.qualification === "provisional" && (provisionalRunner || provisionalDonorWrapper) && executionPass;
  const expected = !executionPass ? "fail" : provisionalAllowed ? "provisional" : "pass";
  if (manifest.result !== expected) errors.push(`$.result: lanes say ${expected}`);
  if (manifest.qualification && manifest.qualification !== "provisional") errors.push("$.qualification: unsupported qualification value");
  if (manifest.result === "provisional" && !provisionalAllowed) errors.push("$.result: provisional is only valid for successful sharded test-runner execution");
  manifest.artifacts.forEach((a, i) => {
    if (a.sha256 === null) errors.push(`$.artifacts[${i}]: ${a.path} was not produced`);
  });
  return errors;
}

// Flatten to dotted leaf paths so a compare names the exact field.
function flatten(value, prefix, out) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, canonicalJson(value));
  }
  return out;
}

function diffSection(a, b, prefix) {
  const fa = flatten(a, prefix, new Map());
  const fb = flatten(b, prefix, new Map());
  const keys = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  return keys.filter((k) => fa.get(k) !== fb.get(k)).map((k) => ({ path: k, a: fa.get(k) ?? null, b: fb.get(k) ?? null }));
}

const ENVIRONMENT_INPUTS = Object.freeze(["toolchain", "environment", "edition"]);

function keyed(list, key) { return Object.fromEntries((list || []).map((item) => [key(item), item])); }

// Artifacts are compared by file name: two runs write to different directories.
const artifactKey = (a) => path.basename(a.path);
const laneKey = (l) => l.name;

function compareManifests(a, b) {
  const inputKeys = [...new Set([...Object.keys(a.inputs || {}), ...Object.keys(b.inputs || {})])].sort();
  const diffs = { inputs: [], environment: [], host: [], results: [] };
  for (const key of inputKeys) {
    diffs[ENVIRONMENT_INPUTS.includes(key) ? "environment" : "inputs"].push(...diffSection(a.inputs?.[key], b.inputs?.[key], `inputs.${key}`));
  }
  diffs.host = diffSection(a.host, b.host, "host");
  diffs.results = [
    ...diffSection({ result: a.result }, { result: b.result }, ""),
    ...diffSection(keyed(a.lanes, laneKey), keyed(b.lanes, laneKey), "lanes"),
    ...diffSection(keyed(a.artifacts, artifactKey), keyed(b.artifacts, artifactKey), "artifacts"),
  ];
  return { same_inputs: a.input_digest === b.input_digest, ...diffs };
}

function formatCompare(cmp, labels = ["A", "B"]) {
  const lines = [`run-manifest compare: ${labels[0]} vs ${labels[1]} (inputs ${cmp.same_inputs ? "identical" : "differ"})`];
  const section = (title, list) => {
    lines.push(`${title}: ${list.length ? `${list.length} difference(s)` : "none"}`);
    for (const d of list) lines.push(`  ~ ${d.path}: ${d.a} -> ${d.b}`);
  };
  section("results", cmp.results);
  section("environment (toolchain, settings, edition)", cmp.environment);
  section("host (recorded, not binding)", cmp.host);
  section("inputs", cmp.inputs);
  return `${lines.join("\n")}\n`;
}

function isAncestor(root, ancestor, descendant) {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root });
  return r.status === 0;
}

function sourceRefusals(evidence, current) {
  const refusals = [];
  const e = evidence.inputs.source;
  const c = current.inputs.source;
  if (!e.commit || !e.tree) refusals.push("evidence source commit or tree is unknown");
  if (e.dirty) refusals.push("evidence was produced from a dirty working tree");
  if (e.tree !== c.tree || e.dirty_digest !== c.dirty_digest) refusals.push(`landing changes the tested tree (${e.tree} -> ${c.tree})`);
  if (!e.base || e.base !== c.base) refusals.push(`landing changes the tested base (${e.base} -> ${c.base})`);
  return refusals;
}

function stackRefusals(evidence, { batchingRuling, ticketCommit, root }) {
  const ruling = batchingRuling || evidence.evidence_policy.batching_ruling;
  const refusals = [];
  if (!ruling) refusals.push("evidence from a top-of-stack tree is reused for an intermediate ticket without a recorded batching ruling");
  if (ticketCommit && !isAncestor(root, ticketCommit, evidence.inputs.source.commit)) {
    refusals.push(`ticket commit ${ticketCommit} is not an ancestor of the tested commit ${evidence.inputs.source.commit}`);
  }
  return { refusals, ruling: ruling || null };
}

// Evidence is reusable only when every input matches. Host facts never bind.
// COORD-924: at landing the evidence ran on the gate host, so only the inputs
// that the tree carries bind (policy, dependencies, gate files, engine pin);
// the host's toolchain and settings stay recorded for compare.
function landingInputs(inputs) {
  return { policy: inputs.policy, dependencies: inputs.dependencies, gate_config_files: inputs.gate_config.files, engine_pin: inputs.tool_revision.engine_pin };
}

function inputDiffs(evidence, current, scope) {
  if (scope === "landing") return diffSection(landingInputs(evidence.inputs), landingInputs(current.inputs), "inputs");
  const cmp = compareManifests({ inputs: { ...evidence.inputs, source: null } }, { inputs: { ...current.inputs, source: null } });
  return [...cmp.inputs, ...cmp.environment];
}

function checkEvidenceReuse(evidence, current, { intermediate = false, batchingRuling = null, ticketCommit = null, root = process.cwd(), scope = "reuse" } = {}) {
  const invalid = [["evidence", evidence], ["current", current]]
    .flatMap(([label, m]) => validateManifest(m).map((e) => `${label} manifest invalid: ${e}`));
  if (invalid.length) return { ok: false, refusals: invalid, batching_ruling: null, rule: STACKED_RULE };
  const refusals = [];
  if (evidence.result !== "pass") refusals.push(`evidence run result is ${evidence.result}`);
  refusals.push(...sourceRefusals(evidence, current));
  for (const d of inputDiffs(evidence, current, scope)) refusals.push(`input differs: ${d.path} (${d.a} -> ${d.b})`);
  const stack = intermediate ? stackRefusals(evidence, { batchingRuling, ticketCommit, root }) : { refusals: [], ruling: null };
  refusals.push(...stack.refusals);
  return { ok: refusals.length === 0, refusals, batching_ruling: stack.ruling, rule: STACKED_RULE };
}

// guard:evidence-reuse
function formatReuseRefusal(verdict) {
  return `run-manifest: refusing evidence reuse: ${verdict.refusals.length} problem(s)\n${verdict.refusals.map((r) => `  - ${r}`).join("\n")}\n  policy: ${verdict.rule}\n`;
}

function writeManifest(file, manifest) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

function manifestPathFor(reportPath, explicit) {
  if (explicit) return explicit;
  return `${reportPath.replace(/\.json$/, "")}.manifest.json`;
}

// Where a run writes its evidence is not an input to what it tests.
const OUTPUT_ARGS = Object.freeze(["--report", "--manifest"]);

function bindingArgv(argv) {
  return argv.filter((arg, i) => !OUTPUT_ARGS.includes(arg) && !OUTPUT_ARGS.includes(argv[i - 1]));
}

// The test runner's manifest: its lanes are the modules it ran.
function testRunnerManifest({ root, argv, opts, selected, results, scrubbedEnv, toolFile, env = process.env }) {
  const gateConfig = {
    argv: bindingArgv(argv),
    modules: [...opts.modules],
    files: [...opts.files],
    engine_coverage: Boolean(opts.engineCoverage),
    shards: opts.shards || null,
    passthrough: [...opts.passthrough],
  };
  const { inputs, host } = collectInputs({ root, env, base: opts.base || env.COORD_RUN_BASE || null, gateConfig, scrubbedEnv, toolFile });
  const plan = { shards: selected.map((m) => ({ lane: m.name, files: [...m.files] })), selection: null };
  const lanes = results.map((r) => ({ name: r.module, exit_code: r.exit_code, signal: r.signal, duration_ms: r.duration_ms }));
  return buildManifest({ tool: "coord/scripts/test-runner.js", inputs, host, plan, lanes, evidencePolicy: defaultEvidencePolicy(env),
    qualification: opts.shards ? "provisional" : null });
}

// The repo gate's manifest (gate-runtime clean-checkout runs): one lane, the
// disposable checkout as the source, the gate invocation as configuration.
function repoGateManifest({ root, lane, invocation, exitCode, signal = null, durationMs, env = process.env }) {
  const gateConfig = { lane, invocation: invocation.kind === "bash" ? "bash scripts/gate.sh" : `script ${invocation.script}` };
  const { inputs, host } = collectInputs({ root, env, gateConfig });
  const lanes = [{ name: lane, exit_code: exitCode, signal, duration_ms: durationMs }];
  return buildManifest({ tool: "gov gate (clean checkout)", inputs, host, plan: { shards: [{ lane, files: [] }], selection: null }, lanes, evidencePolicy: defaultEvidencePolicy(env) });
}

function finalizeManifest(manifest, artifactFiles) {
  return { ...manifest, artifacts: artifactDigests(artifactFiles) };
}

// --- CLI ---------------------------------------------------------------------

function parseCli(argv) {
  const opts = { positional: [], lanes: [], artifacts: [], json: false, intermediate: false };
  const valued = { "--out": "out", "--tool": "tool", "--base": "base", "--root": "root", "--batching-ruling": "batchingRuling", "--ticket-commit": "ticketCommit" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (valued[arg]) opts[valued[arg]] = argv[++i];
    else if (arg === "--lane") opts.lanes.push(argv[++i]);
    else if (arg === "--artifact") opts.artifacts.push(argv[++i]);
    else if (arg === "--json") opts.json = true;
    else if (arg === "--intermediate") opts.intermediate = true;
    else opts.positional.push(arg);
  }
  return opts;
}

function parseLane(spec) {
  const m = /^([^:]+):(-?\d+):(\d+(?:\.\d+)?)$/.exec(spec || "");
  if (!m) throw new Error(`--lane must be <name>:<exit>:<ms>, got ${spec}`);
  return { name: m[1], exit_code: Number(m[2]), signal: null, duration_ms: Number(m[3]) };
}

function readManifest(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function emit(out, opts, manifest) {
  if (opts.out) {
    writeManifest(opts.out, manifest);
    out.write(`run-manifest: wrote ${opts.out} input_digest=${manifest.input_digest} result=${manifest.result}\n`);
  } else {
    out.write(`${JSON.stringify(manifest, null, 2)}\n`);
  }
}

const COMMANDS = {
  collect(opts, { out, root }) {
    const { inputs, host } = collectInputs({ root, base: opts.base });
    emit(out, opts, buildManifest({ tool: opts.tool || "run-manifest collect", inputs, host }));
    return 0;
  },
  write(opts, { out, root }) {
    const lanes = opts.lanes.map(parseLane);
    const { inputs, host } = collectInputs({ root, base: opts.base, gateConfig: { lanes: lanes.map((l) => l.name) } });
    const manifest = buildManifest({ tool: opts.tool || "unknown", inputs, host, plan: { shards: lanes.map((l) => ({ lane: l.name, files: [] })), selection: null }, lanes });
    emit(out, opts, finalizeManifest(manifest, opts.artifacts));
    return 0;
  },
  validate(opts, { out, err }) {
    const errors = validateManifest(readManifest(opts.positional[0]));
    for (const e of errors) err.write(`run-manifest: ${e}\n`);
    out.write(`run-manifest: ${errors.length ? "INVALID" : "VALID"} ${opts.positional[0]}\n`);
    return errors.length ? 1 : 0;
  },
  compare(opts, { out }) {
    const [a, b] = opts.positional;
    const cmp = compareManifests(readManifest(a), readManifest(b));
    out.write(opts.json ? `${JSON.stringify(cmp, null, 2)}\n` : formatCompare(cmp, [a, b]));
    return 0;
  },
  "check-reuse"(opts, { out, err, root }) {
    const [evidence, current] = opts.positional.map(readManifest);
    const verdict = checkEvidenceReuse(evidence, current, { ...opts, root });
    if (opts.json) out.write(`${JSON.stringify(verdict, null, 2)}\n`);
    // guard:evidence-reuse
    if (!verdict.ok) err.write(formatReuseRefusal(verdict));
    else out.write("run-manifest: evidence reuse allowed: every input matches\n");
    return verdict.ok ? 0 : 1;
  },
};

function main(argv, { out = process.stdout, err = process.stderr } = {}) {
  const [command, ...rest] = argv;
  const opts = parseCli(rest);
  const handler = COMMANDS[command];
  if (!handler) {
    err.write(`run-manifest: unknown command ${command} (${Object.keys(COMMANDS).join(", ")})\n`);
    return 2;
  }
  try {
    return handler(opts, { out, err, root: path.resolve(opts.root || process.cwd()) });
  } catch (e) {
    err.write(`run-manifest: ${e.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  SCHEMA_VERSION, MANIFEST_KIND, SCHEMA_PATH, POLICY_FILES, GATE_CONFIG_FILES, STACKED_RULE,
  canonicalJson, digestOf, gitVersion, filesystemType, tmpdirFacts, timeoutSettings, detectEdition, lockFiles,
  formatUmask, bindingArgv, collectInputs, defaultEvidencePolicy, buildManifest, validateManifest, compareManifests,
  formatCompare, checkEvidenceReuse, formatReuseRefusal, writeManifest, manifestPathFor,
  testRunnerManifest, repoGateManifest, finalizeManifest, artifactDigests, parseLane, main,
};
