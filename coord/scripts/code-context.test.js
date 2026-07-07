"use strict";

// Tests for code-context.js — code symbol index and token-reduction utilities.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, before, after } = require("node:test");

const {
  __testing: {
    extractPurpose,
    extractExports,
    extractDeps,
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
    buildIndexGitAware: buildIndexGitAwareInternal,
  },
  buildIndex,
  buildIndexGitAware,
  codeDiff,
  codeSearch,
  codeContext,
  getCompactViews,
} = require("./code-context.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "code-ctx-test-"));
}

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ─── extractPurpose ───────────────────────────────────────────────────────────

describe("extractPurpose", () => {
  it("extracts single-line // comment", () => {
    const src = `"use strict";\n// Handles session identity and lock semantics.\nconst x = 1;`;
    assert.strictEqual(extractPurpose(src), "Handles session identity and lock semantics.");
  });

  it("extracts block comment", () => {
    const src = `/*\n * Governance board state reducer.\n * Owns row/index updates.\n */\nconst x = 1;`;
    const result = extractPurpose(src);
    assert.ok(result.includes("Governance board state reducer"), `got: ${result}`);
  });

  it("skips 'use strict' and shebangs", () => {
    const src = `#!/usr/bin/env node\n"use strict";\n// Real purpose here.\n`;
    assert.strictEqual(extractPurpose(src), "Real purpose here.");
  });

  it("stops after 3 lines", () => {
    const src = `// Line one.\n// Line two.\n// Line three.\n// Line four.\n`;
    const result = extractPurpose(src);
    assert.ok(!result.includes("four"), `should stop at 3: ${result}`);
  });

  it("returns empty string for file with no leading comment", () => {
    const src = `const x = 1;\nfunction foo() {}\n`;
    assert.strictEqual(extractPurpose(src), "");
  });
});

// ─── extractExports ───────────────────────────────────────────────────────────

describe("extractExports", () => {
  it("extracts named function declarations", () => {
    const src = `"use strict";\nfunction buildIndex(options) { return {}; }\nfunction sha1(v) {}\n`;
    const syms = extractExports(src);
    const names = syms.map(s => s.name);
    assert.ok(names.includes("buildIndex"), `names: ${names}`);
    assert.ok(names.includes("sha1"), `names: ${names}`);
  });

  it("extracts exports.name = function(params)", () => {
    const src = `exports.codeSearch = function codeSearch(query, options) { return {}; };\n`;
    const syms = extractExports(src);
    assert.strictEqual(syms[0].name, "codeSearch");
    assert.strictEqual(syms[0].kind, "function");
    assert.ok(syms[0].sig.includes("query"), `sig: ${syms[0].sig}`);
  });

  it("extracts SCREAMING_SNAKE constants", () => {
    const src = `const DEFAULT_EXTENSIONS = [".js", ".ts"];\nconst x = 1;\n`;
    const syms = extractExports(src);
    const c = syms.find(s => s.name === "DEFAULT_EXTENSIONS");
    assert.ok(c, `symbols: ${JSON.stringify(syms.map(s => s.name))}`);
    assert.strictEqual(c.kind, "const");
  });

  it("extracts class declarations", () => {
    const src = `class GovernanceError extends Error { constructor(msg) { super(msg); } }\n`;
    const syms = extractExports(src);
    assert.strictEqual(syms[0].name, "GovernanceError");
    assert.strictEqual(syms[0].kind, "class");
  });

  it("deduplicates repeated names", () => {
    const src = `function foo(a) {}\nfunction foo(b) {}\n`;
    const syms = extractExports(src);
    assert.strictEqual(syms.filter(s => s.name === "foo").length, 1);
  });

  it("extracts ESM export function", () => {
    const src = `export async function recall(query, options) { return {}; }\n`;
    const syms = extractExports(src);
    assert.strictEqual(syms[0].name, "recall");
    assert.strictEqual(syms[0].kind, "function");
  });

  it("extracts ESM export interface and type", () => {
    const src = `export interface Ticket { id: string; }\nexport type Status = string;\n`;
    const syms = extractExports(src);
    const iface = syms.find(s => s.name === "Ticket");
    const type = syms.find(s => s.name === "Status");
    assert.ok(iface && iface.kind === "interface");
    assert.ok(type && type.kind === "type");
  });

  it("records correct line numbers", () => {
    const src = `"use strict";\n\nfunction alpha() {}\nfunction beta() {}\n`;
    const syms = extractExports(src);
    const alpha = syms.find(s => s.name === "alpha");
    const beta = syms.find(s => s.name === "beta");
    assert.ok(alpha && alpha.line === 3, `alpha.line=${alpha?.line}`);
    assert.ok(beta && beta.line === 4, `beta.line=${beta?.line}`);
  });
});

// ─── extractDeps ──────────────────────────────────────────────────────────────

describe("extractDeps", () => {
  it("extracts local CJS requires", () => {
    const src = `const fs = require("fs");\nconst recall = require("./recall.js");\nconst pkg = require("../pkg/index.js");\n`;
    const deps = extractDeps(src);
    assert.ok(deps.includes("./recall.js"), `deps: ${deps}`);
    assert.ok(deps.includes("../pkg/index.js"), `deps: ${deps}`);
    assert.ok(!deps.includes("fs"), "should not include node built-ins");
  });

  it("extracts ESM imports", () => {
    const src = `import { foo } from "./foo.js";\nimport bar from "../bar.ts";\n`;
    const deps = extractDeps(src);
    assert.ok(deps.includes("./foo.js"));
    assert.ok(deps.includes("../bar.ts"));
  });

  it("returns sorted, deduplicated list", () => {
    const src = `require("./b.js");\nrequire("./a.js");\nrequire("./b.js");\n`;
    const deps = extractDeps(src);
    assert.deepStrictEqual(deps, ["./a.js", "./b.js"]);
  });
});

// ─── loadIndex / saveIndex ────────────────────────────────────────────────────

describe("loadIndex / saveIndex", () => {
  let dir;
  before(() => { dir = tmpDir(); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("round-trips records via NDJSON", () => {
    const indexPath = path.join(dir, "idx.ndjson");
    const map = new Map();
    map.set("foo.js", { path: "foo.js", content_hash: "abc", indexed_at: "2026-01-01", locs: 10, bytes: 100, purpose: "test", exports: [], deps: [] });
    map.set("bar.js", { path: "bar.js", content_hash: "def", indexed_at: "2026-01-01", locs: 20, bytes: 200, purpose: "other", exports: [], deps: [] });
    saveIndex(indexPath, map);
    const loaded = loadIndex(indexPath);
    assert.strictEqual(loaded.size, 2);
    assert.ok(loaded.has("foo.js"));
    assert.ok(loaded.has("bar.js"));
    assert.strictEqual(loaded.get("foo.js").content_hash, "abc");
  });

  it("returns empty map for missing file", () => {
    const map = loadIndex(path.join(dir, "nonexistent.ndjson"));
    assert.strictEqual(map.size, 0);
  });

  it("skips corrupt NDJSON lines", () => {
    const indexPath = path.join(dir, "corrupt.ndjson");
    fs.writeFileSync(indexPath, '{"path":"a.js","content_hash":"x","indexed_at":"t","locs":1,"bytes":1,"purpose":"","exports":[],"deps":[]}\nNOT_JSON\n{"path":"b.js","content_hash":"y","indexed_at":"t","locs":2,"bytes":2,"purpose":"","exports":[],"deps":[]}\n');
    const map = loadIndex(indexPath);
    assert.strictEqual(map.size, 2);
    assert.ok(map.has("a.js") && map.has("b.js"));
  });

  it("writes files sorted by path", () => {
    const indexPath = path.join(dir, "sorted.ndjson");
    const map = new Map();
    map.set("z.js", { path: "z.js", content_hash: "1", indexed_at: "t", locs: 1, bytes: 1, purpose: "", exports: [], deps: [] });
    map.set("a.js", { path: "a.js", content_hash: "2", indexed_at: "t", locs: 1, bytes: 1, purpose: "", exports: [], deps: [] });
    saveIndex(indexPath, map);
    const lines = fs.readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    assert.strictEqual(JSON.parse(lines[0]).path, "a.js");
    assert.strictEqual(JSON.parse(lines[1]).path, "z.js");
  });
});

// ─── shouldSkip ───────────────────────────────────────────────────────────────

describe("shouldSkip", () => {
  it("skips node_modules", () => { assert.ok(shouldSkip("/project/node_modules/foo.js")); });
  it("skips .next dirs", () => { assert.ok(shouldSkip("/app/.next/static/a.js")); });
  it("skips .worktrees", () => { assert.ok(shouldSkip("/project/.worktrees/agentA/t/file.js")); });
  it("skips .min.js", () => { assert.ok(shouldSkip("/src/bundle.min.js")); });
  it("skips .d.ts", () => { assert.ok(shouldSkip("/src/types.d.ts")); });
  it("does not skip regular .js", () => { assert.ok(!shouldSkip("/src/lifecycle.js")); });
  it("does not skip .ts files", () => { assert.ok(!shouldSkip("/app/ticket/page.tsx")); });
});

// ─── tokenize ─────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and splits on non-word chars", () => {
    const tokens = tokenize("BM25 ranking buildContextPack");
    assert.ok(tokens.includes("bm25"));
    assert.ok(tokens.includes("ranking"));
  });

  it("filters short tokens (len <= 2)", () => {
    const tokens = tokenize("a bb ccc");
    assert.ok(!tokens.includes("a"));
    assert.ok(!tokens.includes("bb"));
    assert.ok(tokens.includes("ccc"));
  });

  it("handles empty/null input", () => {
    assert.deepStrictEqual(tokenize(""), []);
    assert.deepStrictEqual(tokenize(null), []);
  });
});

// ─── BM25 ─────────────────────────────────────────────────────────────────────

describe("BM25", () => {
  it("scores relevant doc higher than irrelevant", () => {
    const docs = [
      { tokens: tokenize("BM25 search ranking algorithm token reduction") },
      { tokens: tokenize("governance board ticket status lifecycle") },
    ];
    const idx = buildBm25Index(docs);
    const s0 = bm25Score(tokenize("BM25 ranking"), 0, idx);
    const s1 = bm25Score(tokenize("BM25 ranking"), 1, idx);
    assert.ok(s0 > s1, `s0=${s0} s1=${s1}`);
  });

  it("returns 0 for no matching terms", () => {
    const docs = [{ tokens: tokenize("the quick brown fox") }];
    const idx = buildBm25Index(docs);
    const s = bm25Score(tokenize("completely unrelated"), 0, idx);
    assert.strictEqual(s, 0);
  });
});

// ─── rankRecords ─────────────────────────────────────────────────────────────

describe("rankRecords", () => {
  const records = [
    { path: "scripts/recall.js", purpose: "BM25 retrieval and memory recall", exports: [{ name: "recall", sig: "recall(query, options)", kind: "function" }], deps: [] },
    { path: "scripts/lifecycle.js", purpose: "Governance ticket lifecycle", exports: [{ name: "startTicket", sig: "startTicket(id)", kind: "function" }], deps: [] },
    { path: "scripts/code-context.js", purpose: "Code context persistence and symbol index", exports: [{ name: "buildIndex", sig: "buildIndex(options)", kind: "function" }], deps: [] },
  ];

  it("ranks code-context higher for 'code index' query", () => {
    const results = rankRecords("code index", records, 3);
    assert.strictEqual(results[0].path, "scripts/code-context.js");
  });

  it("ranks recall higher for 'recall BM25' query", () => {
    const results = rankRecords("recall BM25 retrieval", records, 3);
    assert.strictEqual(results[0].path, "scripts/recall.js");
  });

  it("returns at most `top` results", () => {
    const results = rankRecords("governance", records, 1);
    assert.ok(results.length <= 1);
  });
});

// ─── compactView ─────────────────────────────────────────────────────────────

describe("compactView", () => {
  it("includes key fields and excludes none", () => {
    const rec = { path: "a.js", content_hash: "abc", indexed_at: "t", locs: 10, bytes: 100, purpose: "test", exports: [{ name: "fn", kind: "function", sig: "fn(x)", line: 5 }], deps: ["./b.js"] };
    const v = compactView(rec);
    assert.strictEqual(v.path, "a.js");
    assert.strictEqual(v.locs, 10);
    assert.strictEqual(v.bytes, 100);
    assert.strictEqual(v.purpose, "test");
    assert.strictEqual(v.exports[0].sig, "fn(x)");
    assert.deepStrictEqual(v.deps, ["./b.js"]);
  });
});

// ─── buildIndex / codeSearch / codeContext (integration) ─────────────────────

describe("buildIndex + codeSearch + codeContext (integration)", () => {
  let rootDir;
  let indexPath;

  before(() => {
    rootDir = tmpDir();
    indexPath = path.join(rootDir, "code-index.ndjson");

    // Write fixture JS files
    writeFile(rootDir, "src/alpha.js",
      `"use strict";\n// Alpha module: handles BM25 ranking.\nfunction rankDocs(query, corpus) { return []; }\nconst MAX_RESULTS = 10;\nexports.rankDocs = rankDocs;\nexports.MAX_RESULTS = MAX_RESULTS;\n`
    );
    writeFile(rootDir, "src/beta.js",
      `"use strict";\n// Beta module: ticket lifecycle transitions.\nfunction startTicket(id, options) { return {}; }\nfunction stopTicket(id) {}\nmodule.exports = { startTicket, stopTicket };\n`
    );
    writeFile(rootDir, "src/gamma.ts",
      `// Gamma: TypeScript interface definitions.\nexport interface Ticket { id: string; status: string; }\nexport type Owner = string;\nexport function resolveOwner(ticket: Ticket): Owner { return ""; }\n`
    );
    // A file that should be skipped
    writeFile(rootDir, "node_modules/lib/foo.js", `function foo() {}\n`);
  });

  after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("buildIndex indexes .js and .ts files, skips node_modules", () => {
    const result = buildIndex({ repo: path.join(rootDir, "src"), indexPath });
    assert.strictEqual(result.errors.length, 0, `errors: ${JSON.stringify(result.errors)}`);
    assert.ok(result.total >= 3, `total=${result.total}`);
    assert.ok(result.indexed >= 3, `indexed=${result.indexed}`);

    const map = loadIndex(indexPath);
    const paths = [...map.keys()];
    assert.ok(paths.some(p => p.includes("alpha.js")), `paths: ${paths}`);
    assert.ok(paths.some(p => p.includes("beta.js")));
    assert.ok(paths.some(p => p.includes("gamma.ts")));
    assert.ok(!paths.some(p => p.includes("node_modules")), "node_modules must be skipped");
  });

  it("buildIndex is incremental (skips unchanged files)", () => {
    // Run index again without --force
    const result = buildIndex({ repo: path.join(rootDir, "src"), indexPath });
    assert.strictEqual(result.indexed, 0, `indexed should be 0 on second run: ${result.indexed}`);
    assert.ok(result.skipped >= 3, `skipped=${result.skipped}`);
  });

  it("buildIndex re-indexes changed files", () => {
    const alphaPath = path.join(rootDir, "src", "alpha.js");
    fs.writeFileSync(alphaPath, `"use strict";\n// Alpha v2.\nfunction rankDocs(q) {}\nexports.rankDocs = rankDocs;\n`);
    const result = buildIndex({ repo: path.join(rootDir, "src"), indexPath });
    assert.strictEqual(result.indexed, 1, `expected 1 re-indexed: ${result.indexed}`);
  });

  it("codeSearch returns relevant results for a query", () => {
    const result = codeSearch("ticket lifecycle", { indexPath, top: 5 });
    assert.ok(Array.isArray(result.results), "results should be array");
    // beta.js is about ticket lifecycle
    const betaResult = result.results.find(r => r.path.includes("beta"));
    assert.ok(betaResult, `beta.js not in results: ${result.results.map(r => r.path)}`);
  });

  it("codeSearch returns empty when index has no match", () => {
    const result = codeSearch("zzz_no_match_zzz", { indexPath, top: 5 });
    assert.deepStrictEqual(result.results, []);
  });

  it("codeContext returns compact views for known paths", () => {
    const map = loadIndex(indexPath);
    const knownPath = [...map.keys()].find(k => k.includes("beta"));
    assert.ok(knownPath, "beta not in index");
    const result = codeContext([knownPath], { indexPath });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.missing.length, 0);
    const v = result.results[0];
    assert.ok(v.exports.some(e => e.name === "startTicket" || e.name === "stopTicket"), `exports: ${JSON.stringify(v.exports.map(e => e.name))}`);
  });

  it("codeContext reports missing for unknown paths", () => {
    const result = codeContext(["nonexistent/file.js"], { indexPath });
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.missing.length, 1);
  });

  it("getCompactViews returns compact views for known paths", () => {
    const map = loadIndex(indexPath);
    const knownPath = [...map.keys()].find(k => k.includes("gamma"));
    const views = getCompactViews([knownPath], indexPath);
    assert.ok(views.length >= 1, `views: ${views.length}`);
    assert.ok(views[0].exports.some(e => e.name === "Ticket" || e.name === "Owner" || e.name === "resolveOwner"));
  });

  it("getCompactViews returns empty array when index missing", () => {
    const views = getCompactViews(["any/file.js"], path.join(rootDir, "no-index.ndjson"));
    assert.deepStrictEqual(views, []);
  });
});

// ─── Git helpers (graceful degradation in non-git dirs) ───────────────────────

describe("git helpers (non-git dir fallback)", () => {
  let nonGitDir;
  before(() => { nonGitDir = tmpDir(); });
  after(() => { fs.rmSync(nonGitDir, { recursive: true, force: true }); });

  it("gitTry returns non-zero status for unknown git dir", () => {
    const r = gitTry(nonGitDir, ["rev-parse", "--git-dir"]);
    assert.ok(r.status !== 0, "expected non-zero exit code in non-git dir");
  });

  it("getGitChangedFiles returns [] for non-git dir", () => {
    const files = getGitChangedFiles(nonGitDir);
    assert.deepStrictEqual(files, []);
  });

  it("getGitDiffFiles returns [] for non-git dir", () => {
    const files = getGitDiffFiles(nonGitDir, "HEAD");
    assert.deepStrictEqual(files, []);
  });

  it("getFileGitMeta returns null for non-git dir", () => {
    const someFile = path.join(nonGitDir, "a.js");
    fs.writeFileSync(someFile, "const x = 1;\n");
    const meta = getFileGitMeta(someFile, nonGitDir);
    assert.strictEqual(meta, null);
  });
});

// ─── buildIndexGitAware ───────────────────────────────────────────────────────

describe("buildIndexGitAware", () => {
  let rootDir;
  let indexPath;

  before(() => {
    rootDir = tmpDir();
    indexPath = path.join(rootDir, "git-index.ndjson");
    // Write a fixture .js file so buildIndex has something to find
    const srcDir = path.join(rootDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "util.js"), `"use strict";\n// Utility module.\nfunction helper(x) { return x; }\nmodule.exports = { helper };\n`);
    // Build a baseline full index first
    buildIndex({ repo: srcDir, indexPath });
  });

  after(() => { fs.rmSync(rootDir, { recursive: true, force: true }); });

  it("returns git_mode: true", () => {
    // Non-git dir: no changed files, returns stats only
    const result = buildIndexGitAware({ repo: rootDir, indexPath });
    assert.strictEqual(result.git_mode, true);
  });

  it("returns total = existing index size when no git changes detected", () => {
    // In a non-git rootDir, getGitChangedFiles returns [], so nothing re-indexed
    const before = loadIndex(indexPath);
    const result = buildIndexGitAware({ repo: rootDir, indexPath });
    assert.strictEqual(result.total, before.size, "total should equal existing index size");
    assert.strictEqual(result.indexed, 0);
  });

  it("does not corrupt the index when run on a non-git dir", () => {
    buildIndexGitAware({ repo: rootDir, indexPath });
    const map = loadIndex(indexPath);
    assert.ok(map.size > 0, "index should still have entries");
    for (const rec of map.values()) {
      assert.ok(rec.path, "every record should have a path");
      assert.ok(rec.content_hash, "every record should have a content_hash");
    }
  });
});

// ─── codeDiff ─────────────────────────────────────────────────────────────────

describe("codeDiff", () => {
  let rootDir;
  let indexPath;

  before(() => {
    rootDir = tmpDir();
    indexPath = path.join(rootDir, "diff-index.ndjson");
    const srcDir = path.join(rootDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "mod.js"), `"use strict";\n// Mod.\nfunction foo() {}\nmodule.exports = { foo };\n`);
    buildIndex({ repo: srcDir, indexPath });
  });

  after(() => { fs.rmSync(rootDir, { recursive: true, force: true }); });

  it("returns base_ref and total_changed fields", () => {
    // Pass repo: rootDir (non-git) so getGitDiffFiles falls back to []
    const result = codeDiff("HEAD", { repo: rootDir, indexPath });
    assert.ok(Object.prototype.hasOwnProperty.call(result, "base_ref"), "should have base_ref");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "total_changed"), "should have total_changed");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "results"), "should have results");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "unindexed"), "should have unindexed");
  });

  it("defaults base_ref to HEAD when called with null", () => {
    const result = codeDiff(null, { repo: rootDir, indexPath });
    assert.strictEqual(result.base_ref, "HEAD");
  });

  it("returns empty results when no git changes in non-git dir", () => {
    const result = codeDiff("HEAD", { repo: rootDir, indexPath });
    // Non-git rootDir: getGitDiffFiles returns [] → total_changed = 0
    assert.strictEqual(result.total_changed, 0);
    assert.deepStrictEqual(result.results, []);
  });
});
