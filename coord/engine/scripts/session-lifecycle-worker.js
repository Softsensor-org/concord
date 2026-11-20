// COORD-712: real CLI worker. All mutation targets are under its retained-on-failure temporary root.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fixedLayoutEnv } = require("./session-lifecycle-test-utils");
const { withApprovedPacket } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/approved-reconcile.js"));
const { createApprovalFixture, retryTransferWithLogin, runFixtureApproval } = require("./__fixtures__/approval-fixture.js");

function fixture(lane, progress) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cust013-cli-"));
  const coord = path.join(root, "coord");
  const repo = path.join(root, "backend");
  const gitTrace = path.join(root, "git-trace2.jsonl");
  fs.mkdirSync(coord); fs.mkdirSync(repo);
  const source = path.resolve(__dirname, "..","..");
  // COORD-851: no lane verb loads test files, measured coverage baselines or the
  // donor's own ticket prompts, yet each lane re-hashed, committed, pushed and
  // checked them out. The lane still runs the full production engine.
  const donorTicketPrompts = path.join(source, "prompts", "tickets");
  const laneFilter = from => from !== donorTicketPrompts && !/(?:\.test\.js|engine-coverage-baseline[\w-]*\.json)$/.test(from);
  require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/fixtures/coord-engine-schemas.js")).installCanonicalEngine(coord, source, laneFilter);
  for (const name of ["scripts", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "AGENTS.md", "product", "prompts", "schemas", "docs", "agents.json", "gates", "TEMPLATE_SYNC_MANIFEST.json", "engine-pin.json"]) {
    if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(coord, name), { recursive: true, filter: laneFilter });
  }
  progress("engine copy");
  const write = (name, data) => { const target = path.join(coord, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data)); };
  write("project.config.js", 'module.exports={repos:{B:{path:"backend",integrationBranch:"dev"}}};\n');
  const gitEnv = { ...process.env, GIT_TRACE2_EVENT: gitTrace };
  const git = (cwd, ...args) => { const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const disableAutomaticMaintenance = repoRoot => {
    git(repoRoot, "config", "--local", "gc.auto", "0");
    git(repoRoot, "config", "--local", "maintenance.auto", "false");
    // These disposable repos exercise real Git publication, not storage compression.
    git(repoRoot, "config", "--local", "core.compression", "0");
    assert.equal(git(repoRoot, "config", "--local", "--get", "gc.auto"), "0");
    assert.equal(git(repoRoot, "config", "--local", "--get", "maintenance.auto"), "false");
  };
  const configureSyntheticRepo = (repoRoot, branch) => {
    git(repoRoot, "init", "-b", branch);
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    disableAutomaticMaintenance(repoRoot);
  };
  configureSyntheticRepo(repo, "dev");
  fs.writeFileSync(path.join(repo, "evidence.txt"), "preserve me\n"); git(repo, "add", "evidence.txt"); git(repo, "commit", "-m", "seed");
  const ticket = "TEST-001", oldOwner = `codexa${lane}1`, newOwner = `codexa${lane}2`;
  const branch = "agent/codexa01-test-001-recovery";
  const worktree = path.join(repo, ".worktrees", oldOwner, ticket);
  git(repo, "worktree", "add", "-b", branch, worktree);
  const row = { ID: ticket, Repo: "B", Type: "bug", Pri: "P1", Status: "done", Owner: oldOwner, Description: "Recovery regression", "Depends On": "" };
  write("board/tasks.json", { version: 1, metadata: { title: "Recovery", last_updated: new Date().toISOString(), canonical_references: [], plan_markdown_render_statuses: ["doing", "review"], preamble: [], plan_records_required_from_ticket: {B:"TEST-999"}, landing_index_required_from_ticket:{B:"TEST-999"}, pr_index_required_from_ticket:{B:"TEST-999"}}, sections:[{kind:"table",level:2,heading:"Recovery",separator_before:false,columns:Object.keys(row),rows:[row]}], prompt_index:{[ticket]:"coord/prompts/recovery.md"},pr_index:{},landing_index:{},review_findings:{},followup_exceptions:{} });
  write("prompts/recovery.md", "# Recovery\n"); write("QUESTIONS.md", "# Questions\n"); write("PLAN.md", "");
  const renderFixtureViews = () => require(path.join(coord, "board/board.js")).renderBoardArtifacts();
  write(".runtime/agents.json", [oldOwner,newOwner].map((handle,i)=>({id:`a${lane}${i+1}`,handle,provider:"openai",status:"active",aliases:[]})));
  write(".runtime/agent_sessions.json", []);
  renderFixtureViews();
  const env = fixedLayoutEnv(`recovery-${path.basename(root)}`);
  env.GIT_TRACE2_EVENT = gitTrace;
  // COORD-851: these CLI processes run a temporary engine copy outside the
  // workspace, whose V8 coverage the test runner discards; skip writing it.
  // Node re-adds a deleted NODE_V8_COVERAGE to child envs; empty disables it.
  env.NODE_V8_COVERAGE = "";
  // Each lane runs ~30 cold CLI processes over one engine copy; reuse its compilation.
  env.NODE_COMPILE_CACHE = path.join(root, "node-compile-cache");
  // COORD-896: every governance CLI call is a progress step for the parent's deadlines.
  const cli = (...args) => { const r = spawnSync(process.execPath, [path.join(coord,"scripts/governance.js"),...args], {cwd:root,env,encoding:"utf8"}); progress(args[0]); return r; };
  const ok = (...given) => {
    let args = given;
    if (given[0] === "reconcile") args = withApprovedPacket(given, (dryArgs) => cli(...dryArgs));
    let result;
    if (args.includes("--human-admin-override")) {
      assert.ok(["reconcile", "recover"].includes(args[0]), `fixture signer has no verb mapping for ${args[0]}`);
      const verb = args[0] === "reconcile" ? "reconcile" : "recover --human-admin-override";
      const ticket = verb === "reconcile" ? "control-plane" : args[1];
      result = runFixtureApproval(verb, ticket, () => cli(...args), (approval) => {
        const approved = approval.runCli(coord, args, { cwd: root, env, encoding: "utf8" });
        progress(args[0]);
        return approved;
      });
    } else {
      result = cli(...args);
    }
    assert.equal(result.status, 0, `${root}: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  write(".gitignore", ".runtime/\n.worktrees/\n");
  configureSyntheticRepo(coord, "main");
  git(coord,"add","."); git(coord,"commit","-m","Seed regression fixture");
  ok("reconcile", "--reason", "initialize isolated regression fixture", "--human-admin-override", "fixture owns this isolated baseline");
  ok("agentid", "--owner", newOwner);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(coord,name),"utf8"));
  return {root,coord,repo,ticket,row,branch,worktree,oldOwner,newOwner,git,cli,ok,read,write,env,gitTrace,disableAutomaticMaintenance,renderFixtureViews};
}



const lane=Number(process.argv[2]||1);
let OWNER;
const proceed=process.send?new Promise(resolve=>process.once("message",resolve)):Promise.resolve();
// COORD-896: report each step over IPC so a slow lane extends its deadline while a hung one does not.
// A synchronous caller (the mutation harness) cannot read IPC, so the same steps also go to an optional file.
let steps=0;
const progressFile=process.env.COORD_LIFECYCLE_PROGRESS_FILE;
// COORD-937 fault injection (test-only, never set in production): COORD_INJECT_LIFECYCLE_SLOW_MS
// delays every step after its progress message; COORD_INJECT_LIFECYCLE_SLOW_ONCE_MS delays only the
// first. Both keep reporting progress. COORD_INJECT_LIFECYCLE_HANG=ready stops the lane silently
// before its ready message; a positive millisecond value stalls at the same point, then resumes.
const sleepMs=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const injectedMs=name=>Number(process.env[name]||0);
const progress=step=>{
 steps++;process.send?.({type:"progress",lane,step,steps});
 if(progressFile)fs.appendFileSync(progressFile,`${lane} ${steps} ${step}\n`);
 const slow=injectedMs("COORD_INJECT_LIFECYCLE_SLOW_MS")||(steps===1?injectedMs("COORD_INJECT_LIFECYCLE_SLOW_ONCE_MS"):0);
 if(slow)sleepMs(slow);
};
(async()=>{
const f=fixture(lane,progress);
try {
if(process.env.COORD_INJECT_LIFECYCLE_STARTUP_FAILURE) throw new Error("injected lifecycle worker startup failure");
const remote=path.join(f.root,"remote.git");f.git(f.root,"init","--bare",remote);f.disableAutomaticMaintenance(remote);f.git(f.coord,"remote","add","origin",remote);f.git(f.coord,"push","-u","origin","main");f.git(f.coord,"branch","dev","main");f.git(f.coord,"push","-u","origin","dev");
const id=`LANE-00${lane}`;
const next=`NEXT-00${lane}`;
f.ok("file-ticket",next,"--repo","X","--type","chore","--pri","P2","--description","Continuation target","--with-prompt");
f.ok("file-ticket",id,"--repo","X","--type","chore","--pri","P2","--description","Conformance lane artifact","--with-prompt");
// COORD-813: start refuses the generated scaffold, so each lane ticket gets a
// ticket-specific prompt body through the governed authoring verb first.
for(const ticket of [next,id]){const body=path.join(f.root,`${ticket}-prompt-body.md`);fs.writeFileSync(body,`# ${ticket}: conformance lane\n\n## Acceptance Criteria\n\n- ${ticket} completes its governed conformance lane.\n`);f.ok("register-prompt",ticket,"--body-file",body);}
f.ok("start",id);
const lock=f.read(`.runtime/locks/${id}.lock`);
fs.writeFileSync(path.join(lock.worktree,"docs/LANE.md"),"# Conformance artifact\nVerified lane bytes.\n");
f.ok("update-plan",id,"--startup","completed","--traceability","exempt","--files","docs/LANE.md","--baseline","Conformance artifact absent before this lane","--verify","node -e require('node:fs').readFileSync('docs/LANE.md')","--repo-gate","Artifact bytes verified by the OS-process conformance worker","--security","yes","--rollback","Revert lane artifact source commit","--invariant","business-context investigation: not-required");
f.ok("commit",id,"--message","conformance lane artifact","--all");

OWNER=f.newOwner;
assert.equal(f.read(".runtime/agent_sessions.json").find(s=>s.status==="active").thread_id,f.env.CODEX_THREAD_ID,"native session identity must remain distinct");
f.ok("set-review-cycles",id,"--replace",...[1,2,3].flatMap(n=>["--review-cycle",`lens=lane ${n}; diff=docs/LANE.md; risks=lost bytes, wrong lane; findings=artifact read from committed tree; verification=fixture assertion; verdict=pass`]));
fs.writeFileSync(path.join(lock.worktree,"docs/LANE.md"),`# Lane ${lane} dirty tracked bytes\n`);
fs.writeFileSync(path.join(lock.worktree,"docs/UNTRACKED.md"),`lane ${lane} untracked bytes\n`);
const expected=["docs/LANE.md","docs/UNTRACKED.md"].map(p=>fs.readFileSync(path.join(lock.worktree,p),"utf8"));
const reviewBefore=f.read(`.runtime/plans/${id}.json`).self_review_cycles;
const preserve=()=>{
 ["docs/LANE.md","docs/UNTRACKED.md"].forEach((p,i)=>assert.equal(fs.readFileSync(path.join(lock.worktree,p),"utf8"),expected[i],"workspace byte preservation"));
 const l=f.read(`.runtime/locks/${id}.lock`);assert.equal(l.worktree,lock.worktree);assert.equal(l.branch,lock.branch);
 assert.deepEqual(f.read(`.runtime/plans/${id}.json`).self_review_cycles,reviewBefore,"review evidence preservation");
};
const readyStallMs=Number((process.env.COORD_INJECT_LIFECYCLE_HANG || "").replace(/^ready$/, "Infinity"));
if(readyStallMs>0)sleepMs(readyStallMs);
process.send?.({type:"ready",lane,root:f.root,coord:f.coord,id,handle:f.newOwner,thread:f.env.CODEX_THREAD_ID,worktree:lock.worktree});
await proceed;
if(lane===1){
 f.ok("block",id,"--reason","session gap with preserved evidence");
 const sessions=f.read(".runtime/agent_sessions.json"), prior=sessions.find(s=>s.status==="active");
 prior.status="expired";prior.last_seen_at=new Date(Date.now()-5*3600000).toISOString();f.write(".runtime/agent_sessions.json",sessions);
 f.env.CODEX_THREAD_ID+="-replacement";
 f.ok("recover",id,"--owner",f.newOwner);preserve();
 let active=f.read(".runtime/agent_sessions.json").find(s=>s.status==="active");assert.equal(active.previous_session_id,prior.session_id);assert.equal(active.thread_id,f.env.CODEX_THREAD_ID,"replacement native identity");
 assert.equal(f.read("board/tasks.json").sections.flatMap(s=>s.rows||[]).find(r=>r.ID===id).Status,"doing (blocked: session gap with preserved evidence)");
 f.ok("agent-release",active.session_id,"--reason","authorized fixture admin repair and handoff");
 f.ok("agentid","--owner",f.oldOwner);
 fs.unlinkSync(path.join(f.coord,`.runtime/locks/${id}.lock`));
 const denied=f.cli("recover",id);assert.notEqual(denied.status,0,"foreign missing-lock repair must require authority");
 const unsigned=f.cli("recover",id,"--human-admin-override","fixture owner-preserving lock repair");
 assert.notEqual(unsigned.status,0,"reason-only repair authority must be refused");
 assert.match(`${unsigned.stdout}\n${unsigned.stderr}`,/requires a signed human-admin approval/);
 f.ok("recover",id,"--human-admin-override","fixture owner-preserving lock repair");preserve();
 assert.equal(f.read(`.runtime/locks/${id}.lock`).owner,f.newOwner);
 assert.notEqual(f.cli("claim",id,"--transfer-to",f.oldOwner).status,0,"transfer needs separate authority");
 const approval = createApprovalFixture();
 try {
  const args=["claim",id,"--transfer-to",f.oldOwner,"--human-admin-override","fixture separately authorized transfer"];
  const transferred=retryTransferWithLogin(approval,id,()=>{
   const result=approval.runCli(f.coord,args,{cwd:f.root,env:f.env,encoding:"utf8"});
   progress("claim transfer");
   return result;
  });
  assert.equal(transferred.status,0,`${f.root}: ${args.join(" ")}\n${transferred.stdout}\n${transferred.stderr}`);
 } finally { approval.cleanup(); }
 preserve();OWNER=f.oldOwner;
 f.ok("unblock",id);
}
f.ok("commit",id,"--message","preserved lane evidence after session gap","--all","--ack-outside-scope","docs/UNTRACKED.md");
const source=f.git(lock.worktree,"rev-parse","HEAD");
assert.equal(f.git(lock.worktree,"show","HEAD:docs/LANE.md"),expected[0].trim());
assert.equal(f.git(lock.worktree,"show","HEAD:docs/UNTRACKED.md"),expected[1].trim(),"explicit exception preserves the recovered untracked evidence");

const p=f.read(`.runtime/plans/${id}.json`),args=["update-plan",id];
assert.ok(Array.isArray(p.feature_proof),"the freshly seeded plan must contain its feature-proof collection");
for(const proof of p.feature_proof)if(proof.startsWith("TODO"))args.push("--drop-feature-proof",proof);
args.push("--feature-proof","path:docs/LANE.md");f.ok(...args);
const ack={considered:{active_constraints:["Isolated temporary runtime"],adrs:["No architecture change"],business_rules:["Conformance fixture only"],conflicts:["No conflict"],stale_warnings:["No live state involved"],open_questions:["No open decision"]},authority:{constraints:["Conformance fixture"],advisory_only:["No production authority"]},closeout_learning:{decision:"scratch-only",rationale:"Temporary fixture"}};
f.ok("update-plan",id,"--context-pack-ack",JSON.stringify(ack));

f.ok("set-requirement-closure",id,"--supersede","--ticket-ask","Create this isolated lane artifact","--implemented","Committed and read the lane artifact through its own worktree","--not-implemented","No product change outside temporary sandbox","--deferred-to","none","--closeout-verdict","complete");
f.ok("gate-plan",id,"--write");f.ok("submit",id,"--pr","local-review (no PR)");
f.git(f.coord,"add",".");f.git(f.coord,"commit","-m","lane governed review");
f.ok("land",id,"--no-pr","--merge-workspace","--push-before-closeout","--push-after-sync","--landed","Conformance local bare remote landing");

assert.equal(f.read("board/tasks.json").sections.flatMap(s=>s.rows||[]).find(r=>r.ID===id).Status,"done");
assert.equal(f.read("board/tasks.json").sections.flatMap(s=>s.rows||[]).find(r=>r.ID===id).Owner,OWNER);
f.git(f.coord,"merge-base","--is-ancestor",source,"origin/main");
assert.equal(fs.existsSync(path.join(f.coord,`.runtime/locks/${id}.lock`)),false);
assert.equal(fs.existsSync(lock.worktree),false,"landed worktree cleaned after committed evidence");
const closed=f.read(".runtime/agent_sessions.json").find(s=>s.handle===OWNER && s.release_reason==="terminal");assert.ok(closed,"terminal release recorded");
const prompt=f.read("board/tasks.json").prompt_index[next], promptPath=path.resolve(f.root,prompt), promptBytes=fs.readFileSync(promptPath);
const before=fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8");
const publishedBeforeFailure=f.git(f.coord,"rev-parse","origin/main");
fs.unlinkSync(promptPath);assert.notEqual(f.cli("start",next).status,0,"injected dependent mutation failure");
assert.equal(fs.readFileSync(path.join(f.coord,".runtime/agent_sessions.json"),"utf8"),before,"failed continuation rolls back session");fs.writeFileSync(promptPath,promptBytes);
assert.equal(f.git(f.coord,"rev-parse","origin/main"),publishedBeforeFailure,"local rollback cannot unpublish prior landing");
f.git(f.coord,"merge-base","--is-ancestor",source,"origin/main");
f.ok("start",next);f.ok("start",next);
const active=f.read(".runtime/agent_sessions.json").find(s=>s.status==="active");assert.equal(active.handle,OWNER);assert.equal(active.previous_session_id,closed.session_id);
f.ok("unstart",next);f.ok("agent-release",active.session_id,"--reason","conformance lane finished");
assert.equal(f.read(".runtime/agent_sessions.json").filter(s=>s.status==="active").length,0);
assert.equal(fs.existsSync(path.join(f.coord,`.runtime/locks/${next}.lock`)),false,"unstarted continuation lock removed");
assert.equal(f.git(f.coord,"worktree","list","--porcelain").split("worktree ").length-1,1,"no leaked coord worktree");
const events=fs.readFileSync(path.join(f.coord,".runtime/governance-events.ndjson"),"utf8").trim().split("\n").map(JSON.parse);
const acknowledgedCommit=events.find(e=>e.command==="commit" && e.ticket===id && e.details?.source_commit_sha===source);
assert.deepEqual(acknowledgedCommit?.details.acknowledged_outside_scope,["docs/UNTRACKED.md"],"scope exception remains attributable after recovery and landing");
for(const ticket of [id,next])assert.equal(events.filter(e=>e.ticket===ticket && e.command==="start" && e.result==="succeeded").length,1,"exactly once start after retry");
assert.equal(events.filter(e=>e.ticket===id && e.command==="land" && e.result==="succeeded").length,1,"exactly once land");
const landing=events.find(e=>e.ticket===id && e.command==="land" && e.result==="succeeded");
const push=landing.details.external_side_effects.find(e=>e.type==="control_plane_push");
const merge=landing.details.external_side_effects.find(e=>e.type==="control_plane_workspace_merge");
assert.ok(push?.acknowledged && push.delivered,"publication receipt acknowledges real local remote");
assert.equal(push.remote_sha_after,merge.merge_commit_sha,"push receipt matches actual merge");
f.git(f.coord,"merge-base","--is-ancestor",push.remote_sha_after,"origin/main");
const chain=JSON.parse(f.ok("conform","--json").stdout);assert.equal(chain.verdict,"pass");assert.equal(chain.total_events,events.length);
for(const name of ["PLAN.md","rendered/TASKS.md"]) assert.ok(fs.existsSync(path.join(f.coord,name)),"projection exists");
const rendered=fs.readFileSync(path.join(f.coord,"rendered/TASKS.md"),"utf8");
assert.ok(rendered.includes(`| ${id} | X | chore | P2 | done | ${OWNER} |`),"rendered status and owner match final board");
assert.ok(rendered.includes(`| ${next} | X | chore | P2 | todo | unassigned |`),"rendered continuation target restored");
assert.deepEqual(f.read(`.runtime/plans/${id}.json`).self_review_cycles,reviewBefore,"closed plan retains reviewed evidence");
process.send?.({type:"done",lane,root:f.root,owner:OWNER,source,remote:f.git(f.coord,"rev-parse","origin/main"),events:events.length,sessions:f.read(".runtime/agent_sessions.json").length});
console.log("DONE",lane,f.root);

}catch(e){console.error("RETAINED SANDBOX",f.root);throw e;}
})().catch(e=>{console.error(e);process.exitCode=1;});
