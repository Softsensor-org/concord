"use strict";

// COORD-1027: journal-backed proposals for the closed adopter testPolicy target.
// The target adapter is injected so fixtures can exercise atomic apply/refusal
// without ever granting production authority through an environment variable.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveProjectConfigPath } = require("../../paths.js");

const TARGETS = Object.freeze({
  "project.testPolicy": Object.freeze({
    description: "the adopter testPolicy override (stageMap, stages, repoMaps, execution)",
  }),
});

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

// guard:test-policy-override
function assertTarget(target) {
  if (!Object.hasOwn(TARGETS, target)) {
    throw new Error(`config proposal target refused: ${String(target)}; allowed: ${Object.keys(TARGETS).join(", ")}`);
  }
}

// guard:test-policy-override
function assertOverrideShape(value) {
  if (value === null) return; // null means remove the optional adopter override.
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("testPolicy proposal must be a JSON object");
  const allowed = new Set(["stageMap", "stages", "repoMaps", "execution"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`testPolicy proposal refused unknown or engine-owned key(s): ${unknown.join(", ")}; allowed: ${[...allowed].join(", ")}`);
}

// guard:test-policy-override
function skipTrivia(source, start) {
  let index = start;
  for (;;) {
    while (/\s/.test(source[index] || "")) index += 1;
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return source.length;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("project.config.js refused: unterminated comment");
      index = end + 2;
    } else return index;
  }
}

// guard:test-policy-override
function skipString(source, start, quote) {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    if (escaped) escaped = false;
    else if (source[index] === "\\") escaped = true;
    else if (source[index] === quote) return index + 1;
  }
  throw new Error("project.config.js refused: unterminated string");
}

// guard:test-policy-override
function locateTestPolicyValue(source) {
  let index = skipTrivia(source, 0);
  if (!source.startsWith("module.exports", index)) throw new Error("project.config.js refused: expected a static module.exports object");
  index += "module.exports".length;
  index = skipTrivia(source, index);
  if (source[index] !== "=") throw new Error("project.config.js refused: computed module.exports assignment");
  index = skipTrivia(source, index + 1);
  if (source[index] !== "{") throw new Error("project.config.js refused: module.exports must be an object literal");
  const open = index;
  let depth = 1;
  for (index += 1; index < source.length; index += 1) {
    if (source.startsWith("//", index)) { index = skipTrivia(source, index); index -= 1; continue; }
    if (source.startsWith("/*", index)) { index = skipTrivia(source, index); index -= 1; continue; }
    const ch = source[index];
    if (ch === "\"" || ch === "'" || ch === "`") { index = skipString(source, index, ch) - 1; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) break;
  }
  if (depth !== 0) throw new Error("project.config.js refused: unterminated module.exports object");
  const close = index;
  index = skipTrivia(source, close + 1);
  if (source[index] === ";") index = skipTrivia(source, index + 1);
  if (index !== source.length) throw new Error("project.config.js refused: executable code after module.exports object");

  // guard:test-policy-override
  let propertyIndex = null;
  let propertyStart = null;
  let propertyEnd = null;
  let propertyHasComma = false;
  let propertyPreviousComma = null;
  let previousTopComma = null;
  let pos = open + 1;
  while (pos < close) {
    pos = skipTrivia(source, pos);
    if (pos >= close) break;
    if (source[pos] === ",") { previousTopComma = pos; pos += 1; continue; }
    if (source.startsWith("...", pos) || source[pos] === "[") throw new Error("project.config.js refused: spread or computed top-level keys make testPolicy ambiguous");
    let key;
    let keyStart = pos;
    if (source[pos] === "\"" || source[pos] === "'") {
      const endKey = skipString(source, pos, source[pos]);
      const raw = source.slice(pos, endKey);
      if (raw.includes("\\") && raw[0] === "'") throw new Error("project.config.js refused: escaped single-quoted top-level keys are unsupported");
      key = raw[0] === "\"" ? JSON.parse(raw) : raw.slice(1, -1).replace(/\\'/g, "'");
      pos = endKey;
    } else {
      const keyMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(pos, close));
      if (!keyMatch) throw new Error(`project.config.js refused: unsupported top-level property syntax near ${JSON.stringify(source.slice(pos, close).slice(0, 32))}`);
      key = keyMatch[0];
      pos += key.length;
    }
    pos = skipTrivia(source, pos);
    if (source[pos] !== ":") {
      if (key === "testPolicy") throw new Error("project.config.js refused: testPolicy must be a direct static property");
      throw new Error("project.config.js refused: getter, shorthand or method top-level properties are unsupported");
    }
    if (key === "__proto__") throw new Error("project.config.js refused: __proto__ top-level property is unsupported");
    const valueStart = pos + 1;
    let valueDepth = 0;
    let end = valueStart;
    for (; end < close; end += 1) {
      if (source.startsWith("//", end)) { end = skipTrivia(source, end) - 1; continue; }
      if (source.startsWith("/*", end)) { end = skipTrivia(source, end) - 1; continue; }
      const c = source[end];
      if (c === "\"" || c === "'" || c === "`") { end = skipString(source, end, c) - 1; continue; }
      if ("{[(".includes(c)) valueDepth += 1;
      else if ("}])".includes(c)) {
        if (valueDepth === 0) break;
        valueDepth -= 1;
      } else if (c === "," && valueDepth === 0) break;
    }
    if (key === "testPolicy") {
      if (propertyIndex !== null) throw new Error("project.config.js refused: duplicate testPolicy properties are ambiguous");
      propertyIndex = keyStart;
      propertyStart = valueStart;
      propertyEnd = end;
      propertyHasComma = source[end] === ",";
      propertyPreviousComma = previousTopComma;
    }
    if (source[end] === ",") previousTopComma = end;
    pos = source[end] === "," ? end + 1 : end;
  }
  return { open, close, exists: propertyIndex !== null, keyStart: propertyIndex, start: propertyStart, end: propertyEnd, hasComma: propertyHasComma, previousComma: propertyPreviousComma };
}

// guard:test-policy-override
function readStaticTestPolicy(source) {
  const found = locateTestPolicyValue(source);
  if (!found.exists) return null;
  const raw = source.slice(found.start, found.end).trim().replace(/,$/, "").trim();
  try {
    const value = JSON.parse(raw);
    if (value === null) throw new Error("explicit null testPolicy values are unsupported; remove the property instead");
    assertOverrideShape(value);
    return value;
  } catch (error) {
    throw new Error(`project.config.js refused: testPolicy must be a static JSON-compatible object (${error.message})`);
  }
}

function renderTestPolicy(source, value) {
  const found = locateTestPolicyValue(source);
  if (value === null) {
    if (!found.exists) return source;
    readStaticTestPolicy(source);
    if (found.hasComma) return `${source.slice(0, found.keyStart)}${source.slice(found.end + 1)}`;
    return found.previousComma !== null ? `${source.slice(0, found.previousComma)}${source.slice(found.end)}` : `${source.slice(0, found.keyStart)}${source.slice(found.end)}`;
  }
  assertOverrideShape(value);
  const encoded = JSON.stringify(value, null, 2).replace(/^/gm, "  ");
  if (!found.exists) return `${source.slice(0, found.open + 1)}\n  testPolicy: ${encoded},${source.slice(found.open + 1)}`;
  // Never rewrite a computed/spread/function value. Only JSON-compatible static
  // object literals are accepted as the current value of this target.
  readStaticTestPolicy(source);
  return `${source.slice(0, found.start)} ${encoded}${source.slice(found.end)}`;
}

function createConfigProposals(deps) {
  for (const key of ["readTarget", "renderTarget", "diff", "validateTarget", "writeTarget", "readEvents", "appendEvent", "withMutation", "authorizeHumanAdmin", "now", "newId"]) {
    if (!deps || typeof deps[key] !== "function") throw new TypeError(`createConfigProposals: deps.${key} must be a function`);
  }

  // guard:test-policy-override
  function propose({ target, proposed, baseDigest, actor = {} }) {
    const outcome = deps.withMutation({ command: "config-propose", ticket: null }, () => {
      try {
        assertTarget(target);
        assertOverrideShape(proposed);
        const current = deps.readTarget(target);
        const actualBaseDigest = digest(current.source);
        if (baseDigest && baseDigest !== actualBaseDigest) throw new Error(`stale config proposal: base digest ${baseDigest} does not match current ${actualBaseDigest}; re-propose`);
        const errors = deps.validateTarget(target, proposed);
        if (errors?.length) throw new Error(`config proposal refused: ${errors.join("; ")}`);
        const result = deps.renderTarget(target, current.source, proposed);
        const proposal = {
          proposal_id: deps.newId(), target, base_digest: actualBaseDigest,
          result_digest: digest(result), before_present: current.value !== null,
          before_value: current.value, proposed_value: proposed,
          diff: deps.diff(current.source, result),
          proposer: actor.handle || null, proposer_session: actor.session_id || null,
          created_at: deps.now(), state: "pending",
        };
        deps.appendEvent({ ts: proposal.created_at, command: "config-propose", result: "proposed", type: "config.proposed", ...proposal });
        return { proposal_id: proposal.proposal_id, target, base_digest: actualBaseDigest,
          diff: proposal.diff, refusal: null };
      } catch (error) {
        const refusal = error?.message || String(error);
        deps.appendEvent({ ts: deps.now(), command: "config-propose", result: "refused", type: "config.proposal_refused",
          target: String(target), proposer: actor.handle || null, proposer_session: actor.session_id || null, refusal });
        return { refusal };
      }
    });
    if (outcome?.refusal) throw new Error(outcome.refusal);
    return outcome;
  }

  // guard:test-policy-override
  function approve({ proposalId, reason, actor }) {
    const outcome = deps.withMutation({ command: "config-approve", ticket: null }, () => {
      let target = null;
      let resultDigest = null;
      try {
        if (typeof reason !== "string" || !reason.trim()) throw new Error("config approve requires a nonblank human-admin reason");
        const events = deps.readEvents();
        const proposal = events.find((event) => event.type === "config.proposed" && event.proposal_id === proposalId);
        if (!proposal) throw new Error(`unknown config proposal: ${proposalId}`);
        target = proposal.target;
        resultDigest = proposal.result_digest;
        if (events.some((event) => event.type === "config.applied" && event.proposal_id === proposalId)) {
          throw new Error(`config proposal ${proposalId} is already applied; only pending proposals can be applied`);
        }
        assertTarget(proposal.target);
        const current = deps.readTarget(proposal.target);
        if (digest(current.source) !== proposal.base_digest) throw new Error(`stale config proposal ${proposalId}: target changed; re-propose against the current version`);
        const errors = deps.validateTarget(proposal.target, proposal.proposed_value);
        if (errors?.length) throw new Error(`config proposal refused at apply: ${errors.join("; ")}`);
        const next = deps.renderTarget(proposal.target, current.source, proposal.proposed_value);
        if (digest(next) !== proposal.result_digest) throw new Error(`config proposal ${proposalId} result digest mismatch`);
        // Approval authority is bound to the proposal's immutable identity and
        // exact target/result, not merely to the generic config-approve verb.
        const authority = deps.authorizeHumanAdmin({ proposalId, target: proposal.target, resultDigest: proposal.result_digest,
          baseDigest: proposal.base_digest, reason, actor });
        if (!authority || authority.ok !== true || authority.mode !== "signed") {
          throw new Error("config approve requires a signed human-admin approval bound to this proposal");
        }
        // The runtime lock serializes gov writers; an editor that ignores the
        // lock can still change the source during a human authorization pause.
        const authorizedSource = deps.readTarget(proposal.target);
        if (digest(authorizedSource.source) !== proposal.base_digest) {
          throw new Error(`stale config proposal ${proposalId}: target changed during approval; re-propose against the current version`);
        }
        deps.writeTarget(proposal.target, next);
        try {
          deps.appendEvent({ ts: deps.now(), command: "config-approve", result: "applied", type: "config.applied", proposal_id: proposalId, target: proposal.target,
            base_digest: proposal.base_digest, result_digest: proposal.result_digest,
            approver: authority.session_id, approver_session: authority.session_id, approval_record: authority.record_id,
            reason: reason.trim(), at: deps.now(),
            changed_paths: ["coord/project.config.js"] });
        } catch (error) {
          deps.writeTarget(proposal.target, current.source);
          throw new Error(`config apply journal append failed; target restored: ${error.message}`);
        }
        return { proposal_id: proposalId, target: proposal.target, diff: deps.diff(current.source, next), refusal: null };
      } catch (error) {
        const refusal = error?.message || String(error);
        deps.appendEvent({ ts: deps.now(), command: "config-approve", result: "refused", type: "config.apply_refused",
          proposal_id: proposalId || null, target, result_digest: resultDigest,
          approver: actor?.handle || null, approver_session: actor?.session_id || null, refusal });
        return { refusal };
      }
    });
    if (outcome?.refusal) throw new Error(outcome.refusal);
    return outcome;
  }

  function rollback({ proposalId, actor }) {
    const events = deps.readEvents();
    const applied = events.find((event) => event.type === "config.applied" && event.proposal_id === proposalId);
    if (!applied) throw new Error(`config rollback requires an applied proposal: ${proposalId}`);
    const proposal = events.find((event) => event.type === "config.proposed" && event.proposal_id === proposalId);
    const current = deps.readTarget(proposal.target);
    const restoredValue = proposal.before_present ? proposal.before_value : null;
    return propose({ target: proposal.target, proposed: restoredValue, baseDigest: digest(current.source), actor });
  }

  return Object.freeze({ propose, approve, rollback });
}

function createConfigProposalCommand({ coordDir, rootDir, lifecycle, ensureCurrentAgentIdentity, fail, approvalClient = null }) {
  if (!coordDir || !rootDir || !lifecycle || typeof ensureCurrentAgentIdentity !== "function" || typeof fail !== "function") {
    throw new TypeError("createConfigProposalCommand requires resolved workspace paths, lifecycle services and fail");
  }
  const configPath = resolveProjectConfigPath(coordDir);
  const policyCore = require("./test-policy.js");
  const service = createConfigProposals({
    readTarget: (target) => {
      assertTarget(target);
      const source = fs.readFileSync(configPath, "utf8");
      const value = readStaticTestPolicy(source);
      return { source, value };
    },
    renderTarget: (_target, source, value) => renderTestPolicy(source, value),
    diff: (before, after) => ({ target: "project.testPolicy", before: readStaticTestPolicy(before), after: readStaticTestPolicy(after) }),
    validateTarget: (_target, value) => {
      const loaded = policyCore.loadProjectConfig(rootDir);
      if (loaded.error) return [`project.config.js could not be validated: ${loaded.error}`];
      return policyCore.validateOverride(value, policyCore.loadEngineDefaults(), loaded.config.repos || {});
    },
    writeTarget: (_target, source) => lifecycle.__testing.writeFileAtomicSync(configPath, source),
    readEvents: () => lifecycle.__testing.readGovernanceEventLog(),
    appendEvent: (event) => lifecycle.__testing.appendGovernanceEvent({
      identity: ensureCurrentAgentIdentity({ readOnly: true }).agent,
      before_status: null, after_status: null, details: {}, changed_paths: [], ...event,
    }),
    withMutation: (metadata, operation) => lifecycle.__testing.withGovernanceMutation(metadata, operation),
    // The corrected COORD-1034 verifier is intentionally a required injection;
    // no reason string, environment variable or UI role can grant authority.
    authorizeHumanAdmin: ({ proposalId, target, resultDigest, baseDigest, reason, actor }) => {
      let verifier;
      try { verifier = require("./approval-verifier.js"); }
      catch { throw new Error("config approve unavailable: trusted COORD-1034 approval verifier is not installed"); }
      if (typeof verifier.requireHumanAdminApproval !== "function" || typeof verifier.subjectSha256 !== "function" || typeof verifier.canonicalJson !== "function" || typeof verifier.journalRecordUsed !== "function") {
        throw new Error("config approve unavailable: trusted COORD-1034 approval verifier is not installed");
      }
      const verb = "config approve";
      const ticket = proposalId;
      const state = verifier.canonicalJson({ proposal_id: proposalId, target, base_digest: baseDigest, result_digest: resultDigest });
      const subjectDigest = verifier.subjectSha256({ verb, ticket, reason, state });
      const verdict = verifier.requireHumanAdminApproval({ verb, ticket, subjectDigest, reason,
        journal: (event) => lifecycle.__testing.appendGovernanceEvent({ ts: new Date().toISOString(), ...event }),
        recordUsed: verifier.journalRecordUsed(path.join(require("./governance-context.js").state.RUNTIME_DIR, "governance-events.ndjson")),
        anchor: approvalClient?.anchor, runSign: approvalClient?.runSign,
      });
      if (!verdict.ok || verdict.mode !== "signed") throw new Error(verdict.message || "config approve requires a signed human-admin approval");
      return { ok: true, mode: "signed", session_id: verdict.session_id, record_id: verdict.record_id };
    },
    now: () => new Date().toISOString(),
    newId: () => require("node:crypto").randomUUID(),
  });

  return function configProposalCommand(args) {
    const [subcommand, ...rest] = args;
    const options = parseConfigProposalArgs(rest, subcommand, fail);
    const identity = ensureCurrentAgentIdentity({ readOnly: true });
    const actor = { handle: identity.agent.handle, session_id: identity.session.session_id };
    let result;
    if (subcommand === "propose") result = service.propose({ target: options.target || "project.testPolicy", proposed: options.value, baseDigest: options.baseDigest, actor });
    else if (subcommand === "approve") result = service.approve({ proposalId: options.proposalId, reason: options.reason, actor });
    else fail("config requires one of: propose or approve.");
    console.log(JSON.stringify(result, null, 2));
    return result;
  };
}

function parseConfigProposalArgs(args, subcommand, fail) {
  const result = {};
  const flags = new Set(["--target", "--value-json", "--diff-file", "--base-digest", "--proposal-id", "--human-admin-override"]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--") && !result.proposalId) { result.proposalId = flag; continue; }
    if (!flags.has(flag)) fail(`config: unsupported option ${flag}`);
    const key = ({ "--target": "target", "--value-json": "valueText", "--diff-file": "diffFile", "--base-digest": "baseDigest", "--proposal-id": "proposalId", "--human-admin-override": "reason" })[flag];
    if (Object.hasOwn(result, key)) fail(`config: repeated option ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`config: ${flag} requires a value`);
    result[key] = value;
    index += 1;
  }
  if (result.valueText !== undefined) {
    try { result.value = JSON.parse(result.valueText); }
    catch { fail("config propose --value-json must contain valid JSON"); }
    delete result.valueText;
  }
  if (result.diffFile !== undefined) {
    if (result.value !== undefined) fail("config propose accepts only one of --value-json or --diff-file");
    try { result.value = JSON.parse(fs.readFileSync(path.resolve(result.diffFile), "utf8")); }
    catch (error) { fail(`config propose --diff-file must contain valid JSON: ${error.message}`); }
    delete result.diffFile;
  }
  if (subcommand === "propose" && result.value === undefined) fail("config propose requires --diff-file or --value-json");
  if (subcommand === "approve" && !result.proposalId) fail(`config ${subcommand} requires a proposal id`);
  return result;
}

module.exports = { TARGETS, assertTarget, assertOverrideShape, canonical, digest, locateTestPolicyValue, readStaticTestPolicy, renderTestPolicy, createConfigProposals, createConfigProposalCommand, parseConfigProposalArgs };
