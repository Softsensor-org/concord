"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { qualificationContentDigest } = require("../../../cut-attestation.js");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
const { gitFixture } = require("../test-git-fixture.js");

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coord-release-gates-test-"));
  gitFixture(root, ["init", "-q", "."]);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  fs.mkdirSync(path.join(root, "coord/engine"), { recursive: true });
  fs.mkdirSync(path.join(root, "release"), { recursive: true });
  fs.writeFileSync(path.join(root, "coord/engine/test-policy.json"), "{}");
  fs.writeFileSync(path.join(root, "release/build-public-release.sh"), "# fixture builder\n");
  gitFixture(root, ["add", "."]);
  gitFixture(root, ["commit", "-q", "-m", "fixture"]);
  return { root, cache: path.join(root, "..", `${path.basename(root)}-cache`), cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(`${root}-cache`, { recursive: true, force: true }); } };
}

// A fake exec: the build step writes a fixture artifact (optionally with Enterprise paths) and the named
// steps return scripted results; anything else is recorded and passes. calls records every invocation.
function fakeExec(script = {}, { scanExec } = {}) {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const joined = args.join(" ");
    if (/build-public-release\.sh/.test(joined)) {
      const dir = args[1];
      const enterprise = args.includes("--enterprise");
      const qualify = args.find((arg) => arg.startsWith("--qualify-commit="));
      const donor = gitFixture(options.cwd, ["rev-parse", "HEAD"]);
      if (qualify && qualify !== `--qualify-commit=${donor}`) throw new Error("incorrect candidate requested");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, "coord"), { recursive: true });
      fs.writeFileSync(path.join(dir, "README.md"), "fixture cut\n");
      fs.writeFileSync(path.join(dir, ".gitignore"), "ignored-data/\n");
      fs.writeFileSync(path.join(dir, "coord", "RELEASE_PROVENANCE.json"), JSON.stringify({
        artifact: enterprise ? "softsensor-concord-enterprise" : "softsensor-concord",
        cut: enterprise ? "Enterprise" : "Community",
        donor_commit: donor,
        ...(qualify ? { donor_mode: "qualification" } : {}),
      }));
      if (enterprise) fs.mkdirSync(path.join(dir, "coord", "scripts", "enterprise"), { recursive: true });
      if (enterprise) fs.mkdirSync(path.join(dir, "coord", "engine", "scripts", "enterprise"), { recursive: true });
      if (script.leakEnterprise && !enterprise) fs.mkdirSync(path.join(dir, "coord", "engine", "scripts", "enterprise"), { recursive: true });
      if (script.donorRefLeak) fs.writeFileSync(path.join(dir, "coord", "leak.md"), `${["SERVICES", "PILOT"].join("_")}\n`);
      // A safe, shipped internal link is part of the cut digest and remains valid.
      fs.symlinkSync("../README.md", path.join(dir, "coord", "readme-link.md"));
      gitFixture(dir, ["init", "-q", "."]);
      gitFixture(dir, ["add", "."]);
      gitFixture(dir, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "cut fixture"]);
      const cutCommit = gitFixture(dir, ["rev-parse", "HEAD"]);
      const cutTree = gitFixture(dir, ["rev-parse", "HEAD^{tree}"]);
      const donorCommit = gitFixture(options.cwd, ["rev-parse", "HEAD"]);
      const donorTree = gitFixture(options.cwd, ["rev-parse", "HEAD^{tree}"]);
      const edition = enterprise ? "enterprise" : "community";
      const cut = enterprise ? "Enterprise" : "Community";
      const artifact = enterprise ? "softsensor-concord-enterprise" : "softsensor-concord";
      const attestation = {
        schema_version: 1,
        artifact,
        cut,
        cut_dir: dir,
        cut_commit: cutCommit,
        cut_tree_digest: cutTree,
        donor_commit: donorCommit,
        donor_edition: edition,
        donor_mode: "none",
        donor_tree_state: "clean",
        hygiene_gate: "pass",
        publishable: false,
        unpublishable_reasons: ["no donor branch named (--from-donor); not a release cut"],
      };
      if (qualify) {
        Object.assign(attestation, {
          schema_version: 2, purpose: "qualification", donor_mode: "qualification", donor_tag: null,
          source_tree: donorTree, cut_content_digest: qualificationContentDigest(dir),
          policy_sha256: sha256(path.join(options.cwd, "coord/engine/test-policy.json")),
          builder_sha256: sha256(path.join(options.cwd, "release/build-public-release.sh")),
          toolchain: { node: process.version, git: "fixture Git" },
          ...script.qualificationAttestation,
        });
      }
      if (script.donorBranch) {
        attestation.donor_mode = "donor-branch";
        attestation.donor_branch = script.donorBranch;
        attestation.publishable = true;
        attestation.unpublishable_reasons = [];
      }
      fs.writeFileSync(`${dir}.attestation.json`, JSON.stringify(attestation, null, 2));
      return script.build || { status: 0, output: "hygiene gate PASS\n" };
    }
    // npm steps: pack writes a tarball into the pack destination; install writes the create-concord bin.
    if (command === "npm" && args[0] === "pack") {
      fs.mkdirSync(args[2], { recursive: true });
      fs.writeFileSync(path.join(args[2], "create-concord-0.0.0.tgz"), "fixture\n");
      return { status: 0, output: "" };
    }
    if (command === "npm" && args[0] === "install") {
      fs.mkdirSync(path.join(args[args.indexOf("--prefix") + 1], "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(args[args.indexOf("--prefix") + 1], "node_modules", ".bin", "create-concord"), "fixture\n");
      return { status: 0, output: "" };
    }
    if (/build-linux-binary\.sh/.test(joined)) {
      const result = script["build-linux-binary.sh"] || { status: 0, output: "" };
      if (result.status === 0 && script.seaBinary) {
        fs.mkdirSync(args[1], { recursive: true });
        const name = `concord-qualification-linux-${os.machine()}`;
        const binary = path.join(args[1], name);
        fs.writeFileSync(binary, "fixture binary\n", { mode: 0o755 });
        const cut = JSON.parse(fs.readFileSync(`${args.at(-1)}.attestation.json`, "utf8"));
        fs.writeFileSync(`${binary}.qualification.json`, JSON.stringify({
          schema_version: 2, purpose: "qualification", publishable: false, binary: name,
          donor_commit: cut.donor_commit, cut_tree_digest: cut.cut_tree_digest,
          cut_content_digest: cut.cut_content_digest, sha256: sha256(binary), ...script.seaAttestation,
        }));
      }
      return result;
    }
    if (["create-concord", `concord-qualification-linux-${os.machine()}`].includes(path.basename(command))) {
      const digest = "a".repeat(64);
      if (args.at(-1) === "--dry-run") {
        return { status: 0, output: `${JSON.stringify({ digest })}\nReview then apply ${digest}\n` };
      }
      const coord = path.join(args.at(-3), "coord");
      if (args.at(-2) === "--apply-plan" && args.at(-1) === digest) {
        fs.mkdirSync(path.join(coord, "scripts"), { recursive: true });
        fs.writeFileSync(path.join(coord, "scripts", "governance.js"), "fixture install\n");
        fs.writeFileSync(path.join(coord, ".concord-install-receipt.json"), JSON.stringify({ plan_digest: digest }));
        return { status: 0, output: "" };
      }
      return { status: 1, output: "fixture installer expected the dry-run digest" };
    }
    const key = Object.keys(script).find((k) => joined.includes(k));
    if (key && key !== "build") return script[key];
    // Real scanner execution must be explicitly supplied by the donor integration suite.
    if (/scan-(donor-refs|secrets|enterprise-refs)\.sh/.test(joined)) {
      if (!scanExec) throw new Error(`unexpected scanner invocation: ${joined}`);
      return scanExec(command, args, options);
    }
    return { status: 0, output: "" };
  };
  exec.calls = calls;
  return exec;
}

module.exports = { fixtureRepo, fakeExec };
