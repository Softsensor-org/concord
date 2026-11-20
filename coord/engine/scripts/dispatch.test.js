// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("../../scripts/governance-test-utils.js").sandboxProcessRuntime();
// Behavior tests for the wired dispatch loop reference harness
// coord/engine/scripts/dispatch.mjs (COORD-033). The harness is provider-agnostic,
// read-only, deterministic, and does NOT spawn agents. Relocated verbatim from
// governance.test.js by COORD-096 (residual facade split, slice 1): these tests
// drive dispatch.mjs as an imported ESM module against a seeded manifest file,
// so they need no live board and no governance facade.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const cjsRequire = createRequire(__filename);
const { buildDispatchCachePrefixMarker, renderDispatchCachePrefix, resolveDispatchCachePrefixReferences } = cjsRequire("./dispatch-context.js");
const { applyInvariantRetraction, applySupersession } = cjsRequire("./plan-evidence-supersession.js");
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

// ---------------------------------------------------------------------------
// COORD-033: wired dispatch loop — reference harness coord/engine/scripts/dispatch.mjs.
// The harness is provider-agnostic, read-only, deterministic, and does NOT spawn
// agents. These tests drive it as a subprocess against a seeded manifest file so
// they need no live board.
// ---------------------------------------------------------------------------

const DISPATCH_HARNESS = path.join("coord", "engine", "scripts", "dispatch.mjs");

let dispatchHarnessModulePromise = null;

async function runDispatchHarness(args) {
  const { pathToFileURL } = require("node:url");
  if (!dispatchHarnessModulePromise) {
    dispatchHarnessModulePromise = import(pathToFileURL(path.resolve(DISPATCH_HARNESS)).href);
  }
  const dispatch = await dispatchHarnessModulePromise;
  return dispatch.runDispatch(args);
}

function seededDispatchManifest() {
  return {
    schema_version: 1,
    status_filter: "todo",
    repo_filter: null,
    wave_filter: null,
    render: "json",
    cache_prefix: buildDispatchCachePrefixMarker(
      ["coord/product/TOKEN_ECONOMICS.md", "coord/engine/docs/MULTI_AGENT_BURNIN_RUNBOOK.md"],
      resolveDispatchCachePrefixReferences(["coord/product/TOKEN_ECONOMICS.md", "coord/engine/docs/MULTI_AGENT_BURNIN_RUNBOOK.md"], PROJECT_ROOT),
    ),
    wave_count: 1,
    waves: [{ wave: 1, tickets: [
      { ticket: "HARN-001", action: "skip", reason: "precheck verdict already-satisfied (1 probe(s))",
        finalize_command: 'coord/scripts/gov finalize HARN-001 --no-pr --already-landed --landed "precheck already-satisfied"',
        precheck: { verdict: "already-satisfied" }, tier: "standard", suggested_model_class: "standard",
        evidence_depth: { review_cycles: 3, feature_proofs: 0, critical_invariants: 0 },
        parallelizable: true, repo: "B", files: ["src/a.js"], satisfied_deps: {}, wave_note: null },
      { ticket: "HARN-002", action: "spawn", reason: "precheck verdict not-started -> spawn",
        precheck: { verdict: "not-started" }, tier: "critical", suggested_model_class: "frontier",
        evidence_depth: { review_cycles: 4, feature_proofs: 1, critical_invariants: 2 },
        context_pack: { stable: { shared_references: ["coord/product/TOKEN_ECONOMICS.md"] },
          ticket_specific: { ticket: "HARN-002", description: "add a thing", files: ["src/b.js"],
            acceptance_criteria: ["does the thing"], prior_feature_proofs: [{ ticket: "OLD-001", proof: "symbol:src/b.js#thing" }] } },
        parallelizable: true, repo: "B", files: ["src/b.js"], satisfied_deps: {}, wave_note: null },
      { ticket: "HARN-003", action: "spawn", context_mode: "pack_only", reason: "pack-only fixture",
        tier: "mechanical", suggested_model_class: "small",
        evidence_depth: { review_cycles: 2, feature_proofs: 0, critical_invariants: 1 },
        context_pack: { stable: { shared_references: [] },
          ticket_specific: { ticket: "HARN-003", description: "bounded task", files: ["src/c.js"],
            acceptance_criteria: ["stay in the governed pack"], prior_feature_proofs: [] } },
        parallelizable: true, repo: "B", files: ["src/c.js"], satisfied_deps: {}, wave_note: null },
    ] }],
    excluded: [],
  };
}

function withSeededManifest(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-harness-"));
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(seededDispatchManifest()), "utf8");
  try {
    const result = fn(file);
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test("COORD-033: dispatch.mjs prints SKIP (with the governed finalize command) and SPAWN actions", async () => {
  await withSeededManifest(async (file) => {
    const r = await runDispatchHarness(["--manifest", file]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[SKIP\] HARN-001/);
    assert.match(r.stdout, /finalize \(no agent run\): coord\/scripts\/gov finalize HARN-001 --no-pr --already-landed/);
    assert.match(r.stdout, /\[SPAWN\] HARN-002/);
  });
});

test("COORD-033: a SPAWN carries the suggested model class, the cache-prefix split, and the record-cost template", async () => {
  await withSeededManifest(async (file) => {
    const r = await runDispatchHarness(["--json", "--manifest", file]);
    assert.equal(r.status, 0, r.stderr);
    const loop = JSON.parse(r.stdout);
    const t = loop.waves[0].tickets.find((x) => x.ticket === "HARN-002");
    assert.equal(t.action, "SPAWN");
    assert.equal(t.suggested_model_class, "frontier");
    // Cache-prefix split: the stable marker + references are separate from the ticket body.
    assert.equal(t.assembled_prompt.cache_prefix_marker, "coord-dispatch-stable-v1");
    assert.ok(Array.isArray(t.assembled_prompt.cache_prefix_references) && t.assembled_prompt.cache_prefix_references.length > 0);
    assert.equal(t.assembled_prompt.cache_prefix_sha256, loop.cache_prefix.sha256);
    assert.equal(t.assembled_prompt.cache_prefix_byte_length, loop.cache_prefix.byte_length);
    assert.equal(Buffer.byteLength(loop.cache_prefix.text, "utf8"), loop.cache_prefix.byte_length);
    assert.match(loop.cache_prefix.sha256, /^[a-f0-9]{64}$/);
    assert.match(t.report_prefix_use_template,
      /gov report-prefix-use HARN-002 --expected-prefix-hash [a-f0-9]{64} --used-prefix-hash <agent-reported-sha256>/);
    const sameWave = loop.waves[0].tickets.filter((item) => item.action === "SPAWN");
    assert.equal(sameWave.length, 2);
    assert.equal(sameWave[0].assembled_prompt.cache_prefix_sha256, sameWave[1].assembled_prompt.cache_prefix_sha256);
    assert.notEqual(sameWave[0].assembled_prompt.ticket_body, sameWave[1].assembled_prompt.ticket_body);
    assert.match(t.assembled_prompt.ticket_body, /## Ticket context: HARN-002/);
    assert.match(t.assembled_prompt.ticket_body, /OLD-001\] symbol:src\/b\.js#thing/);
    // Legacy implement template remains available, while the routine contract
    // exposes all phase callbacks with stable execution/attempt slots.
    assert.match(t.record_cost_template, /gov record-cost HARN-002 --agent <handle> --model <model-id:frontier> --dispatch-execution-id <dispatch-execution-id> --attempt-id <stable-provider-attempt-id>/);
    assert.deepEqual(t.cost_phase_callbacks.map((entry) => entry.phase), ["plan", "implement", "review"]);
    assert.ok(t.cost_phase_callbacks.every((entry) => /--measurement-source provider_reported --usage-scope phase_delta/.test(entry.actual_usage_command)));
    assert.ok(t.cost_phase_callbacks.every((entry) => /lifecycle boundary records explicit unknown/.test(entry.unknown_usage_action)));
    // A SKIP entry must NOT carry a spawn prompt or a record-cost template.
    const skip = loop.waves[0].tickets.find((x) => x.ticket === "HARN-001");
    assert.equal(skip.action, "SKIP");
    assert.ok(!("record_cost_template" in skip));
    assert.ok(!("assembled_prompt" in skip));
  });
});

test("COORD-772: dispatch binds callback templates to a caller-supplied stable execution id", async () => {
  await withSeededManifest(async (file) => {
    const result = await runDispatchHarness(["--json", "--manifest", file, "--execution-id", "exec-coord-772"]);
    assert.equal(result.status, 0, result.stderr);
    const loop = JSON.parse(result.stdout);
    assert.equal(loop.dispatch_execution_id, "exec-coord-772");
    const spawn = loop.waves[0].tickets.find((ticket) => ticket.action === "SPAWN");
    assert.match(spawn.dispatch_execution_id, /^dispatch-[a-f0-9]{64}$/);
    assert.notEqual(spawn.dispatch_execution_id, loop.dispatch_execution_id, "each ticket gets its own execution identity");
    assert.ok(spawn.start_command_template.includes(`--dispatch-execution-id ${spawn.dispatch_execution_id}`));
    assert.ok(spawn.cost_phase_callbacks.every((callback) => callback.actual_usage_command.includes(`--dispatch-execution-id ${spawn.dispatch_execution_id}`)));
  });
  const unsafe = await runDispatchHarness(["--json", "--manifest", path.join(os.tmpdir(), "unused.json"), "--execution-id", "x;touch-pwned"]);
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /safe identifier characters/);
});

test("COORD-033: dispatch.mjs is deterministic across two runs", async () => {
  await withSeededManifest(async (file) => {
    const a = (await runDispatchHarness(["--json", "--manifest", file])).stdout;
    const b = (await runDispatchHarness(["--json", "--manifest", file])).stdout;
    assert.equal(a, b, "the harness must be deterministic for identical input");
  });
});

test("COORD-771: dispatch exposes and validates the exact expected prefix hash", async () => {
  await withSeededManifest(async (file) => {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectedPrefix = renderDispatchCachePrefix(manifest.cache_prefix);
    const r = await runDispatchHarness(["--json", "--manifest", file]);
    assert.equal(r.status, 0, r.stderr);
    const loop = JSON.parse(r.stdout);
    assert.equal(loop.cache_prefix.text, expectedPrefix);
    assert.equal(loop.cache_prefix.sha256, manifest.cache_prefix.sha256);

    const legacy = JSON.parse(JSON.stringify(manifest));
    delete legacy.cache_prefix.sha256;
    delete legacy.cache_prefix.byte_length;
    fs.writeFileSync(file, JSON.stringify(legacy), "utf8");
    const compatible = await runDispatchHarness(["--json", "--manifest", file]);
    assert.equal(compatible.status, 0, compatible.stderr);
    const compatibleLoop = JSON.parse(compatible.stdout);
    assert.match(compatibleLoop.cache_prefix.sha256, /^[a-f0-9]{64}$/);

    manifest.cache_prefix.sha256 = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(manifest), "utf8");
    const tampered = await runDispatchHarness(["--json", "--manifest", file]);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /cache_prefix digest does not match/);
  });
});

test("COORD-771: human dispatch emits the exact prefix text covered by its digest", async () => {
  await withSeededManifest(async (file) => {
    const r = await runDispatchHarness(["--manifest", file]);
    assert.equal(r.status, 0, r.stderr);
    const startMarker = "----- BEGIN CACHE PREFIX TEXT -----\n";
    const endMarker = "\n----- END CACHE PREFIX TEXT -----";
    const start = r.stdout.indexOf(startMarker);
    const end = r.stdout.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, "human output brackets the exact cache prefix bytes");
    const emitted = r.stdout.slice(start + startMarker.length, end);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(emitted, renderDispatchCachePrefix(manifest.cache_prefix));
    assert.equal(require("node:crypto").createHash("sha256").update(Buffer.from(emitted, "utf8")).digest("hex"), manifest.cache_prefix.sha256);
  });
});

test("COORD-770: assembled prompt preserves mode, legacy defaults open, and pack-only is an instruction rather than a sandbox claim", async () => {
  await withSeededManifest(async (file) => {
    const loop = JSON.parse((await runDispatchHarness(["--json", "--manifest", file])).stdout);
    const legacy = loop.waves[0].tickets.find((ticket) => ticket.ticket === "HARN-002");
    const restricted = loop.waves[0].tickets.find((ticket) => ticket.ticket === "HARN-003");
    assert.equal(legacy.context_mode, "open");
    assert.doesNotMatch(legacy.assembled_prompt.ticket_body, /Context mode: pack_only/);
    assert.equal(restricted.context_mode, "pack_only");
    assert.match(restricted.assembled_prompt.ticket_body, /Context mode: pack_only/);
    assert.match(restricted.assembled_prompt.ticket_body, /gov request-context HARN-003 --path <relative-path> --reason <reason>/);
    assert.match(restricted.assembled_prompt.ticket_body, /ask the orchestrator for the canonical checkout/);
    assert.match(restricted.assembled_prompt.ticket_body, /using your same already-registered owner session and ticket lock/);
    assert.match(restricted.assembled_prompt.ticket_body, /Never discover the canonical path by exploring/);
    assert.match(restricted.assembled_prompt.ticket_body, /orchestrator must not substitute its identity, rebind you, or override the ephemeral-worktree guard/i);
    assert.match(restricted.assembled_prompt.ticket_body, /Even after a successful request, wait for the supplement before accessing the path/i);
    assert.match(restricted.assembled_prompt.ticket_body, /a refused ephemeral-worktree attempt is not a recorded request/i);
    assert.match(restricted.assembled_prompt.ticket_body, /wait for authorized owner-session execution plus a context supplement/i);
    assert.match(restricted.assembled_prompt.ticket_body, /A request is an observation, not permission/);
    assert.match(restricted.assembled_prompt.ticket_body, /not a process sandbox/);
  });
});

test("COORD-770: dispatch refuses an explicit unknown context mode in a saved manifest", async () => {
  await withSeededManifest(async (file) => {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.waves[0].tickets[1].context_mode = "unrestricted";
    fs.writeFileSync(file, JSON.stringify(manifest), "utf8");
    const result = await runDispatchHarness(["--json", "--manifest", file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /context_mode must be one of open\|pack_only/);
  });
});

test("COORD-773: reviewer dispatch assembles only the supplied diff, declared invariants, and plan record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-review-handoff-"));
  try {
    const outside = path.join(dir, "unrelated-repository-file.txt");
    fs.writeFileSync(outside, "OUTSIDE_REPOSITORY_SECRET_773", "utf8");
    const manifestFile = path.join(dir, "review.json");
    const planRecord = {
      schema_version: 1,
      ticket_id: "REV-773",
      critical_invariants: ["Historical invariant retained in the full record.", "Declared active invariant supplied by the orchestrator."],
      change_summary: ["Record content supplied by the orchestrator."],
    };
    fs.writeFileSync(manifestFile, JSON.stringify({
      schema_version: 1,
      ticket_id: "REV-773",
      diff: "diff --git a/src/change.js b/src/change.js\n+const x = ` ``` `;\n",
      declared_invariants: ["Declared active invariant supplied by the orchestrator."],
      plan_record_sha256: crypto.createHash("sha256").update(JSON.stringify(planRecord), "utf8").digest("hex"),
      plan_record: planRecord,
    }), "utf8");

    const result = await runDispatchHarness(["--review-manifest", manifestFile]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /## Diff/);
    assert.match(result.stdout, /## Declared invariants/);
    assert.match(result.stdout, /Declared active invariant supplied by the orchestrator/);
    assert.match(result.stdout, /## Plan record/);
    assert.match(result.stdout, /Historical invariant retained in the full record/);
    assert.match(result.stdout, /const x = ` ``` `/, "the exact diff is preserved inside a safe delimiter");
    assert.doesNotMatch(result.stdout, /OUTSIDE_REPOSITORY_SECRET_773/,
      "dispatch must not read unrelated files from the surrounding repository");
    assert.doesNotMatch(result.stdout, /unrelated-repository-file\.txt/);

    const cli = spawnSync(process.execPath, [path.resolve(DISPATCH_HARNESS), "--review-manifest", manifestFile, "--json"], {
      cwd: dir, encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    const payload = JSON.parse(cli.stdout);
    assert.equal(payload.ticket_id, "REV-773");
    assert.equal(payload.reviewer_body, `${result.stdout.trimEnd()}`);
    assert.doesNotMatch(payload.reviewer_body, /OUTSIDE_REPOSITORY_SECRET_773/);

    const largeManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    largeManifest.diff = "~~x".repeat(200_000);
    fs.writeFileSync(manifestFile, JSON.stringify(largeManifest), "utf8");
    const largeResult = await runDispatchHarness(["--review-manifest", manifestFile]);
    assert.equal(largeResult.status, 0, largeResult.stderr,
      "a size-bounded diff with many short fence runs must not overflow argument expansion");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-771/773: stable prefix and bounded reviewer handoff coexist without reading unlisted artifacts", async () => {
  await withSeededManifest(async (dispatchManifestPath) => {
    const dispatchResult = await runDispatchHarness(["--json", "--manifest", dispatchManifestPath]);
    assert.equal(dispatchResult.status, 0, dispatchResult.stderr);
    const loop = JSON.parse(dispatchResult.stdout);
    const dispatchManifest = JSON.parse(fs.readFileSync(dispatchManifestPath, "utf8"));
    const expectedReferences = dispatchManifest.cache_prefix.shared_references;
    assert.deepEqual(loop.cache_prefix.references, expectedReferences);
    assert.deepEqual(dispatchManifest.cache_prefix.resolved_references.map((entry) => entry.path), expectedReferences);
    assert.equal(loop.cache_prefix.text, renderDispatchCachePrefix(dispatchManifest.cache_prefix));
    assert.equal(
      require("node:crypto").createHash("sha256").update(Buffer.from(loop.cache_prefix.text, "utf8")).digest("hex"),
      loop.cache_prefix.sha256,
    );
    const spawned = loop.waves[0].tickets.filter((ticket) => ticket.action === "SPAWN");
    assert.ok(spawned.length >= 2, "the wave fixture contains multiple agents");
    assert.ok(spawned.every((ticket) => ticket.assembled_prompt.cache_prefix_sha256 === loop.cache_prefix.sha256));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-prefix-review-integration-"));
    try {
      const unlisted = path.join(dir, "unlisted-artifact.txt");
      const secret = "UNLISTED_REVIEW_ARTIFACT_771_773";
      fs.writeFileSync(unlisted, secret, "utf8");
      const planRecord = {
        schema_version: 1,
        ticket_id: "REV-771",
        critical_invariants: ["Active invariant supplied by the orchestrator."],
      };
      const reviewerManifestPath = path.join(dir, "review.json");
      fs.writeFileSync(reviewerManifestPath, JSON.stringify({
        schema_version: 1,
        ticket_id: "REV-771",
        diff: "diff --git a/src/change.js b/src/change.js\n+const reviewed = true;\n",
        declared_invariants: ["Active invariant supplied by the orchestrator."],
        plan_record_sha256: require("node:crypto").createHash("sha256")
          .update(JSON.stringify(planRecord), "utf8").digest("hex"),
        plan_record: planRecord,
      }), "utf8");

      const reviewerResult = await runDispatchHarness(["--json", "--review-manifest", reviewerManifestPath]);
      assert.equal(reviewerResult.status, 0, reviewerResult.stderr);
      const reviewerPayload = JSON.parse(reviewerResult.stdout);
      assert.equal(reviewerPayload.ticket_id, "REV-771");
      assert.match(reviewerPayload.reviewer_body, /## Diff/);
      assert.match(reviewerPayload.reviewer_body, /## Declared invariants/);
      assert.match(reviewerPayload.reviewer_body, /## Plan record/);
      assert.match(reviewerPayload.reviewer_body, /const reviewed = true/);
      assert.doesNotMatch(reviewerPayload.reviewer_body, /UNLISTED_REVIEW_ARTIFACT_771_773/);
      assert.doesNotMatch(reviewerResult.stdout, /unlisted-artifact\.txt/);
      assert.doesNotMatch(reviewerPayload.reviewer_body, /TOKEN_ECONOMICS\.md|MULTI_AGENT_BURNIN_RUNBOOK\.md/,
        "review mode consumes only its three supplied artifacts, not dispatch context references");
      assert.equal(fs.readFileSync(unlisted, "utf8"), secret);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("COORD-773: reviewer dispatch refuses missing, mismatched, malformed, or extra artifacts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-review-invalid-"));
  const file = path.join(dir, "review.json");
  try {
    const base = {
      schema_version: 1, ticket_id: "REV-773", diff: "diff --git a/a b/a\n",
      declared_invariants: [], plan_record: { ticket_id: "REV-773", critical_invariants: [] },
    };
    base.plan_record_sha256 = crypto.createHash("sha256").update(JSON.stringify(base.plan_record), "utf8").digest("hex");
    for (const [name, mutate] of [
      ["missing diff", (m) => { delete m.diff; }],
      ["ticket mismatch", (m) => { m.plan_record.ticket_id = "REV-774"; }],
      ["malformed invariants", (m) => { m.declared_invariants = [""]; }],
      ["extra artifact", (m) => { m.repository_snapshot = "must not be accepted"; }],
      ["stale plan digest", (m) => { m.plan_record_sha256 = "0".repeat(64); }],
    ]) {
      const manifest = structuredClone(base);
      mutate(manifest);
      fs.writeFileSync(file, JSON.stringify(manifest), "utf8");
      const result = await runDispatchHarness(["--review-manifest", file]);
      assert.equal(result.status, 2, `${name}: ${result.stderr}`);
      assert.equal(result.stdout, "", `${name} must fail without emitting a partial body`);
    }
    const missingPath = await runDispatchHarness(["--review-manifest"]);
    assert.equal(missingPath.status, 2);
    assert.equal(missingPath.stdout, "", "a missing reviewer manifest cannot fall through to normal dispatch");
    fs.writeFileSync(file, JSON.stringify(base), "utf8");
    for (const args of [
      ["--review-manifest", file, "--manifest", file],
      ["--review-manifest", file, "--status", "review"],
      ["--review-manifest", file, "--repo", "X"],
      ["--review-manifest", file, "--wave", "1"],
      ["--review-manifest", file, "--status"],
      ["--review-manifest", file, "--repo", ""],
      ["--review-manifest", file, "--wave", "--json"],
      ["--review-manifest", file, "--review-manifest", file],
    ]) {
      const result = await runDispatchHarness(args);
      assert.equal(result.status, 2, `${args.join(" ")} must fail closed`);
      assert.equal(result.stdout, "");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// COORD-807: a corrected invariant stays in the plan record's history but is
// not active, so a reviewer handoff may not declare it.
test("COORD-807: reviewer dispatch declares active invariants only and names a retracted or superseded one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-review-corrected-"));
  const file = path.join(dir, "review.json");
  const correction = { kind: "critical_invariant", actor: "fixture-agent", timestamp: "2026-10-13T00:00:00.000Z" };
  const retracted = "Retracted invariant kept in history.";
  const superseded = "Superseded invariant kept in history.";
  const successor = "Successor invariant that replaced it.";
  const active = "Active invariant never corrected.";
  let planRecord = { schema_version: 1, ticket_id: "REV-807", critical_invariants: [retracted, superseded, active] };
  planRecord = applyInvariantRetraction(planRecord, { ...correction, entry: retracted, reason: "no longer true" }).record;
  planRecord = applySupersession(planRecord, { ...correction, entry: superseded, replacement: successor, reason: "reworded" }).record;
  const run = (declared, record = planRecord) => {
    fs.writeFileSync(file, JSON.stringify({
      schema_version: 1, ticket_id: "REV-807", diff: "diff --git a/a b/a\n", declared_invariants: declared,
      plan_record_sha256: crypto.createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex"),
      plan_record: record,
    }), "utf8");
    return runDispatchHarness(["--review-manifest", file]);
  };
  try {
    assert.deepEqual(planRecord.critical_invariants, [retracted, superseded, active, successor], "history is append-only");

    const accepted = await run([active, successor]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const declaredSection = accepted.stdout.slice(accepted.stdout.indexOf("## Declared invariants"), accepted.stdout.indexOf("## Plan record"));
    assert.match(declaredSection, /Active invariant never corrected\./);
    assert.match(declaredSection, /Successor invariant that replaced it\./);
    assert.doesNotMatch(declaredSection, /kept in history/);

    for (const [value, status] of [[retracted, "retracted"], [superseded, "superseded"]]) {
      const refused = await run([active, value]);
      assert.equal(refused.status, 2, `${status}: ${refused.stderr}`);
      assert.equal(refused.stdout, "", `${status} invariant must fail without emitting a partial body`);
      assert.ok(refused.stderr.includes(JSON.stringify(value)), `refusal names the ${status} invariant: ${refused.stderr}`);
      assert.match(refused.stderr, new RegExp(`is ${status} in the supplied plan_record`));
    }

    const unknown = await run(["Invariant the plan never recorded."]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /every declared invariant must appear in the supplied plan_record/);

    // A plan record whose correction ledger does not resolve has no trustworthy
    // active projection, so the handoff is refused rather than guessed.
    const broken = await run([active], { ...planRecord, evidence_dispositions: [{ ...planRecord.evidence_dispositions[0], disposition: "ignored" }] });
    assert.equal(broken.status, 2, broken.stderr);
    assert.equal(broken.stdout, "");
    assert.match(broken.stderr, /plan_record correction ledger is invalid: .*unsupported disposition/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-773: reviewer CLI refuses unsafe files and malformed JSON without partial output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-review-files-"));
  try {
    const invalid = path.join(dir, "invalid.json");
    const oversized = path.join(dir, "oversized.json");
    const link = path.join(dir, "linked.json");
    fs.writeFileSync(invalid, "{broken");
    fs.writeFileSync(oversized, "x".repeat(4 * 1024 * 1024 + 1));
    fs.symlinkSync(invalid, link);
    for (const input of [invalid, oversized, link, dir, path.join(dir, "missing.json")]) {
      const result = spawnSync(process.execPath, [path.resolve(DISPATCH_HARNESS), "--review-manifest", input], {
        cwd: dir, encoding: "utf8", timeout: 10000,
      });
      assert.equal(result.error, undefined, `${input}: reader must terminate normally`);
      assert.notEqual(result.status, 0, input);
      assert.equal(result.stdout, "", `${input}: no partial handoff`);
      assert.ok(result.stderr.trim(), `${input}: refusal explains the error`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("COORD-033: dispatch.mjs --wave filter is honored end-to-end against the live board", async () => {
  // The harness invokes gov dispatch-plan; --wave 999 yields no waves -> empty loop.
  const r = await runDispatchHarness(["--json", "--wave", "999"]);
  assert.equal(r.status, 0, r.stderr);
  const loop = JSON.parse(r.stdout);
  assert.equal(loop.wave_count, 0, "an out-of-range wave filter yields no waves");
  assert.ok(loop.cache_prefix && loop.cache_prefix.id, "the cache prefix is still present");
});

test("COORD-033: the runbook documents the wired dispatch loop and the cost-from-usage convention", () => {
  const doc = fs.readFileSync(path.join("coord", "engine", "docs", "MULTI_AGENT_BURNIN_RUNBOOK.md"), "utf8");
  const normalizedDoc = doc.replace(/\s+/g, " ");
  assert.match(normalizedDoc, /Wired dispatch loop/);
  assert.match(normalizedDoc, /Cost-from-usage convention/);
  assert.match(normalizedDoc, /gov record-cost <ID> --agent <handle> --model <model-id>/);
  assert.match(normalizedDoc, /precheck gates spawn/i);
  assert.match(normalizedDoc, /context-pack as a cached prefix/i);
  assert.match(normalizedDoc, /tier routes the model/i);
  assert.match(normalizedDoc, /context mode bounds the agent's operating instructions/i);
  assert.match(normalizedDoc, /pack_only/i);
  assert.match(normalizedDoc, /not an operating-system sandbox/i);
  assert.match(normalizedDoc, /gov request-context <ID> --path <relative-path> --reason <text>/);
  assert.match(normalizedDoc, /canonical checkout .*using that checkout's gov entrypoint and the worker's same already-registered owner session and ticket lock/i);
  assert.match(normalizedDoc, /must not substitute its own identity, rebind the worker, or override the ephemeral-worktree guard/i);
  assert.match(normalizedDoc, /a refused ephemeral-worktree attempt is not a recorded request/i);
  assert.match(normalizedDoc, /waits for authorized owner-session execution plus a context supplement/i);
  assert.match(normalizedDoc, /even after a successful request, the worker waits for the supplement/i);
  assert.match(normalizedDoc, /`context-requests --limit N` view bounds returned rows only/i);
  assert.match(normalizedDoc, /reads and filters the full journal before applying the output limit/i);
  assert.match(normalizedDoc, /--review-manifest artifacts\/<ID>\.review\.json/);
  const reviewerPrompt = fs.readFileSync(path.join("coord", "prompts", "reviewer.md"), "utf8").replace(/\s+/g, " ");
  assert.match(reviewerPrompt, /use only the three labeled artifacts.*supplied diff, the declared invariants, and the supplied plan record/i);
  assert.match(reviewerPrompt, /do not explore the repository or rely on conversation history/i);
});
