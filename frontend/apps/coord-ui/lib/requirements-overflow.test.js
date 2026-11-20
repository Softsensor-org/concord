import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { loadCoordUiDeps } from './coord-ui-deps.mjs';
const { ts, React, renderToStaticMarkup } = await loadCoordUiDeps();

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const huge = `generate-${'X'.repeat(320)}-report`;
const longPath = `coord/product/${'deep'.repeat(80)}-requirements.md`;
const longMissingPath = `coord/missing/${'source'.repeat(80)}-requirements.json`;
const longMarkdown = `requirement-${'M'.repeat(360)}-tail`;
const link = ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children);

async function renderTsx(file, requests, invoke) {
  const page = new Module(file);
  page.filename = file;
  page.paths = Module._nodeModulePaths(path.dirname(file));
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === file && request === 'next/link') return { __esModule: true, default: link };
    if (parent?.filename === file && Object.hasOwn(requests, request)) return requests[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
    }).outputText;
    page._compile(code, file);
    const element = await invoke(page.exports.default);
    return renderToStaticMarkup(element);
  } finally {
    Module._load = original;
  }
}

test('requirements generated values stay inside explicit overflow wrappers', async () => {
  const overview = await renderTsx(path.join(root, 'app/requirements/page.tsx'), {
    '../../lib/requirements': {
      loadRequirements: () => ({
        found: true,
        views: [{ id: 'x', route: '/requirements/x', title: 'X', copy_command: huge, available: true, missing_sources: [] }],
        summary: { views: 1, available_views: 1, missing_all_sources: 0 }
      })
    }
  }, (Page) => Page());
  assert.match(overview, /class="ac-stat"><div class="ac-overflow"><code>/);
  assert.ok(overview.includes(huge));

  const detailFile = path.join(root, 'app/requirements/[slug]/page.tsx');
  const detail = await renderTsx(detailFile, {
    'next/navigation': { notFound: () => { throw new Error('unexpected notFound'); } },
    '../../../lib/requirements': {
      loadRequirementView: () => ({
        slug: 'x', id: 'x', route: '/requirements/x', title: 'X', copy_command: huge,
        available: true, missing_sources: [longMissingPath], source_status: [{ path: longPath, exists: true, kind: 'generated' }]
      }),
      loadRequirements: () => ({ views: [{ route: '/requirements/x' }] }),
      slugForRequirementRoute: () => 'x'
    }
  }, (Page) => Page({ params: Promise.resolve({ slug: 'x' }) }));
  assert.match(detail, /class="ac-stat"><div class="ac-overflow"><code>/);
  assert.match(detail, /class="ac-overflow"><code>/);
  assert.ok(detail.includes(huge));
  assert.ok(detail.includes(longPath));
  assert.ok(detail.includes(`<li class="ac-stat"><span class="ac-overflow"><code>${longMissingPath}</code></span></li>`));
});

test('long requirements Markdown remains in its constrained document and wide tables keep a scroll wrapper', async () => {
  const urs = await renderTsx(path.join(root, 'app/urs/page.tsx'), {
    '../../lib/urs': { loadUrs: () => ({ found: true, raw: longMarkdown, title: 'URS', headings: [] }) },
    '../../lib/traceability': { loadTraceability: () => ({ withRealClosure: 0, total: 0, verified: 0, closingGap: 0 }) },
    '../../lib/urs-markdown': { parseUrsMarkdown: () => [
      { type: 'paragraph', inline: [{ type: 'text', text: longMarkdown }] },
      { type: 'table', header: [[{ type: 'text', text: 'Source path' }]], align: [null], rows: [[[{ type: 'text', text: longPath }]]] }
    ] }
  }, (Page) => Page());
  assert.match(urs, /class="urs-doc"/);
  assert.ok(urs.includes(longMarkdown));
  assert.match(urs, /class="urs-table-wrap"><table/);
  assert.ok(urs.includes(longPath));
});

test('overflow wrappers and their card/grid parents can shrink while preserving inner scrolling', () => {
  const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
  assert.match(css, /\.action-center\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(15rem,\s*100%\),\s*1fr\)\)/s);
  assert.match(css, /\.ac-card\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.ac-stat\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.ac-overflow\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.ac-overflow\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.ac-overflow\s*\{[^}]*word-break:\s*break-word/s);
  assert.match(css, /\.urs-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*260px\)\s+minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.urs-doc\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.urs-doc\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.urs-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
});
