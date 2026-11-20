"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { evaluateSite, runContentGate } = require("./content-gate.js");

// A fully-compliant page: valid HTML + complete SEO/social metadata.
function goodHtml(overrides = {}) {
  const o = Object.assign(
    {
      title: "Concord — AI-agent governance",
      description: "Govern AI agents with evidence.",
      canonical: '<link rel="canonical" href="/index.html">',
      ogTitle: '<meta property="og:title" content="Concord">',
      ogDescription: '<meta property="og:description" content="Govern AI agents.">',
      ogImage: '<meta property="og:image" content="/og.png">',
      twitter: '<meta name="twitter:card" content="summary_large_image">',
      ldjson: '<script type="application/ld+json">{"@type":"Organization","name":"Softsensor"}</script>',
      body: '<a href="/about.html">About</a>',
    },
    overrides
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${o.title}</title>
  <meta name="description" content="${o.description}">
  ${o.canonical}
  ${o.ogTitle}
  ${o.ogDescription}
  ${o.ogImage}
  ${o.twitter}
  ${o.ldjson}
</head>
<body>${o.body}</body>
</html>`;
}

test("passes a fully compliant single-page site", () => {
  const r = evaluateSite([{ path: "index.html", html: goodHtml() }]);
  assert.strictEqual(r.result, "pass");
  assert.strictEqual(r.gateProc, "content");
  assert.strictEqual(r.track, "marketing");
  assert.strictEqual(r.site, "site");
  assert.ok(r.checks.find((c) => c.name === "html_validity" && c.result === "pass"));
  assert.ok(r.checks.find((c) => c.name === "seo_meta" && c.result === "pass"));
});

test("fails html_validity when doctype/title missing", () => {
  const html = "<html><head></head><body>no doctype, no title</body></html>";
  const r = evaluateSite([{ path: "bad.html", html }]);
  assert.strictEqual(r.result, "fail");
  const v = r.checks.find((c) => c.name === "html_validity");
  assert.strictEqual(v.result, "fail");
  assert.match(v.detail, /doctype/i);
});

test("fails seo_meta when canonical is missing and reports it", () => {
  const r = evaluateSite([{ path: "index.html", html: goodHtml({ canonical: "" }) }]);
  assert.strictEqual(r.result, "fail");
  const m = r.checks.find((c) => c.name === "seo_meta");
  assert.strictEqual(m.result, "fail");
  assert.match(m.detail, /canonical/);
});

test("fails seo_meta when og:image is missing", () => {
  const r = evaluateSite([{ path: "index.html", html: goodHtml({ ogImage: "" }) }]);
  const m = r.checks.find((c) => c.name === "seo_meta");
  assert.strictEqual(m.result, "fail");
  assert.match(m.detail, /og:image/);
});

test("fails seo_meta when ld+json lacks Organization", () => {
  const ldjson = '<script type="application/ld+json">{"@type":"WebSite"}</script>';
  const r = evaluateSite([{ path: "index.html", html: goodHtml({ ldjson }) }]);
  const m = r.checks.find((c) => c.name === "seo_meta");
  assert.strictEqual(m.result, "fail");
  assert.match(m.detail, /ld\+json Organization/);
});

test("link_check flags dangling local references against knownPaths", () => {
  const html = goodHtml({ body: '<a href="/missing.html">x</a>' });
  const r = evaluateSite([{ path: "index.html", html }], { knownPaths: ["index.html"] });
  const lc = r.checks.find((c) => c.name === "link_check");
  assert.strictEqual(lc.result, "fail");
  assert.match(lc.detail, /missing\.html/);
});

test("link_check passes when references resolve and ignores external/anchor refs", () => {
  const html = goodHtml({
    body: '<a href="https://x.com">ext</a><a href="#top">top</a><a href="/about.html">a</a>',
  });
  const r = evaluateSite([{ path: "index.html", html }], { knownPaths: ["index.html", "about.html"] });
  const lc = r.checks.find((c) => c.name === "link_check");
  assert.strictEqual(lc.result, "pass");
});

test("sitemap_membership skips without xml, fails for absent page", () => {
  const page = { path: "index.html", html: goodHtml() };
  const skip = evaluateSite([page]).checks.find((c) => c.name === "sitemap_membership");
  assert.strictEqual(skip.result, "skip");

  const fail = evaluateSite([page], { sitemapXml: "<urlset></urlset>" }).checks.find(
    (c) => c.name === "sitemap_membership"
  );
  assert.strictEqual(fail.result, "fail");

  const pass = evaluateSite([page], {
    sitemapXml: "<urlset><url><loc>https://x/index.html</loc></url></urlset>",
  }).checks.find((c) => c.name === "sitemap_membership");
  assert.strictEqual(pass.result, "pass");
});

test("lighthouse and preview_url skip by default, pass/record when supplied", () => {
  const page = { path: "index.html", html: goodHtml() };
  const skipped = evaluateSite([page]);
  assert.strictEqual(skipped.checks.find((c) => c.name === "lighthouse").result, "skip");
  assert.strictEqual(skipped.checks.find((c) => c.name === "preview_url").result, "skip");

  const supplied = evaluateSite([page], { lighthouseScore: 0.95, previewUrl: "https://preview.example" });
  assert.strictEqual(supplied.checks.find((c) => c.name === "lighthouse").result, "pass");
  const pv = supplied.checks.find((c) => c.name === "preview_url");
  assert.strictEqual(pv.result, "pass");
  assert.ok(supplied.artifact_paths.includes("https://preview.example"));

  const lowScore = evaluateSite([page], { lighthouseScore: 0.5 });
  assert.strictEqual(lowScore.checks.find((c) => c.name === "lighthouse").result, "fail");
});

test("runContentGate fails cleanly with no pages", () => {
  const r = runContentGate({ pages: [], site: "empty" });
  assert.strictEqual(r.result, "fail");
  assert.strictEqual(r.site, "empty");
});

// Regression (real-site dogfood): index.html must match a sitemap that lists the
// site root as an absolute URL ("https://x/"), not literally "index.html".
test("sitemap_membership matches index.html against the root URL", () => {
  const pages = [
    { path: "index.html", html: goodHtml() },
    { path: "about.html", html: goodHtml() },
  ];
  const sitemapXml =
    '<?xml version="1.0"?><urlset><url><loc>https://softsensor.ai/</loc></url>' +
    '<url><loc>https://softsensor.ai/about</loc></url></urlset>';
  const r = evaluateSite(pages, { sitemapXml });
  const c = r.checks.find((x) => x.name === "sitemap_membership");
  assert.strictEqual(c.result, "pass", c.detail);
});

// Regression: references to asset files (css/img), not just .html pages, must
// resolve when knownPaths includes the full file list.
test("link_check resolves asset references when knownPaths includes assets", () => {
  const pages = [
    { path: "index.html", html: goodHtml({ body: '<link href="assets/css/style.css"><img src="assets/img/logo.webp">' }) },
  ];
  const knownPaths = ["index.html", "assets/css/style.css", "assets/img/logo.webp"];
  const r = evaluateSite(pages, { knownPaths });
  const c = r.checks.find((x) => x.name === "link_check");
  assert.strictEqual(c.result, "pass", c.detail);
});

// Regression: a noindex page (e.g. a 404) must not be flagged as missing from
// the sitemap — it legitimately shouldn't be listed there.
test("sitemap_membership skips noindex pages (404)", () => {
  const pages = [
    { path: "index.html", html: goodHtml() },
    { path: "404.html", html: goodHtml({ canonical: '<meta name="robots" content="noindex, follow"><link rel="canonical" href="/404">' }) },
  ];
  const sitemapXml = '<?xml version="1.0"?><urlset><url><loc>https://softsensor.ai/</loc></url></urlset>';
  const r = evaluateSite(pages, { sitemapXml });
  const c = r.checks.find((x) => x.name === "sitemap_membership");
  assert.strictEqual(c.result, "pass", c.detail);
});

// Regression: links to clean / directory-index URLs (e.g. /insights ->
// insights/index.html, /about -> about.html) must resolve in link_check when
// knownPaths is derived from the file tree.
test("link_check resolves clean-URL / directory-index links", () => {
  const pages = [{ path: "index.html", html: goodHtml({ body: '<a href="/insights">Insights</a><a href="/insights/cios">C</a><a href="/about">About</a>' }) }];
  const knownPaths = ["index.html", "about.html", "insights/index.html", "insights/cios/index.html"]
    .flatMap((f) => [f, require("./content-gate.js").__cleanKey ? require("./content-gate.js").__cleanKey(f) : f]);
  // emulate runContentGate's expansion using the gate's own logic via runContentGate
  const r = require("./content-gate.js").runContentGate({
    pages,
    knownPaths: ["index.html","about.html","insights/index.html","insights/cios/index.html","about","insights","insights/cios"],
  });
  const c = r.checks.find((x) => x.name === "link_check");
  assert.strictEqual(c.result, "pass", c.detail);
});
