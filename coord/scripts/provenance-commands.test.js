'use strict';
const { invokeFixtureReconcile } = require("../engine/scripts/__fixtures__/approval-fixture.js");
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveEngineModule } = require('../paths.js');
const { state } = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-context.js"));
const u = require('./governance-test-utils.js');
const { createIsolatedGovernanceWorkspace } = require(resolveEngineModule(path.resolve(__dirname, '..'), 'engine/scripts/fixtures/isolated-governance-workspace.js'));
const createSync = require(resolveEngineModule(path.resolve(__dirname, '..'), 'scripts/sync-provenance.js'));
const createQuestions = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/questions.js"));
const createGovernanceRepair = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/governance-repair.js"));
const questions = createQuestions({
  classifyQuestionOperationalType: createGovernanceRepair({}).classifyQuestionOperationalType,
  uniqueStrings: (values) => [...new Set(values)],
  readCanonicalTextFile: (...args) => require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/state-io.js")).readCanonicalTextFile(...args),
});
u.sandboxProcessRuntime();
for (const key of ['CODEX_THREAD_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'COORD_SESSION_ID', 'GEMINI_THREAD_ID']) delete process.env[key];
const question = ['log-question', '--from', 'fixture-agent', '--to', 'orchestrator', '--question', 'fixture finding', '--answer', 'fixture evidence', '--resolved', 'yes'];

for (const entry of [
  {name:'omitted answer remains empty and active', resolved:'no', answer:undefined, expected:''},
  {name:'pending answer is retained', resolved:'no', answer:'Evidence is still being gathered.', expected:'Evidence is still being gathered.'},
  {name:'answered n/a remains supported', resolved:'n/a', answer:'This question does not apply.', expected:'This question does not apply.'},
]) {
  test(`COORD-568: public question command ${entry.name}`, () => {
    u.withGovernedSurfaceSandbox(({logPath}) => {
      u.__testing.ensureGovernanceJournalBaseline('COORD-568 fixture');
      const args=['log-question','--from','fixture-agent','--to','orchestrator','--question','A decision is needed','--resolved',entry.resolved];
      if(entry.answer!==undefined) args.push('--answer',entry.answer);
      const result=u.executeCommand(args);
      assert.equal(result.ok,true,result.error);
      const rows=questions.readQuestionRows();
      assert.equal(rows.length,1);
      assert.equal(rows[0].answer,entry.expected);
      assert.equal(rows[0].resolved,entry.resolved);
      assert.equal(rows[0].from,'fixture-agent');
      if(entry.resolved==='no') assert.equal(questions.readActiveOrchestratorQuestionRows().length,1);
      const writes=fs.readFileSync(logPath,'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.command==='log-question');
      assert.equal(writes.length,1);
      assert.equal(writes[0].result,'succeeded');
      assert.ok(writes[0].changed_paths.some(p=>p.endsWith('QUESTIONS.md')));
      assert.deepEqual(u.__testing.detectGovernanceProvenanceDrift().drift,[]);
    });
  });
}

for (const entry of [
  {name:'answered status without an answer', args:['--resolved','yes'], error:/answer/},
  {name:'answered status with whitespace only', args:['--resolved','yes','--answer','   '], error:/answer/},
  {name:'n/a status without an answer', args:['--resolved','n/a'], error:/answer/},
  {name:'unknown resolution status', args:['--resolved','maybe','--answer','Some evidence'], error:/resolved/},
  {name:'explicit empty flag value', args:['--resolved','no','--answer',''], error:/requires a value/},
]) {
  test(`COORD-568: public question command refuses ${entry.name} without writes`, () => {
    u.withGovernedSurfaceSandbox(({logPath}) => {
      u.__testing.ensureGovernanceJournalBaseline('COORD-568 refusal fixture');
      const target=state.QUESTIONS_PATH;
      const before=fs.readFileSync(target,'utf8'), journal=fs.readFileSync(logPath,'utf8');
      const result=u.executeCommand(['log-question','--from','fixture-agent','--to','orchestrator','--question','A decision is needed',...entry.args]);
      assert.equal(result.ok,false,'invalid question must not be appended');
      assert.match(result.error,entry.error);
      assert.equal(fs.readFileSync(target,'utf8'),before);
      assert.equal(fs.readFileSync(logPath,'utf8'),journal);
    });
  });
}

test('COORD-568: verb help explains the conditional answer requirement', () => {
  const result=u.executeCommand(['log-question','--help']);
  assert.equal(result.ok,true,result.error);
  assert.match(result.stdout,/\[--answer <text>\]/);
  assert.match(result.stdout,/answer.*required.*yes.*n\/a/);
});

test('COORD-668: CLI question writes are journaled and repeated writes leave no provenance drift', () => {
  u.withGovernedSurfaceSandbox(({logPath}) => {
    u.__testing.ensureGovernanceJournalBaseline('seed');
    for (let i = 0; i < 2; i++) {
      const result = u.executeCommand(question);
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(u.__testing.detectGovernanceProvenanceDrift().drift, []);
    }
    const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
    const writes = events.filter(e => e.command === 'log-question');
    assert.equal(writes.length, 2);
    assert(writes.every(e => e.changed_paths.some(p => p.endsWith('QUESTIONS.md'))));
  });
});

for (const surface of ['prompt', 'questions', 'plan']) {
  test(`COORD-668: ordinary reconcile refuses semantic ${surface} drift without changing journal or file`, () => {
    u.withGovernedSurfaceSandbox(({promptsDir, logPath}) => {
      const target = surface === 'prompt' ? path.join(promptsDir, 'tickets', 'COORD-999.md') : state[surface === 'plan' ? 'PLAN_PATH' : 'QUESTIONS_PATH'];
      fs.writeFileSync(target, 'Acceptance: deny unauthorized writes.\n');
      u.__testing.ensureGovernanceJournalBaseline('seed');
      fs.writeFileSync(target, 'Acceptance: permit unauthorized writes.\n');
      const journal = fs.readFileSync(logPath, 'utf8');
      const result = u.executeCommand(['reconcile', '--reason', 'ordinary repair']);
      assert.equal(result.ok, false, 'reason alone cannot authorize semantic drift');
      assert.match(result.error, /human-admin-override/);
      assert.equal(fs.readFileSync(logPath, 'utf8'), journal);
      assert.equal(fs.readFileSync(target, 'utf8'), 'Acceptance: permit unauthorized writes.\n');
      assert(u.__testing.detectGovernanceProvenanceDrift().drift.some(p => p.endsWith(path.basename(target))));
      const dry = u.executeCommand(['reconcile', '--reason', 'inspect', '--dry-run']);
      assert.equal(dry.ok, true);
      assert.equal(JSON.parse(dry.stdout).requires_human_admin_override, true);
      assert.equal(fs.readFileSync(logPath, 'utf8'), journal);
    });
  });
}

test('COORD-668: explicit reconciliation approval and accepted paths are auditable', () => {
  const fixture = createIsolatedGovernanceWorkspace({ prefix: 'coord668-reconcile-' });
  try {
    const state = fixture.governance.__testing;
    const target = path.join(fixture.coord, 'prompts', 'tickets', 'COORD-999.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    assert.equal(fixture.invoke(['agentid', '--assign']).ok, true);
    fs.writeFileSync(target, 'approved requirement correction\n');
    const relative = path.relative(fixture.coord, target).split(path.sep).join('/');
    const expectedPacket = [`${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')} ${relative}`];
    const dry = fixture.invoke(['reconcile', '--reason', 'inspect correction', '--dry-run']);
    assert.deepEqual(JSON.parse(dry.stdout).expect_paths_packet, expectedPacket);
    const packetPath = path.join(fixture.root, 'approved.packet');
    fs.writeFileSync(packetPath, `${expectedPacket.join('\n')}\n`);
    const result = invokeFixtureReconcile(fixture.coord, fixture.invoke, ['reconcile', '--reason', 'apply reviewed correction', '--human-admin-override', 'Fixture administrator approved this requirement correction', '--expect-paths-file', packetPath]);
    assert.equal(result.ok, true, result.error);
    const event = state.readGovernanceEventLog().findLast(e => e.command === 'manual-reconcile');
    assert.equal(event.details.human_admin_override, 'Fixture administrator approved this requirement correction');
    assert(event.details.reconciled_drift.includes(relative));
    assert.deepEqual(state.detectGovernanceProvenanceDrift().drift, []);
  } finally {
    fixture.cleanup();
  }
});

function withSyncFixture(run) {
  u.withGovernedSurfaceSandbox(({tempDir, logPath}) => {
    const gitTry = (cwd, args) => spawnSync('git', args, {cwd, encoding:'utf8'});
    const git = args => {
      const result = gitTry(tempDir, args);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '--initial-branch=main']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    u.__testing.ensureGovernanceJournalBaseline('seed');
    git(['add', '.']); git(['commit', '-m', 'seed']);
    const service = createSync({
      COORD_DIR:tempDir, DEFAULT_PATHS:{boardPath:path.join(tempDir,'tasks.json')},
      isInsideGitWorkTree:()=>true, canonicalSyncablePaths:()=>['PLAN.md', '.runtime/governance-events.ndjson'],
      relativeCoordPath:p=>path.relative(tempDir,p), readBoard:()=>({sections:[]}), getRows:()=>[],
      runBoardSync:()=>fs.writeFileSync(state.PLAN_PATH,'regenerated plan\n'),
      withGovernanceMutation:u.__testing.withGovernanceMutation,
      detectGovernanceProvenanceDrift:u.__testing.detectGovernanceProvenanceDrift,
      splitGovernanceProvenanceDrift:drift=>({blocking:drift, warnings:[]}),
      state: {get QUESTIONS_PATH() { return state.QUESTIONS_PATH; }},
      computeSyncDelta:(cwd, paths)=>paths.filter(p=>git(['status','--porcelain','--',p])!==''),
      gitTry, fail:message=>{throw new Error(message);},
    });
    run({service,git,logPath,tempDir});
  });
}

test('COORD-668: question plus standalone sync converge in one commit and retain out-of-scope files', () => {
  withSyncFixture(({service,git,tempDir}) => {
    assert.equal(u.executeCommand(question).ok, true);
    fs.writeFileSync(path.join(tempDir,'unrelated.txt'),'not governed\n');
    const result = service.runSyncCommand({commit:'sync sanctioned outputs',quiet:true});
    assert.equal(result.committed,true);
    assert.deepEqual(u.__testing.detectGovernanceProvenanceDrift().drift,[]);
    assert.equal(git(['status','--porcelain','--','QUESTIONS.md','PLAN.md','.runtime/governance-events.ndjson']),'');
    assert.match(git(['status','--porcelain','--','unrelated.txt']),/\?\?/);
    const head = git(['rev-parse','HEAD']);
    assert.equal(service.runSyncCommand({commit:'noop',quiet:true}).committed,false);
    assert.equal(git(['rev-parse','HEAD']),head);
  });
});

test('COORD-668: sync refuses a manually edited plan before regeneration or commit', () => {
  withSyncFixture(({service,git}) => {
    fs.writeFileSync(state.PLAN_PATH,'manual semantic change\n');
    const head=git(['rev-parse','HEAD']);
    assert.throws(()=>service.runSyncCommand({commit:'must refuse',quiet:true}),/drift|out-of-band/);
    assert.equal(fs.readFileSync(state.PLAN_PATH,'utf8'),'manual semantic change\n');
    assert.equal(git(['rev-parse','HEAD']),head);
  });
});

test('COORD-668: a manual question edit cannot be laundered through a sanctioned question append', () => {
  u.withGovernedSurfaceSandbox(({logPath}) => {
    u.__testing.ensureGovernanceJournalBaseline('seed');
    fs.appendFileSync(state.QUESTIONS_PATH,'unapproved semantic edit\n');
    const journal=fs.readFileSync(logPath,'utf8');
    const result=u.executeCommand(question);
    assert.equal(result.ok,false);
    assert.match(result.error,/out-of-band/);
    assert.equal(fs.readFileSync(logPath,'utf8'),journal);
  });
});

test('COORD-668: missing journal needs approval before even a baseline is written', () => {
  u.withGovernedSurfaceSandbox(({logPath}) => {
    const result=u.executeCommand(['reconcile','--reason','ordinary recovery']);
    assert.equal(result.ok,false);
    assert.match(result.error,/human-admin-override/);
    assert.equal(fs.existsSync(logPath),false);
  });
});

test('COORD-668: a failed mutation restores its generated drift note and leaves preexisting drift visible', () => {
  u.withGovernedSurfaceSandbox(({logPath}) => {
    u.__testing.ensureGovernanceJournalBaseline('seed');
    const before=fs.readFileSync(state.QUESTIONS_PATH,'utf8');
    const journal=fs.readFileSync(logPath,'utf8');
    fs.writeFileSync(state.AGENTS_PATH,JSON.stringify([{note:'runtime registry drift'}]));
    assert.throws(()=>u.__testing.withGovernanceMutation({command:'fixture-failure'},()=>{throw new Error('fixture failure');}),/fixture failure/);
    assert.equal(fs.readFileSync(state.QUESTIONS_PATH,'utf8'),before);
    assert.equal(fs.readFileSync(logPath,'utf8'),journal);
    assert(u.__testing.detectGovernanceProvenanceDrift().drift.some(p=>p.endsWith('agents.json')));
  });
});

test('COORD-668: terminal best-effort sync does not reconcile a rejected manual plan edit', () => {
  withSyncFixture(({service,git}) => {
    fs.writeFileSync(state.PLAN_PATH,'unapproved terminal drift\n');
    const head=git(['rev-parse','HEAD']);
    const result=service.autoSyncAfterLifecycle({verb:'finalize',ticketId:'COORD-668'});
    assert.equal(result.failed,true);
    assert.equal(git(['rev-parse','HEAD']),head);
    assert(u.__testing.detectGovernanceProvenanceDrift().drift.some(p=>p.endsWith('PLAN.md')));
  });
});
