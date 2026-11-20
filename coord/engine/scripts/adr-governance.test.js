const test = require("node:test");
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sourceCoord = path.resolve(__dirname, '../..');
const { resolveEngineModule } = require('../../paths.js');
const { createIsolatedGovernanceWorkspace } = require(resolveEngineModule(sourceCoord, 'engine/scripts/fixtures/isolated-governance-workspace.js'));
const workspace = createIsolatedGovernanceWorkspace({ sourceCoord, prefix: 'coord836-adr-cli-' });
const fixtureRoot = workspace.root;
const coord = workspace.coord;
const { state: governanceState, DEFAULT_PATHS: governanceDefaultPaths } = require(resolveEngineModule(coord, "scripts/governance-context.js"));
process.on('exit', workspace.cleanup);
const { executeCommand } = require(resolveEngineModule(coord, 'scripts/cli.js'));
const { __testing, withGovernedSurfaceSandbox } = require(resolveEngineModule(coord, 'scripts/governance-test-utils.js'));
const { withApprovedPacket } = require(resolveEngineModule(coord, 'scripts/fixtures/approved-reconcile.js'));
const { parseReconcilePacket } = require(resolveEngineModule(coord, 'scripts/reconcile-packet.js'));

const { createApprovalFixture } = require('./__fixtures__/approval-fixture.js');
const { withApprovalTestClient } = require('./__fixtures__/approval-test-client.js');

// Positive reconciliation only. Raw invoke remains the boundary for refusal
// assertions, including malformed packets and reason-only authorization.
function signedReconcile(invoke, args, afterLogin = (run) => run()) {
  assert.equal(args[0], 'reconcile');
  const approval = createApprovalFixture({ allowedVerbs: ['reconcile'] });
  try {
    return withApprovalTestClient(coord, approval.client(), () => {
      const baselineBefore = __testing.readLatestGovernanceSnapshotSource();
      const refused = invoke(args);
      assert.equal(refused.ok, false, 'an unsigned reconcile must refuse');
      const baselineAfter = __testing.readLatestGovernanceSnapshotSource();
      assert.deepEqual({ snapshot: baselineAfter.snapshot, expectedDigest: baselineAfter.expectedDigest },
        { snapshot: baselineBefore.snapshot, expectedDigest: baselineBefore.expectedDigest },
        'approval refusal and any legacy chain migration preserve the selected baseline without adopting current drift');
      assert.match(refused.error, /requires a signed human-admin approval/);
      const digest = /Subject digest: ([0-9a-f]{64})/.exec(refused.error);
      assert.ok(digest, refused.error);
      approval.login({ verb: 'reconcile', ticket: 'control-plane', subject_sha256: digest[1] });
      return afterLogin(() => invoke(args));
    });
  } finally { approval.cleanup(); }
}


test('COORD-722: gov adr commands are journaled with exact paths', () => {
  withGovernedSurfaceSandbox(({ tempDir, logPath }) => {
    const decisions = governanceState.DECISIONS_DIR;
    fs.mkdirSync(decisions, { recursive: true });
    fs.writeFileSync(path.join(decisions, 'README.md'), '# Decision Records (ADRs)\n', 'utf8');
    const identity = executeCommand(['agentid', '--assign'], {
      cwd: tempDir,
      env: { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: 'coord722-proto', CODEX_THREAD_ID: 'thread-722-proto' },
    });
    assert.equal(identity.ok, true, identity.error);
    const invoke = (args) => {
      const result = executeCommand(['adr', ...args, '--json'], { cwd: tempDir, env: { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: 'coord722-proto', CODEX_THREAD_ID: 'thread-722-proto' } });
      assert.equal(result.ok, true, result.error);
      return JSON.parse(result.stdout);
    };
    const readEvents = () => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const before = readEvents().length;
    invoke(['new', '--title', 'First governed decision', '--ticket', 'COORD-722']);
    const newEvent = readEvents().slice(before).find((event) => event.command === 'adr-new');
    assert.ok(newEvent, 'new event must be emitted');
    assert.equal(newEvent.ticket, 'COORD-722');
    assert.deepEqual(newEvent.changed_paths, [
      path.relative(coord, path.join(decisions, '0001-first-governed-decision.md')).split(path.sep).join('/'),
      path.relative(coord, path.join(decisions, 'README.md')).split(path.sep).join('/'),
    ]);
    assert.ok(newEvent.identity?.agent_id, 'event is attributed to an agent');
    const linkStart = readEvents().length;
    invoke(['link', 'COORD-722', '0001']);
    const linkEvent = readEvents().slice(linkStart).find((event) => event.command === 'adr-link');
    assert.ok(linkEvent, 'link event must be emitted');
    assert.equal(linkEvent.ticket, 'COORD-722');
    assert.deepEqual(linkEvent.changed_paths, [path.relative(coord, path.join(decisions, '0001-first-governed-decision.md')).split(path.sep).join('/')]);
    const createReplacementStart = readEvents().length;
    invoke(['new', '--title', 'Replacement decision', '--ticket', 'COORD-722']);
    assert.ok(readEvents().slice(createReplacementStart).some((event) => event.command === 'adr-new'));
    const supersedeStart = readEvents().length;
    invoke(['supersede', '0001', '--by', '0002', '--ticket', 'COORD-722']);
    const supersedeEvent = readEvents().slice(supersedeStart).find((event) => event.command === 'adr-supersede');
    assert.ok(supersedeEvent, 'supersede event must be emitted');
    assert.equal(supersedeEvent.ticket, 'COORD-722');
    assert.deepEqual(supersedeEvent.changed_paths, [
      path.relative(coord, path.join(decisions, '0001-first-governed-decision.md')).split(path.sep).join('/'),
      path.relative(coord, path.join(decisions, '0002-replacement-decision.md')).split(path.sep).join('/'),
      path.relative(coord, path.join(decisions, 'README.md')).split(path.sep).join('/'),
    ]);
  });
});

test('COORD-722: failure between ADR and registry writes restores both', () => {
  withGovernedSurfaceSandbox(({ tempDir, logPath }) => {
    const decisions = governanceState.DECISIONS_DIR;
    fs.mkdirSync(decisions, { recursive: true });
    const readme = path.join(decisions, 'README.md');
    fs.writeFileSync(readme, '# Decision Records (ADRs)\n', 'utf8');
    const env = { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: 'coord722-fault', CODEX_THREAD_ID: 'thread-722-fault' };
    assert.equal(executeCommand(['agentid', '--assign'], { cwd: tempDir, env }).ok, true);
    const invoke = (args) => executeCommand(['adr', ...args, '--json'], { cwd: tempDir, env });
    const seed = invoke(['new', '--title', 'Existing decision', '--ticket', 'COORD-722']);
    assert.equal(seed.ok, true, seed.error);
    const adrPath = path.join(decisions, '0001-existing-decision.md');
    const readmeBefore = fs.readFileSync(readme);
    const adrBefore = fs.readFileSync(adrPath);
    const originalWrite = fs.writeFileSync;
    let adrWriteSeen = false;
    let injected = false;
    const lockHeldDuringAdrWrites = [];
    fs.writeFileSync = function (target, ...args) {
      if (typeof target === 'string' && path.resolve(target).startsWith(`${decisions}${path.sep}`)) lockHeldDuringAdrWrites.push(fs.existsSync(governanceState.GOVERNANCE_EVENT_LOCK_DIR));
      if (path.resolve(String(target)).startsWith(`${decisions}${path.sep}`) && path.extname(String(target)) === '.md' && String(target).includes('partial-decision')) adrWriteSeen = true;
      if (adrWriteSeen && path.resolve(String(target)) === readme && !injected) {
        injected = true;
        throw new Error('injected registry failure');
      }
      return originalWrite.call(this, target, ...args);
    };
    try {
      assert.throws(
        () => invoke(['new', '--title', 'Partial decision', '--ticket', 'COORD-722']),
        /injected registry failure/
      );
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(injected, true, 'fault was injected after the ADR file write');
    assert.ok(lockHeldDuringAdrWrites.length >= 2, 'ADR and registry writes were observed');
    assert.deepEqual(lockHeldDuringAdrWrites.filter((held) => !held), [], 'every ADR write happens under the governance runtime lock');
    assert.equal(fs.existsSync(governanceState.GOVERNANCE_EVENT_LOCK_DIR), false, 'the runtime lock is released after rollback');
    assert.deepEqual(fs.readFileSync(readme), readmeBefore);
    assert.deepEqual(fs.readFileSync(adrPath), adrBefore);
    assert.equal(fs.existsSync(path.join(decisions, '0002-partial-decision.md')), false);
    const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.command === 'adr-new' && event.result === 'succeeded' && event.ticket === 'COORD-722'), true);
    assert.equal(events.some((event) => event.command === 'adr-new' && event.result === 'failed'), false);
  });
});

test('COORD-722: out-of-band ADR and registry edits refuse later gov adr writes', () => {
  for (const targetKind of ['adr', 'registry']) {
    withGovernedSurfaceSandbox(({ tempDir }) => {
        const decisions = governanceState.DECISIONS_DIR;
      fs.mkdirSync(decisions, { recursive: true });
      const readme = path.join(decisions, 'README.md');
      fs.writeFileSync(readme, '# Decision Records (ADRs)\n', 'utf8');
      const env = { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: `coord722-${targetKind}`, CODEX_THREAD_ID: `thread-722-${targetKind}` };
      assert.equal(executeCommand(['agentid', '--assign'], { cwd: tempDir, env }).ok, true);
      const invoke = (args) => executeCommand(['adr', ...args, '--json'], { cwd: tempDir, env });
      const seed = invoke(['new', '--title', 'Sealed decision', '--ticket', 'COORD-722']);
      assert.equal(seed.ok, true, seed.error);
      const adrPath = path.join(decisions, '0001-sealed-decision.md');
      const target = targetKind === 'adr' ? adrPath : readme;
      fs.appendFileSync(target, '\nmanual out-of-band edit\n', 'utf8');
      const refused = invoke(['link', 'COORD-722', '0001']);
      assert.equal(refused.ok, false, `${targetKind} edit must be detected`);
      assert.match(refused.error, /out-of-band/i);
      assert.match(refused.error, /decisions/);
      assert.match(fs.readFileSync(target, 'utf8'), /manual out-of-band edit/);
    });
  }
});

test('COORD-722: ADR fixture path is isolated from donor decisions', () => {
  withGovernedSurfaceSandbox(({ tempDir }) => {
    const decisions = governanceState.DECISIONS_DIR;
    const readme = path.join(decisions, 'README.md');
    fs.writeFileSync(readme, '# Isolated ADR fixture\n', 'utf8');
    const paths = __testing.buildGovernanceSnapshot().files.map((entry) => entry.path).filter((entry) => entry.includes('decisions'));
    assert.equal(paths.length, 1);
    assert.match(paths[0], /coord032-journal-.*\/docs\/decisions\/README\.md$/);
    assert.notEqual(paths[0], 'docs/decisions/README.md', 'the donor ADR registry must not be ingested');
  });
});

test('COORD-722: explicit mutation directory must be the configured governed ADR root', () => {
  withGovernedSurfaceSandbox(({ tempDir }) => {
    const configured = governanceState.DECISIONS_DIR;
    const decoy = path.join(tempDir, 'unsealed-decisions');
    fs.mkdirSync(configured, { recursive: true });
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(configured, 'README.md'), '# Decision Records (ADRs)\n', 'utf8');
    fs.writeFileSync(path.join(decoy, 'README.md'), '# Decoy decisions\n', 'utf8');
    const env = { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: 'coord722-dir', CODEX_THREAD_ID: 'thread-722-dir' };
    assert.equal(executeCommand(['agentid', '--assign'], { cwd: tempDir, env }).ok, true);
    const listed = executeCommand(['adr', 'list', '--dir', decoy, '--json'], { cwd: tempDir, env });
    assert.equal(listed.ok, true, listed.error);
    const adrFile = path.join(decoy, '0001-decoy.md');
    fs.writeFileSync(adrFile, '# ADR 0001: Decoy\n\n- **Status:** Accepted\n- **Ticket:** COORD-722\n- **Date:** 2026-10\n\n## Context\n\nTBD.\n\n## Linked Scope\n\nTBD.\n\n## Decision Criteria\n\nTBD.\n\n## Options Evaluated\n\nTBD.\n\n## Decision\n\nTBD.\n\n## Alternatives Rejected\n\nTBD.\n\n## Consequences\n\nTBD.\n', 'utf8');
    const calls = [
      ['new', '--title', 'Unsealed', '--ticket', 'COORD-722'],
      ['link', 'COORD-722', '0001'],
      ['supersede', '0001', '--by', '0001', '--ticket', 'COORD-722'],
    ];
    for (const args of calls) {
      const rejected = executeCommand(['adr', ...args, '--dir', decoy], { cwd: tempDir, env });
      assert.equal(rejected.ok, false, `${args[0]} must reject an unsealed target`);
      assert.match(rejected.error, /mutate only the governed decisions directory/i);
    }
    assert.deepEqual(fs.readdirSync(decoy).sort(), ['0001-decoy.md', 'README.md']);
    assert.match(fs.readFileSync(adrFile, 'utf8'), /Status:\*\* Accepted/);
  });
});

test('COORD-722: legacy ADR snapshots require reviewed adoption before governed writes', () => {
  withReconcileSurfaceSandbox(({ tempDir, logPath }) => {
    const decisions = governanceState.DECISIONS_DIR;
    fs.mkdirSync(decisions, { recursive: true });
    fs.writeFileSync(path.join(decisions, 'README.md'), '# Decision Records (ADRs)\n', 'utf8');
    const env = { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: 'coord722-upgrade', CODEX_THREAD_ID: 'thread-722-upgrade' };
    assert.equal(executeCommand(['agentid', '--assign'], { cwd: tempDir, env }).ok, true);
    const invoke = (args) => executeCommand(args, { cwd: tempDir, env });
    const seed = invoke(['adr', 'new', '--title', 'Existing decision', '--ticket', 'COORD-722', '--json']);
    assert.equal(seed.ok, true, seed.error);

    // Recreate the latest snapshot shape from before ADR files were governed:
    // the legitimate files exist on disk, but are absent from the journal baseline.
    const legacySnapshot = __testing.buildGovernanceSnapshot();
    legacySnapshot.files = legacySnapshot.files.filter((entry) => !entry.path.includes('/docs/decisions/'));
    legacySnapshot.digest = crypto.createHash('sha1').update(JSON.stringify(legacySnapshot.files)).digest('hex');
    fs.writeFileSync(governanceState.GOVERNANCE_SNAPSHOT_PATH, JSON.stringify(legacySnapshot), 'utf8');
    fs.writeFileSync(logPath, `${JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z', command: 'legacy-baseline', ticket: null,
      before_status: null, after_status: null, identity: null, details: null,
      changed_paths: [], snapshot: legacySnapshot,
    })}\n`, 'utf8');

    const expectedPaths = [
      '0001-existing-decision.md',
      'README.md',
    ];
    const dryRun = invoke(['reconcile', '--reason', 'inspect legacy ADR adoption', '--dry-run']);
    assert.equal(dryRun.ok, true, dryRun.error);
    const drift = JSON.parse(dryRun.stdout).drift;
    assert.deepEqual(drift.map((entry) => path.posix.basename(entry)).sort(), expectedPaths);
    assert.equal(JSON.parse(dryRun.stdout).requires_human_admin_override, true);

    const journalBeforeRefusal = fs.readFileSync(logPath, 'utf8');
    const refused = invoke(['agentid', '--assign']);
    assert.equal(refused.ok, false, 'ordinary governed mutations must not auto-adopt pre-existing ADR files');
    assert.match(refused.error, /0001-existing-decision\.md/);
    assert.equal(fs.readFileSync(logPath, 'utf8'), journalBeforeRefusal);

    const approval = 'Fixture administrator approves the exact inspected legacy ADR files and registry';
    const adoptArgs = ['reconcile', '--reason', 'adopt reviewed legacy ADR baseline', '--human-admin-override', approval];
    const unbound = invoke(adoptArgs);
    assert.equal(unbound.ok, false, 'an override without the approved packet must refuse');
    assert.match(unbound.error, /requires --expect-paths-file/);
    assert.equal(fs.readFileSync(logPath, 'utf8'), journalBeforeRefusal, 'an unbound override appends nothing');
    const adopted = signedReconcile(invoke, withApprovedPacket(adoptArgs, invoke));
    assert.equal(adopted.ok, true, adopted.error);
    const reconcileEvent = __testing.readGovernanceEventLog().findLast((event) => event.command === 'manual-reconcile');
    assert.equal(reconcileEvent.details.human_admin_override, approval);
    assert.deepEqual(reconcileEvent.details.reconciled_drift.map((entry) => path.posix.basename(entry)).sort(), expectedPaths);
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);

    const afterAdoption = invoke(['adr', 'new', '--title', 'After migration', '--ticket', 'COORD-722', '--json']);
    assert.equal(afterAdoption.ok, true, afterAdoption.error);
    fs.appendFileSync(path.join(decisions, '0001-existing-decision.md'), '\nout-of-band edit\n', 'utf8');
    const laterWrite = invoke(['adr', 'link', 'COORD-722', '0001', '--json']);
    assert.equal(laterWrite.ok, false, 'reviewed baseline adoption must not weaken later drift detection');
    assert.match(laterWrite.error, /0001-existing-decision\.md/);
  });
});

// Shared fixture: a seeded ADR whose latest journal snapshot predates ADR
// governance (the pre-COORD-722 shape), so decisions/** is drifted at entry.
function seedLegacyAdrBaseline({ tempDir, logPath }, label) {
  const decisions = governanceState.DECISIONS_DIR;
  fs.mkdirSync(decisions, { recursive: true });
  fs.writeFileSync(path.join(decisions, 'README.md'), '# Decision Records (ADRs)\n', 'utf8');
  const env = { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: label, CODEX_THREAD_ID: `thread-${label}` };
  const invoke = (args) => executeCommand(args, { cwd: tempDir, env });
  assert.equal(invoke(['agentid', '--assign']).ok, true);
  const seed = invoke(['adr', 'new', '--title', 'Existing decision', '--ticket', 'COORD-722', '--json']);
  assert.equal(seed.ok, true, seed.error);
  const legacy = __testing.buildGovernanceSnapshot();
  legacy.files = legacy.files.filter((entry) => !entry.path.includes('/docs/decisions/'));
  legacy.digest = crypto.createHash('sha1').update(JSON.stringify(legacy.files)).digest('hex');
  fs.writeFileSync(governanceState.GOVERNANCE_SNAPSHOT_PATH, JSON.stringify(legacy), 'utf8');
  fs.writeFileSync(logPath, `${JSON.stringify({
    ts: '2026-01-01T00:00:00.000Z', command: 'legacy-baseline', ticket: null,
    before_status: null, after_status: null, identity: null, details: null,
    changed_paths: [], snapshot: legacy,
  })}\n`, 'utf8');
  return { decisions, invoke, adrPath: path.join(decisions, '0001-existing-decision.md') };
}

const basenames = (paths) => paths.map((entry) => path.posix.basename(entry)).sort();
// The event log stores only snapshot_digest; the snapshot artifact holds the files.
const latestSnapshot = () => __testing.readLatestGovernanceSnapshotSource().snapshot;
// Packet paths are coord-relative. These reconcile flows use an ignored
// sandbox below coord/ so the real production path authority emits valid ones.
const withReconcileSurfaceSandbox = (fn) => withGovernedSurfaceSandbox(fn, { coordRelativePaths: true });

test('COORD-722: drift-tolerant verbs cannot launder pre-existing ADR drift into the baseline', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const { invoke, adrPath } = seedLegacyAdrBaseline(sandbox, 'coord722-launder');
    fs.appendFileSync(adrPath, '\nTAMPER\n', 'utf8');
    const expected = ['0001-existing-decision.md', 'README.md'];
    assert.deepEqual(basenames(__testing.detectGovernanceProvenanceDrift().drift), expected);

    // claim still does its own job (session recovery) on top of unrelated drift ...
    const claimed = invoke(['claim']);
    assert.equal(claimed.ok, true, claimed.error);
    const claimEvent = __testing.readGovernanceEventLog().at(-1);
    assert.equal(claimEvent.command, 'claim');
    assert.ok(claimEvent.changed_paths.length > 0, 'claim journals its own session write');
    assert.deepEqual(basenames(claimEvent.details.retained_preexisting_drift), expected);
    assert.equal(claimEvent.snapshot_digest, latestSnapshot().digest);
    assert.equal(latestSnapshot().files.some((entry) => entry.path.includes('/docs/decisions/')), false,
      'paths absent from the last journaled snapshot stay absent');
    // ... but the drift it did not produce is still detected afterwards ...
    assert.deepEqual(basenames(__testing.detectGovernanceProvenanceDrift().drift), expected);
    // ... and the next ordinary mutation still refuses without writing.
    const journalBefore = fs.readFileSync(sandbox.logPath);
    const next = invoke(['adr', 'link', 'COORD-722', '0001', '--json']);
    assert.equal(next.ok, false, 'the tampered ADR must not have become the baseline');
    assert.match(next.error, /out-of-band[\s\S]*0001-existing-decision\.md/);
    assert.deepEqual(fs.readFileSync(sandbox.logPath), journalBefore);

    // doctor --fix is drift-tolerant too and must not adopt it either.
    assert.equal(invoke(['doctor', '--fix']).ok, true);
    assert.deepEqual(basenames(__testing.detectGovernanceProvenanceDrift().drift), expected);

    // Only reconcile with a human-admin override adopts it.
    const unbound = invoke(['reconcile', '--reason', 'adopt reviewed ADR bytes', '--human-admin-override', 'fixture admin approves']);
    assert.equal(unbound.ok, false);
    assert.match(unbound.error, /requires --expect-paths-file/);
    assert.deepEqual(basenames(__testing.detectGovernanceProvenanceDrift().drift), expected);
    const adopted = signedReconcile(invoke, withApprovedPacket(['reconcile', '--reason', 'adopt reviewed ADR bytes', '--human-admin-override', 'fixture admin approves'], invoke));
    assert.equal(adopted.ok, true, adopted.error);
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);
  });
});

test('COORD-722: drift retention keeps the last journaled entry for a changed tracked path', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const { invoke, adrPath } = seedLegacyAdrBaseline(sandbox, 'coord722-retain');
    assert.equal(signedReconcile(invoke, withApprovedPacket(['reconcile', '--reason', 'adopt', '--human-admin-override', 'fixture admin approves'], invoke)).ok, true);
    const adoptedEntry = latestSnapshot().files.find((entry) => entry.path.endsWith('0001-existing-decision.md'));
    assert.ok(adoptedEntry);
    fs.appendFileSync(adrPath, '\nTAMPER\n', 'utf8');
    assert.equal(invoke(['claim']).ok, true);
    const claimEvent = __testing.readGovernanceEventLog().at(-1);
    assert.deepEqual(basenames(claimEvent.details.retained_preexisting_drift), ['0001-existing-decision.md']);
    const sealed = latestSnapshot();
    assert.equal(claimEvent.snapshot_digest, sealed.digest);
    assert.deepEqual(sealed.files.find((entry) => entry.path === adoptedEntry.path), adoptedEntry);
    assert.equal(sealed.digest, crypto.createHash('sha1').update(JSON.stringify(sealed.files)).digest('hex'));
    assert.deepEqual(basenames(__testing.detectGovernanceProvenanceDrift().drift), ['0001-existing-decision.md']);
  });
});

test('COORD-722: an out-of-band ADR deletion survives a drift-tolerant verb and is adopted only through an approved packet', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const { invoke, adrPath } = seedLegacyAdrBaseline(sandbox, 'coord722-delete');
    assert.equal(signedReconcile(invoke, withApprovedPacket(['reconcile', '--reason', 'adopt', '--human-admin-override', 'fixture admin approves'], invoke)).ok, true);
    const adoptedEntry = latestSnapshot().files.find((entry) => entry.path.endsWith('0001-existing-decision.md'));
    fs.rmSync(adrPath);
    assert.equal(invoke(['claim']).ok, true);
    assert.deepEqual(basenames(__testing.readGovernanceEventLog().at(-1).details.retained_preexisting_drift), ['0001-existing-decision.md']);
    assert.deepEqual(latestSnapshot().files.find((entry) => entry.path === adoptedEntry.path), adoptedEntry,
      'the deleted ADR keeps its last journaled entry');
    assert.deepEqual(basenames(__testing.detectGovernanceProvenanceDrift().drift), ['0001-existing-decision.md']);
    const dryRun = invoke(['reconcile', '--reason', 'inspect deletion', '--dry-run']);
    const packetLines = JSON.parse(dryRun.stdout).expect_paths_packet;
    assert.deepEqual(packetLines, [`absent ${adoptedEntry.path}`]);
    const packetFile = path.join(sandbox.tempDir, 'deletion.packet');
    fs.writeFileSync(packetFile, `${packetLines[0]}\n`, 'utf8');
    const adopted = signedReconcile(invoke, ['reconcile', '--reason', 'adopt deletion', '--human-admin-override', 'approve deletion', '--expect-paths-file', packetFile]);
    assert.equal(adopted.ok, true, adopted.error);
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);
  });
});

test('COORD-722: reconcile --expect-paths-file adopts exactly the approved packet and refuses any mismatch', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const { decisions, invoke, adrPath } = seedLegacyAdrBaseline(sandbox, 'coord722-packet');
    const approval = 'Fixture administrator approves the packet bytes';
    const dryRun = invoke(['reconcile', '--reason', 'inspect', '--dry-run']);
    assert.equal(dryRun.ok, true, dryRun.error);
    const packetLines = JSON.parse(dryRun.stdout).expect_paths_packet;
    assert.deepEqual(basenames(packetLines.map((line) => line.split(' ').slice(1).join(' '))), ['0001-existing-decision.md', 'README.md']);
    for (const line of packetLines) {
      const [hash, rel] = [line.split(' ')[0], line.split(' ').slice(1).join(' ')];
      assert.equal(hash, crypto.createHash('sha256').update(fs.readFileSync(path.resolve(coord, rel))).digest('hex'));
    }
    const packetFile = path.join(sandbox.tempDir, 'approved.packet');
    const reconcileWith = (lines, run = invoke) => {
      fs.writeFileSync(packetFile, `# approved packet\n\n${lines.join('\n')}\n`, 'utf8');
      return run(['reconcile', '--reason', 'adopt approved packet', '--human-admin-override', approval, '--expect-paths-file', packetFile]);
    };
    const assertRefusedWithoutWrites = (lines, pattern) => {
      const journal = fs.readFileSync(sandbox.logPath);
      const adr = fs.readFileSync(adrPath);
      const drift = __testing.detectGovernanceProvenanceDrift().drift;
      const refused = reconcileWith(lines);
      assert.equal(refused.ok, false, `packet mismatch must refuse: ${pattern}`);
      assert.match(refused.error, pattern);
      assert.match(refused.error, /nothing was adopted|is not "<sha256\|absent> <path>"|more than once|normalized relative POSIX path/);
      assert.deepEqual(fs.readFileSync(sandbox.logPath), journal, 'a refused reconcile appends nothing');
      assert.deepEqual(fs.readFileSync(adrPath), adr);
      assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, drift);
    };
    const assertRefusedContentWithoutWrites = (content, pattern) => {
      const journal = fs.readFileSync(sandbox.logPath);
      const adr = fs.readFileSync(adrPath);
      const drift = __testing.detectGovernanceProvenanceDrift().drift;
      fs.writeFileSync(packetFile, content, 'utf8');
      const refused = invoke(['reconcile', '--reason', 'adopt malformed packet', '--human-admin-override', approval, '--expect-paths-file', packetFile]);
      assert.equal(refused.ok, false);
      assert.match(refused.error, pattern);
      assert.deepEqual(fs.readFileSync(sandbox.logPath), journal, 'a refused reconcile appends nothing');
      assert.deepEqual(fs.readFileSync(adrPath), adr);
      assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, drift);
    };
    // missing: a drifted path the packet does not list
    assertRefusedWithoutWrites(packetLines.slice(0, 1), /would adopt paths not in the packet: .*README\.md/);
    // added: a packet path that is not drifted
    const extra = `absent ${path.relative(coord, path.join(decisions, '0099-unapproved.md')).split(path.sep).join('/')}`;
    assertRefusedWithoutWrites([...packetLines, extra], /packet paths not drifted: .*0099-unapproved\.md/);
    // changed: bytes edited after approval
    fs.appendFileSync(adrPath, '\nedited after approval\n', 'utf8');
    assertRefusedWithoutWrites(packetLines, /bytes differ from the packet: .*0001-existing-decision\.md \(approved [0-9a-f]{64}, current [0-9a-f]{64}\)/);
    fs.writeFileSync(adrPath, fs.readFileSync(adrPath, 'utf8').replace('\nedited after approval\n', ''), 'utf8');
    // malformed and duplicated packets
    assertRefusedWithoutWrites(['not-a-hash docs/decisions/README.md'], /line 3 is not "<sha256\|absent> <path>"/);
    assertRefusedWithoutWrites([packetLines[0], packetLines[0]], /more than once/);
    assertRefusedContentWithoutWrites(`| path | sha256 |\n| --- | --- |\n| coord/docs/decisions/0001-existing-decision.md | ${'a'.repeat(64)} |\n${packetLines[0]}\n`, /exactly one packet format; mixed table and line/);
    assertRefusedWithoutWrites([`${packetLines[0].split(' ')[0]} ./docs/decisions/0001-existing-decision.md`], /normalized relative POSIX path/);
    assertRefusedWithoutWrites([`${packetLines[0].split(' ')[0]} ../outside.md`], /normalized relative POSIX path/);

    const adopted = reconcileWith(packetLines, (args) => signedReconcile(invoke, args));
    assert.equal(adopted.ok, true, adopted.error);
    const event = __testing.readGovernanceEventLog().findLast((entry) => entry.command === 'manual-reconcile');
    assert.deepEqual(basenames(event.details.approved_packet_paths), ['0001-existing-decision.md', 'README.md']);
    assert.deepEqual([...event.details.reconciled_drift].sort(), [...event.details.approved_packet_paths].sort());
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);
    // with nothing drifted, a non-empty packet is itself a mismatch
    assertRefusedWithoutWrites(packetLines, /packet paths not drifted/);
  });
});

test('COORD-836: reconcile refuses actual after-snapshot additions, removals, and byte changes', () => {
  for (const change of ['add', 'remove', 'change']) {
    withReconcileSurfaceSandbox(({ tempDir, boardPath, logPath }) => {
      const env = { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: `coord836-after-${change}`, CODEX_THREAD_ID: `thread-836-after-${change}` };
      const invoke = (args) => executeCommand(args, { cwd: tempDir, env });
      assert.equal(invoke(['agentid', '--assign']).ok, true);
      const decisions = governanceState.DECISIONS_DIR;
      const approvedPath = path.join(decisions, 'approved.md');
      const approvedBytes = Buffer.from('approved bytes\n');
      fs.writeFileSync(approvedPath, approvedBytes);
      const approvedRelativePath = path.relative(coord, approvedPath).split(path.sep).join('/');
      const approvedHash = crypto.createHash('sha256').update(approvedBytes).digest('hex');
      const expectedPacket = [`${approvedHash} ${approvedRelativePath}`];
      const dryRun = invoke(['reconcile', '--reason', `inspect ${change}`, '--dry-run']);
      assert.equal(dryRun.ok, true, dryRun.error);
      assert.deepEqual(JSON.parse(dryRun.stdout).expect_paths_packet, expectedPacket,
        'fixture expected path and bytes are independent of the dry-run packet');
      const packetPath = path.join(tempDir, `approved-${change}.packet`);
      fs.writeFileSync(packetPath, `${expectedPacket.join('\n')}\n`);

      const governedState = () => ({
        board: fs.readFileSync(boardPath),
        plan: fs.readFileSync(governanceState.PLAN_PATH),
        questions: fs.readFileSync(governanceState.QUESTIONS_PATH),
        journal: fs.readFileSync(logPath),
        decisions: fs.readdirSync(decisions).sort().map((name) => [name, fs.readFileSync(path.join(decisions, name))]),
      });
      const args = ['reconcile', '--reason', `adopt ${change}`, '--human-admin-override',
        'fixture administrator approves exact path', '--expect-paths-file', packetPath];
      signedReconcile(invoke, args, (runApproved) => {
        // The unsigned request and real signer login finish before the fault is
        // installed. Its refusal audit is part of the pre-mutation journal.
        const before = governedState();
        const latePath = path.join(decisions, change === 'add' ? 'late.md' : 'approved.md');
        const originalReaddir = fs.readdirSync;
        const logDescriptor = Object.getOwnPropertyDescriptor(console, 'log');
        let currentLog = console.log;
        let callbackCompleted = false;
        let injected = false;
        const observeLog = function (line, ...rest) {
          // The callback emits its provisional result immediately before the
          // transaction builds and validates the actual after-snapshot. Arm at
          // this observable boundary instead of counting incidental reads.
          try {
            if (JSON.parse(String(line)).status === 'reconciled') callbackCompleted = true;
          } catch { /* unrelated command output */ }
          return currentLog.call(this, line, ...rest);
        };
        // executeCommand installs its own output collector; observe that writer
        // through its normal console property assignment, without replacing CLI dispatch.
        Object.defineProperty(console, 'log', { configurable: true,
          get: () => observeLog, set: (writer) => { if (writer !== observeLog) currentLog = writer; } });
        fs.readdirSync = function (target, ...rest) {
          if (callbackCompleted && !injected && path.resolve(String(target)) === path.resolve(decisions)) {
            injected = true;
            if (change === 'add') fs.writeFileSync(latePath, 'unapproved extra path\n');
            if (change === 'remove') fs.rmSync(latePath);
            if (change === 'change') fs.writeFileSync(latePath, 'changed after approval\n');
          }
          return originalReaddir.call(this, target, ...rest);
        };
        let refused;
        try { refused = runApproved(); }
        finally { fs.readdirSync = originalReaddir; Object.defineProperty(console, 'log', logDescriptor); }
        assert.equal(callbackCompleted, true, 'the signed request reached the mutation callback');
        assert.equal(injected, true, 'the fault was injected at after-snapshot enumeration');
        assert.equal(refused.ok, false, 'actual after-snapshot drift must refuse adoption');
        assert.match(refused.error, /actual after-snapshot changed after packet validation/);
        const after = governedState();
        // Verification precedes the mutation and remains audited on rollback.
        // All earlier journal bytes and all governed material must be restored.
        assert.deepEqual(after.journal.subarray(0, before.journal.length), before.journal);
        const appended = after.journal.subarray(before.journal.length).toString('utf8')
          .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        assert.equal(appended.length, 1, 'no reconcile or rollback mutation event is adopted');
        assert.equal(appended[0].event, 'approval.verified');
        assert.equal(appended[0].command, 'reconcile');
        assert.equal(appended[0].ticket, 'control-plane');
        assert.match(appended[0].approval_record, /^[a-f0-9]{32}$/);
        assert.deepEqual({ ...after, journal: before.journal }, before,
          'refusal restores board, plan, questions, and ADR bytes exactly');
      });
    }, { coordRelativePaths: true });
  }
});

test('COORD-722: a reconcile packet over a missing baseline must list every governed file', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const { invoke } = seedLegacyAdrBaseline(sandbox, 'coord722-genesis');
    fs.rmSync(sandbox.logPath, { force: true });
    fs.rmSync(governanceState.GOVERNANCE_SNAPSHOT_PATH, { force: true });
    const dryRun = invoke(['reconcile', '--reason', 'inspect genesis', '--dry-run']);
    assert.equal(dryRun.ok, true, dryRun.error);
    const packetLines = JSON.parse(dryRun.stdout).expect_paths_packet;
    // Exclude only the fixture's configured transient ledgers. Do not use
    // the production classifier here: ignored ADRs and durable plan files stay in.
    const transient = new Set([governanceState.AGENTS_PATH, governanceState.AGENT_SESSIONS_PATH]
      .map((file) => path.relative(coord, file).split(path.sep).join('/')));
    const files = __testing.buildGovernanceSnapshot().files
      .filter((entry) => entry.exists && !transient.has(entry.path)).map((entry) => entry.path);
    assert.deepEqual(packetLines.map((line) => line.split(' ').slice(1).join(' ')), files);
    const packetFile = path.join(sandbox.tempDir, 'genesis.packet');
    fs.writeFileSync(packetFile, packetLines.slice(1).join('\n'), 'utf8');
    const refused = invoke(['reconcile', '--reason', 'genesis', '--human-admin-override', 'approve', '--expect-paths-file', packetFile]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /would adopt paths not in the packet/);
    assert.equal(fs.existsSync(sandbox.logPath), false, 'a refused genesis reconcile must not bootstrap the journal');
    fs.writeFileSync(packetFile, packetLines.join('\n'), 'utf8');
    const adopted = signedReconcile(invoke, ['reconcile', '--reason', 'genesis', '--human-admin-override', 'approve', '--expect-paths-file', packetFile]);
    assert.equal(adopted.ok, true, adopted.error);
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);
  });
});

test('COORD-836: missing-baseline reconcile requires a Git-ignored governed file in the explicit packet', () => {
  withReconcileSurfaceSandbox(({ tempDir, boardPath, logPath }) => {
    const env = { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: 'coord836-ignored-governed', CODEX_THREAD_ID: 'thread-836-ignored-governed' };
    const invoke = (args) => executeCommand(args, { cwd: tempDir, env });
    const decisions = governanceState.DECISIONS_DIR;
    const ignoredPath = path.join(decisions, 'ignored', 'governed.json');
    fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
    fs.writeFileSync(ignoredPath, '{"reviewed":true}\n');
    fs.appendFileSync(path.join(coord, '.gitignore'), '\n**/docs/decisions/ignored/\n');
    const gitPath = path.relative(fixtureRoot, ignoredPath).split(path.sep).join('/');
    const ignored = spawnSync('git', ['check-ignore', '--quiet', gitPath], { cwd: fixtureRoot });
    assert.equal(ignored.status, 0, 'the governed fixture path is actually Git ignored');

    const relative = (file) => path.relative(coord, file).split(path.sep).join('/');
    const expectedPaths = [boardPath, governanceState.PLAN_PATH, governanceState.QUESTIONS_PATH,
      ignoredPath].map(relative).sort((left, right) => left.localeCompare(right));
    const expectedPacket = expectedPaths.map((entry) => {
      const bytes = fs.readFileSync(path.resolve(coord, entry));
      return `${crypto.createHash('sha256').update(bytes).digest('hex')} ${entry}`;
    });
    const dryRun = invoke(['reconcile', '--reason', 'inspect missing baseline', '--dry-run']);
    assert.equal(dryRun.ok, true, dryRun.error);
    assert.deepEqual(JSON.parse(dryRun.stdout).expect_paths_packet, expectedPacket,
      'the independently declared governed path set includes the ignored file and excludes only runtime ledgers');

    const packetPath = path.join(tempDir, 'explicit.packet');
    const withoutIgnored = expectedPacket.filter((line) => !line.endsWith(` ${relative(ignoredPath)}`));
    fs.writeFileSync(packetPath, `${withoutIgnored.join('\n')}\n`);
    const journalBefore = fs.existsSync(logPath) ? fs.readFileSync(logPath) : null;
    const refused = invoke(['reconcile', '--reason', 'approve incomplete baseline', '--human-admin-override', 'fixture administrator reviewed listed paths', '--expect-paths-file', packetPath]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /would adopt paths not in the packet: .*governed\.json/);
    assert.equal(fs.existsSync(logPath), journalBefore !== null);
    if (journalBefore) assert.deepEqual(fs.readFileSync(logPath), journalBefore);

    fs.writeFileSync(packetPath, `${expectedPacket.join('\n')}\n`);
    const adopted = signedReconcile(invoke, ['reconcile', '--reason', 'approve complete baseline', '--human-admin-override', 'fixture administrator reviewed every governed path', '--expect-paths-file', packetPath]);
    assert.equal(adopted.ok, true, adopted.error);
    const event = __testing.readGovernanceEventLog().findLast((entry) => entry.command === 'manual-reconcile');
    assert.ok(event.details.approved_packet_paths.includes(relative(ignoredPath)));
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);
  }, { coordRelativePaths: true });
});

test('COORD-722: failure inside adr supersede restores both ADR files and the registry byte-for-byte', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const decisions = governanceState.DECISIONS_DIR;
    fs.mkdirSync(decisions, { recursive: true });
    const readme = path.join(decisions, 'README.md');
    fs.writeFileSync(readme, '# Decision Records (ADRs)\n', 'utf8');
    const env = { COORD_PROVIDER: 'codex', COORD_INSTANCE_ID: 'coord722-supersede', CODEX_THREAD_ID: 'thread-722-supersede' };
    const invoke = (args) => executeCommand(args, { cwd: sandbox.tempDir, env });
    assert.equal(invoke(['agentid', '--assign']).ok, true);
    assert.equal(invoke(['adr', 'new', '--title', 'Old decision', '--ticket', 'COORD-722', '--json']).ok, true);
    assert.equal(invoke(['adr', 'new', '--title', 'New decision', '--ticket', 'COORD-722', '--json']).ok, true);
    const oldPath = path.join(decisions, '0001-old-decision.md');
    const newPath = path.join(decisions, '0002-new-decision.md');
    // Bytes that do not round-trip through UTF-8: a decoding restore would turn
    // them into U+FFFD. Adopt them through the reviewed path first.
    fs.appendFileSync(oldPath, Buffer.from([0x0a, 0xff, 0xfe, 0x0a]));
    const adopted = signedReconcile(invoke, withApprovedPacket(['reconcile', '--reason', 'adopt fixture bytes', '--human-admin-override', 'fixture admin approves'], invoke));
    assert.equal(adopted.ok, true, adopted.error);
    const before = new Map([oldPath, newPath, readme].map((file) => [file, fs.readFileSync(file)]));
    const journalBefore = fs.readFileSync(sandbox.logPath);
    const originalWrite = fs.writeFileSync;
    const adrWrites = [];
    const lockHeld = [];
    let injected = false;
    fs.writeFileSync = function (target, ...args) {
      const resolved = typeof target === 'string' ? path.resolve(target) : null;
      if (resolved && resolved.startsWith(`${decisions}${path.sep}`)) lockHeld.push(fs.existsSync(governanceState.GOVERNANCE_EVENT_LOCK_DIR));
      if (resolved === oldPath || resolved === newPath) adrWrites.push(resolved);
      if (resolved === readme && adrWrites.length === 2 && !injected) {
        injected = true;
        throw new Error('injected supersede registry failure');
      }
      return originalWrite.call(this, target, ...args);
    };
    try {
      assert.throws(
        () => invoke(['adr', 'supersede', '0001', '--by', '0002', '--ticket', 'COORD-722', '--json']),
        /injected supersede registry failure/
      );
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(injected, true, 'fault was injected after both ADR writes');
    assert.deepEqual(adrWrites, [oldPath, newPath]);
    assert.deepEqual(lockHeld.filter((held) => !held), [], 'every ADR write happens under the governance runtime lock');
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, `${path.basename(file)} restored byte-for-byte`);
    assert.deepEqual(fs.readFileSync(sandbox.logPath), journalBefore, 'a rolled-back supersede journals nothing');
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);
  });
});

// Review regressions (launder2): a tampered, journaled ADR must stay drifted
// through every append path a drift-tolerant verb can reach.
function seedTamperedJournaledAdr(sandbox, label) {
  const { invoke, adrPath } = seedLegacyAdrBaseline(sandbox, label);
  assert.equal(signedReconcile(invoke, withApprovedPacket(['reconcile', '--reason', 'adopt', '--human-admin-override', 'fixture admin approves'], invoke)).ok, true);
  assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);
  fs.appendFileSync(adrPath, '\nTAMPERED: status Accepted -> Rejected\n', 'utf8');
  assert.deepEqual(basenames(__testing.detectGovernanceProvenanceDrift().drift), ['0001-existing-decision.md']);
  return { invoke, adrPath };
}

const assertNextOrdinaryMutationRefuses = (invoke) => {
  assert.deepEqual(basenames(__testing.detectGovernanceProvenanceDrift().drift), ['0001-existing-decision.md']);
  const next = invoke(['adr', 'link', 'COORD-999', '0001', '--json']);
  assert.equal(next.ok, false, 'the tampered ADR must not have become the baseline');
  assert.match(next.error, /out-of-band[\s\S]*0001-existing-decision\.md/);
};

test('COORD-722: a collision recorded inside a drift-tolerant verb that then fails does not adopt drift', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const { invoke } = seedTamperedJournaledAdr(sandbox, 'coord722-collision');
    const baselineDigest = latestSnapshot().digest;
    // The claimTicket co-located-session shape: drift-tolerant mutation ->
    // recordGovernanceCollision -> refusal (rollback appends nothing).
    assert.throws(() => __testing.withGovernanceMutation({ command: 'claim-ticket', ticket: null, allowProvenanceDrift: true }, () => {
      __testing.recordGovernanceCollision({ conflictType: 'co-located-session', verb: 'claim', contenders: [] });
      throw new Error('co-located refusal');
    }), /co-located refusal/);
    const collision = __testing.readGovernanceEventLog().at(-1);
    assert.equal(collision.command, 'collision-detected');
    assert.equal(collision.snapshot_digest, baselineDigest, 'a collision re-records the current baseline, never on-disk state');
    assertNextOrdinaryMutationRefuses(invoke);
  });
});

test('COORD-722: crash rollback of an interrupted drift-tolerant verb does not adopt its entry-time drift', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const { invoke, adrPath } = seedTamperedJournaledAdr(sandbox, 'coord722-crash');
    const adoptedEntry = latestSnapshot().files.find((entry) => entry.path.endsWith('0001-existing-decision.md'));
    // claim crashed after entry: its restore point (captured over the tampered
    // ADR) is persisted, and it had already rewritten the board.
    __testing.persistGovernanceRestorePoint(__testing.captureGovernanceRestorePoint(), { command: 'claim' });
    const tampered = fs.readFileSync(adrPath);
    fs.appendFileSync(governanceState.BOARD_PATH, '\n', 'utf8');
    const journalLength = __testing.readGovernanceEventLog().length;
    const next = invoke(['adr', 'link', 'COORD-999', '0001', '--json']);
    assert.equal(next.ok, false, 'an ordinary ADR mutation must not proceed on top of the tampered ADR');
    assert.match(next.error, /out-of-band[\s\S]*0001-existing-decision\.md/);
    const appended = __testing.readGovernanceEventLog().slice(journalLength);
    assert.deepEqual(appended.map((event) => event.command), ['crash-rollback']);
    assert.deepEqual(latestSnapshot().files.find((entry) => entry.path === adoptedEntry.path), adoptedEntry,
      'the rollback event keeps the last journaled entry for the entry-time drift');
    assert.deepEqual(fs.readFileSync(adrPath), tampered, 'rollback restores bytes; it does not hide the tamper');
    assertNextOrdinaryMutationRefuses(invoke);
  });
});

const APPROVED_PACKET = path.join(coord, 'docs', 'evidence', 'COORD-722-adr-baseline-packet.md');
const packetFail = (message) => { throw new Error(message); };

test('COORD-722: the human-approved markdown packet parses verbatim into coord-relative paths', () => {
  const text = fs.readFileSync(APPROVED_PACKET, 'utf8');
  const rows = text.split('\n').filter((line) => /^\| \d+ \|/.test(line)).map((line) => line.split('|').map((cell) => cell.trim()));
  assert.equal(rows.length, 17);
  const packet = parseReconcilePacket(text, { coordDir: coord, fail: packetFail });
  assert.deepEqual([...packet.entries()], rows.map(([, , repoPath, sha]) => [repoPath.replace(/^coord\//, ''), sha]),
    'repo-relative coord/... rows become the coord-relative paths reconcile --dry-run reports; prose is ignored');
  assert.ok([...packet.keys()].every((entry) => entry.startsWith('docs/decisions/')));
  // A malformed row in an approval table refuses instead of being skipped.
  assert.throws(() => parseReconcilePacket(text.replace(/[0-9a-f]{64}/, 'not-a-hash'), { coordDir: coord, fail: packetFail }),
    /table row on line \d+ needs a repo-relative path and a sha256/);
  assert.throws(() => parseReconcilePacket('# nothing approved\n', { coordDir: coord, fail: packetFail }), /names no paths/);
});

test('COORD-722: reconcile adopts exactly the paths of a markdown approval packet in the approved format', () => {
  withReconcileSurfaceSandbox((sandbox) => {
    const { invoke, adrPath } = seedLegacyAdrBaseline(sandbox, 'coord722-markdown');
    const drifted = __testing.detectGovernanceProvenanceDrift().drift;
    assert.deepEqual(basenames(drifted), ['0001-existing-decision.md', 'README.md']);
    // Same layout as the approved evidence file: its prose verbatim, its table
    // rows replaced by this sandbox's repo-relative paths and hashes.
    const approved = fs.readFileSync(APPROVED_PACKET, 'utf8').split('\n');
    const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const rowsFor = (files) => files.map((file, index) => `| ${index + 1} | ${path.relative(path.dirname(coord), file).split(path.sep).join('/')} | ${sha(file)} |`);
    const writePacket = (files) => {
      const firstRow = approved.findIndex((line) => /^\| \d+ \|/.test(line));
      const rest = approved.slice(firstRow).filter((line) => !/^\| \d+ \|/.test(line));
      const file = path.join(sandbox.tempDir, 'approved-packet.md');
      fs.writeFileSync(file, [...approved.slice(0, firstRow), ...rowsFor(files), ...rest].join('\n'), 'utf8');
      return file;
    };
    const readme = path.join(governanceState.DECISIONS_DIR, 'README.md');
    const reconcile = (file, run = invoke) => run(['reconcile', '--reason', 'adopt approved ADR baseline', '--human-admin-override', 'fixture admin approves the packet', '--expect-paths-file', file]);
    const journal = fs.readFileSync(sandbox.logPath);
    const partial = reconcile(writePacket([adrPath]));
    assert.equal(partial.ok, false);
    assert.match(partial.error, /would adopt paths not in the packet: .*README\.md/);
    assert.deepEqual(fs.readFileSync(sandbox.logPath), journal);
    const adopted = reconcile(writePacket([adrPath, readme]), (args) => signedReconcile(invoke, args));
    assert.equal(adopted.ok, true, adopted.error);
    const event = __testing.readGovernanceEventLog().findLast((entry) => entry.command === 'manual-reconcile');
    assert.deepEqual([...event.details.approved_packet_paths].sort(), [...drifted].sort());
    assert.deepEqual(__testing.detectGovernanceProvenanceDrift().drift, []);
  });
});
