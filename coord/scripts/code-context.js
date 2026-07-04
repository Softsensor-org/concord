"use strict";

// code-context.js — Code context persistence and compact symbol index.
//
// Reduces agent token consumption by storing compact symbol summaries of
// source files. Agents receive function signatures + purpose (~200 tokens)
// instead of full file content (~3 000 tokens). Savings scale linearly
// with the number of files a ticket touches.
//
// Five CLI surfaces (exposed via `gov`):
//   gov code-index [--repo <path>] [--ext <exts>] [--git] [--force] [--json]
//     Build or refresh the index at coord/memory/code-index.ndjson.
//     --git: fast mode — only re-indexes files flagged by `git status`
//     (ideal for PostToolUse hook; runs in <100 ms after a single file edit).
//
//   gov code-diff [<base-ref>] [--json]
//     Compact symbol views for files changed vs <base-ref> (default HEAD).
//     Shows what changed + the current API surface so agents understand
//     impact without reading full diffs.
//
//   gov code-search <query> [--top <N>] [--json]
//     BM25 search over the index. Returns compact symbol views of matching
//     files ranked by relevance to the query.
//
//   gov code-context <file1> [file2 ...] [--json]
//     Return compact symbol views for specific files. This is the primary
//     token-reduction primitive: callers get API signatures without reading
//     the full source.
//
// Storage: coord/memory/code-index.ndjson — gitignored, derived, rebuildable.
// Each line is one file record:
//   { path, content_hash, indexed_at, locs, bytes, purpose, exports[], deps[],
//     git: { last_commit, last_author, last_message, last_date,
//            is_modified, is_staged, is_untracked } }
//
// Integration: buildContextPack (token-economics.js) calls getCompactViews so
// ticket context packs include file symbols inline, letting agents start work
// without a separate file-read round-trip.
//
// PostToolUse hook (auto-refresh): .claude/settings.json fires
// `gov code-index --git` after every Edit/Write so the index always reflects
// the current working tree during active development sessions.
//
// WHY REGEX NOT AST: coord scripts are simple CJS/ESM modules. A regex
// extractor is zero-dependency, <5 ms/file, and captures >90% of useful
// signatures. Full AST (acorn / @babel/parser) would add a required dep.
//
// CARDINAL GUARDRAIL: this module is read-only at query time. Index builds
// read source files only; nothing in this module mutates governed state.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const COORD_DIR = path.join(ROOT_DIR, "coord");
const DEFAULT_INDEX_PATH = path.join(COORD_DIR, "memory", "code-index.ndjson");

const DEFAULT_EXTENSIONS = [".js", ".ts", ".tsx", ".mjs"];

// Paths to skip when scanning — node_modules, build artifacts, runtime state.
const SKIP_PATTERNS = [
  /node_modules/,
  /\.next[/\\]/,
  /\.worktrees[/\\]/,
  /[/\\]dist[/\\]/,
  /[/\\]build[/\\]/,
  /[/\\]coverage[/\\]/,
  /coord[/\\]\.runtime/,
  /\.min\.js$/,
  /\.d\.ts$/,
  /code-index\.ndjson$/,
];

// ─── Hashing ──────────────────────────────────────────────────────────────────

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

// ─── Git Helpers ─────────────────────────────────────────────────────────────
// Mirrors the gitTry pattern from git-ops.js. No shared import so this module
// can be required independently without pulling in the full git-ops surface.

function gitTry(dir, args) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

// Returns { path: absPath, status: "M"|"??"|... } for every working-tree
// change (modified, added, staged, untracked). Paths are absolute.
function getGitChangedFiles(repoRoot) {
  const r = gitTry(repoRoot, ["status", "--porcelain"]);
  if (r.status !== 0 || !r.stdout) return [];
  const files = [];
  for (const raw of r.stdout.split("\n")) {
    if (!raw.trim()) continue;
    const xy = raw.slice(0, 2);
    let filePart = raw.slice(3);
    // Renames: "R  old -> new" — take the destination path.
    if (filePart.includes(" -> ")) filePart = filePart.split(" -> ").pop();
    filePart = filePart.trim().replace(/^"|"$/g, ""); // strip git quoting
    if (!filePart) continue;
    files.push({ path: path.resolve(repoRoot, filePart), status: xy.trim() });
  }
  return files;
}

// Returns absolute paths of files changed vs <baseRef> (default "HEAD"),
// including staged changes not yet committed.
function getGitDiffFiles(repoRoot, baseRef) {
  const ref = baseRef || "HEAD";
  const seen = new Set();
  const files = [];

  const addLines = (stdout) => {
    for (const line of (stdout || "").split("\n")) {
      const f = line.trim();
      if (f && !seen.has(f)) {
        seen.add(f);
        files.push(path.resolve(repoRoot, f));
      }
    }
  };

  const r = gitTry(repoRoot, ["diff", ref, "--name-only"]);
  if (r.status === 0) addLines(r.stdout);

  const staged = gitTry(repoRoot, ["diff", "--cached", "--name-only"]);
  if (staged.status === 0) addLines(staged.stdout);

  return files;
}

// Returns per-file last-commit metadata or null when the file is new/untracked.
function getFileGitMeta(absPath, repoRoot) {
  const r = gitTry(repoRoot, ["log", "-1", "--format=%H|%an|%s|%aI", "--", absPath]);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const [last_commit, last_author, last_message, last_date] = r.stdout.trim().split("|");
  return {
    last_commit: last_commit || null,
    last_author: last_author || null,
    last_message: last_message || null,
    last_date: last_date || null,
  };
}

// ─── Purpose Extraction ───────────────────────────────────────────────────────
// Extract a short module description from the leading comment block. Skips
// "use strict", shebang, and blank lines before the first real comment.

function extractPurpose(source) {
  const lines = source.split("\n");
  const collected = [];
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '"use strict";' || line === "'use strict';" || line.startsWith("#!")) continue;

    if (line.startsWith("/*")) {
      inBlock = true;
      const body = line.replace(/^\/\*+/, "").replace(/\*+\/$/, "").trim();
      if (body) collected.push(body);
      if (line.includes("*/") && line.indexOf("*/") > 2) {
        break;
      }
      continue;
    }

    if (inBlock) {
      if (line.includes("*/")) break;
      const body = line.replace(/^\*+\s?/, "").trim();
      if (body && !body.startsWith("@")) collected.push(body);
      if (collected.length >= 3) break;
      continue;
    }

    if (line.startsWith("//")) {
      const body = line.replace(/^\/\/+\s*/, "");
      if (body) collected.push(body);
      if (collected.length >= 3) break;
      continue;
    }

    break; // first non-comment, non-blank line: done
  }

  return collected.slice(0, 3).join(" ").replace(/\s+/g, " ").trim();
}

// ─── Symbol Extraction ────────────────────────────────────────────────────────
// Regex-based extraction of exported symbols with line numbers and signatures.
// Handles CJS (exports.name, module.exports) and ESM (export function, etc.).

const EXPORT_PATTERNS = [
  // CJS: exports.name = function / exports.name = (params) =>
  { re: /^exports\.(\w+)\s*=\s*(?:async\s+)?function\s*(?:\w+)?\s*\(([^)]*)\)/, kind: "function" },
  { re: /^exports\.(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/, kind: "function" },
  { re: /^exports\.(\w+)\s*=\s*(?:async\s+)?(\w+)\s*=>/, kind: "function" },

  // Named function declarations
  { re: /^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/, kind: "function" },

  // const/let assignments to function expressions / arrow functions
  { re: /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*(?:\w+)?\s*\(([^)]*)\)/, kind: "function" },
  { re: /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/, kind: "function" },

  // SCREAMING_SNAKE constants
  { re: /^(?:const|let)\s+([A-Z_][A-Z0-9_]{2,})\s*=\s*(.{0,60})/, kind: "const" },

  // Class declarations
  { re: /^class\s+(\w+)(?:\s+extends\s+\S+)?/, kind: "class" },

  // ESM: export function / export async function
  { re: /^export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*[\w<>[\],\s|&.]+)?/, kind: "function" },

  // ESM: export const / export let
  { re: /^export\s+(?:const|let)\s+(\w+)(?:\s*:\s*[\w<>[\],\s|&.]+)?\s*=/, kind: "const" },

  // ESM: export interface / export type
  { re: /^export\s+interface\s+(\w+)/, kind: "interface" },
  { re: /^export\s+type\s+(\w+)/, kind: "type" },

  // ESM: export class / export abstract class
  { re: /^export\s+(?:abstract\s+)?class\s+(\w+)/, kind: "class" },

  // ESM: export default function / export default class
  { re: /^export\s+default\s+(?:async\s+)?function\s+(\w+)/, kind: "function" },
  { re: /^export\s+default\s+(?:abstract\s+)?class\s+(\w+)/, kind: "class" },
];

function extractExports(source) {
  const lines = source.split("\n");
  const symbols = [];
  const seen = new Set();

  // Collect names mentioned in `module.exports = { a, b, c }` so we know
  // which top-level declarations are actually exported.
  const moduleExportsBlock = source.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
  const moduleExportedNames = new Set();
  if (moduleExportsBlock) {
    (moduleExportsBlock[1].match(/\b(\w+)\b/g) || []).forEach(n => moduleExportedNames.add(n));
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;

    for (const pat of EXPORT_PATTERNS) {
      const m = line.match(pat.re);
      if (!m) continue;

      const name = m[1];
      if (!name || seen.has(name)) continue;

      let sig;
      if (pat.kind === "function") {
        const params = (m[2] !== undefined ? m[2] : "").replace(/\s+/g, " ").trim();
        sig = `${name}(${params})`;
      } else if (pat.kind === "const" && m[2] !== undefined) {
        const val = m[2].trim().replace(/[,{;].*/, "").trim();
        sig = `${name} = ${val}`;
      } else {
        sig = name;
      }

      seen.add(name);
      symbols.push({ name, kind: pat.kind, sig, line: i + 1 });
      break;
    }
  }

  return symbols;
}

// ─── Dependency Extraction ────────────────────────────────────────────────────
// Collect local require/import paths (relative, not node_modules).

function extractDeps(source) {
  const deps = new Set();

  const cjsRe = /require\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
  let m;
  while ((m = cjsRe.exec(source)) !== null) deps.add(m[1]);

  const esmRe = /from\s+["'](\.[^"']+)["']/g;
  while ((m = esmRe.exec(source)) !== null) deps.add(m[1]);

  return [...deps].sort();
}

// ─── File Record ──────────────────────────────────────────────────────────────

function indexFile(absPath, rootDir) {
  const source = fs.readFileSync(absPath, "utf8");
  const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");
  const stats = fs.statSync(absPath);

  return {
    path: relPath,
    content_hash: sha1(source),
    indexed_at: new Date().toISOString(),
    locs: source.split("\n").length,
    bytes: stats.size,
    purpose: extractPurpose(source),
    exports: extractExports(source),
    deps: extractDeps(source),
  };
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

function shouldSkip(absPath) {
  return SKIP_PATTERNS.some(p => p.test(absPath));
}

function scanDir(dir, extensions, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (shouldSkip(full)) continue;
    if (entry.isDirectory()) {
      scanDir(full, extensions, results);
    } else if (entry.isFile() && extensions.includes(path.extname(full))) {
      results.push(full);
    }
  }
  return results;
}

// ─── Index I/O ────────────────────────────────────────────────────────────────

function loadIndex(indexPath) {
  const map = new Map();
  if (!fs.existsSync(indexPath)) return map;
  const lines = fs.readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && rec.path) map.set(rec.path, rec);
    } catch {
      // skip corrupt line
    }
  }
  return map;
}

function saveIndex(indexPath, map) {
  const dir = path.dirname(indexPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sorted = [...map.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const content = sorted.map(r => JSON.stringify(r)).join("\n") + "\n";
  // Atomic write: temp file + rename to avoid corrupt index on crash.
  const tmp = indexPath + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, indexPath);
}

// ─── BM25 Search ─────────────────────────────────────────────────────────────
// Same approach as recall.js: pure in-memory BM25, zero npm deps.

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function buildBm25Index(docs) {
  const N = docs.length;
  const df = new Map();
  const tf = docs.map(doc => {
    const freq = new Map();
    doc.tokens.forEach(t => freq.set(t, (freq.get(t) || 0) + 1));
    freq.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
    return freq;
  });
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / (N || 1);
  return { N, df, tf, avgdl };
}

function bm25Score(queryTerms, docIdx, idx, k1 = 1.5, b = 0.75) {
  const { N, df, tf, avgdl } = idx;
  const docTf = tf[docIdx];
  const dl = [...docTf.values()].reduce((s, v) => s + v, 0);
  let score = 0;
  for (const term of queryTerms) {
    const idf = Math.log(((N - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5)) + 1);
    const termFreq = docTf.get(term) || 0;
    if (!termFreq) continue;
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (dl / avgdl));
    score += idf * (numerator / denominator);
  }
  return score;
}

function rankRecords(query, records, top) {
  // Boost: exact file-name match ranks above BM25 result.
  const queryLower = query.toLowerCase();
  const queryTerms = tokenize(query);

  const docs = records.map(rec => ({
    rec,
    tokens: tokenize(
      [rec.path, rec.purpose, rec.exports.map(e => `${e.name} ${e.sig}`).join(" ")].join(" ")
    ),
  }));

  const idx = buildBm25Index(docs);
  const scored = docs.map((doc, i) => {
    const bm = bm25Score(queryTerms, i, idx);
    const nameBoost = doc.rec.path.toLowerCase().includes(queryLower) ? 5 : 0;
    return { rec: doc.rec, score: bm + nameBoost };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top)
    .map(s => s.rec);
}

// ─── Compact View ─────────────────────────────────────────────────────────────
// The token-reduced representation of a file: purpose + signatures, no bodies.
// Typical size: 150–400 tokens vs 2 000–5 000 for full source.

function compactView(rec) {
  return {
    path: rec.path,
    locs: rec.locs,
    bytes: rec.bytes,
    purpose: rec.purpose || "",
    exports: rec.exports.map(e => ({ name: e.name, kind: e.kind, sig: e.sig, line: e.line })),
    deps: rec.deps,
    content_hash: rec.content_hash,
    indexed_at: rec.indexed_at,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

// buildIndex — scan configured repo roots, update coord/memory/code-index.ndjson.
// options: { repo, ext, force, indexPath }
function buildIndex(options = {}) {
  const indexPath = options.indexPath || DEFAULT_INDEX_PATH;
  const extensions = options.ext
    ? options.ext.split(",").map(e => (e.startsWith(".") ? e : `.${e}`))
    : DEFAULT_EXTENSIONS;
  const force = Boolean(options.force);

  // Determine roots: explicit --repo, or default set derived from project layout.
  const roots = [];
  if (options.repo) {
    roots.push(path.resolve(ROOT_DIR, options.repo));
  } else {
    roots.push(path.join(COORD_DIR, "scripts"));
    const coordUiPath = path.join(ROOT_DIR, "frontend", "apps", "coord-ui");
    if (fs.existsSync(coordUiPath)) roots.push(coordUiPath);
    const backendSrc = path.join(ROOT_DIR, "backend", "src");
    const backendRoot = path.join(ROOT_DIR, "backend");
    if (fs.existsSync(backendSrc)) roots.push(backendSrc);
    else if (fs.existsSync(backendRoot)) roots.push(backendRoot);
  }

  const existing = force ? new Map() : loadIndex(indexPath);
  const updated = new Map(existing);
  let indexed = 0;
  let skipped = 0;
  const errors = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const files = scanDir(root, extensions);
    for (const absPath of files) {
      const relPath = path.relative(ROOT_DIR, absPath).replace(/\\/g, "/");
      if (!force && existing.has(relPath)) {
        try {
          const source = fs.readFileSync(absPath, "utf8");
          if (existing.get(relPath).content_hash === sha1(source)) {
            skipped++;
            continue;
          }
        } catch {
          // fall through to re-index
        }
      }
      try {
        updated.set(relPath, indexFile(absPath, ROOT_DIR));
        indexed++;
      } catch (err) {
        errors.push({ path: relPath, error: err.message });
      }
    }
  }

  saveIndex(indexPath, updated);
  return { total: updated.size, indexed, skipped, errors, index_path: indexPath };
}

// buildIndexGitAware — fast refresh: only re-indexes files flagged by git status.
// Ideal for PostToolUse hook: on a typical single-file edit it finishes in <100 ms.
// Falls back gracefully when there are no git changes (returns stats without saving).
// options: { repo, ext, indexPath }
function buildIndexGitAware(options = {}) {
  const repoRoot = options.repo ? path.resolve(ROOT_DIR, options.repo) : ROOT_DIR;
  const indexPath = options.indexPath || DEFAULT_INDEX_PATH;
  const extensions = options.ext
    ? options.ext.split(",").map(e => (e.startsWith(".") ? e : `.${e}`))
    : DEFAULT_EXTENSIONS;

  const changed = getGitChangedFiles(repoRoot);
  const toIndex = changed
    .map(c => c.path)
    .filter(absPath => extensions.includes(path.extname(absPath)) && !shouldSkip(absPath));

  const existing = loadIndex(indexPath);
  if (toIndex.length === 0) {
    return { total: existing.size, indexed: 0, skipped: 0, errors: [], index_path: indexPath, git_mode: true };
  }

  const updated = new Map(existing);
  let indexed = 0;
  let skipped = 0;
  const errors = [];
  const statusMap = new Map(changed.map(c => [c.path, c.status]));

  for (const absPath of toIndex) {
    const relPath = path.relative(ROOT_DIR, absPath).replace(/\\/g, "/");
    if (!fs.existsSync(absPath)) {
      updated.delete(relPath); // deleted file — drop from index
      continue;
    }
    try {
      const source = fs.readFileSync(absPath, "utf8");
      if (existing.has(relPath) && existing.get(relPath).content_hash === sha1(source)) {
        skipped++;
        continue;
      }
      const rec = indexFile(absPath, ROOT_DIR);
      const xy = statusMap.get(absPath) || "";
      rec.git = {
        ...getFileGitMeta(absPath, repoRoot),
        is_modified: xy.includes("M"),
        is_staged: xy.length > 0 && xy[0] !== " " && xy[0] !== "?",
        is_untracked: xy === "??",
      };
      updated.set(relPath, rec);
      indexed++;
    } catch (err) {
      errors.push({ path: relPath, error: err.message });
    }
  }

  if (indexed > 0 || errors.length > 0) {
    saveIndex(indexPath, updated);
  }
  return { total: updated.size, indexed, skipped, errors, index_path: indexPath, git_mode: true };
}

// codeDiff — compact views for files changed vs <baseRef> (default HEAD).
// options: { indexPath, repo }
function codeDiff(baseRef, options = {}) {
  const indexPath = options.indexPath || DEFAULT_INDEX_PATH;
  const repoRoot = options.repo ? path.resolve(ROOT_DIR, options.repo) : ROOT_DIR;
  const changed = getGitDiffFiles(repoRoot, baseRef || "HEAD");
  const map = loadIndex(indexPath);

  const results = [];
  const unindexed = [];

  for (const absPath of changed) {
    const relPath = path.relative(ROOT_DIR, absPath).replace(/\\/g, "/");
    const rec = map.get(relPath);
    if (rec) results.push({ ...compactView(rec), git_changed: true });
    else unindexed.push(relPath);
  }

  return { base_ref: baseRef || "HEAD", results, unindexed, total_changed: changed.length };
}

// codeSearch — BM25 search over the index.
// options: { top, indexPath }
function codeSearch(query, options = {}) {
  const indexPath = options.indexPath || DEFAULT_INDEX_PATH;
  const top = Math.max(1, parseInt(options.top || options.n || "10", 10));
  const map = loadIndex(indexPath);
  if (map.size === 0) {
    return { query, results: [], message: "Index empty — run `gov code-index` first." };
  }
  const results = rankRecords(query, [...map.values()], top);
  return { query, results: results.map(compactView), total_indexed: map.size };
}

// codeContext — compact view for specific file paths.
// options: { indexPath }
function codeContext(filePaths, options = {}) {
  const indexPath = options.indexPath || DEFAULT_INDEX_PATH;
  const map = loadIndex(indexPath);
  const results = [];
  const missing = [];

  for (const fp of filePaths) {
    const normalized = fp.replace(/\\/g, "/");
    let rec = map.get(normalized);
    if (!rec) {
      // Try resolving relative to ROOT_DIR.
      const rel = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, fp)).replace(/\\/g, "/");
      rec = map.get(rel);
    }
    if (rec) results.push(compactView(rec));
    else missing.push(normalized);
  }

  return { results, missing, total_indexed: map.size };
}

// getCompactViews — used by context-pack to embed file symbols inline.
// Returns compact views for the given paths; silently omits paths not in index.
function getCompactViews(filePaths, indexPath) {
  const ip = indexPath || DEFAULT_INDEX_PATH;
  if (!fs.existsSync(ip)) return [];
  const map = loadIndex(ip);
  return filePaths
    .map(fp => {
      const norm = fp.replace(/\\/g, "/");
      const rel = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, fp)).replace(/\\/g, "/");
      return map.get(norm) || map.get(rel) || null;
    })
    .filter(Boolean)
    .map(compactView);
}

// ─── CLI Command Handlers ─────────────────────────────────────────────────────
// Called from lifecycle.js thin wrappers → cli.js dispatch.

function codeIndexCommand(options = {}) {
  const result = options.git ? buildIndexGitAware(options) : buildIndex(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const errMsg = result.errors.length
    ? `\nErrors (${result.errors.length}):\n` +
      result.errors.map(e => `  ${e.path}: ${e.error}`).join("\n")
    : "";
  process.stdout.write(
    `Code index built: ${result.total} files total, ` +
      `${result.indexed} re-indexed, ${result.skipped} unchanged.\n` +
      `Index: ${result.index_path}${errMsg}\n`
  );
  return result;
}

function codeSearchCommand(query, options = {}) {
  if (!query || !String(query).trim()) {
    process.stderr.write('code-search requires a <query>. e.g. gov code-search "BM25 ranking"\n');
    process.exitCode = 1;
    return null;
  }
  const result = codeSearch(String(query), options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  process.stdout.write(
    `Query: "${result.query}" — ${result.results.length} result(s) (${result.total_indexed} indexed)\n\n`
  );
  if (result.message) {
    process.stdout.write(`${result.message}\n`);
    return result;
  }
  for (const r of result.results) {
    process.stdout.write(`## ${r.path}  [${r.locs} lines]\n`);
    if (r.purpose) process.stdout.write(`   ${r.purpose}\n`);
    const shown = r.exports.slice(0, 10);
    for (const e of shown) {
      process.stdout.write(`   [${e.kind}:${e.line}] ${e.sig}\n`);
    }
    if (r.exports.length > 10) {
      process.stdout.write(`   … +${r.exports.length - 10} more\n`);
    }
    process.stdout.write("\n");
  }
  return result;
}

function codeDiffCommand(baseRef, options = {}) {
  const result = codeDiff(baseRef, options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  process.stdout.write(
    `Changed vs ${result.base_ref}: ${result.total_changed} file(s) ` +
      `(${result.results.length} indexed, ${result.unindexed.length} not yet indexed)\n\n`
  );
  if (result.unindexed.length > 0) {
    process.stdout.write(`Not in index: ${result.unindexed.join(", ")}\n\n`);
  }
  for (const r of result.results) {
    process.stdout.write(`## ${r.path}  [${r.locs} lines]\n`);
    if (r.purpose) process.stdout.write(`   ${r.purpose}\n`);
    for (const e of r.exports.slice(0, 10)) {
      process.stdout.write(`   [${e.kind}:${e.line}] ${e.sig}\n`);
    }
    if (r.exports.length > 10) process.stdout.write(`   … +${r.exports.length - 10} more\n`);
    process.stdout.write("\n");
  }
  return result;
}

function codeContextCommand(filePaths, options = {}) {
  if (!filePaths || filePaths.length === 0) {
    process.stderr.write("code-context requires at least one <file-path>.\n");
    process.exitCode = 1;
    return null;
  }
  const result = codeContext(filePaths, options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (result.missing.length > 0) {
    process.stdout.write(
      `Not in index (run 'gov code-index' first): ${result.missing.join(", ")}\n\n`
    );
  }
  for (const r of result.results) {
    process.stdout.write(`## ${r.path}  [${r.locs} lines, ${r.bytes} bytes]\n`);
    if (r.purpose) process.stdout.write(`Purpose: ${r.purpose}\n`);
    process.stdout.write(`Exports (${r.exports.length}):\n`);
    for (const e of r.exports) {
      process.stdout.write(`  [${e.kind}:${e.line}] ${e.sig}\n`);
    }
    if (r.deps.length > 0) {
      process.stdout.write(`Deps: ${r.deps.join(", ")}\n`);
    }
    process.stdout.write("\n");
  }
  return result;
}

module.exports = {
  buildIndex,
  buildIndexGitAware,
  codeDiff,
  codeSearch,
  codeContext,
  getCompactViews,
  codeIndexCommand,
  codeSearchCommand,
  codeContextCommand,
  codeDiffCommand,
  DEFAULT_INDEX_PATH,
  __testing: {
    extractPurpose,
    extractExports,
    extractDeps,
    indexFile,
    loadIndex,
    saveIndex,
    rankRecords,
    compactView,
    tokenize,
    bm25Score,
    buildBm25Index,
    shouldSkip,
    gitTry,
    getGitChangedFiles,
    getGitDiffFiles,
    getFileGitMeta,
    buildIndexGitAware,
    codeDiff,
  },
};
