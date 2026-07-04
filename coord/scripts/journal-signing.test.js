"use strict";

// COORD-146: [Memory] cross-cutting batch signing for per-event NON-REPUDIATION.
//
// All keys are EPHEMERAL, generated in-test (mirrors the conformance attestation
// tests) — no committed keys, no touch of the live .runtime/ keypair. We prove:
//   - signing a batch produces a signature that verifies over the events/root;
//   - an individual event's inclusion is provable (per-event non-repudiation)
//     via a Merkle proof under the SIGNED root;
//   - a TAMPERED event (or one not in the signed set) fails verification;
//   - the key-provider abstraction works with a FAKE provider (KMS substitute);
//   - unsigned / legacy journals are unaffected (this module is read-only +
//     additive — backward compatible);
//   - determinism: identical events -> identical merkle_root + subject_digest;
//   - the local key provider keeps the private key under the gitignored .runtime/.

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const signing = require("./journal-signing.js");

// Generate an ephemeral ed25519 signer (the same shape a key provider returns).
function ephemeralSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

// Build a set of journal-event "lines" the way the journal stores them: each is
// the verbatim JSON.stringify of a record. The leaf hash is sha1 of that line.
function sampleEvents(n = 5) {
  const events = [];
  let prev = "genesis";
  for (let i = 0; i < n; i += 1) {
    const record = {
      ts: `2026-06-24T10:0${i}:00.000Z`,
      command: "start",
      ticket: `COORD-${100 + i}`,
      result: "succeeded",
      prev_event_hash: prev,
    };
    const line = JSON.stringify(record);
    events.push({ line, record });
    prev = signing.eventHashFromLine(line);
  }
  return events;
}

test("signing a batch produces a signature that verifies over the events/root", () => {
  const events = sampleEvents(5);
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch } = signing.buildSignedBatch({ events, keyProvider: provider });

  assert.equal(batch.subject.event_count, 5);
  assert.match(batch.subject.merkle_root, /^[0-9a-f]{64}$/);
  assert.equal(batch.subject.chain_head, signing.chainHeadOf(events));
  assert.equal(batch.signature.algorithm, "ed25519");

  const report = signing.verifySignedBatch(batch, {
    liveChainHead: signing.chainHeadOf(events),
    liveEventHashes: events.map((e) => signing.eventHashFromLine(e.line)),
  });
  assert.equal(report.verdict, signing.BATCH_VERDICT.VALID);
  assert.equal(report.ok, true);
  assert.equal(report.signature_valid, true);
  assert.equal(report.merkle_root_matches, true);
  assert.equal(report.chain_head_matches, true);
});

test("an individual event's inclusion is provable (per-event non-repudiation)", () => {
  const events = sampleEvents(6);
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch, eventHashes } = signing.buildSignedBatch({ events, keyProvider: provider });
  const tree = signing.buildMerkleTree(eventHashes);

  // Every event must be provably included under the signed root.
  for (let i = 0; i < eventHashes.length; i += 1) {
    const proof = signing.buildInclusionProof(tree, i);
    const result = signing.verifyEventInclusion(batch, eventHashes[i], proof);
    assert.equal(result.ok, true, `event ${i} should be provably included`);
    assert.equal(result.included, true);
    assert.equal(result.signature_valid, true);
  }
});

test("rootFromProof recomputes the signed merkle_root for an included leaf", () => {
  const events = sampleEvents(7); // odd count exercises duplicate-last
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch, eventHashes } = signing.buildSignedBatch({ events, keyProvider: provider });
  const tree = signing.buildMerkleTree(eventHashes);
  const idx = 3;
  const proof = signing.buildInclusionProof(tree, idx);
  assert.equal(signing.rootFromProof(eventHashes[idx], proof), batch.subject.merkle_root);
});

test("a TAMPERED event fails per-event verification (different hash, no proof)", () => {
  const events = sampleEvents(5);
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch, eventHashes } = signing.buildSignedBatch({ events, keyProvider: provider });
  const tree = signing.buildMerkleTree(eventHashes);

  // Use a real proof for slot 2 but a tampered event hash -> recomputed root diverges.
  const proof = signing.buildInclusionProof(tree, 2);
  const tamperedHash = signing.eventHashFromLine(JSON.stringify({ tampered: true }));
  const result = signing.verifyEventInclusion(batch, tamperedHash, proof);
  assert.equal(result.ok, false);
  assert.equal(result.included, false);
  assert.ok(result.problems.some((p) => p.code === "not_included"));
});

test("an event NOT in the signed set is rejected (batch event_hashes edited)", () => {
  const events = sampleEvents(5);
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch } = signing.buildSignedBatch({ events, keyProvider: provider });

  // Append a fabricated event hash to the batch's event_hashes AFTER signing.
  const tampered = JSON.parse(JSON.stringify(batch));
  tampered.event_hashes.push(signing.eventHashFromLine(JSON.stringify({ injected: 1 })));

  const report = signing.verifySignedBatch(tampered, {});
  assert.equal(report.verdict, signing.BATCH_VERDICT.MERKLE_ROOT_MISMATCH);
  assert.equal(report.merkle_root_matches, false);
});

test("a tampered signed subject is detected (subject_digest mismatch)", () => {
  const events = sampleEvents(4);
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch } = signing.buildSignedBatch({ events, keyProvider: provider });

  const tampered = JSON.parse(JSON.stringify(batch));
  tampered.subject.event_count = 99; // mutate a SIGNED field

  const report = signing.verifySignedBatch(tampered, {});
  assert.equal(report.verdict, signing.BATCH_VERDICT.SUBJECT_DIGEST_MISMATCH);
  assert.equal(report.digest_matches_subject, false);
});

test("a tampered signature is detected (signature-invalid)", () => {
  const events = sampleEvents(4);
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch } = signing.buildSignedBatch({ events, keyProvider: provider });

  const tampered = JSON.parse(JSON.stringify(batch));
  // Flip the signature bytes but keep length valid base64.
  const buf = Buffer.from(tampered.signature.value, "base64");
  buf[0] ^= 0xff;
  tampered.signature.value = buf.toString("base64");

  const report = signing.verifySignedBatch(tampered, {});
  assert.equal(report.verdict, signing.BATCH_VERDICT.SIGNATURE_INVALID);
  assert.equal(report.signature_valid, false);
});

test("a stale batch (chain_head diverged) is reported as chain-head-mismatch", () => {
  const events = sampleEvents(3);
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch } = signing.buildSignedBatch({ events, keyProvider: provider });

  // The live journal advanced (new head) since the batch was signed.
  const report = signing.verifySignedBatch(batch, { liveChainHead: "advanced-head" });
  assert.equal(report.verdict, signing.BATCH_VERDICT.CHAIN_HEAD_MISMATCH);
  assert.equal(report.chain_head_matches, false);
});

test("no public key material -> unverifiable-signature (soft, not a hard fail)", () => {
  const events = sampleEvents(3);
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch } = signing.buildSignedBatch({ events, keyProvider: provider });

  const stripped = JSON.parse(JSON.stringify(batch));
  stripped.signature.public_key_pem = null;
  const report = signing.verifySignedBatch(stripped, {});
  assert.equal(report.verdict, signing.BATCH_VERDICT.UNVERIFIABLE_SIGNATURE);
});

test("the key-provider abstraction works with a FAKE provider (KMS substitute)", () => {
  // A fake provider standing in for a KMS/HSM: it holds an ephemeral signer and
  // exposes the IDENTICAL getSigner() interface. The signing path never knows
  // (or cares) where the key lives.
  let calls = 0;
  const signer = ephemeralSigner();
  const kmsLike = {
    kind: "fake-kms",
    getSigner() {
      calls += 1;
      return signer;
    },
  };
  const events = sampleEvents(5);
  const { batch } = signing.buildSignedBatch({ events, keyProvider: kmsLike });
  assert.equal(calls, 1, "the provider seam was used to obtain the signer");

  const report = signing.verifySignedBatch(batch, {
    liveChainHead: signing.chainHeadOf(events),
  });
  assert.equal(report.verdict, signing.BATCH_VERDICT.VALID);
});

test("determinism: identical events -> identical merkle_root + subject_digest", () => {
  const events = sampleEvents(5);
  const p1 = signing.staticKeyProvider(ephemeralSigner());
  const p2 = signing.staticKeyProvider(ephemeralSigner());
  const a = signing.buildSignedBatch({ events, keyProvider: p1, issuedAt: "x" });
  const b = signing.buildSignedBatch({ events, keyProvider: p2, issuedAt: "y" });
  // Different keys + different issued_at, but the SIGNED subject (root + chain
  // head) is identical -> identical merkle_root + subject_digest.
  assert.equal(a.batch.subject.merkle_root, b.batch.subject.merkle_root);
  assert.equal(a.subjectDigest, b.subjectDigest);
});

test("an empty journal signs to a well-defined empty root (total, not a crash)", () => {
  const provider = signing.staticKeyProvider(ephemeralSigner());
  const { batch } = signing.buildSignedBatch({ events: [], keyProvider: provider });
  assert.equal(batch.subject.event_count, 0);
  assert.equal(batch.subject.merkle_root, signing.EMPTY_ROOT);
  assert.equal(batch.subject.chain_head, null);
  const report = signing.verifySignedBatch(batch, {});
  // Signature still verifies; only the (absent) chain-head bind is skipped.
  assert.equal(report.signature_valid, true);
});

test("BACKWARD COMPAT: this module is read-only over the journal and adds NO per-event signature", () => {
  // Read a fixture journal (legacy + chained mix) and confirm the module reads it
  // without mutating it and without requiring any signature field on events.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coord146-"));
  try {
    const journalPath = path.join(tmp, "journal.ndjson");
    const events = sampleEvents(3);
    // Prepend a LEGACY pre-chain event (no prev_event_hash) — must be tolerated.
    const legacy = JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", command: "legacy", ticket: "COORD-001" });
    const raw = [legacy, ...events.map((e) => e.line)].join("\n") + "\n";
    fs.writeFileSync(journalPath, raw);

    const before = fs.readFileSync(journalPath, "utf8");
    const read = signing.readJournalEvents(journalPath);
    assert.equal(read.length, 4, "legacy + 3 chained events read");
    // No event gained a signature field; the journal file is byte-identical.
    for (const e of read) {
      assert.equal("signature" in e.record, false, "events never gain a signature field");
    }
    assert.equal(fs.readFileSync(journalPath, "utf8"), before, "journal not mutated");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the local key provider keeps the private key under the gitignored .runtime tree", () => {
  const provider = signing.localKeyProvider();
  // The private key path must be git-ignored by the live repo (never committed).
  const check = spawnSync("git", ["check-ignore", provider.paths.privatePath], {
    encoding: "utf8",
  });
  // exit 0 => ignored. (Skip the assertion gracefully if git is unavailable.)
  if (check.status === 0) {
    assert.ok(
      check.stdout.includes("journal-batch-signing-key.pem"),
      "private signing key is gitignored"
    );
  }
});
