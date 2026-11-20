'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const direction of [1, -1]) test(`COORD-754: UI readiness uses elapsed time through ${direction > 0 ? 'forward' : 'backward'} wall-clock jumps`, () => {
  const launcher = path.join(__dirname, 'coord-ui-launch.js');
  const code = `
    const http=require('node:http'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
    const {waitForReady}=require(${JSON.stringify(launcher)});let requests=0;
    const server=http.createServer((req,res)=>{res.statusCode=${direction}===1&&++requests>1?200:503;res.end('fixture');});
    server.listen(0,'127.0.0.1',async()=>{
      const real=Date.now;let calls=0;Date.now=()=>real()+(${direction}*calls++*120000);
      const start=performance.now();let error=null;
      try{await waitForReady('http://127.0.0.1:'+server.address().port,${direction > 0 ? 2000 : 600});}
      catch(e){error=e.message;}finally{Date.now=real;server.close();}
      console.log(JSON.stringify({error,elapsed:performance.now()-start,requests}));
    });
  `;
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 4500 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim());
  if (direction > 0) {
    assert.equal(observed.error, null);
    assert.equal(observed.requests, 2);
  } else assert.match(observed.error, /did not become ready within 0.6s/);
  assert.ok(observed.elapsed >= 600 && observed.elapsed < 3000, JSON.stringify(observed));
});

// COORD-864: the launcher moved under coord/engine/scripts, so its main runs
// end to end here with spawn, the readiness probe, the browser opener and
// signals stubbed by __fixtures__/coord-ui-launch-stub.js.
test('COORD-864: coord-ui-launch main covers help, options, install, serve, open and signal paths', () => {
  const launcher = path.join(__dirname, 'coord-ui-launch.js');
  const stub = path.join(__dirname, '__fixtures__', 'coord-ui-launch-stub.js');
  const run = (args, scenario = {}, env = {}) => {
    const childEnv = { ...process.env, COORD_UI_LAUNCH_STUB: JSON.stringify(scenario), ...env };
    if (!('COORD_UI_HOST' in env)) delete childEnv.COORD_UI_HOST;
    if (!('COORD_UI_PORT' in env)) delete childEnv.COORD_UI_PORT;
    const result = spawnSync(process.execPath, ['--require', stub, launcher, ...args], { encoding: 'utf8', timeout: 10000, env: childEnv });
    assert.ifError(result.error);
    return result;
  };
  const ready = { ui: true, next: true };

  // Help, its short form, and an unknown flag.
  for (const flag of ['--help', '-h']) {
    const help = run([flag]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: node coord\/engine\/scripts\/coord-ui-launch\.js \[options\]/);
  }
  const unknown = run(['--bogus']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown coord-ui option: --bogus/);

  // Every option is parsed; a workspace without the bundled UI stops with a clear error.
  const missing = run(['--no-install', '--open', '--no-open', '--host', 'h1', '--host=h2', '--port', '1', '--port=2'], { exists: { ui: false } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /\[coord-ui\] Missing frontend\/apps\/coord-ui\/package\.json\./);

  // Install, serve and open: the first openers fail, wslview succeeds; the child exits cleanly.
  const served = run([], {
    exists: { ui: true, next: false, winCmd: true, powerShell: true },
    spawnSync: { npm: { status: 0 }, '/mnt/c/Windows/System32/cmd.exe': { status: 1 },
      '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe': { error: 'denied' }, sh: { status: 0 }, wslview: { status: 0 } },
  });
  assert.equal(served.status, 0, served.stderr);
  assert.match(served.stdout, /Installing coord-ui dependencies/);
  assert.match(served.stdout, /STUB spawnSync npm install/);
  assert.match(served.stdout, /STUB spawn npm exec -- next dev -p 3002 -H 127\.0\.0\.1 COORD_DIR=set/);
  assert.match(served.stdout, /STUB spawnSync wslview http:\/\/localhost:3002/);
  assert.doesNotMatch(served.stderr, /auto-open failed/);

  // Windows: npm.cmd, `where` probing, no opener found; environment host/port; child exit code forwarded.
  const windows = run([], { platform: 'win32', exists: ready, spawnSync: { where: { status: 1 } }, child: { code: 3 } },
    { COORD_UI_HOST: '127.0.0.1', COORD_UI_PORT: '4100' });
  assert.equal(windows.status, 3, windows.stderr);
  assert.match(windows.stdout, /STUB spawn npm\.cmd exec -- next dev -p 4100 -H 127\.0\.0\.1/);
  assert.match(windows.stdout, /STUB spawnSync where cmd\.exe/);
  assert.match(windows.stderr, /Browser auto-open failed\. Open http:\/\/localhost:4100 manually\./);

  // The readiness probe gives up; no Windows openers exist on this host.
  const unready = run(['--no-install'], { exists: ready, http: 'error' });
  assert.equal(unready.status, 0, unready.stderr);
  assert.match(unready.stderr, /coord-ui did not become ready within 60s\. Open http:\/\/localhost:3002 manually if it is running\./);

  // Dependency install failures: a non-zero status, a missing status, and a spawn error.
  for (const [result, status] of [[{ status: 2 }, 2], [{ status: null }, 1]]) {
    const failed = run(['--no-open'], { exists: { ui: true, next: false }, spawnSync: { npm: result } });
    assert.equal(failed.status, status, failed.stderr);
  }
  const broken = run(['--no-open'], { exists: { ui: true, next: false }, spawnSync: { npm: { error: 'npm vanished' } } });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /npm vanished/);

  // The dev server cannot start.
  const startFailure = run(['--no-open', '--no-install'], { exists: ready, child: { error: 'spawn ENOENT' } });
  assert.equal(startFailure.status, 1);
  assert.match(startFailure.stderr, /\[coord-ui\] Failed to start: spawn ENOENT/);

  // SIGINT and SIGTERM are forwarded once; a signal exit is re-raised on this process.
  const signalled = run(['--no-open', '--no-install'], { exists: ready, child: { signals: true, signal: 'SIGTERM' } });
  assert.equal(signalled.status, 99, signalled.stderr);
  assert.equal((signalled.stdout.match(/STUB child\.kill/g) || []).length, 1);
  assert.match(signalled.stdout, /STUB child\.kill SIGINT/);
  assert.match(signalled.stdout, /STUB process\.kill SIGTERM/);
});

// COORD-940: the launcher binds loopback by default, refuses a non-loopback bind
// without the explicit flag, and warns with the required auth mode when it is given.
test('COORD-940: coord-ui-launch binds 127.0.0.1 by default and marks the bind scope as loopback', () => {
  const launcher = path.join(__dirname, 'coord-ui-launch.js');
  const stub = path.join(__dirname, '__fixtures__', 'coord-ui-launch-stub.js');
  const scenario = { exists: { ui: true, next: true }, child: { code: 0 } };
  const env = { ...process.env, COORD_UI_LAUNCH_STUB: JSON.stringify(scenario) };
  delete env.COORD_UI_HOST;
  delete env.COORD_UI_PORT;
  const result = spawnSync(process.execPath, ['--require', stub, launcher, '--no-install', '--no-open'], { encoding: 'utf8', timeout: 10000, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STUB spawn npm exec -- next dev -p 3002 -H 127\.0\.0\.1 COORD_DIR=set BIND_SCOPE=loopback/);
  assert.doesNotMatch(result.stdout, /-H 0\.0\.0\.0/);
});

test('COORD-940: a non-loopback bind host is refused without --allow-remote-bind', () => {
  const launcher = path.join(__dirname, 'coord-ui-launch.js');
  const stub = path.join(__dirname, '__fixtures__', 'coord-ui-launch-stub.js');
  const scenario = { exists: { ui: true, next: true }, child: { code: 0 } };
  const base = { ...process.env, COORD_UI_LAUNCH_STUB: JSON.stringify(scenario) };
  delete base.COORD_UI_HOST;
  for (const args of [['--host', '0.0.0.0'], ['--host=192.168.1.20']]) {
    const result = spawnSync(process.execPath, ['--require', stub, launcher, '--no-install', '--no-open', ...args], { encoding: 'utf8', timeout: 10000, env: base });
    assert.equal(result.status, 1, `${args.join(' ')} must be refused`);
    assert.match(result.stderr, /non-loopback host .* requires --allow-remote-bind/);
    assert.doesNotMatch(result.stdout, /STUB spawn npm/, 'no dev server is started for a refused bind');
  }
  const viaEnv = spawnSync(process.execPath, ['--require', stub, launcher, '--no-install', '--no-open'], { encoding: 'utf8', timeout: 10000, env: { ...base, COORD_UI_HOST: '0.0.0.0' } });
  assert.equal(viaEnv.status, 1, 'COORD_UI_HOST alone does not enable a remote bind');
  assert.match(viaEnv.stderr, /requires --allow-remote-bind/);
});

test('COORD-940: --allow-remote-bind permits a non-loopback bind but warns and names the required auth mode', () => {
  const launcher = path.join(__dirname, 'coord-ui-launch.js');
  const stub = path.join(__dirname, '__fixtures__', 'coord-ui-launch-stub.js');
  const scenario = { exists: { ui: true, next: true }, child: { code: 0 } };
  const env = { ...process.env, COORD_UI_LAUNCH_STUB: JSON.stringify(scenario) };
  delete env.COORD_UI_HOST;
  const result = spawnSync(process.execPath, ['--require', stub, launcher, '--no-install', '--no-open', '--allow-remote-bind', '--host', '0.0.0.0'], { encoding: 'utf8', timeout: 10000, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STUB spawn npm exec -- next dev -p 3002 -H 0\.0\.0\.0 COORD_DIR=set BIND_SCOPE=remote/);
  assert.match(result.stderr, /WARNING.*0\.0\.0\.0.*COORD_UI_AUTH_MODE=proxy-header.*COORD_UI_AUTH_MODE=shared-token/s);
});

test('COORD-940: loopback binds never need the flag or produce the warning', () => {
  const launcher = path.join(__dirname, 'coord-ui-launch.js');
  const stub = path.join(__dirname, '__fixtures__', 'coord-ui-launch-stub.js');
  const scenario = { exists: { ui: true, next: true }, child: { code: 0 } };
  const env = { ...process.env, COORD_UI_LAUNCH_STUB: JSON.stringify(scenario) };
  delete env.COORD_UI_HOST;
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const result = spawnSync(process.execPath, ['--require', stub, launcher, '--no-install', '--no-open', '--host', host], { encoding: 'utf8', timeout: 10000, env });
    assert.equal(result.status, 0, `${host}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /WARNING/);
    assert.match(result.stdout, /BIND_SCOPE=loopback/);
  }
});
