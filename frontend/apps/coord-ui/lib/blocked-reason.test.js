import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nonRunnableStatusGuidance } from './board-state.js';
import * as boardCounts from './board-counts.js';
import { loadCoordUiDeps } from './coord-ui-deps.mjs';
const { ts, React, renderToStaticMarkup } = await loadCoordUiDeps();

const componentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../components/blocked-reason.tsx');
const navigationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../components/operator-navigation.tsx');
const pagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/page.tsx');

function loadProductionComponent() {
  const source = fs.readFileSync(componentPath, 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: componentPath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const loaded = new Module(componentPath);
  loaded.filename = componentPath;
  loaded.paths = Module._nodeModulePaths(path.dirname(componentPath));
  loaded._compile(compiled, componentPath);
  return loaded.exports.BlockedReason;
}

test('blocked reason component renders markup-like reason as escaped React text', () => {
  const BlockedReason = loadProductionComponent();
  const markup = renderToStaticMarkup(React.createElement(BlockedReason, { reason: '<img src=x onerror=alert(1)>' }));
  assert.equal(markup, '<div class="card__title"><strong>blocked: </strong>&lt;img src=x onerror=alert(1)&gt;</div>');
});

test('navigation explains the existing manual specialized-view toggle and setup emptiness', () => {
  const source = fs.readFileSync(navigationPath, 'utf8');
  assert.match(source, /Show specialized views and command details/);
  assert.match(source, /Start with common workspace views\. Show specialized views as you add workflow, cost, and integration data; they may be empty during setup\./);
});

test('production board page uses plain-language lanes and keeps ticket, blocker, and health details legible', () => {
  const rows = {
    proposed: [{ id: 'UI-PROPOSED', repo: 'F', status: 'proposed', description: 'A long ticket title with a longunbrokenidentifierthatshouldremainavailableinfull', source: 'tasks.json' }],
    todo: [], doing: [], review: [], done: [],
    blocked: [{ id: 'UI-BLOCKED', repo: 'F', status: 'blocked', blockedReason: '<img onerror=alert(1)>', source: 'tasks.json' }],
    superseded: [],
    unknown: [{ id: 'UI-UNKNOWN', repo: 'F', status: 'unknown', source: 'tasks.json' }]
  };
  const board = {
    rows: [...rows.proposed, ...rows.blocked, ...rows.unknown],
    locks: new Map([['UI-LOCKED', { id: 'UI-LOCKED' }]]),
    byStatus: rows,
    closedCount: 0
  };
  let healthFixture = {
    overall: 'warn',
    checks: [{ name: 'Gate authority', level: 'warn', detail: 'No gate artifacts found.' }]
  };
  const fixtureModules = {
    '../lib/board': { loadBoard: () => board },
    '../lib/board-state.js': { nonRunnableStatusGuidance },
    '../lib/board-counts.js': boardCounts,
    '../lib/agents': { loadAgents: () => ({ live: 2, stale: 1, offline: 1 }) },
    '../lib/findings': { loadFindings: () => ({ open: 0 }) },
    '../lib/git': { summarizeGitStatus: () => ({ dirty: 0, unresolved: 0 }) },
    '../lib/gates': { loadGates: () => ({ failing: 0, passing: 0 }) },
    '../lib/health': { loadHealth: () => healthFixture },
    '../lib/tests': { loadTests: () => ({ failingLaneSteps: 0, totalTestFiles: 0, unresolvedRepos: 0 }) },
    '../lib/readiness': { loadReadinessView: () => ({ found: false, generatedCommand: 'SHOULD_NOT_BE_RENDERED' }) }
  };
  const originalLoad = Module._load;
  const BlockedReason = loadProductionComponent();
  const Link = ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children);
  const pageModule = new Module(pagePath);
  pageModule.filename = pagePath;
  pageModule.paths = Module._nodeModulePaths(path.dirname(pagePath));

  Module._load = function loadWithBoardFixtures(request, parent, isMain) {
    if (parent?.filename === pagePath && request === 'next/link') {
      return { __esModule: true, default: Link };
    }
    if (parent?.filename === pagePath && request === '../components/blocked-reason') {
      return { BlockedReason };
    }
    if (parent?.filename === pagePath && fixtureModules[request]) {
      return fixtureModules[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const compiled = ts.transpileModule(fs.readFileSync(pagePath, 'utf8'), {
      fileName: pagePath,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
    }).outputText;
    pageModule._compile(compiled, pagePath);
    const renderPage = () => renderToStaticMarkup(React.createElement(pageModule.exports.default));
    const markup = renderPage();
    const proposedHeader = markup.indexOf('>awaiting acceptance<');
    const todoHeader = markup.indexOf('>not started<');
    assert.ok(proposedHeader >= 0 && todoHeader >= 0 && proposedHeader < todoHeader, 'acceptance lane is first before not-started lane');
    assert.match(markup, /UI-PROPOSED/);
    assert.match(markup, /title="A long ticket title with a longunbrokenidentifierthatshouldremainavailableinfull"/);
    assert.match(markup, /Accepted tickets awaiting a start appear here/);
    assert.match(markup, /Workspace health: warn/);
    assert.match(markup, /Gate authority: No gate artifacts found\./);
    assert.match(markup, /href="\/health" class="ac-chip ac-chip--warn"/);
    assert.match(markup, /aria-label="Workspace health: warn\. Gate authority: No gate artifacts found\."/);
    assert.match(markup, /<strong>2<\/strong> recently active agents/);
    assert.match(markup, /1 inactive for 4\+ hours/);
    assert.match(markup, /1 with no active session/);
    assert.match(markup, /recorded work reservations:/);
    assert.doesNotMatch(markup, /active work reservations/);
    assert.doesNotMatch(markup, /SHOULD_NOT_BE_RENDERED/);
    assert.match(markup, /UI-UNKNOWN/);
    assert.match(markup, /unknown — inspect the canonical board before acting/);
    assert.match(markup, /&lt;img onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(markup, /<img onerror=alert\(1\)>/);

    healthFixture = {
      overall: 'fail',
      checks: [
        { name: 'Event log', level: 'fail', detail: 'governance-events.ndjson missing.' },
        { name: 'Gate authority', level: 'warn', detail: '<img src=x onerror=alert(1)>' }
      ]
    };
    const failedHealthMarkup = renderPage();
    assert.match(failedHealthMarkup, /Workspace health: fail/);
    assert.match(failedHealthMarkup, /class="ac-chip ac-chip--crit"/);
    assert.match(failedHealthMarkup, /Event log: governance-events\.ndjson missing\./);
    assert.match(failedHealthMarkup, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(failedHealthMarkup, /<img src=x onerror=alert\(1\)>/);
    assert.match(failedHealthMarkup, /href="\/health" class="ac-chip ac-chip--crit"/);

    healthFixture = { overall: 'ok', checks: [{ name: 'Gate authority', level: 'ok', detail: '1 lane passing.' }] };
    const healthyMarkup = renderPage();
    assert.doesNotMatch(healthyMarkup, /Workspace health:/);
    assert.doesNotMatch(healthyMarkup, /Gate authority: 1 lane passing\./);
  } finally {
    Module._load = originalLoad;
  }
});
