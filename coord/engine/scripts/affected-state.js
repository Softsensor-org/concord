"use strict";

// COORD-924: the affected-selection activation state and its per-category
// suspensions as GOVERNED, shared state. They live in the canonical board
// (tasks.json metadata.affected_selection), so every clone and session that
// reads the board sees the same state, and every change is one journaled
// governance mutation (`gov selection suspend|resolve|nightly`) recorded in
// the governance event log with the board snapshot.
//
//   metadata.affected_selection = {
//     state: "active" | "shadow",        // absent: the policy's initial_state
//     policy_version: <n>,                // the version the state was last set under
//     suspended_categories: { <category>: { since, reason, ref, policy_version } },
//     resolutions: [ { category, investigation, policy_version, at } ]
//   }
//
// A board that cannot be read reads as shadow: every gate is full.

const fs = require("node:fs");
const path = require("node:path");

const KEY = "affected_selection";
const ALL = "all";
const STATES = Object.freeze(["active", "shadow"]);

function boardSelectionState(board, policy) {
  if (!board || typeof board !== "object") return { state: "shadow", source: "board unreadable: full gates", suspended_categories: {} };
  const meta = board.metadata && board.metadata[KEY];
  if (!meta) return { state: policy.initial_state, source: `policy default (v${policy.policy_version})`, policy_version: policy.policy_version ?? null, suspended_categories: {} };
  if (meta.state !== undefined && !STATES.includes(meta.state)) return { state: "shadow", source: `unknown state ${meta.state}: full gates`, suspended_categories: {} };
  if (policy.initial_state === "shadow" && meta.state === "active") {
    return { state: "shadow", source: `policy default (v${policy.policy_version}) forces rollback`, policy_version: policy.policy_version ?? null,
      suspended_categories: { ...(meta.suspended_categories || {}) }, resolutions: [...(meta.resolutions || [])] };
  }
  if (Number.isFinite(meta.policy_version) && Number.isFinite(policy.policy_version) && meta.policy_version < policy.policy_version) {
    return { state: policy.initial_state, source: `policy v${policy.policy_version} supersedes board state v${meta.policy_version}`,
      policy_version: policy.policy_version, suspended_categories: { ...(meta.suspended_categories || {}) }, resolutions: [...(meta.resolutions || [])] };
  }
  return { state: meta.state || policy.initial_state, source: "governed board", policy_version: meta.policy_version ?? null,
    suspended_categories: { ...(meta.suspended_categories || {}) }, resolutions: [...(meta.resolutions || [])] };
}

function boardPathFor(root) { return path.join(root, "coord", "board", "tasks.json"); }

function readSelectionState({ root, boardPath = boardPathFor(root), policy }) {
  let board = null;
  try {
    board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
  } catch {
    board = null;
  }
  return boardSelectionState(board, policy);
}

function currentMeta(board, policy) {
  const meta = (board.metadata && board.metadata[KEY]) || {};
  return { state: meta.state || policy.initial_state, policy_version: meta.policy_version ?? policy.policy_version ?? null,
    suspended_categories: { ...(meta.suspended_categories || {}) }, resolutions: [...(meta.resolutions || [])] };
}

function withSuspension(meta, { categories, reason, ref, policyVersion, now }) {
  const names = categories && categories.length ? categories : [ALL];
  const suspended = { ...meta.suspended_categories };
  for (const name of names) suspended[name] = { since: now, reason, ref, policy_version: policyVersion ?? null };
  return { ...meta, suspended_categories: suspended };
}

// A suspension lifts only with an investigation record and a tightened
// (higher) policy version than the one that missed.
function withResolution(meta, { category, investigation, policyVersion, now }) {
  const held = meta.suspended_categories[category];
  // guard:affected-selection-activation
  if (!held) throw new Error(`refusing to resolve: change category ${category} is not suspended`);
  if (!investigation) throw new Error("refusing to resolve a suspension without --investigation <ref> recording what was found");
  if (!((policyVersion || 0) > (held.policy_version || 0))) throw new Error(`refusing to resolve ${category}: tighten the criteria first (policy version ${policyVersion || 0} is not newer than ${held.policy_version || 0}, the version that missed)`);
  const suspended = { ...meta.suspended_categories };
  delete suspended[category];
  return { ...meta, policy_version: policyVersion, suspended_categories: suspended,
    resolutions: [...meta.resolutions, { category, investigation, policy_version: policyVersion, at: now }] };
}

// `gov selection` parses its own arguments, so its options stay out of the
// shared flag table: --category (repeatable or comma-separated), --ref,
// --reason, --investigation, --full-report, --inventory, --base, --head.
const SELECTION_FLAGS = Object.freeze({ "--category": "category", "--ref": "ref", "--reason": "reason", "--investigation": "investigation",
  "--full-report": "fullReport", "--inventory": "inventory", "--base": "base", "--head": "head" });

function parseSelectionArgs(argv) {
  const options = { category: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = SELECTION_FLAGS[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`selection: unknown or valueless argument ${argv[i]}`);
    if (key === "category") options.category.push(argv[++i]);
    else options[key] = argv[++i];
  }
  return options;
}

function splitCategories(value) {
  return [].concat(value || []).flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
}

// `gov selection <state|suspend|resolve|nightly>`.
function createSelectionCommands(deps) {
  const { withBoardTransaction, writeBoard, fail, loadPolicy, root, now = () => new Date().toISOString() } = deps;
  // COORD-989: the comparison is injected by the composition root (cli.js). A lazy
  // require of affected-landing.js here closed a cycle with affected-landing.js.
  const { compareFullRun } = deps;
  const log = deps.log || ((line) => console.log(line));

  function mutate(command, details, change) {
    const policy = loadPolicy();
    return withBoardTransaction({ command: `selection-${command}`, ticket: null, details }, ({ board }) => {
      board.metadata[KEY] = change(currentMeta(board, policy), policy);
      writeBoard(board);
      return board.metadata[KEY];
    });
  }

  function suspend(options) {
    if (!options.ref) fail("selection suspend requires --ref <ticket or run> naming the missed regression.");
    const categories = splitCategories(options.category);
    const reason = options.reason || `missed regression ${options.ref}`;
    const meta = mutate("suspend", { categories: categories.length ? categories : [ALL], ref: options.ref, reason },
      (current, policy) => withSuspension(current, { categories, reason, ref: options.ref, policyVersion: policy.policy_version, now: now() }));
    log(`selection: suspended ${(categories.length ? categories : [ALL]).join(", ")} (${reason})`);
    return meta;
  }

  function resolve(options) {
    const [category] = splitCategories(options.category);
    if (!category) fail("selection resolve requires --category <change category>.");
    try {
      const meta = mutate("resolve", { category, investigation: options.investigation || null },
        (current, policy) => withResolution(current, { category, investigation: options.investigation, policyVersion: policy.policy_version, now: now() }));
      log(`selection: resolved ${category}`);
      return meta;
    } catch (e) {
      return fail(e.message);
    }
  }

  // The nightly / release-candidate comparison: misses suspend their categories
  // in the governed state, in the same journaled command.
  function nightly(options) {
    if (!options.fullReport) fail("selection nightly requires --full-report <authoritative full serial gate report>.");
    if (!options.base) fail("selection nightly requires --base <ref> (the integration base the head is compared with).");
    const fullReport = JSON.parse(fs.readFileSync(options.fullReport, "utf8"));
    const line = compareFullRun({ root, base: options.base, head: options.head || "HEAD", fullReport, inventoryFile: options.inventory || null });
    if (line.missed.length) suspend({ category: line.categories, ref: options.ref || `nightly ${line.at}`, reason: `nightly comparison missed: ${line.missed.join("; ")}` });
    log(`selection: nightly gate=${line.gate} failures=${line.full_failures.length} missed=${line.missed.length}`);
    return line;
  }

  function show() {
    const state = readSelectionState({ root, boardPath: deps.boardPath, policy: loadPolicy() });
    log(JSON.stringify(state, null, 2));
    return state;
  }

  const SUBCOMMANDS = { state: show, suspend, resolve, nightly };
  function selectionCommand(sub, argv = []) {
    const handler = SUBCOMMANDS[sub];
    if (!handler) return fail(`selection requires a subcommand: ${Object.keys(SUBCOMMANDS).join(" | ")}.`);
    let options;
    try {
      options = parseSelectionArgs(argv);
    } catch (e) {
      return fail(e.message);
    }
    return handler(options);
  }
  return { selectionCommand };
}

module.exports = {
  KEY, ALL, STATES, boardSelectionState, boardPathFor, readSelectionState, currentMeta, withSuspension, withResolution,
  SELECTION_FLAGS, parseSelectionArgs, splitCategories, createSelectionCommands,
};
