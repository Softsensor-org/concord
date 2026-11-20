import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUSINESS_DOCUMENTS, documentTextElement, readFixedDocuments } from './business-documents.js';
import { loadCoordUiDeps } from './coord-ui-deps.mjs';
const { ts, React, renderToStaticMarkup } = await loadCoordUiDeps();

const HERE = path.dirname(fileURLToPath(import.meta.url));

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-ui-business-docs-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('reads available, empty, and missing fixed documents independently', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'BUSINESS_CONTEXT.md'), '# Context\nplain text <script>alert(1)</script>');
    fs.writeFileSync(path.join(dir, 'BUSINESS_RULES.md'), '  \n');

    const documents = readFixedDocuments(dir, ['BUSINESS_CONTEXT.md', 'BUSINESS_RULES.md', 'WORKFLOW_INVENTORY.md']);
    assert.deepEqual(documents.map(({ state }) => state), ['available', 'empty', 'missing']);
    assert.equal(documents[0].content, '# Context\nplain text <script>alert(1)</script>');
    assert.equal(documents[1].content, '  \n');
    assert.equal(documents[2].content, null);
  });
});

test('domain model is read from the canonical product path and distinguishes absence', () => {
  withTempDir((coordDir) => {
    const productDir = path.join(coordDir, 'product');
    fs.mkdirSync(productDir);
    fs.writeFileSync(path.join(productDir, 'DOMAIN_MODEL.md'), '# Canonical\nEntity: Example');
    assert.deepEqual(readFixedDocuments(productDir, ['DOMAIN_MODEL.md'], coordDir).map(({ state }) => state), [
      'available'
    ]);
    fs.rmSync(path.join(productDir, 'DOMAIN_MODEL.md'));
    assert.deepEqual(readFixedDocuments(productDir, ['DOMAIN_MODEL.md'], coordDir).map(({ state }) => state), [
      'missing'
    ]);
  });
});

test('knowledge page mounts the domain model independently of knowledge-engine availability', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'app', 'knowledge', 'page.tsx'), 'utf8');
  assert.match(source, /\{!k\.found \? \([\s\S]*?\) : \([\s\S]*?\)\}\s*<DomainModelDocument document=\{domainModel\} \/>/);
});

test('document text renders as escaped React text rather than executable markup', () => {
  const markup = renderToStaticMarkup(documentTextElement('<script>alert(1)</script> & literal Markdown'));
  assert.equal(markup, '<pre style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit">&lt;script&gt;alert(1)&lt;/script&gt; &amp; literal Markdown</pre>');
});

test('rejects traversal names and symlinks that resolve outside the document root', () => {
  withTempDir((parent) => {
    const root = path.join(parent, 'docs');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(parent, 'outside.md'), 'private');
    fs.symlinkSync(path.join(parent, 'outside.md'), path.join(root, 'LINK.md'));
    fs.symlinkSync(parent, path.join(parent, 'external-root'));

    const documents = readFixedDocuments(root, ['../outside.md', 'LINK.md', 'INSIDE.md'], parent);
    const escapedRoot = readFixedDocuments(path.join(parent, 'external-root'), ['outside.md'], root);
    assert.deepEqual(documents.map(({ state, content }) => [state, content]), [
      ['outside-root', null],
      ['outside-root', null],
      ['missing', null]
    ]);
    assert.deepEqual(escapedRoot.map(({ state }) => state), ['outside-root']);
  });
});

test('business summary list covers the eight canonical synthesized documents', () => {
  assert.deepEqual(BUSINESS_DOCUMENTS, [
    'BUSINESS_CONTEXT.md',
    'BUSINESS_RULES.md',
    'WORKFLOW_INVENTORY.md',
    'DOWNSTREAM_CONTRACTS.md',
    'DECISION_LOG.md',
    'KNOWN_WORKAROUNDS.md',
    'OPEN_BUSINESS_QUESTIONS.md',
    'PRESERVATION_HARNESS_CANDIDATES.md'
  ]);
});
