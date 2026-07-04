"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_CONFIG: ARCH_DEFAULT_CONFIG, countLoc } = require("./arch-checks.js");

const DECOMPOSITION_REFACTOR_SIGNAL = /\b(?:slimm?ing|slimmed|decomposition|decomposed|decompose|extract(?:ed|ion|ing)?|pure composition[- ]root|composition[- ]root|countloc|logical[- ]loc|loc ratchet|ratchet budget|monolith)\b/i;
const DECOMPOSITION_PROOF_PREFIX = "decomposition-proof:";

function isMeaningfulText(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !/^todo\b/i.test(text);
}

function ticketClaimsDecompositionRefactor(row, planState) {
  if (String(row?.Type || "").trim().toLowerCase() !== "refactor") {
    return false;
  }
  const text = [
    row?.Description,
    ...(Array.isArray(planState?.change_summary) ? planState.change_summary : []),
    ...(Array.isArray(planState?.requirement_closure) ? planState.requirement_closure : []),
  ].join("\n");
  return DECOMPOSITION_REFACTOR_SIGNAL.test(text);
}

function collectDecompositionProofEntries(planState) {
  const cycleTexts = Array.isArray(planState?.self_review_cycles)
    ? planState.self_review_cycles.map((cycle) => cycle?.raw || cycle?.diff || cycle?.verification || "")
    : [];
  return [
    ...(Array.isArray(planState?.feature_proof) ? planState.feature_proof : []),
    ...(Array.isArray(planState?.repo_gates) ? planState.repo_gates : []),
    ...(Array.isArray(planState?.requirement_closure) ? planState.requirement_closure : []),
    ...cycleTexts,
  ]
    .map((entry) => String(entry || "").trim())
    .filter((entry) => entry.toLowerCase().includes(DECOMPOSITION_PROOF_PREFIX));
}

function parseDecompositionProofEntry(raw) {
  const lower = String(raw || "").toLowerCase();
  const marker = lower.indexOf(DECOMPOSITION_PROOF_PREFIX);
  if (marker < 0) {
    return null;
  }
  const body = String(raw).slice(marker + DECOMPOSITION_PROOF_PREFIX.length);
  const fields = {};
  for (const part of body.split(/[;|]/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(part);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase().replace(/-/g, "_");
    fields[key] = match[2].replace(/^`|`$/g, "").replace(/^"|"$/g, "").trim();
  }
  return { raw, fields };
}

function readIntegerProofField(fields, names) {
  for (const name of names) {
    const value = fields[name];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const parsed = Number.parseInt(String(value).replace(/^<=?/, "").trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeProofTargetPath(value) {
  const rel = String(value || "").trim().replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) {
    return null;
  }
  return rel;
}

function collectDecompositionProofIssues({ ticketId, row, planState, coordDir }) {
  if (!ticketClaimsDecompositionRefactor(row, planState)) {
    return [];
  }
  const proofEntries = collectDecompositionProofEntries(planState);
  if (proofEntries.length === 0) {
    return [{
      code: "decomposition_proof_missing",
      message: `Refactor ticket ${ticketId} claims slimming/decomposition work but has no computed decomposition-proof entry.`,
      next_steps: [
        `coord/scripts/gov update-plan ${ticketId} --feature-proof "decomposition-proof: file=<repo-relative target>; before=<countLoc before>; after=<countLoc after>; claimed_reduction=<before-after>; target_max=<max LOC>; budget=<ratchet LOC>; extracted=<functions moved or explicit rationale>"`,
      ],
      severity: "blocker",
    }];
  }

  const rootDir = path.dirname(coordDir);
  const issues = [];
  for (const raw of proofEntries) {
    const fields = parseDecompositionProofEntry(raw)?.fields || {};
    const file = normalizeProofTargetPath(fields.file || fields.path || fields.target);
    const before = readIntegerProofField(fields, ["before", "before_loc"]);
    const recordedAfter = readIntegerProofField(fields, ["after", "after_loc", "measured_after"]);
    const claimedReduction = readIntegerProofField(fields, ["claimed_reduction", "min_reduction", "reduction"]);
    const targetMax = readIntegerProofField(fields, ["target_max", "target", "max_loc"]);
    const recordedBudget = readIntegerProofField(fields, ["budget", "ratchet_budget", "prodloc_budget", "high_water"]);
    const extracted = fields.extracted || fields.moved || fields.functions || fields.rationale || "";
    const entryIssues = [];

    if (!file) entryIssues.push("file=<repo-relative target> is required");
    if (before === null) entryIssues.push("before=<countLoc before> is required");
    if (recordedAfter === null) entryIssues.push("after=<countLoc after> is required");
    if (claimedReduction === null) entryIssues.push("claimed_reduction=<before-after> is required");
    if (!isMeaningfulText(extracted)) entryIssues.push("extracted=<functions moved> or rationale=<explicit non-extraction rationale> is required");

    let actualAfter = null;
    if (file) {
      const abs = path.resolve(rootDir, file);
      if (!abs.startsWith(`${rootDir}${path.sep}`) && abs !== rootDir) {
        entryIssues.push(`file=${file} escapes the repository root`);
      } else if (!fs.existsSync(abs)) {
        entryIssues.push(`file=${file} does not exist for countLoc verification`);
      } else {
        actualAfter = countLoc(fs.readFileSync(abs, "utf8")).loc;
      }
    }

    if (actualAfter !== null && recordedAfter !== null && actualAfter !== recordedAfter) {
      entryIssues.push(`after=${recordedAfter} does not match computed countLoc=${actualAfter} for ${file}`);
    }
    if (before !== null && actualAfter !== null && before < actualAfter) {
      entryIssues.push(`before=${before} is lower than computed after=${actualAfter}; slimming delta cannot be positive`);
    }
    if (before !== null && actualAfter !== null && claimedReduction !== null) {
      const actualReduction = before - actualAfter;
      if (actualReduction < claimedReduction) {
        entryIssues.push(`computed reduction ${actualReduction} is lower than claimed_reduction=${claimedReduction}`);
      }
    }
    if (actualAfter !== null && targetMax !== null && actualAfter > targetMax) {
      entryIssues.push(`computed countLoc=${actualAfter} exceeds target_max=${targetMax}`);
    }

    const highWater = file ? ARCH_DEFAULT_CONFIG?.checks?.prodloc?.highWater?.[file] : null;
    if (actualAfter !== null && highWater !== undefined && highWater !== null && highWater !== actualAfter) {
      entryIssues.push(`prodloc highWater for ${file} is ${highWater}, not the computed after=${actualAfter}`);
    }
    if (actualAfter !== null && recordedBudget !== null && actualAfter > recordedBudget) {
      entryIssues.push(`computed countLoc=${actualAfter} exceeds recorded budget=${recordedBudget}`);
    }
    if (targetMax === null && recordedBudget === null && (highWater === undefined || highWater === null)) {
      entryIssues.push("target_max=<max LOC> or budget=<ratchet LOC> is required");
    }

    if (entryIssues.length > 0) {
      issues.push({
        code: "decomposition_proof_invalid",
        message: `Invalid decomposition-proof for ${ticketId}: ${entryIssues.join("; ")}.`,
        next_steps: [
          "Recompute the target with arch-checks countLoc and update the proof entry.",
          `coord/scripts/gov update-plan ${ticketId} --feature-proof "decomposition-proof: file=${file || "<repo-relative target>"}; before=<countLoc before>; after=<computed countLoc after>; claimed_reduction=<before-after>; target_max=<max LOC>; budget=<ratchet LOC>; extracted=<functions moved or explicit rationale>"`,
        ],
        severity: "blocker",
      });
    }
  }
  return issues;
}

module.exports = {
  collectDecompositionProofIssues,
};
