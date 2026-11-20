"use strict";

const STATE_PATH_KEYS = Object.freeze([
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
]);

const CONFIG_MAP_KEYS = Object.freeze({
  REPO_ROOTS: "repoRoots",
  REPO_INTEGRATION_BRANCHES: "repoIntegrationBranches",
  REPO_START_BASE_REFS: "repoStartBaseRefs",
  repoRegistry: "repoRegistry",
  legacyRepoAliases: "legacyRepoAliases",
});

const CONFIG_SCALAR_KEYS = Object.freeze({
  DEFAULT_START_BASE_REF: "defaultStartBaseRef",
});

const OVERRIDE_KEYS = new Set([
  ...STATE_PATH_KEYS,
  ...Object.keys(CONFIG_MAP_KEYS),
  ...Object.keys(CONFIG_SCALAR_KEYS),
]);

function cloneConfigValue(value) {
  if (Array.isArray(value)) return value.map(cloneConfigValue);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneConfigValue(child)]));
  }
  return value;
}

function cloneEntries(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, cloneConfigValue(value)]));
}

function captureConfigValue(value) {
  if (Array.isArray(value)) {
    return { kind: "array", reference: value, items: value.map(captureConfigValue) };
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return {
      kind: "object",
      reference: value,
      entries: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, captureConfigValue(child)])),
    };
  }
  return { kind: "value", value };
}

function restoreConfigValue(snapshot) {
  if (snapshot.kind === "array") {
    snapshot.reference.length = 0;
    for (const item of snapshot.items) snapshot.reference.push(restoreConfigValue(item));
    return snapshot.reference;
  }
  if (snapshot.kind === "object") {
    for (const key of Object.keys(snapshot.reference)) delete snapshot.reference[key];
    for (const [key, value] of Object.entries(snapshot.entries)) {
      snapshot.reference[key] = restoreConfigValue(value);
    }
    return snapshot.reference;
  }
  return snapshot.value;
}

function captureEntries(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, captureConfigValue(value)]));
}

function replaceEntries(target, entries) {
  const clonedEntries = cloneEntries(entries);
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, clonedEntries);
}

function restoreEntries(target, snapshots) {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, snapshot] of Object.entries(snapshots)) target[key] = restoreConfigValue(snapshot);
}

function validateOverrides(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Governance test context overrides must be an object.");
  }
  const unknown = Reflect.ownKeys(overrides).filter((key) => typeof key !== "string" || !OVERRIDE_KEYS.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown governance test context override(s): ${unknown.map(String).join(", ")}`);
  }
}

function createGovernanceTestContextHarness({ state, defaultPaths } = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("createGovernanceTestContextHarness requires the live state object.");
  }
  if (!defaultPaths || typeof defaultPaths !== "object") {
    throw new TypeError("createGovernanceTestContextHarness requires the live defaultPaths object.");
  }

  function capture() {
    const stateValues = Object.fromEntries(STATE_PATH_KEYS.map((key) => [key, state[key]]));
    const configMaps = Object.fromEntries(Object.entries(CONFIG_MAP_KEYS).map(([key, property]) => {
      const reference = defaultPaths[property];
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
        throw new TypeError(`Governance config path ${property} must be an object.`);
      }
      return [key, { reference, entries: captureEntries(reference) }];
    }));
    const configScalars = Object.fromEntries(Object.entries(CONFIG_SCALAR_KEYS).map(([key, property]) => [
      key,
      defaultPaths[property],
    ]));
    return { stateValues, configMaps, configScalars };
  }

  function restore(snapshot) {
    for (const key of STATE_PATH_KEYS) state[key] = snapshot.stateValues[key];
    for (const [key, property] of Object.entries(CONFIG_MAP_KEYS)) {
      const { reference, entries } = snapshot.configMaps[key];
      restoreEntries(reference, entries);
      defaultPaths[property] = reference;
    }
    for (const [key, property] of Object.entries(CONFIG_SCALAR_KEYS)) {
      defaultPaths[property] = snapshot.configScalars[key];
    }
  }

  function apply(snapshot, overrides) {
    for (const key of STATE_PATH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) state[key] = overrides[key];
    }
    for (const [key, property] of Object.entries(CONFIG_MAP_KEYS)) {
      if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
      const { reference } = snapshot.configMaps[key];
      const value = overrides[key];
      replaceEntries(reference, value && typeof value === "object" ? value : {});
      defaultPaths[property] = reference;
    }
    for (const [key, property] of Object.entries(CONFIG_SCALAR_KEYS)) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        defaultPaths[property] = overrides[key] === undefined ? null : overrides[key];
      }
    }
  }

  function captureAndApply(overrides) {
    validateOverrides(overrides);
    const snapshot = capture();
    try {
      apply(snapshot, overrides);
    } catch (error) {
      restore(snapshot);
      throw error;
    }
    return snapshot;
  }

  function enterScopedGovernanceTestContext(overrides) {
    const snapshot = captureAndApply(overrides);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      restore(snapshot);
    };
  }

  function withScopedGovernanceTestContext(overrides, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("withScopedGovernanceTestContext requires a callback.");
    }
    // The injected objects are shared process state. Nesting is supported when
    // the inner scope is awaited; independent overlapping async scopes must run
    // in separate workers so neither scope can observe the other's overrides.
    const restoreScope = enterScopedGovernanceTestContext(overrides);
    let result;
    try {
      result = callback();
      if (result && typeof result.then === "function") {
        return Promise.resolve(result).then(
          (value) => {
            restoreScope();
            return value;
          },
          (error) => {
            restoreScope();
            throw error;
          },
        );
      }
    } catch (error) {
      restoreScope();
      throw error;
    }
    restoreScope();
    return result;
  }

  const workerScopes = new WeakMap();
  function installWorkerContext(overrides, workerTarget = process) {
    validateOverrides(overrides);
    if (!workerTarget || typeof workerTarget.once !== "function") {
      throw new TypeError("installWorkerContext requires an event target with once().");
    }

    let workerScope = workerScopes.get(workerTarget);
    if (!workerScope) {
      workerScope = { restores: [] };
      workerScopes.set(workerTarget, workerScope);
      workerTarget.once("exit", () => {
        while (workerScope.restores.length > 0) {
          const restoreScope = workerScope.restores.pop();
          restoreScope();
        }
        workerScopes.delete(workerTarget);
      });
    }

    workerScope.restores.push(enterScopedGovernanceTestContext(overrides));
  }

  return Object.freeze({
    withScopedGovernanceTestContext,
    installWorkerContext,
    // Internal fixture support for setup helpers whose existing API returns an
    // explicit cleanup function. This is not re-exported from governance-test-utils.
    enterScopedGovernanceTestContext,
  });
}

module.exports = { createGovernanceTestContextHarness };
