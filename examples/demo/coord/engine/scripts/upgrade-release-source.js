"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PUBLIC_REPO = "https://github.com/Softsensor-org/concord";
const ENTERPRISE_REPO = "https://github.com/Softsensor-org/concord-enterprise";
const OFFICIAL_REPOS = Object.freeze({
  community: PUBLIC_REPO,
  enterprise: ENTERPRISE_REPO,
});

function parseGitHubRepo(value) {
  const match = String(value || "").trim().match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/#]+?)(?:\.git)?$/i
  );
  if (!match) throw new Error(`unsupported upgrade repository: ${value || "missing"}`);
  return `${match[1]}/${match[2]}`;
}

function validateSourceRepo(value, channel) {
  if (!Object.prototype.hasOwnProperty.call(OFFICIAL_REPOS, channel)) {
    throw new Error(`unsupported upgrade channel: ${channel || "missing"}`);
  }
  const expected = parseGitHubRepo(OFFICIAL_REPOS[channel]);
  const actual = parseGitHubRepo(value);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`untrusted ${channel} release repository: ${actual}; expected ${expected}`);
  }
  return actual;
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
  const lines = String(verboseEntries || "").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("release archive has no verbose listing");
  for (const line of lines) {
    const type = line[0];
    if (type === "l" || type === "h") {
      throw new Error("release archive links are not permitted");
    }
    if (type !== "-" && type !== "d") {
      throw new Error(`unsupported release archive entry type: ${type || "unknown"}`);
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

  function curl(args, token, stage) {
    const command = [
      "-fsSL",
      "-H", "Accept: application/vnd.github+json",
      "-H", "User-Agent: concord-upgrade",
    ];
    let config = null;
    if (token) {
      config = path.join(stage, `curl-${crypto.randomBytes(8).toString("hex")}.conf`);
      const sanitized = String(token).replace(/["\\\r\n]/g, "");
      fileSystem.writeFileSync(
        config,
        `header = "Authorization: Bearer ${sanitized}"\n`,
        { mode: 0o600, flag: "wx" }
      );
      command.push("--config", config);
    }
    command.push(...args);
    try {
      return run("curl", command, {
        encoding: args.includes("-o") ? undefined : "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      if (config) fileSystem.rmSync(config, { force: true });
    }
  }

  function resolveLatest({ repo, channel = "community", entitlement = "" }) {
    if (channel === "enterprise" && !String(entitlement).trim()) {
      throw new Error("enterprise upgrade requires CONCORD_ENTITLEMENT or --entitlement");
    }
    const slug = validateSourceRepo(repo, channel);
    const token = channel === "enterprise" ? entitlement : "";
    const stage = fileSystem.mkdtempSync(path.join(tmpRoot(), "concord-upgrade-"));
    try {
      const metadata = JSON.parse(curl([`https://api.github.com/repos/${slug}/commits/main`], token, stage));
      const commit = String(metadata.sha || "");
      if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("upgrade source returned an invalid commit SHA");

      const archive = path.join(stage, "release.tar.gz");
      const extract = path.join(stage, "extract");
      const tarOptions = {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      };
      fileSystem.mkdirSync(extract, { recursive: true });
      curl(["-o", archive, `https://api.github.com/repos/${slug}/tarball/${commit}`], token, stage);
      const archiveBytes = fileSystem.readFileSync(archive);
      const entries = validateArchiveEntries(run("tar", ["-tzf", archive], tarOptions));
      validateArchiveLinks(run("tar", ["-tvzf", archive], tarOptions));
      run("tar", ["-xzf", archive, "-C", extract, "--no-same-owner", "--no-same-permissions"], tarOptions);
      const roots = [...new Set(entries.map((entry) => entry.split("/")[0]).filter(Boolean))];
      if (roots.length !== 1) throw new Error("release archive must contain one root directory");
      const sourceRoot = path.join(extract, roots[0]);
      return {
        sourceRoot,
        ref: "refs/heads/main",
        sha: commit.toLowerCase(),
        archiveSha256: sha256(archiveBytes),
        cleanup: () => fileSystem.rmSync(stage, { recursive: true, force: true }),
      };
    } catch (error) {
      fileSystem.rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }

  return { resolveLatest };
};

module.exports.__internals = {
  OFFICIAL_REPOS,
  parseGitHubRepo,
  validateSourceRepo,
  validateArchiveEntries,
  validateArchiveLinks,
  sha256,
};
