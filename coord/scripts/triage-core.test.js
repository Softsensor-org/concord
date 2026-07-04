'use strict';

// COORD-287 — coord-ui /triage projection core tests.
// Zero-dependency node:test. Runs in the coord governance gate
// (`node --test coord/scripts/*.test.js`). Covers the three acceptance
// assertions for the read-only /triage view: LISTS-PROPOSED, READ-ONLY,
// EMPTY-STATE. The served lib (frontend/apps/coord-ui/lib/triage.ts) delegates
// to this same module, so green here proves the served projection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const core = require('./triage-core.js');
const {
  proposedTickets,
  toTriageItem,
  deriveTitle,
  parseQkey,
  parseSuggestedFix,
  cliHint
} = core;

// A board fixture mixing proposed + non-proposed rows across two sections,
// shaped exactly like coord/board/tasks.json (columns ID/Repo/Type/Pri/
// Status/Owner/Description/Depends On).
function makeBoard() {
  return {
    sections: [
      {
        kind: 'table',
        columns: ['ID', 'Repo', 'Type', 'Pri', 'Status', 'Owner', 'Description', 'Depends On'],
        rows: [
          {
            ID: 'COORD-900',
            Repo: 'X',
            Type: 'refactor',
            Pri: 'P3',
            Status: 'proposed',
            Owner: 'unassigned',
            Description:
              '[auto-quality] Reduce file size: coord/scripts/big.js (700 LOC > 500). ' +
              'Evidence: coord/scripts/big.js value=700 threshold=500 severity=warn. ' +
              'Detail: file is large. Suggested fix: Split this file into cohesive modules to bring it under the LOC budget. ' +
              '[qkey:size:coord/scripts/big.js:file]',
            'Depends On': 'COORD-083'
          },
          {
            ID: 'COORD-901',
            Repo: 'X',
            Type: 'feature',
            Pri: 'P1',
            Status: 'todo',
            Owner: 'someone',
            Description: 'A normal open ticket, must NOT appear in triage.',
            'Depends On': ''
          },
          {
            ID: 'COORD-902',
            Repo: 'X',
            Type: 'refactor',
            Pri: 'P2',
            Status: 'proposed',
            Owner: 'unassigned',
            Description:
              '[auto-quality] Decompose monolith: coord/scripts/mono.js (1200 LOC > 800). ' +
              'Evidence: coord/scripts/mono.js value=1200 threshold=800 severity=warn. ' +
              'Detail: unbounded growth. Suggested fix: Decompose this monolith; extract sub-modules to halt unbounded growth. ' +
              '[qkey:monolith:coord/scripts/mono.js:file]',
            'Depends On': 'COORD-083'
          }
        ]
      },
      {
        kind: 'table',
        columns: ['ID', 'Repo', 'Type', 'Pri', 'Status', 'Owner', 'Description', 'Depends On'],
        rows: [
          {
            ID: 'COORD-903',
            Repo: 'X',
            Type: 'feature',
            Pri: 'P3',
            Status: 'done',
            Owner: 'x',
            Description: 'Closed work, excluded.',
            'Depends On': ''
          }
        ]
      }
    ]
  };
}

// --- LISTS-PROPOSED ---------------------------------------------------------

test('LISTS-PROPOSED: only proposed rows are returned, id/title/qkey/suggested-fix parsed', () => {
  const items = proposedTickets(makeBoard());
  // Only the two proposed rows, NOT the open/done ones.
  assert.deepEqual(items.map((i) => i.id), ['COORD-902', 'COORD-900']); // P2 before P3
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  const a = byId['COORD-900'];
  assert.equal(a.priority, 'P3');
  assert.equal(a.type, 'refactor');
  assert.equal(a.title, 'Reduce file size: coord/scripts/big.js (700 LOC > 500)');
  assert.equal(a.qkey, 'size:coord/scripts/big.js:file');
  assert.match(a.suggestedFix, /^Split this file into cohesive modules/);
  assert.match(a.finding, /coord\/scripts\/big\.js value=700 threshold=500 severity=warn/);

  const b = byId['COORD-902'];
  assert.equal(b.priority, 'P2');
  assert.equal(b.qkey, 'monolith:coord/scripts/mono.js:file');
  assert.match(b.suggestedFix, /Decompose this monolith/);
});

test('LISTS-PROPOSED: non-proposed and id-less rows project to null', () => {
  assert.equal(toTriageItem({ ID: 'X-1', Status: 'todo', Description: 'x' }), null);
  assert.equal(toTriageItem({ ID: '', Status: 'proposed', Description: 'x' }), null);
  assert.equal(toTriageItem(null), null);
});

test('LISTS-PROPOSED: hand-filed proposed ticket (free-text) still renders gracefully', () => {
  const items = proposedTickets({
    sections: [
      {
        kind: 'table',
        rows: [
          {
            ID: 'COORD-950',
            Status: 'proposed',
            Pri: 'P2',
            Type: 'bug',
            Description: 'Investigate flaky login redirect on slow networks.'
          }
        ]
      }
    ]
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'COORD-950');
  assert.equal(items[0].qkey, null);
  assert.equal(items[0].finding, null);
  assert.equal(items[0].suggestedFix, null);
  assert.equal(items[0].title, 'Investigate flaky login redirect on slow networks.');
});

test('deriveTitle: prefers auto-quality title, falls back to leading sentence', () => {
  assert.equal(
    deriveTitle('[auto-quality] Fix import boundary: a.js imports b. Evidence: a.js value=1.'),
    'Fix import boundary: a.js imports b'
  );
  assert.equal(deriveTitle('Plain description with no structure'), 'Plain description with no structure');
  assert.equal(parseQkey('no marker here'), null);
  assert.equal(parseSuggestedFix('no fix here'), null);
});

// --- EMPTY-STATE ------------------------------------------------------------

test('EMPTY-STATE: zero proposed tickets yields [] (no crash)', () => {
  assert.deepEqual(proposedTickets(makeBoardNoProposed()), []);
  assert.deepEqual(proposedTickets({ sections: [] }), []);
  assert.deepEqual(proposedTickets({}), []);
  assert.deepEqual(proposedTickets(null), []);
  assert.deepEqual(proposedTickets({ sections: [{ kind: 'prose', rows: null }] }), []);
});

function makeBoardNoProposed() {
  return {
    sections: [
      {
        kind: 'table',
        rows: [
          { ID: 'COORD-1', Status: 'todo', Description: 'open' },
          { ID: 'COORD-2', Status: 'done', Description: 'closed' }
        ]
      }
    ]
  };
}

// --- READ-ONLY (SEC-001/002 contract) --------------------------------------

test('READ-ONLY: the projection core has NO fs/spawn/mutation surface', () => {
  // The module source must not import fs / child_process and must not expose
  // any write/approve/reject/mutation function — it is pure data shaping.
  const src = fs.readFileSync(require.resolve('./triage-core.js'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"](?:node:)?fs['"]\s*\)/, 'core must not require fs');
  assert.doesNotMatch(
    src,
    /require\(\s*['"](?:node:)?child_process['"]\s*\)/,
    'core must not require child_process'
  );
  const exported = Object.keys(core);
  for (const name of exported) {
    assert.doesNotMatch(
      name,
      /approve|reject|write|mutate|save|set|update|delete/i,
      `export "${name}" must not be a mutation verb`
    );
  }
});

test('READ-ONLY: cliHint returns plain-text governed commands, never executes', () => {
  const h = cliHint('COORD-900');
  assert.equal(typeof h.approve, 'string');
  assert.equal(typeof h.reject, 'string');
  assert.equal(h.approve, 'coord/scripts/gov approve COORD-900');
  assert.match(h.reject, /^coord\/scripts\/gov reject COORD-900 --reason/);
  // It is just text — no function/callable is handed back to act on.
  assert.notEqual(typeof h.approve, 'function');
});
