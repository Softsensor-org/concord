"use strict";

// COORD-894 — can governance push the board commit to the board branch?
//
// Field report (an adopter workspace, 2026-11-05): an org ruleset required a pull
// request on every default branch, so the first `gov finalize` direct push of
// the board commit was refused, and nothing warned before ticket work began.
//
// This module answers the question BEFORE the first finalize, from the
// remote's EFFECTIVE rules: `gh api repos/<o>/<r>/rules/branches/<b>` (every
// ruleset layer, org and repo, that applies to the branch) plus classic branch
// protection. A ruleset's `current_user_can_bypass` says whether this identity
// may push past it; only "always" (or "exempt") is a direct-push bypass —
// "pull_requests_only" is not.
//
// NEVER A FALSE PASS. Every path that cannot observe the rules — gh missing,
// unauthenticated, offline, a non-GitHub remote, an unreadable response —
// reports status "unknown" with the reason, never "allowed".
//
// `gh` is injected (a function argv -> { status, stdout, stderr, error }) so
// tests drive a fake; the default runner refuses to touch the network under
// the node test runner.

const { spawnSync } = require("node:child_process");
const { gitTry } = require("./git-ops.js");
const { spawnGh } = require("./gh-spawn.js");

// not_applicable: no governance remote, so governance pushes nothing.
const PREFLIGHT_STATUS = Object.freeze({ ALLOWED: "allowed", BLOCKED: "blocked", UNKNOWN: "unknown", NOT_APPLICABLE: "not_applicable" });

// Rule types that refuse a direct (non-PR) push of a new commit.
const BLOCKING_RULE_TYPES = Object.freeze({
  pull_request: "requires a pull request",
  required_status_checks: "requires status checks to pass before the ref moves",
  update: "restricts who may update the branch",
  merge_queue: "requires the merge queue",
  required_deployments: "requires successful deployments",
});
const BYPASSING = new Set(["always", "exempt"]);

const BOARD_PUSH_REMEDIES = Object.freeze([
  "exclude the board repository from the ruleset (or the branch from its target)",
  'add a GitHub App or deploy-key bypass actor in "Always" mode (a "pull request only" bypass cannot push directly)',
  'switch to PR landing: set boardLanding: "pr" in coord/project.config.js',
  "or set boardBranch in coord/project.config.js to a branch the rules do not cover",
]);

// The sentence a refused direct push carries (push mode, COORD-894 (2)).
function boardPushRefusalHint(branch) {
  return (
    `The remote refused a direct push to the board branch "${branch}". If a branch rule requires a pull request, ` +
    `either ${BOARD_PUSH_REMEDIES.slice(0, 2).join(", or ")}, or set boardLanding: "pr" in coord/project.config.js ` +
    "so finalize/land publishes the board commit as a governance-only PR. Run `gov doctor` to see the effective rules."
  );
}

// A push refusal that a branch rule (not a network error) produced.
function isRuleRefusal(stderr) {
  return /\bGH0(?:0[0-9]|1[0-9])\b|protected branch|rule violations?|through a pull request|requires? a pull request/i
    .test(String(stderr || ""));
}

// A short default: doctor and onboard must not hang on a slow network.
const DEFAULT_GH_TIMEOUT_MS = 5000;

function createDefaultGh({ spawn = spawnSync, env = process.env, timeoutMs = DEFAULT_GH_TIMEOUT_MS } = {}) {
  return function gh(args, { cwd } = {}) {
    if (env.NODE_TEST_CONTEXT) {
      return { status: null, stdout: "", stderr: "", error: { code: "TEST_RUNNER", message: "gh is never invoked under the test runner" } };
    }
    return spawnGh(args, { spawn, timeoutMs, env: { ...env, GH_PROMPT_DISABLED: "1" }, ...(cwd ? { cwd } : {}) });
  };
}

function parseGitHubRemote(url) {
  const text = String(url || "").trim();
  const match = text.match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function unknown(base, reason, detail) {
  return { ...base, status: PREFLIGHT_STATUS.UNKNOWN, reason, ...(detail ? { detail } : {}), findings: [], remedies: [] };
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(String(text || "")) };
  } catch {
    return { ok: false };
  }
}

// Spawn errors that name their own reason; anything else falls to stderr.
const SPAWN_ERROR_REASONS = Object.freeze({ ENOENT: "gh_missing", TEST_RUNNER: "gh_disabled", ETIMEDOUT: "timeout" });

function ghFailureReason(result) {
  const error = (result && result.error) || null;
  if (error && SPAWN_ERROR_REASONS[error.code]) return SPAWN_ERROR_REASONS[error.code];
  const stderr = String((result && result.stderr) || "");
  if (/auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(stderr)) return "gh_unauthenticated";
  if (error || /could not resolve|connect|timed? ?out|network|ENOTFOUND|ECONN/i.test(stderr)) return "offline";
  return "gh_error";
}

// Classic branch protection: 404 means "not protected"; 403 means this
// identity cannot read it (unknown, not "unprotected").
function classicProtectionFindings(gh, slug, branch) {
  const result = gh(["api", `repos/${slug}/branches/${encodeURIComponent(branch)}/protection`]);
  const stderr = String((result && result.stderr) || "");
  if (result && result.status === 0) {
    const parsed = parseJson(result.stdout);
    if (!parsed.ok) return { error: "unreadable classic protection response" };
    const p = parsed.value || {};
    const findings = [];
    if (p.required_pull_request_reviews) findings.push({ source: "classic protection", type: "pull_request", effect: BLOCKING_RULE_TYPES.pull_request });
    if (p.required_status_checks) findings.push({ source: "classic protection", type: "required_status_checks", effect: BLOCKING_RULE_TYPES.required_status_checks });
    if (p.restrictions) findings.push({ source: "classic protection", type: "update", effect: BLOCKING_RULE_TYPES.update });
    return { findings };
  }
  if (/HTTP 404|Branch not protected|Not Found/i.test(stderr)) return { findings: [] };
  return { error: ghFailureReason(result), detail: stderr.trim() || undefined };
}

function rulesetBypass(gh, slug, rulesetId, cache) {
  if (rulesetId === undefined || rulesetId === null) return null;
  if (!cache.has(rulesetId)) {
    const result = gh(["api", `repos/${slug}/rulesets/${rulesetId}`]);
    const parsed = result && result.status === 0 ? parseJson(result.stdout) : { ok: false };
    cache.set(rulesetId, parsed.ok && parsed.value ? { name: parsed.value.name || null, bypass: parsed.value.current_user_can_bypass || null } : null);
  }
  return cache.get(rulesetId);
}

function probeBoardPush({ owner, repo, branch, gh } = {}) {
  const slug = `${owner}/${repo}`;
  const base = { repo: slug, branch };
  const auth = gh(["auth", "status"]);
  if (!auth || auth.status !== 0) return unknown(base, ghFailureReason(auth), String((auth && auth.stderr) || "").trim() || undefined);
  const rules = gh(["api", `repos/${slug}/rules/branches/${encodeURIComponent(branch)}`]);
  if (!rules || rules.status !== 0) return unknown(base, ghFailureReason(rules), String((rules && rules.stderr) || "").trim() || undefined);
  const parsed = parseJson(rules.stdout);
  if (!parsed.ok || !Array.isArray(parsed.value)) return unknown(base, "unreadable_rules_response");
  const cache = new Map();
  const findings = [];
  for (const rule of parsed.value) {
    const effect = rule && BLOCKING_RULE_TYPES[rule.type];
    if (!effect) continue;
    const ruleset = rulesetBypass(gh, slug, rule.ruleset_id, cache);
    findings.push({
      source: `ruleset ${ruleset && ruleset.name ? `"${ruleset.name}"` : rule.ruleset_id ?? "(unnamed)"}` +
        (rule.ruleset_source ? ` (${rule.ruleset_source_type || "source"} ${rule.ruleset_source})` : ""),
      type: rule.type,
      effect,
      bypass: ruleset ? ruleset.bypass : null,
    });
  }
  const classic = classicProtectionFindings(gh, slug, branch);
  findings.push(...(classic.findings || []));
  const blocking = findings.filter((finding) => !BYPASSING.has(finding.bypass));
  if (blocking.length > 0) {
    return { ...base, status: PREFLIGHT_STATUS.BLOCKED, reason: "direct_push_blocked", findings, remedies: [...BOARD_PUSH_REMEDIES] };
  }
  if (classic.error) return { ...unknown(base, `classic_protection_${classic.error}`, classic.detail), findings };
  return { ...base, status: PREFLIGHT_STATUS.ALLOWED, reason: findings.length ? "bypass_always" : "no_blocking_rules", findings, remedies: [] };
}

// Resolve the board repository's GitHub coordinates and probe them.
function runBoardPushPreflight({ repoRoot, branch, remote = "origin", gh, gitFn = gitTry, boardLanding = "push", offline = false } = {}) {
  const base = { repo: null, branch, board_landing: boardLanding };
  // Opted out: the answer was not observed, so it is reported as unknown.
  if (offline) return { ...unknown(base, "skipped"), board_landing: boardLanding };
  if (!repoRoot) return { ...base, status: PREFLIGHT_STATUS.NOT_APPLICABLE, reason: "no_control_plane_repository", findings: [], remedies: [] };
  const url = gitFn(repoRoot, ["remote", "get-url", remote]);
  if (!url || url.status !== 0) return { ...base, status: PREFLIGHT_STATUS.NOT_APPLICABLE, reason: "no_remote", findings: [], remedies: [] };
  const coordinates = parseGitHubRemote(url.stdout);
  if (!coordinates) return { ...unknown(base, "not_a_github_remote", String(url.stdout || "").trim()), board_landing: boardLanding };
  return { ...probeBoardPush({ ...coordinates, branch, gh: gh || createDefaultGh() }), board_landing: boardLanding };
}

const UNKNOWN_REASONS = Object.freeze({
  skipped: "the remote rules check was skipped (--offline or COORD_DOCTOR_OFFLINE=1)",
  timeout: "gh did not answer within the timeout",
  gh_missing: "the GitHub CLI (gh) is not installed",
  gh_unauthenticated: "gh is not authenticated (run `gh auth login`)",
  gh_disabled: "gh was not invoked (test runner)",
  offline: "GitHub could not be reached (offline?)",
  gh_error: "gh returned an error",
  unreadable_rules_response: "the rules response could not be read",
  not_a_github_remote: "the board remote is not a GitHub repository",
});

// Human-readable lines; empty when there is nothing to say (no remote).
function formatBoardPushPreflight(result) {
  if (!result || result.status === PREFLIGHT_STATUS.NOT_APPLICABLE) return [];
  const where = `${result.repo || "board remote"} branch "${result.branch}"`;
  if (result.status === PREFLIGHT_STATUS.ALLOWED) {
    return [`[board-push] direct push to ${where}: allowed (${result.reason === "bypass_always" ? "this identity bypasses the rules in Always mode" : "no blocking rules"}).`];
  }
  if (result.status === PREFLIGHT_STATUS.UNKNOWN) {
    const why = UNKNOWN_REASONS[result.reason] || String(result.reason).replace(/_/g, " ");
    const label = ["skipped", "timeout"].includes(result.reason) ? result.reason : "not observed";
    return [`[board-push] direct push to ${where}: UNKNOWN (${label}) — ${why}${result.detail ? ` (${result.detail})` : ""}. This is not a pass; re-run \`gov doctor\` once gh can reach GitHub.`];
  }
  const pr = result.board_landing === "pr";
  return [
    `[board-push] direct push to ${where}: BLOCKED${pr ? ' (boardLanding is "pr", so finalize/land lands the board commit through a PR instead)' : " — the first finalize push will be refused"}:`,
    ...result.findings.filter((f) => !BYPASSING.has(f.bypass)).map((f) => `  - ${f.source}: ${f.type} ${f.effect}${f.bypass ? ` (your bypass: ${f.bypass})` : ""}`),
    ...(pr ? [] : ["  Remedies:", ...result.remedies.map((r) => `  - ${r}`)]),
  ];
}

// Doctor surfaces only what needs attention: a blocked direct push in push
// mode, or an answer it could not observe.
function boardPushDoctorWarnings(result) {
  if (!result) return [];
  const blockedInPushMode = result.status === PREFLIGHT_STATUS.BLOCKED && result.board_landing !== "pr";
  return blockedInPushMode || result.status === PREFLIGHT_STATUS.UNKNOWN ? formatBoardPushPreflight(result) : [];
}

module.exports = {
  DEFAULT_GH_TIMEOUT_MS,
  boardPushDoctorWarnings,
  PREFLIGHT_STATUS,
  BLOCKING_RULE_TYPES,
  BOARD_PUSH_REMEDIES,
  boardPushRefusalHint,
  isRuleRefusal,
  createDefaultGh,
  parseGitHubRemote,
  probeBoardPush,
  runBoardPushPreflight,
  formatBoardPushPreflight,
};
