"use strict";

// COORD-182: gate-proc for the MARKETING track.
//
// Where the development `test` gate runs a suite and the product-engineering
// `evidence` gate validates live-MCP receipts (analytics-gate.js / COORD-187),
// the marketing `content` gate gates on STATIC-SITE INTEGRITY: every published
// page must be valid HTML, carry complete SEO/social metadata, have no dangling
// local references, and (when a sitemap is provided) be discoverable. Heavier
// signals — Lighthouse scores and a live preview URL — are surfaced as skips
// unless the caller supplies them, so the gate stays pure and offline.
//
// Per the track contract in coord/product/MULTI_TRACK_GOVERNANCE_PROFILE.md,
// this emits a track-gate report in the shared shape used by the other
// gate-procs (analytics-gate.js, infra-gate.js). NO html parser dependency —
// the engine is pure Node with zero runtime deps; all parsing is string/regex.

const fs = require("fs");
const path = require("path");

const DEFAULT_LIGHTHOUSE_THRESHOLD = 0.9;

// ---- pure regex helpers (no html parser) ---------------------------------

function hasTag(html, re) {
  return re.test(html);
}

function nonEmptyTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return !!(m && m[1] && m[1].trim().length > 0);
}

// Collect local href/src targets, excluding external/protocol/anchor refs.
function localReferences(html) {
  const refs = [];
  const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const val = m[1].trim();
    if (!val) continue;
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|#)/i.test(val)) continue;
    if (val.startsWith("//")) continue; // protocol-relative => external
    refs.push(val);
  }
  return refs;
}

// Normalize a local reference to a comparable path (strip query/hash, leading ./).
function normalizeRef(ref) {
  let r = ref.split("#")[0].split("?")[0];
  r = r.replace(/^\.\//, "");
  r = r.replace(/^\/+/, "");
  return r;
}

// ---- per-check evaluation (pure) -----------------------------------------

function checkHtmlValidity(pages) {
  const bad = [];
  for (const p of pages) {
    const missing = [];
    if (!hasTag(p.html, /<!doctype\s+html/i)) missing.push("<!doctype html>");
    if (!hasTag(p.html, /<html[\s>]/i)) missing.push("<html>");
    if (!hasTag(p.html, /<head[\s>]/i)) missing.push("<head>");
    if (!nonEmptyTitle(p.html)) missing.push("non-empty <title>");
    if (missing.length) bad.push(`${p.path}: missing ${missing.join(", ")}`);
  }
  return bad.length === 0
    ? { name: "html_validity", result: "pass", detail: `${pages.length} page(s) structurally valid.` }
    : { name: "html_validity", result: "fail", detail: bad.join(" | ") };
}

function checkSeoMeta(pages) {
  const requirements = [
    ["<title>", (h) => nonEmptyTitle(h)],
    ['<meta name="description">', (h) => /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*>/i.test(h)],
    ['<link rel="canonical">', (h) => /<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.test(h)],
    ["og:title", (h) => /<meta\s+[^>]*property\s*=\s*["']og:title["'][^>]*>/i.test(h)],
    ["og:description", (h) => /<meta\s+[^>]*property\s*=\s*["']og:description["'][^>]*>/i.test(h)],
    ["og:image", (h) => /<meta\s+[^>]*property\s*=\s*["']og:image["'][^>]*>/i.test(h)],
    ["twitter:card", (h) => /<meta\s+[^>]*name\s*=\s*["']twitter:card["'][^>]*>/i.test(h)],
    [
      'ld+json Organization',
      (h) => {
        const re = /<script\s+[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(h)) !== null) {
          if (/Organization/.test(m[1])) return true;
        }
        return false;
      },
    ],
  ];
  const bad = [];
  for (const p of pages) {
    const missing = requirements.filter(([, fn]) => !fn(p.html)).map(([label]) => label);
    if (missing.length) bad.push(`${p.path}: missing ${missing.join(", ")}`);
  }
  return bad.length === 0
    ? { name: "seo_meta", result: "pass", detail: `${pages.length} page(s) carry full SEO/social metadata.` }
    : { name: "seo_meta", result: "fail", detail: bad.join(" | ") };
}

function checkLinks(pages, options) {
  const known = options.knownPaths
    ? new Set(options.knownPaths.map(normalizeRef))
    : null;
  const allRefs = [];
  const dangling = [];
  for (const p of pages) {
    for (const ref of localReferences(p.html)) {
      const norm = normalizeRef(ref);
      allRefs.push(norm);
      if (known && norm && !known.has(norm)) {
        dangling.push(`${p.path} -> ${ref}`);
      }
    }
  }
  if (!known) {
    return {
      name: "link_check",
      result: "pass",
      detail: `${allRefs.length} local reference(s) collected; no knownPaths provided to validate against.`,
    };
  }
  return dangling.length === 0
    ? { name: "link_check", result: "pass", detail: `all ${allRefs.length} local reference(s) resolve to known paths.` }
    : { name: "link_check", result: "fail", detail: `dangling reference(s): ${dangling.join(", ")}` };
}

// Normalize a path or URL to a clean comparison key: strip host, query/hash,
// leading "./" or "/", trailing "/", the "index" basename, and ".html". So
// "https://x/", "/", and "index.html" all map to "" (root); "/about",
// "about.html", and "https://x/about" all map to "about". This makes a sitemap
// of clean absolute URLs comparable to on-disk .html page paths.
function cleanKey(s) {
  let v = String(s).split(/[?#]/)[0];
  v = v.replace(/^https?:\/\/[^/]+/i, "");
  v = v.replace(/^\.?\//, "");
  v = v.replace(/\/$/, "");
  v = v.replace(/index\.html?$/i, "");
  v = v.replace(/\.html?$/i, "");
  v = v.replace(/\/$/, "");
  return v;
}

function checkSitemapMembership(pages, options) {
  if (!options.sitemapXml) {
    return { name: "sitemap_membership", result: "skip", detail: "no options.sitemapXml provided." };
  }
  const locs = [...options.sitemapXml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => cleanKey(m[1]));
  const sitemapKeys = new Set(locs);
  const missing = [];
  for (const p of pages) {
    // noindex pages (e.g. a 404) legitimately don't belong in the sitemap
    if (/<meta[^>]+name=["']robots["'][^>]*noindex/i.test(p.html)) continue;
    if (!sitemapKeys.has(cleanKey(p.path))) missing.push(p.path);
  }
  return missing.length === 0
    ? { name: "sitemap_membership", result: "pass", detail: `all ${pages.length} page(s) present in sitemap.` }
    : { name: "sitemap_membership", result: "fail", detail: `not in sitemap: ${missing.join(", ")}` };
}

function checkLighthouse(options) {
  const threshold =
    typeof options.lighthouseThreshold === "number"
      ? options.lighthouseThreshold
      : DEFAULT_LIGHTHOUSE_THRESHOLD;
  if (typeof options.lighthouseScore !== "number") {
    return {
      name: "lighthouse",
      result: "skip",
      detail: "external step; run lighthouse CLI against the preview URL",
    };
  }
  return options.lighthouseScore >= threshold
    ? { name: "lighthouse", result: "pass", detail: `score ${options.lighthouseScore} >= ${threshold}.` }
    : { name: "lighthouse", result: "fail", detail: `score ${options.lighthouseScore} < ${threshold}.` };
}

function checkPreviewUrl(options, artifactPaths) {
  if (!options.previewUrl) {
    return { name: "preview_url", result: "skip", detail: "no options.previewUrl provided." };
  }
  artifactPaths.push(options.previewUrl);
  return { name: "preview_url", result: "pass", detail: `preview available at ${options.previewUrl}.` };
}

// ---- core pure evaluation -------------------------------------------------

// evaluateSite(pages, options) -> report
// pages: [{ path, html }]
// options: { sitemapXml?, knownPaths?, lighthouseScore?, lighthouseThreshold?, previewUrl?, site? }
function evaluateSite(pages, options = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const site = options.site || "site";
  const checks = [];
  const artifactPaths = [];

  if (list.length === 0) {
    checks.push({ name: "html_validity", result: "fail", detail: "no pages provided to gate." });
    return finalize(site, checks, artifactPaths);
  }

  checks.push(checkHtmlValidity(list));
  checks.push(checkSeoMeta(list));
  checks.push(checkLinks(list, options));
  checks.push(checkSitemapMembership(list, options));
  checks.push(checkLighthouse(options));
  checks.push(checkPreviewUrl(options, artifactPaths));

  return finalize(site, checks, artifactPaths);
}

function finalize(site, checks, artifactPaths) {
  const failed = checks.filter((c) => c.result === "fail");
  return {
    gateProc: "content",
    track: "marketing",
    site,
    result: failed.length === 0 ? "pass" : "fail",
    checks,
    artifact_paths: artifactPaths,
    summary:
      failed.length === 0
        ? `content gate pass: ${checks.length} check(s) ok`
        : `content gate fail: ${failed.length}/${checks.length} check(s) failed`,
  };
}

// ---- fs loader (thin layer over the pure core) ---------------------------

// loadSite(dir) -> [{ path, html }] for each *.html file (recursive).
function loadSite(dir) {
  const pages = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        pages.push({ path: path.relative(dir, full), html: fs.readFileSync(full, "utf8") });
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return pages;
}

// List every file under dir (relative paths) — used as knownPaths for the link
// check so references to assets (css/img/js), not just .html pages, resolve.
function listFiles(dir) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(dir, full));
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return files;
}

function readSitemap(sitemapPath) {
  if (!sitemapPath || !fs.existsSync(sitemapPath)) return undefined;
  return fs.readFileSync(sitemapPath, "utf8");
}

// runContentGate({ dir?, pages?, site?, sitemapPath?, sitemapXml?, knownPaths?, lighthouseScore?, previewUrl? })
function runContentGate(options = {}) {
  const opts = Object.assign({}, options);
  const pages = opts.pages || (opts.dir ? loadSite(opts.dir) : []);
  if (!opts.site) opts.site = opts.dir || "site";
  if (!opts.sitemapXml && opts.sitemapPath) opts.sitemapXml = readSitemap(opts.sitemapPath);
  if (!opts.knownPaths && opts.dir && pages.length) {
    // all files (assets included) PLUS their clean-URL forms, so links to
    // extensionless / directory-index URLs (e.g. /insights -> insights/index.html,
    // /about -> about.html) resolve in the link check.
    const files = listFiles(opts.dir);
    opts.knownPaths = [...new Set(files.flatMap((f) => [f, cleanKey(f)]))];
  }
  return evaluateSite(pages, opts);
}

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--site") out.site = argv[++i];
    else if (a === "--sitemap") out.sitemapPath = argv[++i];
    else if (a === "--lighthouse-score") out.lighthouseScore = Number(argv[++i]);
    else if (a === "--preview-url") out.previewUrl = argv[++i];
    else if (!out.dir && !a.startsWith("--")) out.dir = a;
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.dir && !args.pages) {
    process.stderr.write(
      "usage: node content-gate.js <dir> [--sitemap <file>] [--lighthouse-score <n>] [--preview-url <url>] [--json]\n"
    );
    process.exit(2);
  }
  const report = runContentGate(args);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`${report.summary}\n`);
    for (const c of report.checks) {
      process.stdout.write(`  [${c.result}] ${c.name}: ${c.detail}\n`);
    }
  }
  process.exit(report.result === "pass" ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateSite,
  loadSite,
  runContentGate,
  main,
};
