"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createUpgradeReleaseSource = require("./upgrade-release-source.js");
const {
  parseGitHubRepo,
  validateSourceRepo,
  validateArchiveEntries,
  validateArchiveLinks,
  sha256,
} = createUpgradeReleaseSource.__internals;

test("GitHub repository pins normalize HTTPS and SSH forms", () => {
  assert.strictEqual(parseGitHubRepo("https://github.com/Softsensor-org/concord"), "Softsensor-org/concord");
  assert.strictEqual(parseGitHubRepo("git@github.com:Softsensor-org/concord.git"), "Softsensor-org/concord");
  assert.throws(() => parseGitHubRepo("https://example.com/repo"), /unsupported/);
  assert.throws(() => parseGitHubRepo("prefix-https://github.com/Softsensor-org/concord"), /unsupported/);
});

test("release repositories are allowlisted per channel", () => {
  assert.strictEqual(
    validateSourceRepo("https://github.com/softsensor-org/CONCORD.git", "community"),
    "softsensor-org/CONCORD"
  );
  assert.strictEqual(
    validateSourceRepo("git@github.com:Softsensor-org/concord-enterprise.git", "enterprise"),
    "Softsensor-org/concord-enterprise"
  );
  assert.throws(
    () => validateSourceRepo("https://github.com/attacker/concord", "community"),
    /untrusted community release repository/
  );
  assert.throws(
    () => validateSourceRepo("https://github.com/Softsensor-org/concord", "enterprise"),
    /untrusted enterprise release repository/
  );
});

test("release archive paths reject absolute and traversal entries", () => {
  assert.deepStrictEqual(validateArchiveEntries("root/coord/a\nroot/README.md\n"), ["root/coord/a", "root/README.md"]);
  assert.throws(() => validateArchiveEntries("/etc/passwd\n"), /unsafe/);
  assert.throws(() => validateArchiveEntries("root/../outside\n"), /unsafe/);
  assert.throws(() => validateArchiveEntries(""), /empty/);
});

test("release archives allow only regular files and directories", () => {
  assert.doesNotThrow(() => validateArchiveLinks("drwxr-xr-x root/root 0 date root/\n-rw-r--r-- root/root 4 date root/file\n"));
  assert.throws(() => validateArchiveLinks("lrwxrwxrwx root/root 0 date root/link -> file\n"), /links are not permitted/);
  assert.throws(() => validateArchiveLinks("hrw-r--r-- root/root 0 date root/hard link to root/file\n"), /links are not permitted/);
  assert.throws(() => validateArchiveLinks("prw-r--r-- root/root 0 date root/fifo\n"), /unsupported/);
  assert.throws(() => validateArchiveLinks(""), /no verbose listing/);
});

test("release byte digest is deterministic SHA-256", () => {
  assert.strictEqual(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

function withTempDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-505-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("enterprise resolver keeps entitlement out of argv, uses mode-0600 config, and cleans it", () => {
  withTempDir((tmp) => {
    const token = "ent-token-with-secret";
    let configPath = null;
    const seen = [];
    const run = (command, args) => {
      seen.push([command, [...args]]);
      if (command === "curl") {
        assert.ok(!args.join(" ").includes(token), "credential must not appear in process arguments");
        const configIndex = args.indexOf("--config");
        assert.notStrictEqual(configIndex, -1, "enterprise curl must use a config file");
        configPath = args[configIndex + 1];
        assert.strictEqual(fs.statSync(configPath).mode & 0o777, 0o600);
        assert.match(fs.readFileSync(configPath, "utf8"), /Authorization: Bearer ent-token-with-secret/);
        const outputIndex = args.indexOf("-o");
        if (outputIndex !== -1) {
          fs.writeFileSync(args[outputIndex + 1], "archive-bytes");
          return Buffer.alloc(0);
        }
        return JSON.stringify({ sha: "a".repeat(40) });
      }
      if (args[0] === "-tzf") return "root/\nroot/coord/file\n";
      if (args[0] === "-tvzf") return "drwxr-xr-x root/root 0 date root/\n-rw-r--r-- root/root 4 date root/coord/file\n";
      if (args[0] === "-xzf") return "";
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const resolver = createUpgradeReleaseSource({ execFileSync: run, tmpdir: () => tmp });
    const result = resolver.resolveLatest({
      repo: "https://github.com/Softsensor-org/concord-enterprise",
      channel: "enterprise",
      entitlement: token,
    });
    assert.strictEqual(result.sha, "a".repeat(40));
    assert.ok(configPath);
    assert.ok(!fs.existsSync(configPath), "credential config must be removed after curl");
    assert.ok(seen.length >= 5);
    const stage = path.dirname(path.dirname(result.sourceRoot));
    result.cleanup();
    assert.ok(!fs.existsSync(stage), "successful resolution cleanup must remove staging");
  });
});

test("resolver removes staging after archive validation failure", () => {
  withTempDir((tmp) => {
    const run = (command, args) => {
      if (command === "curl") {
        const outputIndex = args.indexOf("-o");
        if (outputIndex !== -1) {
          fs.writeFileSync(args[outputIndex + 1], "archive-bytes");
          return Buffer.alloc(0);
        }
        return JSON.stringify({ sha: "b".repeat(40) });
      }
      if (args[0] === "-tzf") return "root/link\n";
      if (args[0] === "-tvzf") return "lrwxrwxrwx root/root 0 date root/link -> file\n";
      throw new Error("extract must not run");
    };
    const resolver = createUpgradeReleaseSource({ execFileSync: run, tmpdir: () => tmp });
    assert.throws(
      () => resolver.resolveLatest({
        repo: "https://github.com/Softsensor-org/concord",
        channel: "community",
      }),
      /links are not permitted/
    );
    assert.deepStrictEqual(fs.readdirSync(tmp), [], "failed resolution must remove staging");
  });
});
