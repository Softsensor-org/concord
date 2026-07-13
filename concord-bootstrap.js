#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PUBLIC_REPO = "https://github.com/Softsensor-org/concord";
const ENTERPRISE_REPO = "https://github.com/Softsensor-org/concord-enterprise";
const PIN_REL = "coord/.coord-engine.json";
const OFFICIAL_REPOS = Object.freeze({ community: PUBLIC_REPO, enterprise: ENTERPRISE_REPO });

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function parseRepo(value) {
  const match = String(value || "").match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`unsupported GitHub repository: ${value || "missing"}`);
  return `${match[1]}/${match[2]}`;
}
function validateSourceRepo(value, channel) {
  const expected = parseRepo(OFFICIAL_REPOS[channel]);
  const actual = parseRepo(value);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`untrusted ${channel} release repository: ${actual}; expected ${expected}`);
  }
  return actual;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function detectInstalled(target) {
  const cli = path.join(target, "coord/scripts/coord-cli.js");
  const manifestFile = path.join(target, "coord/TEMPLATE_SYNC_MANIFEST.json");
  if (!fs.existsSync(cli) || !fs.existsSync(manifestFile)) throw new Error("target is not an installed Concord workspace");
  const pinFile = path.join(target, PIN_REL);
  const pin = fs.existsSync(pinFile) ? readJson(pinFile) : null;
  const enterprisePresent = fs.existsSync(path.join(target, "coord/scripts/enterprise"));
  const pinnedChannel = pin?.source?.channel || null;
  if (pinnedChannel && !["community", "enterprise"].includes(pinnedChannel)) throw new Error(`invalid pinned channel: ${pinnedChannel}`);
  if (pinnedChannel === "community" && enterprisePresent) throw new Error("installed edition is ambiguous: Community pin with Enterprise surface");
  if (pinnedChannel === "enterprise" && !enterprisePresent) throw new Error("installed edition is ambiguous: Enterprise pin without Enterprise surface");
  const channel = pinnedChannel || (enterprisePresent ? "enterprise" : "community");
  return {
    target,
    cli,
    channel,
    version: pin?.engine_version || readJson(manifestFile).manifest_version || "unknown",
    pin_status: pin ? "pinned" : "unpinned",
    repo: pin?.source?.repo || (channel === "enterprise" ? ENTERPRISE_REPO : PUBLIC_REPO),
  };
}

function validateEntries(raw) {
  const entries = String(raw || "").split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("release archive is empty");
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) throw new Error(`unsafe archive path: ${entry}`);
  }
  return entries;
}
function validateLinks(raw) {
  const lines = String(raw || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("release archive has no verbose listing");
  for (const line of lines) {
    const type = line[0];
    if (type === "l" || type === "h") throw new Error("release archive links are not permitted");
    if (type !== "-" && type !== "d") throw new Error(`unsupported archive entry type: ${type || "unknown"}`);
  }
}

function createResolver(deps = {}) {
  const run = deps.execFileSync || execFileSync;
  function curl(url, output, token, stage) {
    const args = ["-fsSL", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: concord-bootstrap"];
    let config = null;
    if (token) {
      config = path.join(stage, "curl.conf");
      fs.writeFileSync(config, `header = "Authorization: Bearer ${String(token).replace(/["\\\r\n]/g, "")}"\n`, { mode: 0o600 });
      args.push("--config", config);
    }
    if (output) args.push("-o", output);
    args.push(url);
    try { return run("curl", args, { encoding: output ? undefined : "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    finally { if (config) fs.rmSync(config, { force: true }); }
  }
  function resolve({ repo, channel, entitlement }) {
    if (channel === "enterprise" && !String(entitlement || "").trim()) throw new Error("Enterprise bootstrap requires --entitlement or CONCORD_ENTITLEMENT");
    const slug = validateSourceRepo(repo, channel);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "concord-bootstrap-"));
    const token = channel === "enterprise" ? entitlement : "";
    try {
      const meta = JSON.parse(curl(`https://api.github.com/repos/${slug}/commits/main`, null, token, stage));
      if (!/^[0-9a-f]{40}$/i.test(String(meta.sha || ""))) throw new Error("release source returned an invalid SHA");
      const sha = meta.sha.toLowerCase(), archive = path.join(stage, "release.tar.gz"), extract = path.join(stage, "extract");
      const tarOptions = { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } };
      fs.mkdirSync(extract);
      curl(`https://api.github.com/repos/${slug}/tarball/${sha}`, archive, token, stage);
      const entries = validateEntries(run("tar", ["-tzf", archive], tarOptions));
      validateLinks(run("tar", ["-tvzf", archive], tarOptions));
      run("tar", ["-xzf", archive, "-C", extract, "--no-same-owner", "--no-same-permissions"], tarOptions);
      const roots = [...new Set(entries.map((entry) => entry.split("/")[0]))];
      if (roots.length !== 1) throw new Error("release archive must have one root");
      return { source: path.join(extract, roots[0]), sha, archive_sha256: hash(fs.readFileSync(archive)), cleanup: () => fs.rmSync(stage, { recursive: true, force: true }) };
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }
  return { resolve };
}

function buildPlan(installed, resolved, channel) {
  const manifest = readJson(path.join(resolved.source, "coord/TEMPLATE_SYNC_MANIFEST.json"));
  const files = (manifest.items || []).filter((item) => item.match_policy !== "advisory").map((item) => {
    const targetFile = path.join(installed.target, item.path);
    return { path: item.path, before: fs.existsSync(targetFile) ? hash(fs.readFileSync(targetFile)) : null, after: item.checksum?.hex || null };
  });
  const subject = { schema: 1, channel, source_sha: resolved.sha, archive_sha256: resolved.archive_sha256, target_version: installed.version, pin_status: installed.pin_status, files };
  return { ...subject, digest: hash(stable(subject)) };
}

function runBootstrap(argv, deps = {}) {
  const opts = { target: ".", channel: null, entitlement: process.env.CONCORD_ENTITLEMENT || "", applyPlan: null, json: false };
  const args = [...argv];
  if (args[0] === "upgrade") args.shift();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") opts.target = args[++i];
    else if (args[i] === "--channel") opts.channel = args[++i];
    else if (args[i] === "--entitlement") opts.entitlement = args[++i];
    else if (args[i] === "--apply-plan") opts.applyPlan = args[++i];
    else if (args[i] === "--json") opts.json = true;
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  const target = path.resolve(opts.target), installed = detectInstalled(target);
  if (opts.channel && opts.channel !== installed.channel) throw new Error(`requested ${opts.channel} but installed edition is ${installed.channel}`);
  const channel = opts.channel || installed.channel;
  validateSourceRepo(installed.repo, channel);
  const resolver = deps.resolver || createResolver(deps);
  const resolved = resolver.resolve({ repo: installed.repo, channel, entitlement: opts.entitlement });
  try {
    const plan = buildPlan(installed, resolved, channel);
    const previewArgs = [installed.cli, "upgrade", "--from", resolved.source, "--channel", channel, "--ref", "refs/heads/main", "--sha", resolved.sha, "--dry-run"];
    const preview = (deps.execFileSync || execFileSync)(process.execPath, previewArgs, { cwd: target, encoding: "utf8" });
    if (!opts.applyPlan) return { code: 0, verdict: "plan", installed, source: { sha: resolved.sha, archive_sha256: resolved.archive_sha256 }, plan_digest: plan.digest, preview };
    if (opts.applyPlan !== plan.digest) throw new Error(`plan digest changed: expected ${opts.applyPlan}, current ${plan.digest}`);
    const applyArgs = previewArgs.slice(0, -1);
    const output = (deps.execFileSync || execFileSync)(process.execPath, applyArgs, { cwd: target, encoding: "utf8" });
    try {
      (deps.execFileSync || execFileSync)(process.execPath, [installed.cli, "upgrade", "--check"], { cwd: target, encoding: "utf8" });
    } catch (error) {
      throw new Error(`engine applied but independent post-apply verification failed; inspect the target before retrying: ${error.message}`);
    }
    const receiptDir = path.join(target, "coord/.runtime/upgrade-receipts");
    fs.mkdirSync(receiptDir, { recursive: true });
    const receipt = path.join(receiptDir, `bootstrap-${plan.digest}.json`);
    const receiptTemp = `${receipt}.tmp-${process.pid}`;
    fs.writeFileSync(receiptTemp, JSON.stringify({ schema: 1, plan_digest: plan.digest, source_sha: resolved.sha, channel, prior_version: installed.version, completed_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(receiptTemp, receipt);
    return { code: 0, verdict: "pass", plan_digest: plan.digest, source_sha: resolved.sha, output };
  } finally { resolved.cleanup(); }
}

if (require.main === module) {
  try {
    const result = runBootstrap(process.argv.slice(2));
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.verdict === "plan") process.stdout.write(`${result.preview}\nPlan digest: ${result.plan_digest}\nApply with: node concord-bootstrap.js upgrade --target ${result.installed.target} --apply-plan ${result.plan_digest}\n`);
    else process.stdout.write(`${result.output}\nBootstrap upgrade complete at ${result.source_sha}.\n`);
  } catch (error) {
    process.stderr.write(`concord-bootstrap: ${String(error.message || error).replace(/(token|secret|password|credential)=[^\s]+/gi, "$1=[REDACTED]")}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildPlan, createResolver, detectInstalled, parseRepo, runBootstrap, validateEntries, validateLinks, validateSourceRepo };
