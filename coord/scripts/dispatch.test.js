// COORD-299 / COORD-390: relocate this worker's full runtime + seal surfaces to an os.tmpdir() sandbox
require("./governance-test-utils.js").sandboxProcessRuntime();
// Behavior tests for the wired dispatch loop reference harness
// coord/scripts/dispatch.mjs (COORD-033). The harness is provider-agnostic,
// read-only, deterministic, and does NOT spawn agents. Relocated verbatim from
// governance.test.js by COORD-096 (residual facade split, slice 1): these tests
// drive dispatch.mjs as an imported ESM module against a seeded manifest file,
// so they need no live board and no governance facade.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ---------------------------------------------------------------------------
// COORD-033: wired dispatch loop — reference harness coord/scripts/dispatch.mjs.
// The harness is provider-agnostic, read-only, deterministic, and does NOT spawn
// agents. These tests drive it as a subprocess against a seeded manifest file so
// they need no live board.
// ---------------------------------------------------------------------------

const DISPATCH_HARNESS = path.join("coord", "scripts", "dispatch.mjs");

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
    cache_prefix: { version: 1, id: "coord-dispatch-stable-v1", shared_references: ["coord/product/TOKEN_ECONOMICS.md", "coord/docs/MULTI_AGENT_BURNIN_RUNBOOK.md"] },
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
    assert.match(t.assembled_prompt.ticket_body, /## Ticket context: HARN-002/);
    assert.match(t.assembled_prompt.ticket_body, /OLD-001\] symbol:src\/b\.js#thing/);
    // record-cost template with the input/output token + model field mapping.
    assert.match(t.record_cost_template, /gov record-cost HARN-002 --agent <handle> --model <model-id:frontier> --input-tokens <usage\.input_tokens> --output-tokens <usage\.output_tokens>/);
    // A SKIP entry must NOT carry a spawn prompt or a record-cost template.
    const skip = loop.waves[0].tickets.find((x) => x.ticket === "HARN-001");
    assert.equal(skip.action, "SKIP");
    assert.ok(!("record_cost_template" in skip));
    assert.ok(!("assembled_prompt" in skip));
  });
});

test("COORD-033: dispatch.mjs is deterministic across two runs", async () => {
  await withSeededManifest(async (file) => {
    const a = (await runDispatchHarness(["--json", "--manifest", file])).stdout;
    const b = (await runDispatchHarness(["--json", "--manifest", file])).stdout;
    assert.equal(a, b, "the harness must be deterministic for identical input");
  });
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
  const doc = fs.readFileSync(path.join("coord", "docs", "MULTI_AGENT_BURNIN_RUNBOOK.md"), "utf8");
  assert.match(doc, /Wired dispatch loop/);
  assert.match(doc, /Cost-from-usage convention/);
  assert.match(doc, /gov record-cost <ID> --agent <handle> --model <model-id>/);
  assert.match(doc, /precheck gates spawn/i);
  assert.match(doc, /context-pack as a cached prefix/i);
  assert.match(doc, /tier routes the model/i);
});
