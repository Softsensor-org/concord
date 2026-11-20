import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveBoardCounts, VISIBLE_BOARD_STATUSES } from './board-counts.js';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoordUiDeps } from './coord-ui-deps.mjs';
const { ts, React, renderToStaticMarkup } = await loadCoordUiDeps();

const pagePath = fileURLToPath(new URL('../app/page.tsx', import.meta.url));


const statuses = ['proposed', 'todo', 'doing', 'review', 'done', 'blocked', 'superseded', 'unknown'];
function board(counts) {
  const byStatus = Object.fromEntries(statuses.map((status) => [status, Array.from({ length: counts[status] || 0 }, (_, i) => ({ id: `${status}-${i}`, status }))]));
  return { rows: statuses.flatMap((status) => byStatus[status]), byStatus, locks: new Map(), closedCount: 0 };
}

test('mixed visible and omitted rows reconcile, including proposed and honest unclassified placement', () => {
  const counts = deriveBoardCounts(board({ proposed: 1, todo: 2, unknown: 3, superseded: 4 }));
  assert.equal(counts.totalCount, 10);
  assert.equal(counts.visibleCount, 6, 'proposed and unknown count in lanes currently rendered');
  assert.equal(counts.omittedCount, 4);
  assert.deepEqual(counts.omittedByStatus, [{ status: 'superseded', count: 4 }]);
  assert.equal(counts.unclassifiedCount, 3);
  assert.equal(counts.unclassifiedDisposition, 'visible-lane');
  assert.equal(counts.visibleCount + counts.omittedCount, counts.totalCount);
});

test('zero-row and all-visible partitions are explicit', () => {
  const empty = deriveBoardCounts(board({}));
  assert.deepEqual([empty.totalCount, empty.visibleCount, empty.omittedCount], [0, 0, 0]);
  assert.deepEqual(empty.omittedByStatus, [{ status: 'superseded', count: 0 }]);
  const allVisible = deriveBoardCounts(board({ proposed: 1, todo: 2, doing: 1, unknown: 1 }));
  assert.deepEqual([allVisible.totalCount, allVisible.visibleCount, allVisible.omittedCount], [5, 5, 0]);
});

test('the page lane status constant includes proposed and unknown exactly once', () => {
  assert.deepEqual([...VISIBLE_BOARD_STATUSES], ['proposed', 'todo', 'doing', 'review', 'done', 'blocked', 'unknown']);
});

test('mismatched row total and final status buckets fail closed', () => {
  const input = board({ todo: 1, superseded: 1 });
  input.rows.pop();
  assert.throws(() => deriveBoardCounts(input), /Board row partition mismatch: rows=1, buckets=2/);
});

test('equal-sized buckets with a different canonical row identity fail closed', () => {
  const input = board({ todo: 2 });
  input.byStatus.todo[1] = { id: 'not-in-canonical-rows', status: 'todo' };
  assert.throws(
    () => deriveBoardCounts(input),
    /1 canonical rows missing from buckets; 1 bucket rows absent from canonical rows/
  );
});

test('a repeated bucket row identity fails closed', () => {
  const input = board({ todo: 2 });
  input.byStatus.todo[1] = { ...input.byStatus.todo[0] };
  assert.throws(() => deriveBoardCounts(input), /row todo-0 appears in multiple buckets/);
});


test('matching identities with conflicting canonical statuses fail closed', () => {
  const input = board({ todo: 1 });
  input.rows = [{ ...input.rows[0], status: 'done' }];
  assert.throws(() => deriveBoardCounts(input), /canonical row todo-0 carries status done but is bucketed as todo/);
});

function render(value) {
  const fixtures = {
    '../lib/board': { loadBoard: () => value },
    '../lib/agents': { loadAgents: () => ({ live: 0, stale: 0, offline: 0 }) },
    '../lib/findings': { loadFindings: () => ({ open: 0 }) },
    '../lib/git': { summarizeGitStatus: () => ({ dirty: 0, unresolved: 0 }) },
    '../lib/gates': { loadGates: () => ({ failing: 0, passing: 0 }) },
    '../lib/health': { loadHealth: () => ({ overall: 'ok', checks: [] }) },
    '../lib/tests': { loadTests: () => ({ failingLaneSteps: 0, totalTestFiles: 0, unresolvedRepos: 0 }) },
    '../lib/readiness': { loadReadinessView: () => ({ found: false, generatedCommand: 'hidden' }) },
    '../lib/board-state.js': { nonRunnableStatusGuidance: () => null },
    '../components/blocked-reason': { BlockedReason: () => null }
  };
  const original = Module._load;
  const page = new Module(pagePath);
  page.filename = pagePath;
  page.paths = Module._nodeModulePaths(path.dirname(pagePath));
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === pagePath && request === 'next/link') return { __esModule: true, default: ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children) };
    if (parent?.filename === pagePath && request === '../lib/board-counts.js') return { deriveBoardCounts, VISIBLE_BOARD_STATUSES };
    if (parent?.filename === pagePath && Object.hasOwn(fixtures, request)) return fixtures[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    const compiled = ts.transpileModule(fs.readFileSync(pagePath, 'utf8'), {
      fileName: pagePath,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
    }).outputText;
    page._compile(compiled, pagePath);
    return renderToStaticMarkup(React.createElement(page.exports.default));
  } finally {
    Module._load = original;
  }
}

test('rendered dashboard count reconciles total, visible lanes, and omitted status counts', () => {
  const markup = render(board({ proposed: 1, todo: 2, unknown: 3, superseded: 4 }));
  assert.match(markup, /10<\/strong> total = <strong>6<\/strong> in visible lanes \+ <strong>4<\/strong> not shown \(superseded 4\)/);
  assert.match(markup, /unclassified: 3 visible in the needs-investigation lane \(0 omitted\)/);
});

test('rendered dashboard reports zero rows and all-visible rows honestly', () => {
  const empty = render(board({}));
  assert.match(empty, /0<\/strong> total = <strong>0<\/strong> in visible lanes \+ <strong>0<\/strong> not shown \(superseded 0\)/);
  const allVisible = render(board({ proposed: 1, todo: 2, unknown: 1 }));
  assert.match(allVisible, /4<\/strong> total = <strong>4<\/strong> in visible lanes \+ <strong>0<\/strong> not shown/);
});

test('a mismatched final BoardView partition refuses to render a misleading summary', () => {
  const invalid = board({ todo: 1, superseded: 1 });
  invalid.rows.pop();
  assert.throws(() => render(invalid), /Board row partition mismatch/);
});
