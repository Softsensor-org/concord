#!/usr/bin/env node
"use strict";

// Publish one already-verified tarball without making retries dangerous. npm
// versions are immutable: an existing version is success only when its registry
// integrity is the sha512 of THESE bytes. A different tarball is a hard refusal.

const crypto = require("node:crypto");
const fs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");

const PUBLIC_REPOSITORY = "Softsensor-org/concord";
const RELEASE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function sha512Integrity(file) {
  return "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function packageIdentity(tarball, extract = execFileSync) {
  const raw = extract("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" });
  const pkg = JSON.parse(raw);
  const version = typeof pkg?.version === "string" && RELEASE_VERSION.exec(pkg.version);
  if (pkg?.name !== "create-concord" || !version ||
      version[1]?.split(".").some((identifier) => /^0[0-9]+$/.test(identifier))) {
    throw new Error("npm tarball must contain create-concord with a valid SemVer release version");
  }
  const prerelease = Boolean(version[1]);
  return { name: pkg.name, version: pkg.version, spec: `${pkg.name}@${pkg.version}`,
    repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
    prerelease, dist_tag: prerelease ? "rc" : "latest" };
}

function defaultNpm(args) {
  return spawnSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function lookupIntegrity(spec, npmRun) {
  const result = npmRun(["view", spec, "dist.integrity", "--json"]);
  if (result.status === 0) {
    let value;
    try { value = JSON.parse(result.stdout); } catch { value = String(result.stdout || "").trim(); }
    return { state: "present", integrity: value, result };
  }
  const detail = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/\bE404\b|\b404\b|not found/i.test(detail)) return { state: "absent", integrity: null, result };
  throw new Error(`npm registry lookup failed for ${spec}: ${detail.trim() || `exit ${result.status}`}`);
}

function assertPublicSource(repository, env) {
  const prefix = `https://github.com/${PUBLIC_REPOSITORY}`;
  if (repository !== prefix && repository !== `git+${prefix}.git` && repository !== `${prefix}.git`) {
    throw new Error("npm provenance requires the official public Concord source in package.json");
  }
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== PUBLIC_REPOSITORY) {
    throw new Error("fresh npm publication requires the public Concord GitHub Actions source");
  }
}

function assertPrereleaseIsNotLatest(identity, npmRun) {
  if (!identity.prerelease) return;
  const result = npmRun(["view", identity.name, "dist-tags", "--json"]);
  if (result.status !== 0) throw new Error("cannot verify npm dist-tags for the prerelease");
  const tags = JSON.parse(result.stdout);
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) throw new Error("invalid npm dist-tags");
  if (tags.latest === identity.version) throw new Error("the prerelease is already assigned npm latest");
}

function publishNpmPackage(tarball, options = {}) {
  const npmRun = options.npmRun || defaultNpm;
  const { repository, ...identity } = packageIdentity(tarball, options.extract);
  if (options.releaseTag !== undefined && options.releaseTag !== `v${identity.version}`) {
    throw new Error("the requested GitHub release tag differs from the npm tarball version");
  }
  const expectedIntegrity = sha512Integrity(tarball);
  const before = lookupIntegrity(identity.spec, npmRun);

  if (before.state === "present") {
    if (before.integrity !== expectedIntegrity) {
      throw new Error(
        `${identity.spec} already exists with different integrity; registry=${before.integrity} local=${expectedIntegrity}. ` +
        "npm versions are immutable, so refusing to overwrite or call this release complete."
      );
    }
    assertPrereleaseIsNotLatest(identity, npmRun);
    return { status: "already_present", attempted: false, acknowledged: true, ...identity, integrity: expectedIntegrity };
  }

  if (options.verifyExisting) throw new Error("the approved tarball has not been published by the public Concord workflow");
  assertPublicSource(repository, options.env || process.env);
  const published = npmRun(["publish", "--provenance", "--access", "public", "--tag", identity.dist_tag, tarball]);
  const after = lookupIntegrity(identity.spec, npmRun);
  if (after.state === "present" && after.integrity === expectedIntegrity) {
    assertPrereleaseIsNotLatest(identity, npmRun);
    return {
      status: "published",
      attempted: true,
      acknowledged: published.status === 0,
      ack_lost: published.status !== 0,
      ...identity,
      integrity: expectedIntegrity,
    };
  }
  const detail = `${published.stdout || ""}\n${published.stderr || ""}`.trim();
  throw new Error(
    `npm publish did not deliver ${identity.spec} with the expected integrity` +
    (detail ? `: ${detail}` : "")
  );
}

function main(argv) {
  const [tarball, releaseFlag, releaseTag, verifyFlag] = argv;
  if (!tarball || (argv.length !== 1 && !(
    (argv.length === 3 || (argv.length === 4 && verifyFlag === "--verify-existing")) && releaseFlag === "--release-tag" && releaseTag
  ))) {
    process.stderr.write("usage: publish-npm-package.js <verified-package.tgz> [--release-tag vVERSION [--verify-existing]]\n");
    return 2;
  }
  try {
    const receipt = publishNpmPackage(tarball, { releaseTag, verifyExisting: verifyFlag === "--verify-existing" });
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`npm publication blocked: ${String(error.message || error)}\n`);
    return 1;
  }
}

module.exports = { lookupIntegrity, packageIdentity, publishNpmPackage, sha512Integrity };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
