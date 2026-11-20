"use strict";

// COORD-916: test fixtures must not share fixed paths under the system temp
// directory. A suite that installs into, writes, or deletes a fixed location
// such as "/tmp/coord" destroys the fixtures of any concurrent run on the same
// host: one gate already runs its Node 22, Node 24 and dual-release lanes at
// once, and gates share hosts. Fixtures take a per-test directory from
// fs.mkdtempSync(path.join(os.tmpdir(), "<prefix>-")) instead.
//
// Two checks live here:
//   1. a regression run: two concurrent `node --test coord/scripts/paths.test.js`
//      processes must both pass (that suite used to share /tmp/coord);
//   2. a static scan of every test file and test helper for an fs mutation whose
//      target is a fixed absolute /tmp path or a fixed name directly under
//      os.tmpdir(). Strings that merely contain "/tmp" (path-shape fixtures,
//      parser inputs) are not write targets and are not flagged.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONTENT_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE_ROOT = path.dirname(CONTENT_ROOT);

// fs mutators and the argument positions that name what they create or remove.
const TARGET_ARGS = {
  writeFileSync: [0], appendFileSync: [0], mkdirSync: [0], rmSync: [0], rmdirSync: [0], unlinkSync: [0],
  truncateSync: [0], openSync: [0], writeFile: [0], appendFile: [0], mkdir: [0], rm: [0], rmdir: [0],
  unlink: [0], truncate: [0], cpSync: [1], copyFileSync: [1], symlinkSync: [1], linkSync: [1], cp: [1],
  copyFile: [1], symlink: [1], link: [1], renameSync: [0, 1], rename: [0, 1],
  // The shared engine-install fixture creates its first argument.
  installCanonicalEngine: [0],
};
// Async names are generic words; only count them on an fs-like receiver.
const BARE_ALLOWED = new Set(Object.keys(TARGET_ARGS).filter((name) => name.endsWith("Sync") || name === "installCanonicalEngine"));
const CALL_RE = new RegExp(`(^|[^\\w$.])((?:fs|fsp|fsPromises|fs\\.promises|promises)\\.)?(${Object.keys(TARGET_ARGS).join("|")})\\s*\\(`, "g");
const TMPDIR_CALL = String.raw`(?:os\.|require\(\s*["']node:os["']\s*\)\.|require\(\s*["']os["']\s*\)\.)?tmpdir\(\)`;
const TMP_LITERAL_RE = /^(["'`])\/tmp(?:\/|\1)/;
const TMPDIR_ONLY_RE = new RegExp(`^${TMPDIR_CALL}$`);
const TMPDIR_JOIN_RE = new RegExp(`^path\\.(?:join|resolve)\\(\\s*${TMPDIR_CALL}\\s*,`);
const TMPDIR_TEMPLATE_RE = new RegExp(`^\`\\$\\{${TMPDIR_CALL}\\}[/\\\\]`);
const JOIN_HEAD_RE = /^path\.(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)\s*[,)]/;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
// A name built from these is unique per process or per call, not fixed.
const ENTROPY_RE = /process\.pid|Date\.now\(\)|randomUUID\(|randomBytes\(|mkdtemp/;

// Blank out comments while keeping offsets and line numbers stable.
function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i += 1) out += source[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Split the argument list that starts just after `open` into top-level
// argument strings; `stopAt` ends an initializer at a top-level ; or newline.
function readBalanced(source, start, { stopAt = null } = {}) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      current += ch;
      if (ch === "\\") { current += source[i + 1] ?? ""; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; current += ch; continue; }
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) {
      if (depth === 0) { parts.push(current); return parts; }
      depth -= 1;
    }
    if (depth === 0 && ch === "," && !stopAt) { parts.push(current); current = ""; continue; }
    if (depth === 0 && stopAt && stopAt.includes(ch)) { parts.push(current); return parts; }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function declarationBefore(source, name, offset) {
  const re = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*`, "g");
  let found = null;
  for (const match of source.matchAll(re)) {
    if (match.index >= offset) break;
    found = match.index + match[0].length;
  }
  if (found === null) return null;
  return { init: readBalanced(source, found, { stopAt: ";\n" })[0].trim(), offset: found };
}

// "fixed": a fixed absolute temp path; "tmproot": the temp directory itself;
// null: anything else (a mkdtemp result, a path under one, a non-temp path).
function classify(source, expr, offset, depth = 0) {
  const text = expr.trim();
  if (depth > 6 || !text) return null;
  if (TMP_LITERAL_RE.test(text)) return text === '"/tmp"' || text === "'/tmp'" ? "tmproot" : "fixed";
  if (TMPDIR_ONLY_RE.test(text)) return "tmproot";
  if (/mkdtemp/.test(text)) return null;
  if (TMPDIR_JOIN_RE.test(text) || TMPDIR_TEMPLATE_RE.test(text)) return ENTROPY_RE.test(text) ? null : "fixed";
  const head = JOIN_HEAD_RE.exec(text);
  if (head) {
    const decl = declarationBefore(source, head[1], offset);
    const base = decl && classify(source, decl.init, decl.offset, depth + 1);
    if (base === "fixed") return "fixed";
    if (base === "tmproot") return ENTROPY_RE.test(text) ? null : "fixed";
    return null;
  }
  if (IDENT_RE.test(text)) {
    const decl = declarationBefore(source, text, offset);
    return decl ? classify(source, decl.init, decl.offset, depth + 1) : null;
  }
  return null;
}

function findFixedTmpWrites(rawSource) {
  const source = stripComments(rawSource);
  const findings = [];
  for (const match of source.matchAll(CALL_RE)) {
    const [, , receiver, name] = match;
    if (!receiver && !BARE_ALLOWED.has(name)) continue;
    const callOffset = match.index + match[1].length;
    const args = readBalanced(source, match.index + match[0].length);
    for (const position of TARGET_ARGS[name]) {
      const arg = args[position];
      if (arg === undefined || classify(source, arg, callOffset) !== "fixed") continue;
      const line = source.slice(0, callOffset).split("\n").length;
      findings.push({ line, call: name, target: arg.trim().replace(/\s+/g, " ") });
    }
  }
  return findings;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", ".runtime", "examples", "dist", "coverage"]);
const TEST_FILE_RE = /\.test\.(?:c|m)?js$/;
const SELF = path.relative(WORKSPACE_ROOT, __filename).split(path.sep).join("/");
const HELPER_DIR_RE = /(?:^|\/)(?:fixtures|__fixtures__|test-helpers?|helpers)\//;

function listTestSources() {
  // The workspace tree when this is the source repository; the content root
  // alone inside an installed or cut copy.
  const roots = [CONTENT_ROOT];
  if (fs.existsSync(path.join(WORKSPACE_ROOT, "release", "suite-inventory.json"))) {
    for (const dir of ["create-concord", "release", "test", "frontend", "backend", "packages"]) {
      const abs = path.join(WORKSPACE_ROOT, dir);
      if (fs.existsSync(abs)) roots.push(abs);
    }
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !/\.(?:c|m)?js$/.test(entry.name)) continue;
      const rel = path.relative(WORKSPACE_ROOT, path.join(dir, entry.name)).split(path.sep).join("/");
      // This file's own samples are deliberate violations held in strings.
      if (rel === SELF) continue;
      if (TEST_FILE_RE.test(entry.name) || HELPER_DIR_RE.test(rel)) out.push(rel);
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

function runPathsSuite() {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith("NODE_TEST_")) delete env[name];
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", path.join(CONTENT_ROOT, "scripts", "paths.test.js")],
      { cwd: WORKSPACE_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("COORD-916 two concurrent paths.test.js runs both pass", { timeout: 240000 }, async () => {
  const runs = await Promise.all([runPathsSuite(), runPathsSuite()]);
  runs.forEach((run, index) => {
    assert.equal(run.status, 0, `concurrent run ${index + 1} failed:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /^# fail 0$/m, `concurrent run ${index + 1}`);
    assert.doesNotMatch(run.stdout, /^# pass 0$/m, `concurrent run ${index + 1} ran no tests`);
  });
});

test("COORD-916 the fixed-temp-path scan flags fixed /tmp and os.tmpdir() write targets", () => {
  const T = "/" + "tmp";
  const sample = [
    `installCanonicalEngine("${T}/coord", root);`,
    `fs.rmSync("${T}/coord/engine", { recursive: true, force: true });`,
    "const lock = path.join(os.tmpdir(), \"fixed-lock\");",
    "fs.writeFileSync(lock, \"x\");",
    "const nested = path.join(lock, \"child.txt\");",
    "fs.appendFileSync(nested, \"y\");",
    "fs.cpSync(source, path.join(require(\"node:os\").tmpdir(), \"copy-target\"), { recursive: true });",
    "const tmp = os.tmpdir();",
    "fs.mkdirSync(path.join(tmp, \"shared\"), { recursive: true });",
    `await fs.promises.writeFile(\`${T}/async-out\`, "z");`,
    `fs.renameSync(from, "${T}/renamed");`,
  ].join("\n");
  const findings = findFixedTmpWrites(sample);
  assert.deepEqual(findings.map((finding) => [finding.line, finding.call]), [
    [1, "installCanonicalEngine"], [2, "rmSync"], [4, "writeFileSync"], [6, "appendFileSync"],
    [7, "cpSync"], [9, "mkdirSync"], [10, "writeFile"], [11, "renameSync"],
  ]);
});

test("COORD-916 the fixed-temp-path scan allows mkdtemp roots, unique names and string-only fixtures", () => {
  const T = "/" + "tmp";
  const sample = [
    "const root = fs.mkdtempSync(path.join(os.tmpdir(), \"coord916-\"));",
    "fs.writeFileSync(path.join(root, \"a.txt\"), \"x\");",
    "const sub = path.join(root, \"coord\");",
    "installCanonicalEngine(sub, source);",
    "fs.mkdirSync(os.tmpdir(), { recursive: true });",
    "const marker = path.join(os.tmpdir(), `marker-${process.pid}-${Date.now()}`);",
    "fs.rmSync(marker, { force: true });",
    `const paths = createCoordPaths({ coordDir: "${T}/coord", rootDir: "${T}" });`,
    `assert.equal(paths.boardPath, "${T}/coord/board/tasks.json");`,
    `fs.symlinkSync("${T}", path.join(source, "escape"));`,
    `// fs.rmSync("${T}/commented-out");`,
    `const missing = path.join(os.tmpdir(), "never-written.json");`,
    "assert.equal(fs.existsSync(missing), false);",
  ].join("\n");
  assert.deepEqual(findFixedTmpWrites(sample), []);
});

test("COORD-916 no test file or test helper writes a fixed path under the temp directory", () => {
  const files = listTestSources();
  assert.ok(files.includes("coord/scripts/paths.test.js"), "the scan must cover coord/scripts suites");
  assert.ok(files.includes("coord/scripts/fixtures/coord-engine-schemas.js"), "the scan must cover test helpers");
  const offenders = [];
  for (const rel of files) {
    for (const finding of findFixedTmpWrites(fs.readFileSync(path.join(WORKSPACE_ROOT, rel), "utf8"))) {
      offenders.push(`${rel}:${finding.line} ${finding.call}(${finding.target})`);
    }
  }
  assert.deepEqual(offenders, [],
    "use a per-test fs.mkdtempSync(path.join(os.tmpdir(), \"<prefix>-\")) directory instead of a fixed temp path");
});
