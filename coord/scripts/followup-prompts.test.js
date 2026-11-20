'use strict';
const governanceCommands = require(require("../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, ".."), "scripts/lifecycle.js")).commands;
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {__testing,withGovernedSurfaceSandbox}=require('./governance-test-utils.js');
const root=path.resolve(__dirname,'../..');
const parent='FOLLOWUP-001',child='FOLLOWUP-002';
function fixture(fn,{parentName=parent,coverage=true,preexistingChild=false}={}){
 return withGovernedSurfaceSandbox(ctx=>{
  const parentPath=path.join(ctx.promptsDir,'tickets',parentName+'.md');
  const parentText=`# ${parent}\n\n## Likely Files\n\n- parent-only.js\n`;
  fs.writeFileSync(parentPath,parentText);
  if(preexistingChild)fs.writeFileSync(path.join(ctx.promptsDir,"tickets",child+".md"),"# Existing child-specific scope\n");
  const board={version:1,metadata:{title:'Follow-up scope fixture',preamble:[]},sections:[{kind:'table',level:3,heading:'Backlog',separator_before:false,columns:['ID','Repo','Type','Pri','Status','Owner','Description','Depends On'],rows:[{ID:parent,Repo:'X',Type:'bug',Pri:'P1',Status:'todo',Owner:'unassigned',Description:'Parent scope','Depends On':''}]}],prompt_index:coverage?{[parent]:parentPath}:{},pr_index:{},landing_index:{},review_findings:{},followup_exceptions:{}};
  fs.writeFileSync(ctx.boardPath,JSON.stringify(board));
  __testing.appendGovernanceEvent({ts:'2026-09-22T00:00:00.000Z',command:'journal-baseline',ticket:null,before_status:null,after_status:null,identity:null,details:{reason:'followup-prompt-fixture'},changed_paths:[],snapshot:__testing.buildGovernanceSnapshot()});
  const read=()=>JSON.parse(fs.readFileSync(ctx.boardPath));
  const events=()=>fs.readFileSync(ctx.logPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const open=(id=child,extra={})=>governanceCommands.openFollowup(id,{prefix:'FOLLOWUP',dependsOn:parent,repo:'X',type:'bug',pri:'P1',description:'Distinct child repair',relation:'related',...extra});
  fn({...ctx,parentPath,parentText,read,events,open,childPath:path.join(ctx.promptsDir,'tickets',child+'.md')});
  assert.equal(fs.readFileSync(parentPath,'utf8'),parentText,'parent prompt bytes preserved');
 });
}
test('COORD-651: default follow-up creates its own prompt in the same journaled transaction',()=>fixture(c=>{
 const n=c.events().length;c.open();const b=c.read();
 assert.equal(path.resolve(root,b.prompt_index[child]),c.childPath);
 const text=fs.readFileSync(c.childPath,'utf8');assert.match(text,/# FOLLOWUP-002:/);assert.match(text,/Distinct child repair/);assert.doesNotMatch(text,/parent-only\.js/);
 assert.equal(c.events().length,n+1);const e=c.events().at(-1);
 assert.equal(e.details.prompt.mode,'child');assert.equal(e.details.prompt.created,true);
 assert.ok(e.changed_paths.some(p=>p.endsWith('/tickets/FOLLOWUP-002.md')));
 assert.equal(b.sections[0].rows.find(r=>r.ID===child)['Depends On'],parent);
}));
test('COORD-651: parent prompt coverage is not required to create an independent child prompt',()=>fixture(c=>{
 c.open();assert.equal(path.resolve(root,c.read().prompt_index[child]),c.childPath);assert.ok(fs.existsSync(c.childPath));
},{coverage:false}));
test('COORD-651: explicit shared prompt is preserved and deliberate intent is journaled',()=>fixture(c=>{
 c.open(child,{prompt:c.parentPath});const b=c.read(),e=c.events().at(-1);
 assert.equal(path.resolve(root,b.prompt_index[child]),c.parentPath);assert.equal(fs.existsSync(c.childPath),false);
 assert.equal(e.details.prompt.mode,'explicit-reference');assert.equal(e.details.prompt.created,false);assert.deepEqual(e.details.prompt.shared_with,[parent]);
}));
test('COORD-651: explicit-ID retries retain idempotence without swallowing a different prompt choice',()=>fixture(c=>{
 const n=c.events().length;c.open(child,{prompt:c.parentPath});c.open(child,{prompt:c.parentPath});assert.equal(c.events().length,n+1);
 assert.throws(()=>c.open(child,{prompt:'coord/prompts/planner.md'}),/already exists/);
 assert.equal(c.read().sections[0].rows.length,2);assert.equal(c.events().length,n+2);assert.equal(c.events().at(-1).command,"collision-detected");
}));
test('COORD-651: default prompt creation refuses a path already owned by the parent',()=>fixture(c=>{
 const before=fs.readFileSync(c.boardPath,'utf8');assert.throws(()=>c.open(),/already.*(?:registered|owned)|shared/i);assert.equal(fs.readFileSync(c.boardPath,'utf8'),before);
},{parentName:child}));
test('COORD-651: explicit prompt references cannot overwrite a parent or invent a missing file',()=>fixture(c=>{
 const before=fs.readFileSync(c.boardPath,'utf8');
 assert.throws(()=>c.open(child,{prompt:c.parentPath,withPrompt:true,replace:true,force:true}),/reference|replace|creation/i);
 assert.throws(()=>c.open(child,{prompt:path.join(c.promptsDir,'missing.md')}),/not found|missing|exist/i);
 assert.equal(fs.readFileSync(c.boardPath,'utf8'),before);assert.equal(fs.existsSync(c.childPath),false);
}));
test('COORD-651: a board persistence failure rolls back the newly created prompt and row together',()=>fixture(c=>{
 const before=fs.readFileSync(c.boardPath,'utf8'),n=c.events().length,rename=fs.renameSync;let injected=false;
 fs.renameSync=function(from,to,...args){if(!injected&&path.resolve(String(to))===c.boardPath&&fs.existsSync(c.childPath)){injected=true;throw Error('injected board persistence failure');}return rename.call(this,from,to,...args);};
 try{assert.throws(()=>c.open(),/injected board persistence failure/);}finally{fs.renameSync=rename;}
 assert.equal(injected,true);assert.equal(fs.readFileSync(c.boardPath,'utf8'),before);assert.equal(fs.existsSync(c.childPath),false);assert.equal(c.events().length,n);
}));
test('COORD-651: split-ticket creates separate prompt scopes for every child',()=>fixture(c=>{
 governanceCommands.splitTicket(parent,{into:'B,F',prefix:'FOLLOWUP'});const b=c.read(),children=b.sections[0].rows.filter(r=>r.ID!==parent);
 assert.equal(children.length,2);const paths=children.map(r=>path.resolve(root,b.prompt_index[r.ID]));assert.equal(new Set(paths).size,2);
 for(const [i,r]of children.entries()){assert.notEqual(paths[i],c.parentPath);const text=fs.readFileSync(paths[i],'utf8');assert.ok(text.includes(r.ID));assert.ok(text.includes(r.Description));assert.doesNotMatch(text,/parent-only\.js/);}
}));

test('COORD-651: an existing child prompt requires explicit reference and remains byte-identical',()=>fixture(c=>{
 const text=fs.readFileSync(c.childPath,'utf8');assert.throws(()=>c.open(),/already exists/);
 c.open(child,{prompt:c.childPath});assert.equal(fs.readFileSync(c.childPath,'utf8'),text);assert.equal(path.resolve(root,c.read().prompt_index[child]),c.childPath);assert.equal(c.events().at(-1).details.prompt.mode,'explicit-reference');
},{preexistingChild:true}));
test('COORD-651: an invalid ticket ID cannot escape the child prompt directory',()=>fixture(c=>{
 const before=fs.readFileSync(c.boardPath,'utf8');assert.throws(()=>c.open('../ESCAPE-999'),/ticket id.*PREFIX-123/);assert.equal(fs.readFileSync(c.boardPath,'utf8'),before);assert.equal(fs.existsSync(path.join(c.promptsDir,'ESCAPE-999.md')),false);
}));
