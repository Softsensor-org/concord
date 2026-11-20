"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveEngineModule } = require("../../paths.js");
const COORD_ROOT_DIR = path.resolve(__dirname, "..", "..");
const signing = require("./journal-signing.js");
const migration = require("./chain-migration-signing.js");
const { installCanonicalEngine } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/fixtures/coord-engine-schemas.js"));
const { publicKeyFingerprint } = require(resolveEngineModule(COORD_ROOT_DIR, "scripts/conformance-attestation.js")).__internals;
const { assessSignerTrust } = require("./journal-signature-trust.js");

function signer() {
  const key = crypto.generateKeyPairSync("ed25519");
  return { privateKey: key.privateKey, publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }) };
}
function signed(key) {
  const record = { command: "fixture", result: "succeeded", prev_event_hash: "genesis" };
  const events = [{ record, line: JSON.stringify(record) }];
  return { ...signing.buildSignedBatch({ events, keyProvider: signing.staticKeyProvider(key) }), events };
}

test("COORD-616 signer trust resolves environment and project configuration fail-closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-journal-trust-config-"));
  const priorAnchor = process.env.CONFORMANCE_TRUST_ANCHOR;
  const priorConfig = process.env.COORD_PROJECT_CONFIG;
  const good = signer();
  const fingerprint = publicKeyFingerprint(good.publicKeyPem);
  const assess = (coordDir = root) => assessSignerTrust(good.publicKeyPem, true, { coordDir });
  const writeConfig = (name, source) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, source);
    process.env.COORD_PROJECT_CONFIG = file;
    return file;
  };
  try {
    delete process.env.CONFORMANCE_TRUST_ANCHOR;
    delete process.env.COORD_PROJECT_CONFIG;

    assert.equal(assessSignerTrust(good.publicKeyPem, true).authenticity, "self-signed",
      "without a coordDir, optional project discovery is skipped");
    assert.equal(assess().authenticity, "self-signed",
      "a missing default project config is optional and does not create trust");

    fs.writeFileSync(path.join(root, "project.config.js"), "module.exports = {};\n");
    assert.equal(assess().authenticity, "self-signed",
      "a config without conformance keys stays unconfigured");

    process.env.CONFORMANCE_TRUST_ANCHOR = fingerprint;
    assert.equal(assess().authenticity, "trusted",
      "an environment fingerprint is normalized and trusted");
    delete process.env.CONFORMANCE_TRUST_ANCHOR;

    writeConfig("trusted.config.js", `module.exports = ${JSON.stringify({
      conformance: { trustedAttestationKeys: [fingerprint] },
    })};\n`);
    assert.equal(assess().authenticity, "trusted",
      "an explicit project config path supplies the configured key array");

    writeConfig("invalid-shape.config.js", `module.exports = ${JSON.stringify({
      conformance: { trustedAttestationKeys: "not-an-array" },
    })};\n`);
    assert.equal(assess().authenticity, "untrusted-key",
      "a malformed configured key collection fails closed");

    const brokenConfig = path.join(root, "broken.config.js");
    fs.writeFileSync(brokenConfig, "module.exports = {\n");
    process.env.COORD_PROJECT_CONFIG = brokenConfig;
    assert.equal(assess().authenticity, "untrusted-key",
      "a configured module load/parse failure cannot silently become self-signed");

    process.env.COORD_PROJECT_CONFIG = path.join(root, "absent.config.js");
    assert.equal(assess().authenticity, "untrusted-key",
      "an explicitly requested but missing config fails closed");

    delete process.env.COORD_PROJECT_CONFIG;
    assert.equal(assessSignerTrust(good.publicKeyPem, false, {
      coordDir: root,
      trustAnchor: fingerprint,
    }).trusted, false, "a trusted identity does not override an invalid signature");
    const malformedSigner = assessSignerTrust("not a public key", true, {
      coordDir: root,
      trustAnchor: fingerprint,
    });
    assert.equal(malformedSigner.authenticity, "untrusted-key",
      "a malformed public key cannot become trusted through a valid configured anchor");
    assert.equal(malformedSigner.trusted, false);
    assert.equal(malformedSigner.signing_key_fingerprint, null);
  } finally {
    if (priorAnchor === undefined) delete process.env.CONFORMANCE_TRUST_ANCHOR;
    else process.env.CONFORMANCE_TRUST_ANCHOR = priorAnchor;
    if (priorConfig === undefined) delete process.env.COORD_PROJECT_CONFIG;
    else process.env.COORD_PROJECT_CONFIG = priorConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COORD-681: batch and event evidence distinguish self-signed, trusted and attacker re-signatures", () => {
  const good = signer(), attacker = signer();
  for (const key of [good, attacker]) {
    const { batch, tree, eventHashes } = signed(key);
    const proof = signing.buildInclusionProof(tree, 0);
    const unanchored = signing.verifySignedBatch(batch);
    assert.equal(unanchored.verdict, "self-signed");
    assert.equal(unanchored.trusted, false);
    assert.equal(unanchored.signature_valid, true);
    assert.equal(signing.verifyEventInclusion(batch, eventHashes[0], proof).non_repudiation_proven, false);
    for (const anchor of [good.publicKeyPem, publicKeyFingerprint(good.publicKeyPem)]) {
      const options = { trustAnchors: [anchor] };
      const report = signing.verifySignedBatch(batch, options);
      const event = signing.verifyEventInclusion(batch, eventHashes[0], proof, options);
      assert.equal(report.signature_valid, true, "attacker signature is internally valid");
      assert.equal(report.verdict, key === good ? "trusted" : "untrusted-key");
      assert.equal(report.ok, key === good);
      assert.equal(event.ok, key === good);
      assert.equal(event.non_repudiation_proven, key === good);
      if (key === attacker) assert.ok(report.problems.some(p => p.code === "untrusted_signing_key"));
    }
  }
});

test("COORD-681: invalid anchors fail closed and pinned signers still require intact signatures", () => {
  const good = signer(), { batch } = signed(good);
  for (const anchor of ["missing-anchor.pem", "", "invalid"])
    assert.equal(signing.verifySignedBatch(batch, { trustAnchors: [anchor] }).ok, false);
  batch.signature.value = Buffer.alloc(64).toString("base64");
  const report = signing.verifySignedBatch(batch, { trustAnchors: [good.publicKeyPem] });
  assert.equal(report.verdict, "signature-invalid");
  assert.equal(report.trusted, false);
});

test("COORD-681: migration authenticity has the same three states and rejects forged signers", () => {
  const good = signer(), attacker = signer();
  const payload = { migrated_at: "2026-09-22T00:00:00Z", sha1_chain_head: "a".repeat(40), verifier_version: "fixture" };
  for (const key of [good, attacker]) {
    const signature = migration.signTransition(payload, key.privateKey, key.publicKeyPem);
    assert.equal(migration.verifyTransitionSignature(payload, signature).authenticity, "self-signed");
    const result = migration.verifyTransitionSignature(payload, signature, { trustAnchors: [good.publicKeyPem] });
    assert.equal(result.signature_valid, true);
    assert.equal(result.trust_checked, true);
    assert.equal(result.authenticity, key === good ? "trusted" : "untrusted-key");
    assert.equal(result.trusted, key === good);
    assert.equal(migration.verifyTransitionSignature(payload, signature, { trustAnchors: ["invalid"] }).trusted, false);
  }
});

test("COORD-681: public CLI forwards CLI, environment and project anchors to batch and event verification", { timeout: 90000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "concord-signature-trust-"));
  const coord = path.join(root, "coord"), good = signer(), attacker = signer();
  try {
    fs.mkdirSync(coord);
    installCanonicalEngine(coord, COORD_ROOT_DIR);
    const source = COORD_ROOT_DIR;
    for (const name of ["scripts", "engine", "board", "paths.js", "project.config.js", "GOVERNANCE.md", "docs", "prompts", "schemas"])
      if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(coord, name), { recursive: true });
    fs.mkdirSync(path.join(coord, ".runtime"));
    const anchorPath = path.join(root, "trusted.pem"); fs.writeFileSync(anchorPath, good.publicKeyPem);
    const batchPath = path.join(root, "batch.json");
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^(NODE_TEST_|COORD_|CONFORMANCE_TRUST_ANCHOR)/.test(name)) delete env[name];
    for (const key of [good, attacker]) {
      const { batch, events, eventHashes } = signed(key);
      fs.writeFileSync(batchPath, JSON.stringify(batch));
      fs.writeFileSync(path.join(coord, ".runtime/governance-events.ndjson"), events.map(e => e.line).join("\n") + "\n");
      for (const channel of ["none", "cli", "env", "config", "invalid", "invalid-config", "missing-config"]) {
        const config = { repos: {}, ...(channel === "config" ? { conformance: { trustedAttestationKeys: [publicKeyFingerprint(good.publicKeyPem)] } } : channel === "invalid-config" ? { conformance: { trustedAttestationKeys: "invalid" } } : {}) };
        fs.writeFileSync(path.join(coord, "project.config.js"), `module.exports=${JSON.stringify(config)};\n`);
        fs.writeFileSync(path.join(coord, ".runtime/governance-events.ndjson"), events.map(e => e.line).join("\n") + "\n");
        const args = [path.join(coord, "scripts/governance.js"), "sign-journal", "verify", batchPath, "--json", "--event", eventHashes[0]];
        if (channel === "cli" || channel === "invalid") args.push("--trust-anchor", channel === "invalid" ? "invalid" : anchorPath);
        const result = spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...(channel === "env" ? { CONFORMANCE_TRUST_ANCHOR: anchorPath } : channel === "missing-config" ? { COORD_PROJECT_CONFIG: path.join(root, "absent-config.js") } : {}) }, encoding: "utf8", timeout: 15000 });
        const shouldPass = channel === "none" || (key === good && !["invalid", "invalid-config", "missing-config"].includes(channel));
        assert.equal(result.status === 0, shouldPass, `${channel}: ${result.stdout}\n${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.equal(report.authenticity, channel === "none" ? "self-signed" : shouldPass ? "trusted" : "untrusted-key");
        assert.equal(report.event_inclusion.non_repudiation_proven, channel !== "none" && shouldPass);
        const payload = migration.transitionPayload({ migrated_at: "2026-09-22T00:00:00Z", sha1_chain_head: "genesis", verifier_version: "fixture" });
        const transition = { command: "hash-alg-migration", hash_alg: "sha256", prev_event_hash: "genesis",
          details: { ...payload, signature: migration.signTransition(payload, key.privateKey, key.publicKeyPem) } };
        fs.writeFileSync(path.join(coord, ".runtime/governance-events.ndjson"), JSON.stringify(transition) + "\n");
        const conformArgs = [path.join(coord, "scripts/governance.js"), "conform", "--json"];
        if (channel === "cli" || channel === "invalid") conformArgs.push("--trust-anchor", channel === "invalid" ? "invalid" : anchorPath);
        const conform = spawnSync(process.execPath, conformArgs, { cwd: root, env: { ...env,
          ...(channel === "env" ? { CONFORMANCE_TRUST_ANCHOR: anchorPath } : channel === "missing-config" ? { COORD_PROJECT_CONFIG: path.join(root, "absent-config.js") } : {}) }, encoding: "utf8", timeout: 15000 });
        assert.equal(conform.status === 0, shouldPass, `migration ${channel}: ${conform.stdout}\n${conform.stderr}`);
        const chain = JSON.parse(conform.stdout);
        assert.equal(chain.migration_authenticity, report.authenticity);
        assert.equal(chain.migration_trusted, report.trusted);

      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
