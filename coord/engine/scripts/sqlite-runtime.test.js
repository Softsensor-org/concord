"use strict";
const path=require("node:path");
const {spawnSync}=require("node:child_process"),test=require("node:test"),assert=require("node:assert/strict");
const runner=require("./test-runner.js");
const contentRoot=path.resolve(__dirname, "..","..");

test("COORD-765: the actual runner child environment makes SQLite available on the supported runtime",()=>{
  const {guard}=runner.buildChildEnv(contentRoot);
  const prior=process.env.NODE_OPTIONS;let env;
  try{process.env.NODE_OPTIONS=`--require ${JSON.stringify(guard)}`;({env}=runner.buildChildEnv(contentRoot));}
  finally{if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior;}
  const r=spawnSync(process.execPath,["-e","const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE proof(n INTEGER)');db.close();"],{env,encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);assert.ok(env.NODE_OPTIONS.includes(guard));
});

test("COORD-765: activation follows the documented Node22 and Node23 boundaries",()=>{
  const {sqliteNeedsFlag}=require("./sqlite-runtime.js");
  for(const v of ["22.8.0","22.12.99","23.0.0","23.3.99"])assert.equal(sqliteNeedsFlag(v),true,v);
  for(const v of ["22.13.0","22.19.0","23.4.0","24.0.0","25.8.1"])assert.equal(sqliteNeedsFlag(v),false,v);
});

test("COORD-765: activation is idempotent and preserves the complete existing options suffix",()=>{
  const {sqliteTestNodeOptions}=require("./sqlite-runtime.js");
  for(const options of ["",'--max-old-space-size=512 --require "/tmp/path with spaces.js"',"--no-experimental-sqlite","--experimental-sqlite"]){
    const once=sqliteTestNodeOptions(options,"22.8.0"),twice=sqliteTestNodeOptions(once,"22.8.0");
    assert.equal(twice,once);assert.ok(once.endsWith(options));assert.equal(sqliteTestNodeOptions(options,"24.0.0"),options);
  }
});

test("COORD-765: Node itself honors a later explicit disable in normalized test options",()=>{
  const {sqliteTestNodeOptions}=require("./sqlite-runtime.js");
  const env={...process.env,NODE_OPTIONS:sqliteTestNodeOptions("--no-experimental-sqlite","22.8.0")};
  const helper=path.join(__dirname,"sqlite-runtime.js");
  const r=spawnSync(process.execPath,["-e",`require(${JSON.stringify(helper)}).loadSqlite()`],{env,encoding:"utf8"});
  assert.notEqual(r.status,0);assert.match(r.stderr,/SQLite.*unavailable/);assert.match(r.stderr,/--experimental-sqlite/);
});

test("COORD-765: unrelated loader errors retain their original identity",()=>{
  const helperPath=path.join(__dirname,"sqlite-runtime.js");
  const r=spawnSync(process.execPath,["-e",`const M=require('node:module'),original=M._load; const sentinel=Object.assign(new Error('native load failure'),{code:'NATIVE_FAILURE'});M._load=function(id,...args){if(id==='node:sqlite')throw sentinel;return original.call(this,id,...args)};try{require(${JSON.stringify(helperPath)}).loadSqlite();process.exitCode=1}catch(e){if(e!==sentinel)throw e}`],{encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);
});
