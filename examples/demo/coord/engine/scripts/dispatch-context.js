"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CONTEXT_MODES = Object.freeze(["open", "pack_only"]);
const CONTEXT_REQUEST_EVENT = "context.requested";
const DEFAULT_REQUEST_LIMIT = 20;
const MAX_REQUEST_LIMIT = 100;
const MAX_REQUEST_PATH_BYTES = 1024;
const MAX_REQUEST_REASON_BYTES = 512;
const DISPATCH_CACHE_PREFIX_VERSION = 1;
const DISPATCH_CACHE_PREFIX_DESCRIPTION =
  "Shared, cache-friendly preamble. Identical across tickets in a wave; place this in a prompt-cache prefix so N agents share one cached preamble instead of each re-paying discovery.";

function defaultFail(message) {
  throw new Error(message);
}

function normalizeContextMode(value, fail = defaultFail) {
  if (value === undefined) return "open";
  if (CONTEXT_MODES.includes(value)) return value;
  return fail(`context_mode must be one of ${CONTEXT_MODES.join("|")} (got ${JSON.stringify(value)}).`);
}

function resolveTierContextMode(tier, policy, fail = defaultFail) {
  const tierPolicy = policy && policy.tiers && policy.tiers[tier];
  if (!tierPolicy || typeof tierPolicy !== "object" || Array.isArray(tierPolicy)) {
    return fail(`Cannot resolve context_mode for unknown tier "${tier}".`);
  }
  return normalizeContextMode(tierPolicy.context_mode, fail);
}

function resolveDispatchCachePrefixReferences(references = [], rootDir) {
  if (!rootDir || typeof rootDir !== "string") {
    throw new TypeError("a project root is required to resolve shared context references");
  }
  const root = fs.realpathSync(path.resolve(rootDir));
  return [...references].sort().map((reference) => {
    if (typeof reference !== "string" || !reference || reference.includes("\\") ||
        path.posix.isAbsolute(reference) || reference.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new TypeError(`invalid shared context reference: ${String(reference)}`);
    }
    const absolute = path.resolve(root, reference);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new TypeError(`shared context reference escapes the project root: ${reference}`);
    }
    let current = root;
    const parts = relative.split(path.sep);
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) ||
          (index === parts.length - 1 && !stat.isFile())) {
        throw new TypeError(`shared context reference must use regular directories and end in a regular file: ${reference}`);
      }
    }
    const bytes = fs.readFileSync(absolute);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new TypeError(`shared context reference is not valid UTF-8: ${reference}`);
    }
    return {
      path: reference,
      content,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      byte_length: bytes.length,
    };
  });
}

// guard:dispatch-context-integrity
function assertResolvedReferences(sharedReferences, resolvedReferences) {
  if (!Array.isArray(resolvedReferences) || resolvedReferences.length !== sharedReferences.length ||
      resolvedReferences.some((entry, index) => {
        if (entry?.path !== sharedReferences[index] || typeof entry.content !== "string") return true;
        const bytes = Buffer.from(entry.content, "utf8");
        return entry.byte_length !== bytes.length ||
          entry.sha256 !== crypto.createHash("sha256").update(bytes).digest("hex");
      })) {
    throw new TypeError("resolved shared context bytes and digests must match every shared reference in sorted order");
  }
}

function buildDispatchCachePrefixMarker(references = [], resolvedReferences = []) {
  const sharedReferences = [...references].sort();
  assertResolvedReferences(sharedReferences, resolvedReferences);
  const marker = {
    version: DISPATCH_CACHE_PREFIX_VERSION,
    id: `coord-dispatch-stable-v${DISPATCH_CACHE_PREFIX_VERSION}`,
    description: DISPATCH_CACHE_PREFIX_DESCRIPTION,
    shared_references: sharedReferences,
    resolved_references: resolvedReferences.map((entry) => ({ ...entry })),
  };
  const prefix = renderDispatchCachePrefix(marker);
  const bytes = Buffer.from(prefix, "utf8");
  return {
    ...marker,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.length,
  };
}

function renderDispatchCachePrefix(marker = {}) {
  const refs = Array.isArray(marker.shared_references) ? marker.shared_references : [];
  const resolved = Array.isArray(marker.resolved_references) ? marker.resolved_references : [];
  assertResolvedReferences(refs, resolved);
  const lines = [
    "<!-- STABLE: shared cache-prefix; identical across tickets in a wave -->",
    "## Shared context (cacheable prefix)",
    String(marker.description || DISPATCH_CACHE_PREFIX_DESCRIPTION),
    "",
    "Shared references (resolved content follows):",
  ];
  let text = `${lines.join("\n")}\n`;
  for (const entry of resolved) {
    text += `\n### ${entry.path}\n\n${entry.content}`;
    if (!entry.content.endsWith("\n")) text += "\n";
  }
  return `${text}\n`;
}

function validateRequestedPath(value, fail = defaultFail) {
  if (typeof value !== "string" || value.length === 0 || !value.trim()) {
    return fail("--path requires a non-empty relative POSIX path.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_REQUEST_PATH_BYTES) {
    return fail(`--path exceeds the ${MAX_REQUEST_PATH_BYTES}-byte limit.`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return fail("--path must not contain control characters.");
  }
  if (value.includes("\\")) {
    // guard:dispatch-context-integrity
    return fail("--path must use relative POSIX separators; backslashes are refused.");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return fail("--path must be relative, not absolute.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return fail("--path must be one normalized relative path without empty, dot, or traversal segments.");
  }
  return value;
}

function validateRequestReason(value, fail = defaultFail) {
  if (typeof value !== "string") {
    return fail("--reason requires a non-empty explanation.");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return fail("--reason must not contain control characters.");
  }
  const reason = value.trim();
  if (!reason) return fail("--reason must not be blank.");
  if (Buffer.byteLength(reason, "utf8") > MAX_REQUEST_REASON_BYTES) {
    return fail(`--reason exceeds the ${MAX_REQUEST_REASON_BYTES}-byte limit.`);
  }
  return reason;
}

function parseValueFlags(args, definitions, fail = defaultFail) {
  const values = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const key = Object.hasOwn(definitions, flag) ? definitions[flag] : null;
    if (!key) {
      return fail(String(flag).startsWith("--")
        ? `Unknown flag "${flag}".`
        : `Unexpected positional argument "${flag}".`);
    }
    if (seen.has(flag)) return fail(`Duplicate flag "${flag}" is not allowed.`);
    const value = args[index + 1];
    if (value === undefined || value === "" || String(value).startsWith("--")) {
      return fail(`${flag} requires a value.`);
    }
    values[key] = value;
    seen.add(flag);
    index += 1;
  }
  return values;
}

function parseRequestContextArgs(args, fail = defaultFail) {
  const values = parseValueFlags(args, { "--path": "path", "--reason": "reason" }, fail);
  if (values.path === undefined) return fail("request-context requires --path <relative-path>.");
  if (values.reason === undefined) return fail("request-context requires --reason <text>.");
  return {
    path: validateRequestedPath(values.path, fail),
    reason: validateRequestReason(values.reason, fail),
  };
}

function parseContextRequestsArgs(args, fail = defaultFail) {
  const values = { ticket: null, limit: DEFAULT_REQUEST_LIMIT, json: false };
  const seen = new Set();
  let index = 0;
  if (args.length > 0 && !String(args[0]).startsWith("--")) {
    const ticket = args[0];
    if (typeof ticket !== "string" || !ticket.trim()) return fail("context-requests ticket id must not be blank.");
    values.ticket = ticket;
    index = 1;
  }
  for (; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--json") {
      if (seen.has(flag)) return fail(`Duplicate flag "${flag}" is not allowed.`);
      seen.add(flag);
      values.json = true;
      continue;
    }
    if (flag !== "--limit") {
      return fail(String(flag).startsWith("--")
        ? `Unknown flag "${flag}".`
        : `Unexpected positional argument "${flag}".`);
    }
    if (seen.has(flag)) return fail(`Duplicate flag "${flag}" is not allowed.`);
    const rawLimit = args[index + 1];
    if (rawLimit === undefined || !/^\d+$/.test(String(rawLimit))) {
      return fail("--limit requires a positive integer.");
    }
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REQUEST_LIMIT) {
      return fail(`--limit must be between 1 and ${MAX_REQUEST_LIMIT}.`);
    }
    values.limit = limit;
    seen.add(flag);
    index += 1;
  }
  return values;
}

function projectContextRequestEvent(event) {
  if (!event || event.command !== "request-context" || event.result !== "succeeded" ||
      event.details?.event_type !== CONTEXT_REQUEST_EVENT) {
    return null;
  }
  const request = event.details.context_request;
  const actor = event.identity;
  if (!request || typeof request.path !== "string" || typeof request.reason !== "string" ||
      !actor || typeof actor.owner !== "string" || !actor.owner) {
    return null;
  }
  return {
    ticket: event.ticket,
    requested_by: actor.owner,
    requested_agent_id: actor.agent_id || null,
    requested_at: event.ts || null,
    path: request.path,
    reason: request.reason,
  };
}

function createDispatchContext(deps = {}) {
  const fail = deps.fail || defaultFail;
  const {
    withGovernanceMutation,
    readBoard,
    getTicketRef,
    findLockForTicket,
    assertTicketMutationOwnership,
    readGovernanceEventLog,
  } = deps;

  function requestContext(ticketId, args = []) {
    const request = parseRequestContextArgs(args, fail);
    if (!ticketId || typeof ticketId !== "string" || ticketId.startsWith("--")) {
      fail("request-context requires <ticket-id>.");
    }
    const mutation = {
      command: "request-context",
      ticket: ticketId,
      forceLog: true,
      preserveAgentState: true,
    };
    const payload = withGovernanceMutation(mutation, () => {
      const board = readBoard();
      const ref = getTicketRef(board, ticketId);
      if (!ref) fail(`Unknown ticket "${ticketId}".`);
      const lock = findLockForTicket(ticketId);
      const identity = assertTicketMutationOwnership(ticketId, ref.row, lock, { readOnly: true });
      if (!identity?.agent?.handle || !identity?.agent?.id) {
        fail(`Ticket ${ticketId} context request requires a registered bound owner session.`);
      }
      mutation.beforeStatus = ref.row.Status || null;
      mutation.identity = identity;
      mutation.details = {
        event_type: CONTEXT_REQUEST_EVENT,
        context_request: { path: request.path, reason: request.reason },
      };
      const payload = {
        status: "requested",
        event_type: CONTEXT_REQUEST_EVENT,
        ticket: ticketId,
        requested_by: identity.agent.handle,
        path: request.path,
        reason: request.reason,
        access_granted: false,
      };
      return payload;
    });
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  function contextRequests(args = []) {
    const options = parseContextRequestsArgs(args, fail);
    if (options.ticket && !getTicketRef(readBoard(), options.ticket)) {
      fail(`Unknown ticket "${options.ticket}".`);
    }
    const requests = readGovernanceEventLog()
      .map(projectContextRequestEvent)
      .filter(Boolean)
      .filter((entry) => !options.ticket || entry.ticket === options.ticket)
      .slice(-options.limit)
      .reverse();
    const payload = {
      status: "listed",
      observation_only: true,
      limit: options.limit,
      count: requests.length,
      requests,
    };
    if (options.json) {
      console.log(JSON.stringify(payload));
    } else {
      console.log(`Context requests (${requests.length}; observations only, no access granted):`);
      for (const entry of requests) {
        console.log(`- ${entry.ticket} by ${entry.requested_by}: ${entry.path} — ${entry.reason}`);
      }
    }
    return payload;
  }

  return { requestContext, contextRequests };
}

module.exports = {
  CONTEXT_MODES,
  CONTEXT_REQUEST_EVENT,
  DISPATCH_CACHE_PREFIX_VERSION,
  DISPATCH_CACHE_PREFIX_DESCRIPTION,
  DEFAULT_REQUEST_LIMIT,
  MAX_REQUEST_LIMIT,
  MAX_REQUEST_PATH_BYTES,
  MAX_REQUEST_REASON_BYTES,
  normalizeContextMode,
  resolveTierContextMode,
  buildDispatchCachePrefixMarker,
  renderDispatchCachePrefix,
  resolveDispatchCachePrefixReferences,
  validateRequestedPath,
  validateRequestReason,
  parseRequestContextArgs,
  parseContextRequestsArgs,
  projectContextRequestEvent,
  createDispatchContext,
};
