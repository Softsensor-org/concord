"use strict";

// COORD-718: independent review evidence as a first-class plan record.
//
// A review performed by a session that does not own the ticket is recorded in
// the plan record field `independent_reviews` (append-only). This module owns
// the record shape, the stable id and retry rule, the supersession/correction
// links, the claimed-scope resolver, and the one projection every reader uses
// to tell current reviews from historical ones.
//
// What this module deliberately does NOT read: coord/QUESTIONS.md and
// self_review_cycles. Neither is independent-review evidence, so neither can
// make a review current or count toward any total.

const { sha256Text } = require("./lifecycle-utils.js");

const REVIEW_ID_PATTERN = /^irv1-[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TICKET_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ABSOLUTE_REPOSITORY_PATTERN = /^(?:\/[^\u0000-\u001f\u007f]+|[A-Za-z]:[\\/][^\u0000-\u001f\u007f]+|\\\\[^\\/\u0000-\u001f\u007f]+\\[^\\/\u0000-\u001f\u007f]+(?:\\[^\\/\u0000-\u001f\u007f]+)*)$/;
const FINDING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,99}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const VERDICTS = Object.freeze(["pass", "pass-with-findings", "fail", "inconclusive"]);
const ENTRY_KEYS = Object.freeze([
  "id", "review_key", "ticket_id", "reviewer", "owner_at_review", "repository", "commit", "method",
  "findings", "verdict", "summary", "supersedes", "corrects", "reason", "timestamp",
]);
const REVIEWER_KEYS = Object.freeze(["handle", "agent_id", "session_id", "thread_id"]);
// Only the governed writer constructs a write request carrying this brand. The
// update-plan flag surface passes strings, which can never carry a symbol.
const INDEPENDENT_REVIEW_WRITE = Symbol.for("coord.independent-review.write/v1");
const SECTION_NAME = "Independent reviews (append-only)";
const SUBMISSION_SECTION_NAME = "Review submission";
const NOT_EVIDENCE = Object.freeze(["QUESTIONS.md", "self_review_cycles"]);

function fail(message) {
  throw new Error(`Independent review ${message}`);
}

function independentReviewId(ticketId, reviewerHandle, reviewKey) {
  return `irv1-${sha256Text(`independent-review/v1\0${ticketId}\0${reviewerHandle}\0${reviewKey}`)}`;
}

function defaultReviewKey({ repository, commit, method }) {
  return `${repository}@${commit}:${method}`;
}

function isText(value, max) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
}

function isSingleLine(value, max) {
  return isText(value, max) && !CONTROL_CHARS.test(value);
}

// Repo config deliberately accepts absolute roots, and stores the configured
// path as its repository identity. Keep that identity exact (it participates
// in stable review IDs); writer paths still resolve only by exact registry
// membership, never by treating this persisted string as an arbitrary path.
function isRepositoryIdentity(value) {
  if (!isSingleLine(value, 200) || value.split(/[\\/]/).includes("..")) return false;
  return REPOSITORY_PATTERN.test(value) || ABSOLUTE_REPOSITORY_PATTERN.test(value);
}

function isNullableText(value, max) {
  return value === null || isText(value, max);
}

// guard:independent-review-record
function assertKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(`${label} contains unknown field ${JSON.stringify(unknown)}.`);
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) fail(`${label} is missing field ${JSON.stringify(missing)}.`);
}

// guard:independent-review-record
function assertReviewer(reviewer, label) {
  assertKeys(reviewer, REVIEWER_KEYS, `${label} reviewer`);
  if (typeof reviewer.handle !== "string" || !HANDLE_PATTERN.test(reviewer.handle)) {
    fail(`${label} needs a registered reviewer handle.`);
  }
  for (const key of ["agent_id", "session_id", "thread_id"]) {
    if (!isNullableText(reviewer[key], 200) || CONTROL_CHARS.test(reviewer[key] || "")) {
      fail(`${label} reviewer.${key} must be a single-line string or null.`);
    }
  }
  if (!reviewer.session_id && !reviewer.thread_id) fail(`${label} needs session or thread evidence for the reviewer.`);
}

// guard:independent-review-record
function assertLinks(entry, label) {
  for (const key of ["supersedes", "corrects"]) {
    if (entry[key] !== null && !REVIEW_ID_PATTERN.test(String(entry[key]))) fail(`${label} ${key} must be a review id or null.`);
  }
  if (entry.supersedes && entry.corrects) fail(`${label} cannot both supersede and correct.`);
  const linked = Boolean(entry.supersedes || entry.corrects);
  if (linked ? !isText(entry.reason, 2000) : entry.reason !== null) {
    fail(`${label} needs a reason exactly when it supersedes or corrects a review.`);
  }
}

// Who reviewed, for which ticket, under which retry key.
// guard:independent-review-record
function assertIdentity(entry, label) {
  if (!TICKET_PATTERN.test(String(entry.ticket_id))) fail(`${label} has an invalid ticket_id.`);
  if (!isSingleLine(entry.review_key, 300)) fail(`${label} needs a single-line review_key.`);
  assertReviewer(entry.reviewer, label);
  if (entry.owner_at_review !== null && !HANDLE_PATTERN.test(String(entry.owner_at_review))) {
    fail(`${label} owner_at_review must be a handle or null.`);
  }
  if (entry.owner_at_review === entry.reviewer.handle) fail(`${label} was authored by the ticket owner; owner review is self-review.`);
}

// What was reviewed: an exact repository and immutable commit.
// guard:independent-review-record
function assertReviewedTarget(entry, label) {
  if (!isRepositoryIdentity(entry.repository)) {
    fail(`${label} needs a repository name.`);
  }
  if (!COMMIT_PATTERN.test(String(entry.commit))) fail(`${label} needs a full immutable commit id.`);
}

// Field-level validation of one stored entry. Cross-entry rules (unique ids,
// link targets) live in validateIndependentReviews.
// guard:independent-review-record
function assertEntry(entry, label) {
  assertKeys(entry, ENTRY_KEYS, label);
  assertIdentity(entry, label);
  assertReviewedTarget(entry, label);
  if (!isSingleLine(entry.method, 500)) fail(`${label} needs a single-line review method.`);
  if (!Array.isArray(entry.findings) || entry.findings.some((id) => typeof id !== "string" || !FINDING_PATTERN.test(id)) ||
      new Set(entry.findings).size !== entry.findings.length) {
    fail(`${label} findings must be unique finding ids.`);
  }
  if (!VERDICTS.includes(entry.verdict)) fail(`${label} verdict must be one of ${VERDICTS.join(", ")}.`);
  if (!isNullableText(entry.summary, 4000)) fail(`${label} summary must be text or null.`);
  assertLinks(entry, label);
  if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) fail(`${label} needs a valid timestamp.`);
  if (entry.id !== independentReviewId(entry.ticket_id, entry.reviewer.handle, entry.review_key)) {
    fail(`${label} has an id that does not match its ticket, reviewer and review key.`);
  }
}

// guard:independent-review-record
function assertLinkTarget(entry, label, seen, linkedTargets) {
  const target = entry.supersedes || entry.corrects;
  if (!target) return;
  const prior = seen.get(target);
  if (!prior) fail(`${label} links to a review that is not recorded before it.`);
  if (prior.reviewer.handle !== entry.reviewer.handle) fail(`${label} can only supersede or correct a review by the same reviewer.`);
  if (linkedTargets.has(target)) fail(`${label} forks review ${target}, which already has a successor.`);
  linkedTargets.set(target, { by: entry.id, relation: entry.supersedes ? "superseded" : "corrected" });
}

// Strict, fail-closed validation of the whole ledger. Returns each entry with
// its lifecycle status (active | superseded | corrected) and successor id.
function validateIndependentReviews(record = {}) {
  const entries = record.independent_reviews ?? [];
  if (!Array.isArray(entries)) fail("ledger must be an array.");
  const seen = new Map();
  const linkedTargets = new Map();
  entries.forEach((entry, offset) => {
    const label = `entry ${offset + 1}`;
    assertEntry(entry, label);
    if (record.ticket_id && entry.ticket_id !== record.ticket_id) fail(`${label} belongs to ${entry.ticket_id}, not ${record.ticket_id}.`);
    if (seen.has(entry.id)) fail(`${label} repeats review id ${entry.id}.`);
    assertLinkTarget(entry, label, seen, linkedTargets);
    seen.set(entry.id, entry);
  });
  return entries.map((entry) => {
    const link = linkedTargets.get(entry.id);
    return { entry, status: link ? link.relation : "active", successor: link ? link.by : null };
  });
}

function currencyOf({ entry, status }, scope, owner) {
  if (status !== "active") return status;
  if (owner && owner === entry.reviewer.handle) return "reviewer_is_owner";
  if (!scope) return "scope_unresolved";
  if (entry.repository !== scope.repository) return "other_repository";
  return entry.commit === scope.commit ? "current" : "stale_head";
}

// The board owner of the reviewed ticket, or null when it is unassigned.
function reviewOwnerOf(owner) {
  return typeof owner === "string" && owner !== "" && owner !== "unassigned" ? owner : null;
}

function normalizeScope(scope) {
  if (!scope || !COMMIT_PATTERN.test(String(scope.commit || "").toLowerCase()) || !isSingleLine(scope.repository, 200)) return null;
  return { repository: scope.repository, commit: String(scope.commit).toLowerCase(), source: scope.source || null };
}

// The projection. `scope` is the claimed scope ({ repository, commit,
// source }); `owner` is the ticket's current owner handle. Throws on an
// invalid ledger; readers that must not throw use projectIndependentReviews.
function resolveIndependentReviews(record = {}, { scope = null, owner = null } = {}) {
  const claimed = normalizeScope(scope);
  const items = validateIndependentReviews(record).map((validated) => {
    const currency = currencyOf(validated, claimed, owner);
    return {
      ...JSON.parse(JSON.stringify(validated.entry)),
      status: validated.status,
      successor: validated.successor,
      currency,
      current: currency === "current",
    };
  });
  const current = items.filter((item) => item.current);
  const historical = items.filter((item) => !item.current);
  return {
    scope: claimed,
    counts: {
      current: current.length,
      current_reviewers: new Set(current.map((item) => item.reviewer.handle)).size,
      historical: historical.length,
      total: items.length,
    },
    current,
    historical,
    not_evidence: [...NOT_EVIDENCE],
    error: null,
  };
}

// Fail-closed reader form: an invalid ledger yields zero current reviews plus
// the refusal, never the raw entries.
function projectIndependentReviews(record, options = {}) {
  try {
    return resolveIndependentReviews(record || {}, options);
  } catch (error) {
    // Every refusal above is an Error raised by fail().
    return {
      scope: normalizeScope(options.scope),
      counts: { current: 0, current_reviewers: 0, historical: 0, total: 0 },
      current: [],
      historical: [],
      not_evidence: [...NOT_EVIDENCE],
      error: String(error.message),
    };
  }
}

function repositoryForRepoCode(repoCode, repoRegistry = {}) {
  if (repoCode === "X") return "coord";
  return (repoRegistry && typeof repoRegistry[repoCode] === "string" && repoRegistry[repoCode]) || null;
}

function validateReviewSubmission(submission) {
  if (!submission || typeof submission !== "object" || Array.isArray(submission) ||
      Object.keys(submission).sort().join(",") !== "commit,repository" ||
      !isRepositoryIdentity(submission.repository) || typeof submission.commit !== "string" ||
      !COMMIT_PATTERN.test(submission.commit)) return null;
  return { repository: submission.repository, commit: submission.commit };
}

function readReviewSubmissionFromBlock(block, { readList, fail: reject }) {
  const values = readList(block, SUBMISSION_SECTION_NAME);
  if (!values.length) return undefined;
  if (values.length !== 1) reject("Plan record review submission must contain exactly one JSON object.");
  let parsed;
  try { parsed = JSON.parse(values[0]); }
  catch (error) { reject(`Could not parse plan record review submission: ${error.message}`); }
  const normalized = validateReviewSubmission(parsed);
  if (!normalized) reject("Plan record review submission must contain exactly repository and a full lowercase commit.");
  return normalized;
}

function renderReviewSubmissionSection(lines, record) {
  const submission = record.review_submission;
  if (!submission) return;
  const normalized = validateReviewSubmission(submission);
  if (!normalized) throw new Error("Plan record review submission is invalid.");
  lines.push(`- ${SUBMISSION_SECTION_NAME}:`);
  lines.push(`  - ${JSON.stringify(normalized)}`);
}

// The claimed scope is the immutable submitted pair while in review, the active
// lock while doing, or the immutable landed source after closeout. Legacy review
// tickets with no pair remain unresolved.
function resolveClaimedReviewScope({ lock = null, landing = null, repository = null, status = null, reviewSubmission = null } = {}) {
  if (status === "review") {
    const submitted = validateReviewSubmission(reviewSubmission);
    if (submitted && submitted.repository === repository) return { ...submitted, source: "submission" };
    return null;
  }
  if (status === "doing" || String(status || "").startsWith("doing (")) {
    const lockHead = String(lock?.head || "").toLowerCase();
    if (lock && COMMIT_PATTERN.test(lockHead) && isSingleLine(lock.repo, 200) && lock.repo === repository) {
      return { repository, commit: lockHead, source: "lock" };
    }
    return null;
  }
  if (status === "done" || status === "superseded") {
    const landed = String(landing?.source_commit_sha || "").toLowerCase();
    return COMMIT_PATTERN.test(landed) && isSingleLine(repository, 200)
      ? { repository, commit: landed, source: "landing" }
      : null;
  }
  const lockHead = String(lock?.head || "").toLowerCase();
  if (lock && COMMIT_PATTERN.test(lockHead) && isSingleLine(lock.repo, 200)) {
    return { repository: lock.repo, commit: lockHead, source: "lock" };
  }
  const landed = String(landing?.source_commit_sha || "").toLowerCase();
  if (COMMIT_PATTERN.test(landed) && isSingleLine(repository, 200)) {
    return { repository, commit: landed, source: "landing" };
  }
  return null;
}

// File-reading form for readers that do not already hold the lock.
function readClaimedReviewScope({ fs, path, locksDir, ticketId, board, repoCode, repoRegistry, status = null, reviewSubmission = null }) {
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(locksDir, `${ticketId}.lock`), "utf8"));
  } catch {
    lock = null;
  }
  if (lock && lock.ticket !== ticketId) lock = null;
  return resolveClaimedReviewScope({
    lock,
    landing: board?.landing_index?.[ticketId] || null,
    repository: repositoryForRepoCode(repoCode, repoRegistry),
    status: status || board?.sections?.flatMap((section) => section.rows || []).find((row) => row.ID === ticketId)?.Status || null,
    reviewSubmission,
  });
}

function comparableContent(entry) {
  const { timestamp, reviewer, owner_at_review: ownerAtReview, ...content } = entry;
  return JSON.stringify({ ...content, reviewer: reviewer.handle });
}

function isIdenticalIndependentReview(record, review) {
  const prior = (record.independent_reviews || []).find((entry) => entry.id === review.id);
  return Boolean(prior) && comparableContent(prior) === comparableContent(review);
}

// Build a validated entry from writer input. Defaults fill the retry key and
// timestamp; normalization trims text and lower-cases the commit id.
function buildIndependentReview(input = {}) {
  const trimOrNull = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const repository = trimOrNull(input.repository);
  const commit = trimOrNull(input.commit)?.toLowerCase() || null;
  const method = trimOrNull(input.method);
  const reviewer = input.reviewer || {};
  const reviewKey = trimOrNull(input.reviewKey) || defaultReviewKey({ repository, commit, method });
  const entry = {
    id: null,
    review_key: reviewKey,
    ticket_id: input.ticketId,
    reviewer: {
      handle: reviewer.handle,
      agent_id: trimOrNull(reviewer.agent_id),
      session_id: trimOrNull(reviewer.session_id),
      thread_id: trimOrNull(reviewer.thread_id),
    },
    owner_at_review: trimOrNull(input.ownerAtReview),
    repository,
    commit,
    method,
    findings: (Array.isArray(input.findings) ? input.findings : []).map((id) => String(id).trim()),
    verdict: trimOrNull(input.verdict),
    summary: trimOrNull(input.summary),
    supersedes: trimOrNull(input.supersedes),
    corrects: trimOrNull(input.corrects),
    reason: trimOrNull(input.reason),
    timestamp: input.timestamp || new Date().toISOString(),
  };
  entry.id = independentReviewId(entry.ticket_id, entry.reviewer.handle, entry.review_key);
  assertEntry(entry, "input");
  return entry;
}

// Pure append. Identical retry returns changed=false with the input record;
// a different review under an existing id fails closed.
function applyIndependentReview(record, review) {
  validateIndependentReviews(record);
  if ((record.independent_reviews || []).some((entry) => entry.id === review.id)) {
    if (isIdenticalIndependentReview(record, review)) return { record, review, changed: false };
    fail(`id ${review.id} is already recorded with different content; use a new --review-key or --supersedes.`);
  }
  const nextRecord = JSON.parse(JSON.stringify(record));
  nextRecord.independent_reviews = [...(record.independent_reviews || []), review];
  validateIndependentReviews(nextRecord);
  return { record: nextRecord, review, changed: true };
}

// Canonical-writer hook (called through plan-evidence-supersession's
// applyCorrectionsToRecord). Only a branded request from the governed writer
// is accepted; any other value under this option key is refused.
function applyIndependentReviewToRecord(record, options) {
  const request = options.independentReview;
  if (!request || typeof request !== "object" || request[INDEPENDENT_REVIEW_WRITE] !== true) {
    fail("records are written only by gov record-independent-review.");
  }
  const result = applyIndependentReview(record, request.review);
  if (result.changed) record.independent_reviews = result.record.independent_reviews;
}

function readIndependentReviewsFromBlock(block, { readList, fail: reject }) {
  const values = readList(block, SECTION_NAME);
  if (!values.length) return undefined;
  return values.map((value, index) => {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      reject(`Could not parse plan record independent reviews entry ${index + 1}: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      reject(`Plan record independent reviews entry ${index + 1} must be a JSON object.`);
    }
    return parsed;
  });
}

// PLAN.md has no claimed scope, so it shows lifecycle status only and says
// where currency is decided. Omitted entirely when there are no reviews, so
// existing plan blocks render byte-identically.
function renderIndependentReviewSection(lines, record) {
  const entries = record.independent_reviews || [];
  if (!entries.length) return;
  const statuses = new Map(validateIndependentReviews(record).map((item) => [item.entry.id, item]));
  lines.push(`- ${SECTION_NAME}:`);
  for (const entry of entries) {
    const item = statuses.get(entry.id);
    const lifecycle = item.status === "active"
      ? `active; current only when ${entry.repository}@${entry.commit} is the claimed head in gov explain`
      : `${item.status} by ${item.successor}; historical`;
    lines.push(`  - ${JSON.stringify(entry)}`);
    lines.push(`    - Review: ${entry.id} reviewer=${entry.reviewer.handle} owner_at_review=${entry.owner_at_review || "none"} ` +
      `reviewed=${entry.repository}@${entry.commit} method=${JSON.stringify(entry.method)} verdict=${entry.verdict} ` +
      `findings=${entry.findings.join(",") || "none"} status=${lifecycle}`);
  }
}

function validateIndependentReviewRecord(record, reject) {
  try {
    validateIndependentReviews(record);
  } catch (error) {
    reject(error.message);
  }
}

module.exports = {
  VERDICTS,
  INDEPENDENT_REVIEW_WRITE,
  SECTION_NAME,
  SUBMISSION_SECTION_NAME,
  NOT_EVIDENCE,
  independentReviewId,
  defaultReviewKey,
  buildIndependentReview,
  validateIndependentReviews,
  validateReviewSubmission,
  isRepositoryIdentity,
  readReviewSubmissionFromBlock,
  renderReviewSubmissionSection,
  resolveIndependentReviews,
  projectIndependentReviews,
  repositoryForRepoCode,
  reviewOwnerOf,
  resolveClaimedReviewScope,
  readClaimedReviewScope,
  isIdenticalIndependentReview,
  applyIndependentReview,
  applyIndependentReviewToRecord,
  readIndependentReviewsFromBlock,
  renderIndependentReviewSection,
  validateIndependentReviewRecord,
};
