"use strict";

module.exports = function createLifecycleTestingPaths({ state, REPO_ROOTS, REPO_INTEGRATION_BRANCHES, DEFAULT_PATHS }) {
  return {
    get BOARD_PATH() { return state.BOARD_PATH; },
    set BOARD_PATH(value) { state.BOARD_PATH = value; },
    get PLAN_PATH() { return state.PLAN_PATH; },
    set PLAN_PATH(value) { state.PLAN_PATH = value; },
    get PLAN_RECORDS_DIR() { return state.PLAN_RECORDS_DIR; },
    set PLAN_RECORDS_DIR(value) { state.PLAN_RECORDS_DIR = value; },
    get PROMPTS_DIR() { return state.PROMPTS_DIR; },
    set PROMPTS_DIR(value) { state.PROMPTS_DIR = value; },
    get RENDERED_DIR() { return state.RENDERED_DIR; },
    set RENDERED_DIR(value) { state.RENDERED_DIR = value; },
    get LEGACY_PLAN_RECORDS_DIR() { return state.LEGACY_PLAN_RECORDS_DIR; },
    set LEGACY_PLAN_RECORDS_DIR(value) { state.LEGACY_PLAN_RECORDS_DIR = value; },
    get LOCKS_DIR() { return state.LOCKS_DIR; },
    set LOCKS_DIR(value) { state.LOCKS_DIR = value; },
    get LEGACY_LOCKS_DIR() { return state.LEGACY_LOCKS_DIR; },
    set LEGACY_LOCKS_DIR(value) { state.LEGACY_LOCKS_DIR = value; },
    get QUESTIONS_PATH() { return state.QUESTIONS_PATH; },
    set QUESTIONS_PATH(value) { state.QUESTIONS_PATH = value; },
    get TEMPLATE_FEEDBACK_PATH() { return state.TEMPLATE_FEEDBACK_PATH; },
    set TEMPLATE_FEEDBACK_PATH(value) { state.TEMPLATE_FEEDBACK_PATH = value; },
    get AGENTS_PATH() { return state.AGENTS_PATH; },
    set AGENTS_PATH(value) { state.AGENTS_PATH = value; },
    get LEGACY_AGENTS_PATH() { return state.LEGACY_AGENTS_PATH; },
    set LEGACY_AGENTS_PATH(value) { state.LEGACY_AGENTS_PATH = value; },
    get AGENT_SESSIONS_PATH() { return state.AGENT_SESSIONS_PATH; },
    set AGENT_SESSIONS_PATH(value) { state.AGENT_SESSIONS_PATH = value; },
    get LEGACY_AGENT_SESSIONS_PATH() { return state.LEGACY_AGENT_SESSIONS_PATH; },
    set LEGACY_AGENT_SESSIONS_PATH(value) { state.LEGACY_AGENT_SESSIONS_PATH = value; },
    get RUNTIME_DIR() { return state.RUNTIME_DIR; },
    set RUNTIME_DIR(value) { state.RUNTIME_DIR = value; },
    get GOVERNANCE_EVENT_LOG_PATH() { return state.GOVERNANCE_EVENT_LOG_PATH; },
    set GOVERNANCE_EVENT_LOG_PATH(value) { state.GOVERNANCE_EVENT_LOG_PATH = value; },
    get GOVERNANCE_SNAPSHOT_PATH() { return state.GOVERNANCE_SNAPSHOT_PATH; },
    set GOVERNANCE_SNAPSHOT_PATH(value) { state.GOVERNANCE_SNAPSHOT_PATH = value; },
    get GOVERNANCE_SNAPSHOTS_DIR() { return state.GOVERNANCE_SNAPSHOTS_DIR; },
    set GOVERNANCE_SNAPSHOTS_DIR(value) { state.GOVERNANCE_SNAPSHOTS_DIR = value; },
    get GOVERNANCE_EVENT_LOCK_DIR() { return state.GOVERNANCE_EVENT_LOCK_DIR; },
    set GOVERNANCE_EVENT_LOCK_DIR(value) { state.GOVERNANCE_EVENT_LOCK_DIR = value; },
    get COORD_STATE_LOCK_DIR() { return state.COORD_STATE_LOCK_DIR; },
    set COORD_STATE_LOCK_DIR(value) { state.COORD_STATE_LOCK_DIR = value; },
    get AGENT_STATE_LOCK_DIR() { return state.AGENT_STATE_LOCK_DIR; },
    set AGENT_STATE_LOCK_DIR(value) { state.AGENT_STATE_LOCK_DIR = value; },
    get MEMORY_DIR() { return state.MEMORY_DIR; },
    set MEMORY_DIR(value) { state.MEMORY_DIR = value; },
    get MODEL_PRICES_PATH() { return state.MODEL_PRICES_PATH; },
    set MODEL_PRICES_PATH(value) { state.MODEL_PRICES_PATH = value; },
    get TIER_POLICY_PATH_OVERRIDE() { return state.TIER_POLICY_PATH_OVERRIDE; },
    set TIER_POLICY_PATH_OVERRIDE(value) { state.TIER_POLICY_PATH_OVERRIDE = value; },
    get REPO_ROOTS() { return REPO_ROOTS; },
    set REPO_ROOTS(value) {
      for (const key of Object.keys(REPO_ROOTS)) delete REPO_ROOTS[key];
      Object.assign(REPO_ROOTS, value || {});
    },
    get REPO_INTEGRATION_BRANCHES() { return REPO_INTEGRATION_BRANCHES; },
    set REPO_INTEGRATION_BRANCHES(value) {
      for (const key of Object.keys(REPO_INTEGRATION_BRANCHES)) delete REPO_INTEGRATION_BRANCHES[key];
      Object.assign(REPO_INTEGRATION_BRANCHES, value || {});
    },
    get REPO_START_BASE_REFS() { return DEFAULT_PATHS.repoStartBaseRefs; },
    set REPO_START_BASE_REFS(value) {
      for (const key of Object.keys(DEFAULT_PATHS.repoStartBaseRefs)) delete DEFAULT_PATHS.repoStartBaseRefs[key];
      Object.assign(DEFAULT_PATHS.repoStartBaseRefs, value || {});
    },
    get DEFAULT_START_BASE_REF() { return DEFAULT_PATHS.defaultStartBaseRef; },
    set DEFAULT_START_BASE_REF(value) { DEFAULT_PATHS.defaultStartBaseRef = value === undefined ? null : value; },
    get repoRegistry() { return DEFAULT_PATHS.repoRegistry; },
    set repoRegistry(value) {
      for (const key of Object.keys(DEFAULT_PATHS.repoRegistry)) delete DEFAULT_PATHS.repoRegistry[key];
      Object.assign(DEFAULT_PATHS.repoRegistry, value || {});
    },
    get legacyRepoAliases() { return DEFAULT_PATHS.legacyRepoAliases; },
    set legacyRepoAliases(value) {
      for (const key of Object.keys(DEFAULT_PATHS.legacyRepoAliases)) delete DEFAULT_PATHS.legacyRepoAliases[key];
      Object.assign(DEFAULT_PATHS.legacyRepoAliases, value || {});
    },
  };
};
