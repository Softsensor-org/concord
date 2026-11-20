"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createGovernanceTestContextHarness } = require("./governance-test-context.js");

const STATE_KEYS = [
  "BOARD_PATH",
  "PLAN_PATH",
  "PLAN_RECORDS_DIR",
  "PROMPTS_DIR",
  "DECISIONS_DIR",
  "RENDERED_DIR",
  "LEGACY_PLAN_RECORDS_DIR",
  "LOCKS_DIR",
  "LEGACY_LOCKS_DIR",
  "QUESTIONS_PATH",
  "TEMPLATE_FEEDBACK_PATH",
  "AGENTS_PATH",
  "LEGACY_AGENTS_PATH",
  "AGENT_SESSIONS_PATH",
  "LEGACY_AGENT_SESSIONS_PATH",
  "RUNTIME_DIR",
  "GOVERNANCE_EVENT_LOG_PATH",
  "GOVERNANCE_SNAPSHOT_PATH",
  "GOVERNANCE_SNAPSHOTS_DIR",
  "GOVERNANCE_EVENT_LOCK_DIR",
  "COORD_STATE_LOCK_DIR",
  "AGENT_STATE_LOCK_DIR",
  "MEMORY_DIR",
  "MODEL_PRICES_PATH",
  "TIER_POLICY_PATH_OVERRIDE",
];

const MAP_CONFIG_KEYS = [
  "REPO_ROOTS",
  "REPO_INTEGRATION_BRANCHES",
  "REPO_START_BASE_REFS",
  "repoRegistry",
  "legacyRepoAliases",
];

const CONFIG_KEYS = [...MAP_CONFIG_KEYS, "DEFAULT_START_BASE_REF"];
const OVERRIDE_KEYS = [...STATE_KEYS, ...CONFIG_KEYS];

function makeContext(prefix) {
  const state = Object.fromEntries(STATE_KEYS.map((key) => [key, `${prefix}:${key}`]));
  const defaultPaths = {
    repoRoots: { [prefix]: `${prefix}:root` },
    repoIntegrationBranches: { [prefix]: `${prefix}:integration` },
    repoStartBaseRefs: { [prefix]: `${prefix}:base` },
    defaultStartBaseRef: `${prefix}:default-base`,
    repoRegistry: { [prefix]: { path: `${prefix}:registry`, aliases: [`${prefix}:alias`] } },
    legacyRepoAliases: { [prefix]: [`${prefix}:legacy`] },
  };
  return { state, defaultPaths, harness: createGovernanceTestContextHarness({ state, defaultPaths }) };
}

function readValues({ state, defaultPaths }) {
  const values = Object.fromEntries(STATE_KEYS.map((key) => [key, state[key]]));
  values.REPO_ROOTS = defaultPaths.repoRoots;
  values.REPO_INTEGRATION_BRANCHES = defaultPaths.repoIntegrationBranches;
  values.REPO_START_BASE_REFS = defaultPaths.repoStartBaseRefs;
  values.DEFAULT_START_BASE_REF = defaultPaths.defaultStartBaseRef;
  values.repoRegistry = defaultPaths.repoRegistry;
  values.legacyRepoAliases = defaultPaths.legacyRepoAliases;
  return values;
}

function snapshotValues(context) {
  return structuredClone(readValues(context));
}

function overrideValues(prefix) {
  return Object.fromEntries(OVERRIDE_KEYS.map((key) => [key, `${prefix}:${key}`]));
}

function mapOverrides(prefix) {
  return {
    REPO_ROOTS: { [prefix]: { root: `${prefix}:root`, nested: [`${prefix}:one`, `${prefix}:two`] } },
    REPO_INTEGRATION_BRANCHES: { [prefix]: `${prefix}:integration` },
    REPO_START_BASE_REFS: { [prefix]: [`${prefix}:base-a`, `${prefix}:base-b`] },
    repoRegistry: { [prefix]: { path: `${prefix}:registry`, aliases: [`${prefix}:alias`] } },
    legacyRepoAliases: { [prefix]: `${prefix}:legacy` },
  };
}

test("scoped context returns synchronous values and restores all 31 bindings", () => {
  const context = makeContext("baseline");
  const baseline = snapshotValues(context);
  const overrides = { ...overrideValues("sync"), ...mapOverrides("sync") };

  const result = context.harness.withScopedGovernanceTestContext(overrides, () => {
    assert.deepEqual(readValues(context), overrides);
    return "result";
  });

  assert.equal(result, "result");
  assert.deepEqual(readValues(context), baseline);
});

test("scoped context restores every binding after a synchronous throw", () => {
  const context = makeContext("baseline");
  const baseline = snapshotValues(context);
  const failure = new Error("scope failure");

  assert.throws(() => context.harness.withScopedGovernanceTestContext(
    { ...overrideValues("throw"), ...mapOverrides("throw") },
    () => { throw failure; },
  ), (error) => error === failure);
  assert.deepEqual(readValues(context), baseline);
});

test("scoped context restores when the callback result has a throwing then getter", () => {
  const context = makeContext("baseline");
  const baseline = snapshotValues(context);
  const failure = new Error("then getter failure");
  const thenable = Object.defineProperty({}, "then", {
    get() { throw failure; },
  });

  assert.throws(() => context.harness.withScopedGovernanceTestContext(
    { ...overrideValues("then-getter"), ...mapOverrides("then-getter") },
    () => thenable,
  ), (error) => error === failure);
  assert.deepEqual(readValues(context), baseline);
});

test("scoped context restores every binding after Promise fulfillment and rejection", async () => {
  const context = makeContext("baseline");
  const baseline = snapshotValues(context);

  const value = await context.harness.withScopedGovernanceTestContext(
    { ...overrideValues("fulfilled"), ...mapOverrides("fulfilled") },
    async () => {
      assert.deepEqual(readValues(context), { ...overrideValues("fulfilled"), ...mapOverrides("fulfilled") });
      return 42;
    },
  );
  assert.equal(value, 42);
  assert.deepEqual(readValues(context), baseline);

  const failure = new Error("async scope failure");
  await assert.rejects(context.harness.withScopedGovernanceTestContext(
    { ...overrideValues("rejected"), ...mapOverrides("rejected") },
    async () => { throw failure; },
  ), (error) => error === failure);
  assert.deepEqual(readValues(context), baseline);
});

test("nested synchronous and awaited asynchronous scopes restore inner, outer, then baseline values", async () => {
  const context = makeContext("baseline");
  const baseline = snapshotValues(context);
  const outer = { ...overrideValues("outer"), ...mapOverrides("outer") };
  const inner = { ...overrideValues("inner"), ...mapOverrides("inner") };

  await context.harness.withScopedGovernanceTestContext(outer, async () => {
    assert.deepEqual(readValues(context), outer);
    context.harness.withScopedGovernanceTestContext(inner, () => {
      assert.deepEqual(readValues(context), inner);
    });
    assert.deepEqual(readValues(context), outer);

    await context.harness.withScopedGovernanceTestContext(inner, async () => {
      assert.deepEqual(readValues(context), inner);
      await Promise.resolve();
      assert.deepEqual(readValues(context), inner);
    });
    assert.deepEqual(readValues(context), outer);
  });
  assert.deepEqual(readValues(context), baseline);
});

test("partial overrides preserve unspecified maps and normalize an undefined scalar", () => {
  const context = makeContext("baseline");
  const baseline = snapshotValues(context);
  const rootsIdentity = context.defaultPaths.repoRoots;
  const pathsIdentity = Object.fromEntries(MAP_CONFIG_KEYS.map((key) => [
    key,
    context.defaultPaths[{
      REPO_ROOTS: "repoRoots",
      REPO_INTEGRATION_BRANCHES: "repoIntegrationBranches",
      REPO_START_BASE_REFS: "repoStartBaseRefs",
      repoRegistry: "repoRegistry",
      legacyRepoAliases: "legacyRepoAliases",
    }[key]],
  ]));

  context.harness.withScopedGovernanceTestContext({ REPO_ROOTS: null, DEFAULT_START_BASE_REF: undefined }, () => {
    assert.deepEqual(context.defaultPaths.repoRoots, {});
    assert.equal(context.defaultPaths.defaultStartBaseRef, null);
    for (const [key, reference] of Object.entries(pathsIdentity)) {
      const property = {
        REPO_ROOTS: "repoRoots",
        REPO_INTEGRATION_BRANCHES: "repoIntegrationBranches",
        REPO_START_BASE_REFS: "repoStartBaseRefs",
        repoRegistry: "repoRegistry",
        legacyRepoAliases: "legacyRepoAliases",
      }[key];
      assert.equal(context.defaultPaths[property], reference);
    }
  });

  assert.equal(context.defaultPaths.repoRoots, rootsIdentity);
  assert.deepEqual(readValues(context), baseline);
});

test("fixture cleanup is idempotent", () => {
  const context = makeContext("baseline");
  const baseline = snapshotValues(context);
  const restore = context.harness.enterScopedGovernanceTestContext(overrideValues("fixture"));
  restore();
  restore();
  assert.deepEqual(readValues(context), baseline);
});

test("map identities survive replacement and mutation, including nested arrays", () => {
  const context = makeContext("baseline");
  const references = Object.fromEntries(MAP_CONFIG_KEYS.map((key) => [
    key,
    context.defaultPaths[{
      REPO_ROOTS: "repoRoots",
      REPO_INTEGRATION_BRANCHES: "repoIntegrationBranches",
      REPO_START_BASE_REFS: "repoStartBaseRefs",
      repoRegistry: "repoRegistry",
      legacyRepoAliases: "legacyRepoAliases",
    }[key]],
  ]));
  const originalRepoRecord = context.defaultPaths.repoRegistry.baseline;
  const originalRepoAliases = originalRepoRecord.aliases;
  const originalLegacyAliases = context.defaultPaths.legacyRepoAliases.baseline;
  const baseline = snapshotValues(context);

  context.harness.withScopedGovernanceTestContext(mapOverrides("maps"), () => {
    for (const key of MAP_CONFIG_KEYS) {
      assert.equal(context.defaultPaths[{
        REPO_ROOTS: "repoRoots",
        REPO_INTEGRATION_BRANCHES: "repoIntegrationBranches",
        REPO_START_BASE_REFS: "repoStartBaseRefs",
        repoRegistry: "repoRegistry",
        legacyRepoAliases: "legacyRepoAliases",
      }[key]], references[key]);
    }
    context.defaultPaths.repoRegistry.maps.aliases.push("mutated");
    context.defaultPaths.repoStartBaseRefs.maps.push("mutated");
    // Captured map entries remain the same objects even while their map key is
    // hidden by the scoped override; restoration also returns their old values.
    originalRepoAliases.push("mutated-detached-alias");
    originalLegacyAliases.push("mutated-detached-legacy-alias");
  });

  for (const key of MAP_CONFIG_KEYS) {
    const configKey = {
      REPO_ROOTS: "repoRoots",
      REPO_INTEGRATION_BRANCHES: "repoIntegrationBranches",
      REPO_START_BASE_REFS: "repoStartBaseRefs",
      repoRegistry: "repoRegistry",
      legacyRepoAliases: "legacyRepoAliases",
    }[key];
    assert.equal(context.defaultPaths[configKey], references[key]);
  }
  assert.equal(context.defaultPaths.repoRegistry.baseline, originalRepoRecord);
  assert.equal(context.defaultPaths.repoRegistry.baseline.aliases, originalRepoAliases);
  assert.equal(context.defaultPaths.legacyRepoAliases.baseline, originalLegacyAliases);
  assert.deepEqual(readValues(context), baseline);
});

test("live map aliases can be scoped without clearing entries before clone", () => {
  const context = makeContext("live-alias");
  const roots = context.defaultPaths.repoRoots;
  const registry = context.defaultPaths.repoRegistry;
  const registryEntry = registry["live-alias"];
  const registryAliases = registryEntry.aliases;
  const legacyAliases = context.defaultPaths.legacyRepoAliases["live-alias"];

  context.harness.withScopedGovernanceTestContext({
    REPO_ROOTS: roots,
    repoRegistry: registry,
    legacyRepoAliases: context.defaultPaths.legacyRepoAliases,
  }, () => {
    assert.deepEqual(context.defaultPaths.repoRoots, { "live-alias": "live-alias:root" });
    assert.deepEqual(context.defaultPaths.repoRegistry, {
      "live-alias": { path: "live-alias:registry", aliases: ["live-alias:alias"] },
    });
    assert.deepEqual(context.defaultPaths.legacyRepoAliases, { "live-alias": ["live-alias:legacy"] });
    context.defaultPaths.repoRegistry["live-alias"].aliases.push("scoped mutation");
    context.defaultPaths.legacyRepoAliases["live-alias"].push("scoped mutation");
  });

  assert.equal(context.defaultPaths.repoRoots, roots);
  assert.equal(context.defaultPaths.repoRegistry, registry);
  assert.equal(context.defaultPaths.repoRegistry["live-alias"], registryEntry);
  assert.equal(context.defaultPaths.repoRegistry["live-alias"].aliases, registryAliases);
  assert.equal(context.defaultPaths.legacyRepoAliases["live-alias"], legacyAliases);
  assert.deepEqual(registryAliases, ["live-alias:alias"]);
  assert.deepEqual(legacyAliases, ["live-alias:legacy"]);
});

test("unknown override keys are rejected", () => {
  const context = makeContext("baseline");
  assert.throws(
    () => context.harness.withScopedGovernanceTestContext({ NOT_A_GOVERNANCE_PATH: "unexpected" }, () => {}),
    /unknown|unsupported|override/i,
  );
  const symbolOverride = { [Symbol("unknown path")]: "unexpected" };
  assert.throws(
    () => context.harness.withScopedGovernanceTestContext(symbolOverride, () => {}),
    /unknown|unsupported|override/i,
  );
  const nonEnumerableOverride = {};
  Object.defineProperty(nonEnumerableOverride, "NOT_A_GOVERNANCE_PATH", { value: "unexpected" });
  assert.throws(
    () => context.harness.withScopedGovernanceTestContext(nonEnumerableOverride, () => {}),
    /unknown|unsupported|override/i,
  );
  for (const invalid of [null, "path", [], 42]) {
    assert.throws(
      () => context.harness.withScopedGovernanceTestContext(invalid, () => {}),
      /overrides must be an object/i,
    );
  }
});

test("harness rejects malformed live context and callback/worker targets", () => {
  assert.throws(() => createGovernanceTestContextHarness({ defaultPaths: {} }), /live state object/i);
  assert.throws(() => createGovernanceTestContextHarness({ state: {}, defaultPaths: null }), /live defaultPaths object/i);

  const context = makeContext("invalid");
  assert.throws(() => context.harness.withScopedGovernanceTestContext({}, null), /requires a callback/i);
  assert.throws(() => context.harness.installWorkerContext({}, {}), /event target with once/i);

  const invalidPaths = { ...context.defaultPaths, repoRoots: [] };
  const invalidHarness = createGovernanceTestContextHarness({ state: context.state, defaultPaths: invalidPaths });
  assert.throws(() => invalidHarness.withScopedGovernanceTestContext({}, () => {}), /must be an object/i);
});

test("partial override application failure restores path values and original map entries", () => {
  const context = makeContext("baseline");
  const stateBaseline = { ...context.state };
  const repoRoots = context.defaultPaths.repoRoots;
  const mapBaseline = structuredClone(repoRoots);
  const failure = new Error("config setter failure");
  let failNextAssignment = true;
  Object.defineProperty(context.defaultPaths, "repoRoots", {
    configurable: true,
    enumerable: true,
    get() { return repoRoots; },
    set() {
      if (failNextAssignment) {
        failNextAssignment = false;
        throw failure;
      }
    },
  });
  const harness = createGovernanceTestContextHarness(context);

  assert.throws(
    () => harness.withScopedGovernanceTestContext(
      { BOARD_PATH: "temporary", REPO_ROOTS: { changed: "root" } },
      () => assert.fail("callback must not run"),
    ),
    (error) => error === failure,
  );
  assert.deepEqual(context.state, stateBaseline);
  assert.equal(context.defaultPaths.repoRoots, repoRoots);
  assert.deepEqual(repoRoots, mapBaseline);
});

test("worker context remains installed after scoped context and restores on exit in LIFO order", () => {
  const context = makeContext("baseline");
  const baseline = snapshotValues(context);
  const worker = new EventEmitter();
  const first = { ...overrideValues("worker-one"), ...mapOverrides("worker-one") };
  const second = { ...overrideValues("worker-two"), ...mapOverrides("worker-two") };

  context.harness.installWorkerContext(first, worker);
  assert.deepEqual(readValues(context), first);
  context.harness.withScopedGovernanceTestContext(
    { ...overrideValues("test"), ...mapOverrides("test") },
    () => assert.deepEqual(readValues(context), { ...overrideValues("test"), ...mapOverrides("test") }),
  );
  assert.deepEqual(readValues(context), first);

  context.harness.installWorkerContext(second, worker);
  assert.deepEqual(readValues(context), second);
  worker.emit("exit");
  assert.deepEqual(readValues(context), baseline);
});
