"use strict";

const crypto = require("crypto");

const HASH_ALG_SHA1 = "sha1";
const HASH_ALG_SHA256 = "sha256";
const CHAIN_MIGRATION_COMMAND = "hash-alg-migration";
const CHAIN_VERIFIER_VERSION = "coord-289-sha256-v1";
const CHAIN_ANCHOR_COMMAND = "chain-anchor";
const CHAIN_GENESIS_PREV = "genesis";

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashWithAlg(value, alg) {
  return alg === HASH_ALG_SHA256 ? sha256(value) : sha1(value);
}

function eventHashAlg(record) {
  return (record && record.hash_alg) || HASH_ALG_SHA1;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function canonicalEventSerialization(record) {
  return stableStringify(record);
}

function hashGovernanceEventRecord(record) {
  return hashWithAlg(canonicalEventSerialization(record), eventHashAlg(record));
}

function hashGovernanceEventContent(record) {
  const { prev_event_hash, ...content } = record || {};
  return hashWithAlg(stableStringify(content), eventHashAlg(record));
}

function hashGovernanceEventLine(line) {
  return sha1(String(line));
}

function isChainedEvent(record) {
  return Boolean(record) && typeof record.prev_event_hash === "string" && record.prev_event_hash.length > 0;
}

function buildChainAnchorEvent(reason, extraDetails = {}) {
  return {
    ts: new Date().toISOString(),
    command: CHAIN_ANCHOR_COMMAND,
    ticket: null,
    before_status: null,
    after_status: null,
    identity: null,
    result: "anchored",
    details: { reason, ...extraDetails },
    changed_paths: [],
    prev_event_hash: CHAIN_GENESIS_PREV,
  };
}

function verifyGovernanceChain(events = [], options = {}) {
  const includeAccepted = options.includeAccepted !== false;
  const accepted = [];
  const broken = [];
  let chainStarted = false;
  let head = null;
  let headAlg = HASH_ALG_SHA1;
  let chained = 0;

  for (let index = 0; index < events.length; index += 1) {
    const record = events[index] || {};
    if (!isChainedEvent(record)) {
      if (!chainStarted && includeAccepted) {
        accepted.push({ index, id: record.id || null, command: record.command || null, reason: "pre-chain" });
      } else if (chainStarted) {
        broken.push({ index, id: record.id || null, command: record.command || null, reason: "missing-prev-hash" });
      }
      continue;
    }

    const linkAlg = record.command === CHAIN_MIGRATION_COMMAND ? HASH_ALG_SHA1 : eventHashAlg(record);
    const expectedPrev = chainStarted
      ? hashWithAlg(canonicalEventSerialization(events[index - 1]), linkAlg)
      : CHAIN_GENESIS_PREV;

    if (!chainStarted && record.prev_event_hash !== CHAIN_GENESIS_PREV) {
      broken.push({
        index,
        id: record.id || null,
        command: record.command || null,
        reason: "bad-genesis",
        expected: CHAIN_GENESIS_PREV,
        actual: record.prev_event_hash,
      });
    } else if (chainStarted && record.prev_event_hash !== expectedPrev) {
      broken.push({
        index,
        id: record.id || null,
        command: record.command || null,
        reason: "prev-hash-mismatch",
        expected: expectedPrev,
        actual: record.prev_event_hash,
      });
    }

    if (record.command === CHAIN_MIGRATION_COMMAND) {
      const priorSha1Head = index > 0
        ? hashWithAlg(canonicalEventSerialization(events[index - 1]), HASH_ALG_SHA1)
        : CHAIN_GENESIS_PREV;
      const details = record.details || {};
      if (details.sha1_chain_head && details.sha1_chain_head !== priorSha1Head) {
        broken.push({
          index,
          id: record.id || null,
          command: record.command || null,
          reason: "migration-sha1-head-mismatch",
          expected: priorSha1Head,
          actual: details.sha1_chain_head,
        });
      }
      if (record.hash_alg !== HASH_ALG_SHA256) {
        broken.push({
          index,
          id: record.id || null,
          command: record.command || null,
          reason: "migration-missing-sha256-alg",
          expected: HASH_ALG_SHA256,
          actual: record.hash_alg || null,
        });
      }
    }

    chainStarted = true;
    chained += 1;
    headAlg = eventHashAlg(record);
    head = hashWithAlg(canonicalEventSerialization(record), headAlg);
  }

  return {
    ok: broken.length === 0,
    total: events.length,
    chained,
    accepted,
    broken,
    head,
    head_alg: head ? headAlg : null,
  };
}

module.exports = {
  HASH_ALG_SHA1,
  HASH_ALG_SHA256,
  CHAIN_MIGRATION_COMMAND,
  CHAIN_VERIFIER_VERSION,
  CHAIN_ANCHOR_COMMAND,
  CHAIN_GENESIS_PREV,
  sha1,
  sha256,
  hashWithAlg,
  eventHashAlg,
  stableStringify,
  canonicalEventSerialization,
  hashGovernanceEventRecord,
  hashGovernanceEventContent,
  hashGovernanceEventLine,
  isChainedEvent,
  buildChainAnchorEvent,
  verifyGovernanceChain,
};
