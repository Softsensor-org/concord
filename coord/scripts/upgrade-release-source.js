"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function parseGitHubRepo(value) {
  const match = String(value || "").trim().match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`unsupported upgrade repository: ${value || "missing"}`);
  return `${match[1]}/${match[2]}`;
}

function validateArchiveEntries(entries) {
  const names = String(entries || "").split(/\r?\n/).filter(Boolean);
  if (names.length === 0) throw new Error("release archive is empty");
  for (const name of names) {
    if (name.startsWith("/") || name.split("/").some((part) => part === "..")) {
      throw new Error(`unsafe release archive path: ${name}`);
    }
  }
  return names;
}

function validateArchiveLinks(verboseEntries) {
  for (const line of String(verboseEntries || "").split(/\r?\n/).filter((value) => /^[lh]/.test(value))) {
    const match = line.match(/\s(\S+)\s(?:->|link to)\s(.+)$/);
    if (!match) throw new Error("release archive contains an unparseable link entry");
    const [source, target] = match.slice(1);
    if (target.startsWith("/")) throw new Error(`release archive link escapes its root: ${source}`);
    const root = source.split("/")[0];
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new Error(`release archive link escapes its root: ${source}`);
    }
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = function createUpgradeReleaseSource(deps = {}) {
  const run = deps.execFileSync || execFileSync;
  const fileSystem = deps.fs || fs;
  const tmpRoot = deps.tmpdir || os.tmpdir;

  function curl(args, token) {
    const headers = ["Accept: application/vnd.github+json", "User-Agent: concord-upgrade"];
    if (token) headers.push(`Authorization: Bearer ${token}`);
    const command = ["-fsSL", ...headers.flatMap((header) => ["-H", header]), ...args];
    return run("curl", command, { encoding: args.includes("-o") ? undefined : "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  function resolveLatest({ repo, channel = "community", entitlement = "" }) {
    if (channel === "enterprise" && !String(entitlement).trim()) {
      throw new Error("enterprise upgrade requires CONCORD_ENTITLEMENT or --entitlement");
    }
    const slug = parseGitHubRepo(repo);
    const token = channel === "enterprise" ? entitlement : "";
    const metadata = JSON.parse(curl([`https://api.github.com/repos/${slug}/commits/main`], token));
    const commit = String(metadata.sha || "");
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("upgrade source returned an invalid commit SHA");

    const stage = fileSystem.mkdtempSync(path.join(tmpRoot(), "concord-upgrade-"));
    const archive = path.join(stage, "release.tar.gz");
    const extract = path.join(stage, "extract");
    fileSystem.mkdirSync(extract, { recursive: true });
    curl(["-o", archive, `https://api.github.com/repos/${slug}/tarball/${commit}`], token);
    const archiveBytes = fileSystem.readFileSync(archive);
    const entries = validateArchiveEntries(run("tar", ["-tzf", archive], { encoding: "utf8" }));
    const verbose = String(run("tar", ["-tvzf", archive], { encoding: "utf8" }));
    validateArchiveLinks(verbose);
    run("tar", ["-xzf", archive, "-C", extract, "--no-same-owner", "--no-same-permissions"]);
    const roots = [...new Set(entries.map((entry) => entry.split("/")[0]).filter(Boolean))];
    if (roots.length !== 1) throw new Error("release archive must contain one root directory");
    const sourceRoot = path.join(extract, roots[0]);
    return {
      sourceRoot,
      ref: `refs/heads/main`,
      sha: commit.toLowerCase(),
      archiveSha256: sha256(archiveBytes),
      cleanup: () => fileSystem.rmSync(stage, { recursive: true, force: true }),
    };
  }

  return { resolveLatest };
};

module.exports.__internals = { parseGitHubRepo, validateArchiveEntries, validateArchiveLinks, sha256 };
