import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseUrsInline, parseUrsMarkdown } from './urs-markdown.js';

// COORD-567: /urs must render the requirements document's lists and tables as
// lists and tables, not as one <pre> box per source line.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'app', 'urs', 'page.tsx');
const REAL_DOC = path.join(HERE, '..', '..', '..', '..', 'coord', 'product', 'REQUIREMENTS.md');

// Shaped like coord/product/REQUIREMENTS.md: metadata, a source-declaration
// list, a requirement with wrapped acceptance criteria, and the traceability
// pipe table. The numbered list, emphasis and thematic break are the remaining
// structures the ticket names.
const DOC = [
  '# Product Requirements',
  '',
  'Status: imported baseline',
  'Date: 2026-05-22',
  '',
  'Imported source documents:',
  '',
  '- `docs/product/PRD.md`',
  '- `docs/product/URS.md`',
  '',
  '## Functional Requirements',
  '',
  '### REQ-001: Repo-Local Governance Install',
  '',
  'Coord **must** support installing the scaffold into an *existing* project.',
  '',
  'Acceptance criteria:',
  '',
  '- Transactional installation is provided only by the published',
  '  `create-concord` package and standalone SEA binary. `init.sh` is retired;',
  '  explicit manual copy is a recovery procedure, not an equivalent installer.',
  '- `coord/project.config.js` is the project-owned repo-map seam.',
  '- Public docs must not claim `coord init` until that command exists',
  '  and is tested.',
  '',
  'Rollout order:',
  '',
  '1. Install the scaffold.',
  '2. Configure the repo map:',
  '   - set `integrationBranch`',
  '   - set repo codes',
  '3. Run the gates.',
  '',
  '---',
  '',
  '## Traceability',
  '',
  '| Requirement | Primary Tickets |',
  '| --- | --- |',
  '| REQ-001 | `PILOT-001`, `PILOT-002`, future `PROD-002` |',
  '| REQ-002 | `COORD-003` through `COORD-010`, `PILOT-008` |',
  '',
].join('\n');

function plain(inline) {
  return inline
    .map((t) => (t.type === 'text' || t.type === 'code' ? t.text : plain(t.children)))
    .join('');
}

function ofType(blocks, type) {
  return blocks.filter((b) => b.type === type);
}

test('bullet lines are grouped into one list with one item per bullet', () => {
  const lists = ofType(parseUrsMarkdown(DOC), 'list');
  const sources = lists[0];
  assert.equal(sources.ordered, false);
  assert.deepEqual(
    sources.items.map((i) => plain(i.inline)),
    ['docs/product/PRD.md', 'docs/product/URS.md']
  );
  assert.equal(sources.items[0].inline[0].type, 'code');
});

test('wrapped acceptance criteria stay inside their list item', () => {
  const blocks = parseUrsMarkdown(DOC);
  const criteria = ofType(blocks, 'list')[1];
  assert.equal(criteria.items.length, 3);
  assert.equal(
    plain(criteria.items[0].inline),
    'Transactional installation is provided only by the published create-concord package and ' +
      'standalone SEA binary. init.sh is retired; explicit manual copy is a recovery procedure, ' +
      'not an equivalent installer.'
  );
  assert.equal(
    plain(criteria.items[2].inline),
    'Public docs must not claim coord init until that command exists and is tested.'
  );
  const strayContinuation = ofType(blocks, 'paragraph').filter((p) =>
    /recovery procedure|and is tested/.test(plain(p.inline))
  );
  assert.deepEqual(strayContinuation, []);
});

test('numbered lines become one ordered list and keep nested bullets', () => {
  const ordered = ofType(parseUrsMarkdown(DOC), 'list').filter((l) => l.ordered);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].start, 1);
  assert.deepEqual(
    ordered[0].items.map((i) => plain(i.inline)),
    ['Install the scaffold.', 'Configure the repo map:', 'Run the gates.']
  );
  const nested = ordered[0].items[1].children;
  assert.equal(nested.length, 1);
  assert.equal(nested[0].type, 'list');
  assert.equal(nested[0].ordered, false);
  assert.deepEqual(
    nested[0].items.map((i) => plain(i.inline)),
    ['set integrationBranch', 'set repo codes']
  );
});

test('a pipe table becomes header cells and body rows without raw pipes', () => {
  const tables = ofType(parseUrsMarkdown(DOC), 'table');
  assert.equal(tables.length, 1);
  const table = tables[0];
  assert.deepEqual(table.header.map(plain), ['Requirement', 'Primary Tickets']);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0].map(plain), ['REQ-001', 'PILOT-001, PILOT-002, future PROD-002']);
  assert.deepEqual(
    table.rows[0][1].filter((t) => t.type === 'code').map((t) => t.text),
    ['PILOT-001', 'PILOT-002', 'PROD-002']
  );
  for (const row of [table.header, ...table.rows]) {
    for (const cell of row) assert.ok(!plain(cell).includes('|'), 'cell must not carry a raw pipe');
  }
});

test('table rows are normalised to the header width and honour escaped pipes', () => {
  const [table] = parseUrsMarkdown(
    ['| A | B | C |', '|:--|:-:|--:|', '| 1 | a \\| b |', '| 1 | 2 | 3 | 4 |'].join('\n')
  );
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.deepEqual(table.rows.map((r) => r.map(plain)), [
    ['1', 'a | b', ''],
    ['1', '2', '3'],
  ]);
});

test('pipe lines without a delimiter row stay prose', () => {
  const blocks = parseUrsMarkdown('| not a table |\n\nafter');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['paragraph', 'paragraph']
  );
  assert.equal(plain(blocks[0].inline), '| not a table |');
});

test('emphasis is parsed instead of showing literal asterisks', () => {
  const para = ofType(parseUrsMarkdown(DOC), 'paragraph').find((p) =>
    plain(p.inline).startsWith('Coord must support')
  );
  assert.ok(para, 'requirement statement paragraph');
  assert.deepEqual(para.inline, [
    { type: 'text', text: 'Coord ' },
    { type: 'strong', children: [{ type: 'text', text: 'must' }] },
    { type: 'text', text: ' support installing the scaffold into an ' },
    { type: 'em', children: [{ type: 'text', text: 'existing' }] },
    { type: 'text', text: ' project.' },
  ]);
});

test('inline parsing leaves identifiers, globs in code and stray markers alone', () => {
  assert.deepEqual(parseUrsInline('snake_case_name and 2 * 3 * 4'), [
    { type: 'text', text: 'snake_case_name and 2 * 3 * 4' },
  ]);
  assert.deepEqual(parseUrsInline('`**/*.test.js` stays code'), [
    { type: 'code', text: '**/*.test.js' },
    { type: 'text', text: ' stays code' },
  ]);
  assert.deepEqual(parseUrsInline('an **unclosed marker'), [
    { type: 'text', text: 'an **unclosed marker' },
  ]);
  assert.deepEqual(parseUrsInline('escaped \\*not emphasis\\*'), [
    { type: 'text', text: 'escaped *not emphasis*' },
  ]);
  assert.deepEqual(parseUrsInline('__bold__ and ***both***'), [
    { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
    { type: 'text', text: ' and ' },
    { type: 'strong', children: [{ type: 'em', children: [{ type: 'text', text: 'both' }] }] },
  ]);
});

test('a thematic break is a rule, not text or a list item', () => {
  const blocks = parseUrsMarkdown(DOC);
  assert.equal(ofType(blocks, 'hr').length, 1);
  assert.ok(!ofType(blocks, 'paragraph').some((p) => plain(p.inline).includes('---')));
  assert.deepEqual(
    parseUrsMarkdown('above\n\n* * *\n\n___\n\nbelow').map((b) => b.type),
    ['paragraph', 'hr', 'hr', 'paragraph']
  );
});

test('headings keep their source line so the page can attach contents anchors', () => {
  const headings = ofType(parseUrsMarkdown(DOC), 'heading');
  assert.deepEqual(
    headings.map((h) => [h.level, h.line, plain(h.inline)]),
    [
      [1, 1, 'Product Requirements'],
      [2, 11, 'Functional Requirements'],
      [3, 13, 'REQ-001: Repo-Local Governance Install'],
      [2, 36, 'Traceability'],
    ]
  );
});

test('fenced code is kept verbatim and is not parsed as lists or tables', () => {
  const blocks = parseUrsMarkdown(['```sh', '- not a list', '| not | a table |', '```', 'tail'].join('\n'));
  assert.deepEqual(blocks, [
    { type: 'code', lang: 'sh', text: '- not a list\n| not | a table |' },
    { type: 'paragraph', inline: [{ type: 'text', text: 'tail' }] },
  ]);
  assert.deepEqual(parseUrsMarkdown('```x``` is inline code\n\nnext'), [
    {
      type: 'paragraph',
      inline: [
        { type: 'code', text: 'x' },
        { type: 'text', text: ' is inline code' },
      ],
    },
    { type: 'paragraph', inline: [{ type: 'text', text: 'next' }] },
  ]);
});

test('markup in the document stays text: the parser never emits html', () => {
  const blocks = parseUrsMarkdown(
    ['- <img src=x onerror=alert(1)>', '', '| <script>alert(1)</script> |', '| --- |', '| [x](javascript:alert(1)) |'].join(
      '\n'
    )
  );
  assert.equal(plain(blocks[0].items[0].inline), '<img src=x onerror=alert(1)>');
  assert.equal(plain(blocks[1].header[0]), '<script>alert(1)</script>');
  assert.equal(plain(blocks[1].rows[0][0]), '[x](javascript:alert(1))');
  const kinds = new Set();
  const walk = (inline) =>
    inline.forEach((t) => {
      kinds.add(t.type);
      if (t.children) walk(t.children);
    });
  walk(blocks[0].items[0].inline);
  blocks[1].header.forEach(walk);
  blocks[1].rows.forEach((r) => r.forEach(walk));
  assert.deepEqual([...kinds], ['text']);
});

test('pathological delimiter runs parse in bounded time', () => {
  const started = process.hrtime.bigint();
  parseUrsInline('*a '.repeat(20000) + '`'.repeat(1) + ' `` '.repeat(20000));
  assert.deepEqual(parseUrsInline('*'.repeat(120000)), [{ type: 'text', text: '*'.repeat(120000) }]);
  parseUrsInline('**a '.repeat(40000));
  parseUrsInline('_a_'.repeat(40000));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `inline parse took ${ms}ms`);
});

test('the real requirements document parses with every list and table intact', (t) => {
  if (!fs.existsSync(REAL_DOC)) {
    t.skip('coord/product/REQUIREMENTS.md is not present in this checkout');
    return;
  }
  const raw = fs.readFileSync(REAL_DOC, 'utf8');
  const lines = raw.split('\n');
  const blocks = parseUrsMarkdown(raw);

  const countItems = (list) =>
    list.items.reduce(
      (n, item) => n + 1 + item.children.filter((c) => c.type === 'list').reduce((m, c) => m + countItems(c), 0),
      0
    );
  const itemCount = ofType(blocks, 'list').reduce((n, l) => n + countItems(l), 0);
  assert.equal(itemCount, lines.filter((l) => /^\s*([-*]|\d+\.)\s+/.test(l)).length);

  const tableRows = ofType(blocks, 'table').reduce((n, tb) => n + tb.rows.length, 0);
  assert.equal(tableRows, lines.filter((l) => l.startsWith('|')).length - 2 * ofType(blocks, 'table').length);

  for (const p of ofType(blocks, 'paragraph')) {
    const text = plain(p.inline);
    assert.ok(!/^([-*]|\d+\.)\s/.test(text), `list line leaked into prose: ${text.slice(0, 60)}`);
    assert.ok(!text.startsWith('|'), `table line leaked into prose: ${text.slice(0, 60)}`);
  }
  assert.equal(
    ofType(blocks, 'heading').length,
    lines.filter((l) => /^#{1,4}\s+/.test(l)).length
  );
});

test('the /urs page renders parsed blocks as elements and injects no html', () => {
  const page = fs.readFileSync(PAGE, 'utf8');
  assert.match(page, /parseUrsMarkdown\(/, 'page must render through the block parser');
  assert.ok(!/line\.startsWith\('\|'\)/.test(page), 'the one-pre-per-line branch must be gone');
  for (const tag of ['<ul', '<ol', '<li', '<table', '<th', '<td', '<hr', '<strong', '<em']) {
    assert.ok(page.includes(tag), `page must render ${tag}>`);
  }
  assert.ok(!page.includes('dangerouslySetInnerHTML'), 'document text must stay escaped by React');
});
