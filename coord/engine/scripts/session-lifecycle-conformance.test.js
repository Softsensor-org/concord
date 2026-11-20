'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fork,spawn,spawnSync}=require('node:child_process');
const {waitForMessage,createLaneWaits,createLaneTracker,PROGRESS_DEFAULTS,fixedLayoutEnv:env}=require('./session-lifecycle-test-utils');
// COORD-851: like the worker's own CLI calls, skip V8 coverage the runner discards for the temporary engine copy.
function run(cwd,thread,...args){const trace=path.join(path.dirname(cwd),'git-trace2.jsonl'),cliEnv=env(thread,{...process.env,GIT_TRACE2_EVENT:trace});cliEnv.NODE_V8_COVERAGE='';return spawnSync(process.execPath,[path.join(cwd,'scripts/governance.js'),...args],{cwd:path.dirname(cwd),env:cliEnv,encoding:'utf8'});}
const ownedProcessGroups = new WeakSet();
function forkOwnedWorker(file, args, options) {
 const detached = process.platform !== 'win32';
 const child = fork(file, args, { ...options, detached });
 if (detached) ownedProcessGroups.add(child);
 return child;
}
function reap(child){
 // The worker may already have exited while a synchronous CLI descendant
 // continues writing its fixture. Reap its owned group before filesystem cleanup.
 if (ownedProcessGroups.has(child)) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
 }
if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();return new Promise(resolve=>{const timer=setTimeout(resolve,2000);child.once('exit',()=>{clearTimeout(timer);resolve();});if(child.connected)child.disconnect();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});}
function snapshot(b){return ['board/tasks.json','.runtime/agent_sessions.json',`.runtime/locks/${b.id}.lock`,`.runtime/plans/${b.id}.json`,'PLAN.md'].map(p=>{const f=path.join(b.coord,p),s=fs.statSync(f);return {p,bytes:fs.readFileSync(f,'utf8'),ino:s.ino,mode:s.mode,mtime:s.mtimeMs,ctime:s.ctimeMs};}).concat(['docs/LANE.md','docs/UNTRACKED.md'].map(p=>({p,bytes:fs.readFileSync(path.join(b.worktree,p),'utf8')})));}
function remainingFixtureEntries(root, limit = 128) {
 const entries = [], pending = [root];
 while (pending.length && entries.length < limit) {
  const dir = pending.pop(); let names = [];
  try { names = fs.readdirSync(dir); }
  catch (error) { entries.push({ path: path.relative(root, dir) || '.', error: error.code || 'read_failed' }); continue; }
  for (const name of names) {
   if (entries.length >= limit) break;
   const full = path.join(dir, name); let type = 'unknown';
   try { const stat = fs.lstatSync(full); type = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other'; }
   catch (error) { entries.push({ path: path.relative(root, full), error: error.code || 'stat_failed' }); continue; }
   entries.push({ path: path.relative(root, full), type }); if (type === 'directory') pending.push(full);
  }
 }
 return { entries, truncated: pending.length > 0 || entries.length >= limit };
}
function fixtureProcesses(root, limit = 32) {
 const processes = []; let pids = [];
 try { pids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)); }
 catch { return { available: false, processes }; }
 for (const pid of pids) {
  if (processes.length >= limit) break;
  const proc = path.join('/proc', pid); let cwd = '', cmdline = '', comm = '', status = '';
  try { cwd = fs.readlinkSync(path.join(proc, 'cwd')); } catch {}
  try { cmdline = fs.readFileSync(path.join(proc, 'cmdline')).toString().replace(/\0/g, ' '); } catch {}
  if (!(cwd === root || cwd.startsWith(`${root}${path.sep}`) || cmdline.includes(root))) continue;
  try { comm = fs.readFileSync(path.join(proc, 'comm'), 'utf8').trim(); } catch {}
  try { status = fs.readFileSync(path.join(proc, 'status'), 'utf8'); } catch {}
  const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] || 0);
  const inside = cwd === root || cwd.startsWith(`${root}${path.sep}`);
  processes.push({ pid: Number(pid), ppid, comm, cwdWithinFixture: inside, ...(inside ? { cwdRelative: path.relative(root, cwd) || '.' } : {}) });
 }
 return { available: true, processes, truncated: processes.length >= limit };
}
function cleanupFixture(root, remove = fs.rmSync, emit = message => console.error(message)) {
 try { remove(root, { recursive: true, force: true }); }
 catch (error) {
  try {
   const diagnostic = {
    kind: 'conformance_fixture_cleanup_failed', root: path.basename(root),
    error: { code: error.code || null, syscall: error.syscall || null },
    remaining: fs.existsSync(root) ? remainingFixtureEntries(root) : { entries: [], truncated: false },
    processes: fixtureProcesses(root),
   };
   emit(`CONFORMANCE FIXTURE CLEANUP FAILURE ${JSON.stringify(diagnostic)}`);
  } catch {
   // Diagnostics are best-effort; preserve and rethrow the original cleanup error.
  }
  throw error;
 }
}
function assertSyntheticGitIsolation(root) {
 const repositories = ['backend', 'coord'];
 if (fs.existsSync(path.join(root, 'remote.git'))) repositories.push('remote.git');
 for (const name of repositories) {
  const repo = path.join(root, name);
  for (const [key, expected] of [['gc.auto', '0'], ['maintenance.auto', 'false'], ['core.compression', '0']]) {
   const value = spawnSync('git', ['-C', repo, 'config', '--local', '--get', key], {
    encoding: 'utf8', env: { ...process.env, GIT_TRACE2_EVENT: path.join(root, 'git-trace2.jsonl') },
   });
   assert.equal(value.status, 0, value.stderr); assert.equal(value.stdout.trim(), expected, `${name} must set ${key}=${expected}`);
  }
 }
 const tracePath = path.join(root, 'git-trace2.jsonl'); assert.ok(fs.existsSync(tracePath), 'fixture Git commands must emit Trace2 evidence');
 const events = fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
 const automaticMaintenance = events.filter(event => event.event === 'child_start' && Array.isArray(event.argv) &&
  event.argv.some((part, index) => part === 'maintenance' && event.argv[index + 1] === 'run') && event.argv.includes('--auto'));
 assert.deepEqual(automaticMaintenance, [], 'synthetic commits must not start automatic Git maintenance');
}
test('COORD-808: cleanup failure retains the fixture, emits bounded diagnostics, and rethrows the original error', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cust013-cleanup-diagnostic-'));
 fs.writeFileSync(path.join(root, 'fixture-marker.txt'), 'synthetic only\n');
 const failure = Object.freeze(Object.assign(new Error('injected cleanup diagnostic test failure'), { code: 'EINJECT' }));
 let attempts = 0, output = '';
 const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, stdio: 'ignore' });
 try {
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  assert.throws(() => cleanupFixture(root, () => { attempts++; throw failure; }, message => { output = message; }), error => error === failure);
  assert.equal(attempts, 1, 'cleanup is attempted once without retry');
  assert.ok(fs.existsSync(path.join(root, 'fixture-marker.txt')), 'failed cleanup retains its fixture');
  const match = /^CONFORMANCE FIXTURE CLEANUP FAILURE (.+)$/.exec(output); assert.ok(match, 'cleanup failure emits one diagnostic record');
  const diagnostic = JSON.parse(match[1]); assert.equal(diagnostic.kind, 'conformance_fixture_cleanup_failed');
  assert.equal(diagnostic.error.code, 'EINJECT'); assert.ok(diagnostic.remaining.entries.some(entry => entry.path === 'fixture-marker.txt'));
  assert.ok(Array.isArray(diagnostic.processes.processes));
  if (diagnostic.processes.available) assert.ok(diagnostic.processes.processes.some(process => process.pid === child.pid && process.cwdWithinFixture), 'diagnostic identifies the fixture-owned child by process/cwd data');
  assert.ok(diagnostic.remaining.entries.length <= 128); assert.ok(diagnostic.processes.processes.length <= 32);
  assert.equal('environment' in diagnostic, false); assert.equal('commandLine' in diagnostic, false);
  assert.equal('message' in diagnostic.error, false);
  const emitFailure = Object.assign(new Error('injected diagnostic sink failure'), { code: 'EEMIT' }); let emitterCalls = 0;
  assert.throws(() => cleanupFixture(root, () => { attempts++; throw failure; }, () => { emitterCalls++; throw emitFailure; }), error => error === failure);
  assert.equal(attempts, 2, 'the failed cleanup is not retried');
  assert.equal(emitterCalls, 1, 'diagnostic emission is attempted once');
 } finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  fs.rmSync(root, { recursive: true, force: true });
 }
});
// COORD-896: each lane phase has a progress deadline (no step for 30s, or 120s
// under host I/O or CPU pressure, fails it; 600s is its ceiling). The test bound
// is only a backstop over the three sequential phases.
test('COORD-712: three isolated OS-process lanes finish real lifecycles and preserve a live sibling across recovery and rollback',{timeout:3*PROGRESS_DEFAULTS.ceilingMs+60000},async()=>{
 const workers=[];let success=false;let roots=[];
 const tracker=createLaneTracker(),progressDir=fs.mkdtempSync(path.join(os.tmpdir(),'coord896-progress-'));
 try{
  for(let lane=1;lane<=3;lane++){
   const progressFile=path.join(progressDir,`lane-${lane}.log`);
   const child=forkOwnedWorker(path.join(__dirname,'session-lifecycle-worker.js'),[String(lane)],{env:{...env(`lane-launch-${lane}`),COORD_LIFECYCLE_PROGRESS_FILE:progressFile},stdio:['ignore','pipe','pipe','ipc']});
   let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
   const waits=createLaneWaits(child,lane,globalThis,tracker);
   workers.push({child,waits,ready:waits.ready,get output(){return output;}});
  }
  const lanes=await Promise.all(workers.map(w=>w.ready));roots=lanes.map(x=>x.root);for(const lane of lanes)assertSyntheticGitIsolation(lane.root);assert.equal(new Set(lanes.map(x=>x.handle)).size,3,'distinct registered handles');assert.equal(new Set(lanes.map(x=>x.thread)).size,3,'distinct native threads');assert.equal(new Set(lanes.map(x=>x.worktree)).size,3,'distinct worktrees');
  const [a,b]=lanes;const before=snapshot(b);
  for(const args of [['resume',b.id,'--owner',b.handle],['recover',b.id,'--owner',b.handle]]){
   const denied=run(b.coord,a.thread,...args);assert.notEqual(denied.status,0,'knowing sibling handle must not authorize its live assignment');assert.deepEqual(snapshot(b),before,'foreign refusal preserves sibling bytes and metadata');
  }
  const checkpoint=run(b.coord,b.thread,'update-plan',b.id,'--invariant','sibling checkpoint must survive another lane rollback');assert.equal(checkpoint.status,0,checkpoint.stderr);
  for(const args of [['add','.'],['commit','-m','sibling checkpoint before foreign lane rollback']]){const r=spawnSync('git',['-C',b.coord,...args],{encoding:'utf8',env:env(b.thread,{...process.env,GIT_TRACE2_EVENT:path.join(b.root,'git-trace2.jsonl')})});assert.equal(r.status,0,r.stderr);}
  const committed=snapshot(b);
  const first=await workers[0].waits.continue();assert.ok(first.events>0);assert.deepEqual(snapshot(b),committed,'A rollback must not rewrite committed sibling state or lock metadata');
  const results=[first,...await Promise.all(workers.slice(1).map(w=>w.waits.continue()))];
  for(const lane of lanes)assertSyntheticGitIsolation(lane.root);
  for(const r of results){assert.match(r.source,/^[0-9a-f]{40}$/);assert.match(r.remote,/^[0-9a-f]{40}$/);assert.ok(r.sessions>=2);}
  // The file channel the mutation sample's deadline reads mirrors the IPC steps.
  for(let lane=1;lane<=3;lane++){const lines=fs.readFileSync(path.join(progressDir,`lane-${lane}.log`),'utf8').trim().split('\n');assert.ok(lines.length>1&&lines.every((l,i)=>l.startsWith(`${lane} ${i+1} `)),`lane ${lane} progress file mirrors its steps`);}
  console.log('COORD-712 lane receipts:',JSON.stringify(results));console.log(tracker.describe(tracker.config.readHost()));
  // COORD-937: a burn-in run records its measured silent gaps and host reading when asked to.
  if(process.env.COORD_LIFECYCLE_TIMING_FILE)fs.appendFileSync(process.env.COORD_LIFECYCLE_TIMING_FILE,JSON.stringify({measuredAt:new Date().toISOString(),lanes:tracker.stats(),host:tracker.config.readHost()})+'\n');
  success=true;
 }finally{await Promise.all(workers.map(w=>reap(w.child)));if(!success)for(const w of workers)console.error(w.output);else if(!process.env.COORD_KEEP_CONFORMANCE)for(const root of roots)cleanupFixture(root);cleanupFixture(progressDir);}
});

// COORD-852: a run the deadline kills mid-fixture reports nothing yet still leaves a
// partial sandbox (and its approved-packet dir), so each such child gets a private TMPDIR.
function privateTmpdir(label){return fs.mkdtempSync(path.join(os.tmpdir(),`coord852-${label}-`));}
function closed(child,ms=2000){return new Promise(resolve=>{if(child.stdout.closed&&child.stderr.closed)return resolve();const timer=setTimeout(resolve,ms);child.once('close',()=>{clearTimeout(timer);resolve();});});}
test('COORD-1050: reaping an exited worker stops its descendant fixture writer', {
 timeout: 10000, skip: process.platform === 'win32' ? 'POSIX process groups are unavailable on Windows' : false,
}, async () => {
 const root = privateTmpdir('descendant-writer');
 const output = path.join(root, 'output');
 const writer = path.join(root, 'writer.cjs');
 const parent = path.join(root, 'parent.cjs');
 fs.writeFileSync(writer, `const fs=require('node:fs');const p=process.argv[2];function write(){fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/tick',String(Date.now()));}write();process.send('ready');setInterval(write,5);`);
 fs.writeFileSync(parent, `const {fork}=require('node:child_process');const c=fork(process.argv[2],[process.argv[3]],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>process.send({type:'ready'}));setInterval(()=>{},1000);`);
 const child = forkOwnedWorker(parent, [writer, output], {
  env: env('descendant-writer'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
 });
 try {
  await waitForMessage(child, 'ready', 1, 5000);
  assert.ok(fs.existsSync(path.join(output, 'tick')), 'descendant is writing before worker termination');
  child.kill('SIGKILL');
  await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
  await reap(child);
  await closed(child);
  fs.rmSync(output, { recursive: true, force: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fs.existsSync(output), false, 'orphan writer must not recreate the cleaned fixture');
 } finally {
  // Also reclaim the writer if the assertion or an intentionally mutated
  // reaper fails, so the regression test cannot leak its own process tree.
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await reap(child);
  fs.rmSync(root, { recursive: true, force: true });
 }
});
test('COORD-741: injected worker startup failure is bounded and reaped',{timeout:10000},async()=>{
 const tmp=privateTmpdir('startup-failure');
 const child=forkOwnedWorker(path.join(__dirname,'session-lifecycle-worker.js'),['1'],{env:{...env('lane-startup-failure'),COORD_INJECT_LIFECYCLE_STARTUP_FAILURE:'1',TMPDIR:tmp},stdio:['ignore','pipe','pipe','ipc']});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 let originalError;
 try {
  try { await assert.rejects(waitForMessage(child,'ready',1,3000),/exited before ready|startup failure|did not emit ready/); }
  finally { await reap(child); await closed(child); }
  assert.ok(child.killed || child.exitCode!==null || child.signalCode!==null,'failed startup worker must receive bounded cleanup');
  // Like COORD-748: reclaim the sandbox the worker reports, and only that one.
  const reported=output.match(/RETAINED SANDBOX (.+)/)?.[1]?.trim();
  if(reported){
   assert.equal(path.dirname(path.resolve(reported)),path.resolve(tmp),'reported sandbox lives under the private TMPDIR');
   assert.match(path.basename(reported),/^cust013-cli-/);
   cleanupFixture(reported);
   if(child.signalCode===null)assert.deepEqual(fs.readdirSync(tmp),[],'a naturally failed startup leaves nothing beyond its reported sandbox');
  }
 } catch(error){originalError=error;}
 try{cleanupFixture(tmp);}catch(cleanupError){if(!originalError)originalError=cleanupError;}
 if(originalError)throw originalError;
 assert.equal(fs.existsSync(tmp),false,'COORD-741 leaves no sandbox behind');
});

test('COORD-720: direct worker startup failure retains the default lane diagnostic sandbox',{timeout:30000},()=>{
 const progressDir=privateTmpdir('direct-worker-progress');
 const progressFile=path.join(progressDir,'progress.log');
 const r=spawnSync(process.execPath,[path.join(__dirname,'session-lifecycle-worker.js')],{
  env:{...env('direct-worker-startup-failure'),COORD_INJECT_LIFECYCLE_STARTUP_FAILURE:'1',
    COORD_INJECT_LIFECYCLE_SLOW_ONCE_MS:'1',COORD_LIFECYCLE_PROGRESS_FILE:progressFile},
  encoding:'utf8',timeout:25000,
 });
 const retained=/RETAINED SANDBOX ([^\r\n]+)/.exec(r.stderr || '');
 let root=null;
 if(retained){
  root=retained[1];
  assert.equal(path.dirname(root),require('node:os').tmpdir());
  assert.match(path.basename(root),/^cust013-cli-/);
 }
 let originalError;
 try{
  assert.equal(r.error,undefined,'direct worker must exit before its bounded deadline');
  assert.equal(r.status,1);
  assert.match(r.stderr,/injected lifecycle worker startup failure/);
  assert.ok(root,'startup failure preserves its diagnostic sandbox');
  const board=JSON.parse(fs.readFileSync(path.join(root,'coord/board/tasks.json'),'utf8'));
  assert.equal(board.sections[0].rows[0].Owner,'codexa11','no lane argument uses lane one');
  assert.equal(fs.readFileSync(path.join(root,'backend/evidence.txt'),'utf8'),'preserve me\n');
  const steps=fs.readFileSync(progressFile,'utf8').trim().split('\n');
  assert.equal(steps[0],'1 1 engine copy','slow injection preserves the initial real progress event');
  assert.equal(steps.at(-1),`1 ${steps.length} agentid`,'startup still reaches its final identity step before the injected failure');
  assert.doesNotMatch(r.stdout,/DONE/,'failed worker cannot advertise a completed lifecycle');
  assertSyntheticGitIsolation(root);
 }catch(error){originalError=error;}
 if(root){try{cleanupFixture(root);}catch(cleanupError){if(!originalError)originalError=cleanupError;}}
 try{cleanupFixture(progressDir);}catch(cleanupError){if(!originalError)originalError=cleanupError;}
 if(originalError)throw originalError;
});

// Reuse the primitive shared-runtime proof without extending its guarantee to checkout files.
test('COORD-748: worker default lane and no-IPC startup failure exit naturally with sandbox retained',{timeout:15000},async()=>{
 const child=spawn(process.execPath,[path.join(__dirname,'session-lifecycle-worker.js')],{
  env:{...env('lane-default-startup-failure'),COORD_INJECT_LIFECYCLE_STARTUP_FAILURE:'1'},
  stdio:['ignore','pipe','pipe']
 });
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 let retainedRoot=null;
 let originalError;
 try {
  const exit=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('worker did not close naturally within the bounded startup window')),10000);
   child.once('error',error=>{clearTimeout(timer);reject(error);});
   child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
  });
  assert.equal(exit.signal,null,'startup failure is a natural process exit, not a forced kill');
  assert.notEqual(exit.code,0,'injected startup failure must be visible to the caller');
  assert.match(output,/injected lifecycle worker startup failure/);
  const retained=output.match(/RETAINED SANDBOX (.+)/);
  assert.ok(retained,'worker reports its retained failure fixture');
  retainedRoot=retained[1].trim();
  assert.equal(fs.readFileSync(path.join(retainedRoot,'backend/evidence.txt'),'utf8'),'preserve me\n');
  assert.ok(fs.existsSync(path.join(retainedRoot,'coord/board/tasks.json')),'governed fixture remains available after the failure');
  assert.ok(fs.existsSync(path.join(retainedRoot,'coord/.runtime/agent_sessions.json')),'runtime fixture remains available after the failure');
  assertSyntheticGitIsolation(retainedRoot);
 } catch(error){originalError=error;}
 await reap(child);
 if (!retainedRoot) retainedRoot=output.match(/RETAINED SANDBOX (.+)/)?.[1]?.trim() || null;
 if (retainedRoot && path.dirname(path.resolve(retainedRoot))===path.resolve(os.tmpdir()) && path.basename(retainedRoot).startsWith('cust013-cli-')) {
  try{cleanupFixture(retainedRoot);}catch(cleanupError){if(!originalError)originalError=cleanupError;}
 }
 if(originalError)throw originalError;
});

test('COORD-712: shared runtime refuses by default and explicit exception retains only serialized mutation guarantees',{timeout:90000},()=>{
 // COORD-852: the proof files keep process-scoped lock sandboxes; reclaim them with its TMPDIR.
 const tmp=privateTmpdir('shared-proof');let r;
 try{r=spawnSync(process.execPath,['--test','--test-name-pattern=COORD-224:|COORD-698:',path.join(__dirname,'../../scripts/concurrent-burnin.test.js'),path.join(__dirname,'..', '..','engine','scripts','journal.test.js')],{env:{...env('shared-proof'),COORD_BURNIN_N:'3',COORD_BURNIN_CONCURRENCY:'3',TMPDIR:tmp},encoding:'utf8'});}
 finally{cleanupFixture(tmp);}
 assert.equal(fs.existsSync(tmp),false,'shared-runtime proof leaves no sandbox behind');
 assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/WITHOUT --allow-shared-worktree/);assert.match(r.stdout,/unchanged foreign lock/);
 console.log(r.stdout);
});

// COORD-937: the real lifecycle worker under injected host readings. The verdict depends on the
// injected reading and on the worker's own progress messages, never on this machine's pressure.
const HOST_QUIET={ioPressure:'some avg10=0.00 | full avg10=0.00',ioFullAvg10:0,loadavg:'0.50 0.40 0.30 1/200 99',load1:0.5,cpus:8};
const HOST_IO_BOUND={...HOST_QUIET,ioPressure:'some avg10=52.00 | full avg10=47.89',ioFullAvg10:47.89};
function forkRealLane(lane,injected,tracker,{recordProgress=false}={}){
 const dir=privateTmpdir(`lane${lane}`);
 const progressFile=path.join(dir,'lane-progress.log');
 const child=forkOwnedWorker(path.join(__dirname,'session-lifecycle-worker.js'),[String(lane)],{env:{...env(`lane-937-${lane}`),TMPDIR:dir,...(recordProgress?{COORD_LIFECYCLE_PROGRESS_FILE:progressFile}:{}),...injected},stdio:['ignore','pipe','pipe','ipc']});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 return {child,dir,progressFile,waits:createLaneWaits(child,lane,globalThis,tracker),get output(){return output;}};
}
test('COORD-937: a finite pre-ready stall resumes the real lifecycle worker',{timeout:120000},async()=>{
 const tracker=createLaneTracker({readHost:()=>HOST_QUIET});
 const lane=forkRealLane(1,{COORD_INJECT_LIFECYCLE_HANG:'100'},tracker);
 try{
  const ready=await lane.waits.ready;
  assert.equal(ready.lane,1);
  assert.ok(fs.existsSync(path.join(ready.worktree,'docs/LANE.md')));
  const stopped=closed(lane.child,5000);
  lane.child.disconnect();
  await stopped;
  assert.equal(lane.child.exitCode,0,lane.output);
  assert.equal(lane.child.signalCode,null);
  assert.doesNotMatch(lane.output,/DONE/,'a worker awaiting parent permission cannot complete the lane');
 }finally{await reap(lane.child);cleanupFixture(lane.dir);}
});
test('COORD-937: a hang injected into the real lifecycle worker fails at the stall limit with the documented message',{timeout:120000},async()=>{
 const tracker=createLaneTracker({readHost:()=>HOST_QUIET});
 const lane=forkRealLane(1,{COORD_INJECT_LIFECYCLE_HANG:'ready'},tracker);
 try{
  await assert.rejects(lane.waits.ready,/^Error: lane 1 made no progress toward ready for \d+ms after \d+ms \(stall limit 30000ms, 120000ms under host pressure\)\nlane progress:\n  lane 1: phase=before ready last_step=\S+ steps=\d+ phase_elapsed=\d+ms idle=\d+ms/);
  if(lane.child.exitCode===null&&lane.child.signalCode===null)await new Promise(resolve=>lane.child.once('exit',resolve));
  assert.equal(lane.child.signalCode,'SIGTERM','the hung real worker is killed');
 }finally{await reap(lane.child);cleanupFixture(lane.dir);}
});
test('COORD-937: a slow progressing step under host I/O pressure is not killed at the quiet stall limit',{timeout:240000},async()=>{
 const tracker=createLaneTracker({readHost:()=>HOST_IO_BOUND});
 const lane=forkRealLane(1,{COORD_INJECT_LIFECYCLE_SLOW_ONCE_MS:'40000'},tracker);
 try{
  const ready=await lane.waits.ready;
  assert.equal(ready.lane,1);
  assert.equal(lane.child.signalCode,null,'a progressing lane under pressure is not killed');
  const stats=tracker.stats()[1];
  assert.ok(stats.maxGapMs>=40000,`the slow step must exceed the quiet stall limit (max gap ${stats.maxGapMs}ms)`);
 }finally{await reap(lane.child);cleanupFixture(lane.dir);}
});
test('COORD-937: a real lane that keeps progressing still fails at its hard ceiling',{timeout:120000},async()=>{
 // Keep this real-worker ceiling shorter than production's 600s ceiling, but
 // long enough for the isolated engine/Git fixture setup on a busy host. The
 // utility's exact short-ceiling behavior is covered with fake timers above.
 const tracker=createLaneTracker({readHost:()=>HOST_QUIET,ceilingMs:30000});
 const lane=forkRealLane(1,{COORD_INJECT_LIFECYCLE_SLOW_MS:'5000'},tracker,{recordProgress:true});
 try{
  await assert.rejects(lane.waits.ready,/^Error: lane 1 did not emit ready within the 30000ms ceiling \(still progressing; idle \d+ms\)/);
  if(lane.child.exitCode===null&&lane.child.signalCode===null)await new Promise(resolve=>lane.child.once('exit',resolve));
  assert.equal(lane.child.signalCode,'SIGTERM','the ceiling kills the real worker');
  const recordedSteps=fs.readFileSync(lane.progressFile,'utf8').trim().split('\n').filter(Boolean);
  assert.ok(recordedSteps.length>=3,`the real worker progressed before the ceiling (${recordedSteps.length} recorded steps)`);
 }finally{await reap(lane.child);cleanupFixture(lane.dir);}
});
