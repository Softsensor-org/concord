"use strict";

// COORD-146: [Memory] Cross-cutting — per-event/batch signing for memory
// non-repudiation (folded into the KMS / key-custody roadmap).
//
// WHAT THIS EXTENDS (NOT replaces). Per coord/docs/MEMORY_ARCHITECTURE.md §2 the
// journal today is:
//   - HASH-CHAINED   — each event carries prev_event_hash (journal.js), so
//                      reorder/drop/alter is detectable;
//   - ATTRIBUTED     — each event carries `identity` (who emitted it);
//   - ANCHORED by ONE ed25519 attestation over a subject that INCLUDES
//                      journal_chain_head (conformance-attestation.js).
// There is NO per-event signature. The attestation anchors the chain HEAD, not
// each event individually, so today there is no per-event NON-REPUDIATION: the
// chain proves integrity + order, but nothing proves "key-holder X signed that
// event N existed" for an individual N.
//
// DESIGN CHOICE — BATCH signing with a MERKLE inclusion proof (justified).
// We sign a BATCH of events once: build a Merkle tree over the per-event leaf
// hashes and ed25519-sign a deterministic subject binding the merkle_root TO the
// journal chain_head. This yields PER-EVENT non-repudiation WITHOUT a signature
// per line: any individual event's inclusion under the signed root is proven by
// a compact O(log n) Merkle proof, and the signed subject's chain_head binds the
// batch to the existing hash-chain so the two verifiers COMPOSE. Per-event
// signing (one signature per event) is the stronger but far heavier option
// (N signatures, N verifications, N stored signatures); batch-with-inclusion-
// proof is the pragmatic default at journal scale and still delivers per-event
// non-repudiation. We therefore implement batch signing and expose a per-event
// VERIFY (signature-valid + Merkle-inclusion + chain-head bind) as the
// non-repudiation primitive.
//
// REUSED CRYPTO (no new crypto rolled).
//   - The ed25519 sign/verify + canonical-JSON + sha256 envelope is the SAME
//     stack as conformance-attestation.js (`__internals.canonicalJson` +
//     `__internals.sha256Hex`) and conformance-bundle.js. We import those core
//     primitives so the batch signature algorithm CANNOT diverge from the edge.
//   - The per-event leaf hash is the canonical journal event hash: sha1 of the
//     verbatim stored journal line — IDENTICAL to journal.js
//     `hashGovernanceEventLine` and decision-extractor.js's per-event sha1, so a
//     leaf in this Merkle tree is the exact `event_hash` already cited by the
//     memory layer (§7 recall contract).
//
// PLUGGABLE KEY CUSTODY (the "folded into KMS" part).
//   The signing key SOURCE is an abstraction — a key provider with
//   `getSigner() -> { privateKey, publicKeyPem }`. Coord ships ONE default
//   provider (`localKeyProvider`) that lazily generates + persists a local
//   ed25519 keypair under coord/.runtime/ (gitignored; the private key is NEVER
//   committed). An adopter backs the SAME interface with a KMS/HSM provider
//   (the private key never leaves the HSM; `sign` is delegated). Coord does NOT
//   reimplement a KMS or a production secret store — explicit NON-GOAL, the same
//   stance as COORD-157 and conformance-bundle.js (which never persists a
//   long-lived key). The provider boundary is the seam an adopter plugs into.
//
// BACKWARD COMPATIBLE. This module is purely additive + OPTIONAL. It reads the
// journal read-only and writes only its own signed-batch artifact under the
// gitignored coord/.runtime/ tree. It NEVER mutates journal events, never adds a
// per-event `signature` field, and does not touch verifyGovernanceChain — so
// unsigned / legacy journals behave EXACTLY as today.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// CORE crypto primitives — the IDENTICAL canonical-JSON + sha256 + ed25519 stack
// the per-repo conformance attestation producer uses. Imported, NOT reimplemented,
// so the batch signature cannot diverge from the existing attestation surface.
const { canonicalJson, sha256Hex } = require("./conformance-attestation.js").__internals;

const BATCH_SCHEMA_VERSION = 1;
const SIGNATURE_ALGORITHM = "ed25519";
// The per-event leaf hash algorithm. sha1 of the verbatim stored journal line is
// the canonical journal event hash (journal.js hashGovernanceEventLine /
// decision-extractor.js). A leaf is therefore the exact cited `event_hash`.
const LEAF_ALGORITHM = "sha1-stored-line";
// Domain-separation tags so a leaf hash can never collide with an interior-node
// hash (a standard Merkle second-preimage guard).
const LEAF_TAG = "L:";
const NODE_TAG = "N:";

// --- per-event leaf hash (mirrors journal.js exactly) -----------------------
// The on-disk journal line is itself canonical (the exact string produced by
// JSON.stringify(record) at append time), so the canonical event hash is the
// sha1 of the verbatim stored line. Identical to journal.js
// `hashGovernanceEventLine`; re-implemented in one line so this stays a
// zero-extra-dependency leaf module.
function eventHashFromLine(line) {
  return crypto.createHash("sha1").update(String(line)).digest("hex");
}

// Interior node hash over two child digests (sha256, domain-separated). sha256
// (not sha1) for the tree structure: leaves reuse the canonical sha1 event hash
// for citation parity, while the tree binding uses the same sha256 family as the
// attestation digest.
function hashNode(left, right) {
  return sha256Hex(`${NODE_TAG}${left}:${right}`);
}

function hashLeaf(eventHash) {
  return sha256Hex(`${LEAF_TAG}${eventHash}`);
}

// --- Merkle tree over event leaves ------------------------------------------
// Deterministic, duplicate-last-on-odd Merkle tree. Returns the root + the full
// level structure so inclusion proofs can be derived without rebuilding. An
// EMPTY batch has a well-defined empty root (sha256 of a fixed empty marker) so
// signing an empty journal is total, not a crash.
const EMPTY_ROOT = sha256Hex(`${NODE_TAG}empty`);

function buildMerkleTree(eventHashes) {
  const leaves = eventHashes.map(hashLeaf);
  if (leaves.length === 0) {
    return { root: EMPTY_ROOT, levels: [[]], leafCount: 0 };
  }
  const levels = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      // Duplicate the last node when the level has an odd count.
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashNode(left, right));
    }
    levels.push(next);
    current = next;
  }
  return { root: current[0], levels, leafCount: leaves.length };
}

// Inclusion proof for the leaf at `index`: the ordered list of sibling digests
// (each tagged left/right) needed to recompute the root from the leaf.
function buildInclusionProof(tree, index) {
  if (index < 0 || index >= tree.leafCount) {
    return null;
  }
  const proof = [];
  let idx = index;
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const nodes = tree.levels[level];
    const isRight = idx % 2 === 1;
    const siblingIndex = isRight ? idx - 1 : idx + 1;
    // On an odd level the last node is duplicated, so its sibling is itself.
    const sibling = siblingIndex < nodes.length ? nodes[siblingIndex] : nodes[idx];
    proof.push({ position: isRight ? "left" : "right", hash: sibling });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// Recompute a Merkle root from a leaf event hash + its inclusion proof. Pure;
// used by the verifier (no tree needed — this is what an auditor runs given just
// the proof + the signed batch).
function rootFromProof(eventHash, proof) {
  let acc = hashLeaf(eventHash);
  for (const step of proof || []) {
    if (step.position === "left") {
      acc = hashNode(step.hash, acc);
    } else {
      acc = hashNode(acc, step.hash);
    }
  }
  return acc;
}

// --- key provider abstraction (the KMS seam) -------------------------------
// A key provider exposes getSigner() -> { privateKey: crypto.KeyObject,
// publicKeyPem: string }. The signing key SOURCE is pluggable so an adopter can
// back it with a KMS/HSM. Coord ships exactly the local-key default below; it
// does NOT reimplement a KMS (explicit non-goal).

// Default DEV provider: lazily generate + persist a local ed25519 keypair under
// the gitignored coord/.runtime/ tree. The PRIVATE key is written 0600 and must
// NEVER be committed (the .runtime/ tree is gitignored; see the test that
// asserts this against live git). Mirrors conformance-attestation.js ensureKeypair.
function localKeyProvider(options = {}) {
  const coordDir = options.coordDir || path.resolve(__dirname, "..");
  const keyDir = options.keyDir || path.join(coordDir, ".runtime", "journal-signing-keys");
  const privatePath = path.join(keyDir, "journal-batch-signing-key.pem");
  const publicPath = path.join(keyDir, "journal-batch-signing-key.pub.pem");

  function getSigner() {
    fs.mkdirSync(keyDir, { recursive: true });
    if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      fs.writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), {
        mode: 0o600,
      });
      fs.writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }));
    }
    const privatePem = fs.readFileSync(privatePath, "utf8");
    const publicKeyPem = fs.readFileSync(publicPath, "utf8");
    return {
      privateKey: crypto.createPrivateKey(privatePem),
      publicKeyPem,
    };
  }

  return { kind: "local", getSigner, paths: { keyDir, privatePath, publicPath } };
}

// In-memory provider — handy for tests AND a reference for a KMS substitute: it
// holds a signer object directly (an adopter's KMS provider would instead
// delegate `sign` to the HSM and expose only the public key). The interface is
// identical, which is the whole point of the seam.
function staticKeyProvider(signer) {
  return { kind: "static", getSigner: () => signer };
}

// --- read journal events (read-only) ----------------------------------------
// Read the journal NDJSON into ordered { line, record } pairs. Malformed/blank
// lines are skipped (never throw) so signing tolerates journal scratch state,
// mirroring decision-extractor.js's tolerance.
function readJournalEvents(journalPath) {
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const raw = fs.readFileSync(journalPath, "utf8");
  const out = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    out.push({ line, record });
  }
  return out;
}

// The canonical chain head = sha1 of the LAST stored line (matches journal.js
// `head` and decision-extractor.js chainHead). null for an empty journal.
function chainHeadOf(events) {
  if (events.length === 0) return null;
  return eventHashFromLine(events[events.length - 1].line);
}

// --- build a signed batch ---------------------------------------------------
// Sign a batch of journal events. Builds the Merkle tree over the per-event leaf
// hashes, binds the merkle_root to the journal chain_head in a deterministic
// SIGNED subject, and ed25519-signs the subject digest via the key provider.
// Returns the signed-batch artifact (envelope mirrors conformance-attestation.js)
// + the in-memory tree (for proof derivation by the caller).
//
// The signed subject is:
//   { schema_version, leaf_algorithm, event_count, merkle_root, chain_head }
// chain_head BINDS the batch to the existing hash-chain so a signed batch cannot
// be replayed against a different journal. issued_at lives OUTSIDE the signed
// subject (envelope only), so the digest stays reproducible — same rule as the
// conformance attestation.
function buildSignedBatch(input = {}) {
  const events = Array.isArray(input.events) ? input.events : [];
  const provider = input.keyProvider || localKeyProvider({ coordDir: input.coordDir });
  const eventHashes = events.map((e) => eventHashFromLine(e.line));
  const tree = buildMerkleTree(eventHashes);
  const chainHead = input.chainHead != null ? input.chainHead : chainHeadOf(events);

  const subject = {
    schema_version: BATCH_SCHEMA_VERSION,
    leaf_algorithm: LEAF_ALGORITHM,
    event_count: events.length,
    merkle_root: tree.root,
    chain_head: chainHead,
  };
  const subjectDigest = sha256Hex(canonicalJson(subject));

  const { privateKey, publicKeyPem } = provider.getSigner();
  const signature = crypto
    .sign(null, Buffer.from(subjectDigest, "hex"), privateKey)
    .toString("base64");

  const batch = {
    schema_version: BATCH_SCHEMA_VERSION,
    // Wall-clock issuance lives in the OUTER envelope, OUTSIDE the signed subject.
    issued_at: input.issuedAt || new Date().toISOString(),
    subject,
    subject_digest: subjectDigest,
    signature: {
      algorithm: SIGNATURE_ALGORITHM,
      value: signature,
      public_key_pem: publicKeyPem,
    },
    // Convenience: the ordered leaf event hashes (the cited per-event hashes).
    // These are NON-AUTHORITATIVE for the signature (the root + chain_head are
    // what is signed) but let a verifier locate an event without re-reading the
    // whole journal. Tamper here is caught by the merkle_root recompute.
    event_hashes: eventHashes,
  };

  return { batch, tree, subjectDigest, eventHashes };
}

// --- verify a signed batch + an individual event's non-repudiation ----------
// VERDICTS:
//   valid                  — signature verifies over subject_digest, the
//                            recorded subject_digest re-derives from the subject,
//                            and (if a journal/events set is supplied) the
//                            recorded event_hashes still rebuild the signed
//                            merkle_root AND the recorded chain_head matches the
//                            live chain head (binds to the chain).
//   subject-digest-mismatch — recorded subject_digest != re-derived (tamper).
//   signature-invalid      — signature present + key present but does NOT verify.
//   merkle-root-mismatch   — recorded event_hashes rebuild a DIFFERENT root than
//                            the signed merkle_root (a batch member was edited).
//   chain-head-mismatch    — the signed chain_head no longer matches the live
//                            journal chain head (the batch is stale / not this
//                            journal). Reported, soft (a later batch may exist).
//   unverifiable-signature — no public key material to check the signature
//                            (soft, mirrors conformance-bundle.js stance).
//
// options.liveChainHead: the current journal chain head (enables the chain bind
//   check). options.liveEventHashes: ordered live event hashes (enables the
//   merkle_root recompute against the live journal).
const BATCH_VERDICT = Object.freeze({
  VALID: "valid",
  SUBJECT_DIGEST_MISMATCH: "subject-digest-mismatch",
  SIGNATURE_INVALID: "signature-invalid",
  MERKLE_ROOT_MISMATCH: "merkle-root-mismatch",
  CHAIN_HEAD_MISMATCH: "chain-head-mismatch",
  UNVERIFIABLE_SIGNATURE: "unverifiable-signature",
});

function verifySignedBatch(batch, options = {}) {
  const problems = [];
  const subject = (batch && batch.subject) || {};
  const recordedDigest = (batch && batch.subject_digest) || null;
  const sig = (batch && batch.signature) || {};

  // (a) Internal consistency: recorded subject_digest re-derives from subject.
  const recomputedDigest = sha256Hex(canonicalJson(subject));
  const digestMatchesSubject = recomputedDigest === recordedDigest;
  if (!digestMatchesSubject) {
    problems.push({
      code: "subject_digest_mismatch",
      detail: "recorded subject_digest does not match the recorded subject (tamper)",
    });
  }

  // (b) Signature over the recorded digest using the embedded/supplied key.
  const publicKeyPem = options.publicKeyPem || sig.public_key_pem || null;
  let signatureChecked = false;
  let signatureValid = false;
  if (recordedDigest && sig.value && publicKeyPem) {
    signatureChecked = true;
    try {
      signatureValid = crypto.verify(
        null,
        Buffer.from(recordedDigest, "hex"),
        crypto.createPublicKey(publicKeyPem),
        Buffer.from(sig.value, "base64")
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      problems.push({
        code: "signature_invalid",
        detail: "ed25519 signature does not verify over the recorded subject_digest (tamper)",
      });
    }
  }

  // (c) Merkle root: rebuild from the recorded event_hashes; compare to the
  // SIGNED merkle_root. A mismatch means a batch member was added/removed/edited.
  const recordedRoot = subject.merkle_root || null;
  const eventHashes = Array.isArray(batch && batch.event_hashes) ? batch.event_hashes : [];
  const rebuiltRoot = buildMerkleTree(eventHashes).root;
  const rootMatches = rebuiltRoot === recordedRoot;
  if (!rootMatches) {
    problems.push({
      code: "merkle_root_mismatch",
      detail: "recorded event_hashes rebuild a different merkle_root than the signed value",
      recomputed_merkle_root: rebuiltRoot,
      signed_merkle_root: recordedRoot,
    });
  }

  // (d) Chain bind: if a live chain head is supplied, the signed chain_head must
  // still match it (the batch belongs to THIS journal). Soft — a stale batch is
  // reported, not a tamper.
  let chainHeadMatches = true;
  if (Object.prototype.hasOwnProperty.call(options, "liveChainHead")) {
    chainHeadMatches = subject.chain_head === options.liveChainHead;
    if (!chainHeadMatches) {
      problems.push({
        code: "chain_head_mismatch",
        detail: "signed chain_head no longer matches the live journal chain head (stale batch)",
        signed_chain_head: subject.chain_head || null,
        live_chain_head: options.liveChainHead || null,
      });
    }
  }

  // (e) Optional: confirm the signed event_hashes are a PREFIX of the live
  // journal (the batch covers a real, in-order span of the live chain).
  let liveMembershipOk = true;
  if (Array.isArray(options.liveEventHashes)) {
    liveMembershipOk = eventHashes.every((h, i) => options.liveEventHashes[i] === h);
    if (!liveMembershipOk) {
      problems.push({
        code: "live_membership_mismatch",
        detail: "signed event_hashes are not an in-order prefix of the live journal",
      });
    }
  }

  let verdict;
  if (!digestMatchesSubject) {
    verdict = BATCH_VERDICT.SUBJECT_DIGEST_MISMATCH;
  } else if (signatureChecked && !signatureValid) {
    verdict = BATCH_VERDICT.SIGNATURE_INVALID;
  } else if (!rootMatches || !liveMembershipOk) {
    verdict = BATCH_VERDICT.MERKLE_ROOT_MISMATCH;
  } else if (!chainHeadMatches) {
    verdict = BATCH_VERDICT.CHAIN_HEAD_MISMATCH;
  } else if (!signatureChecked) {
    verdict = BATCH_VERDICT.UNVERIFIABLE_SIGNATURE;
    problems.push({
      code: sig.value ? "unverifiable_signature" : "no_signature",
      detail: sig.value
        ? "signature present but no public key material available to verify it"
        : "batch carries no signature; merkle_root matched but signer is unverifiable",
    });
  } else {
    verdict = BATCH_VERDICT.VALID;
  }

  return {
    verdict,
    ok: verdict === BATCH_VERDICT.VALID,
    digest_matches_subject: digestMatchesSubject,
    signature_checked: signatureChecked,
    signature_valid: signatureValid,
    merkle_root_matches: rootMatches,
    chain_head_matches: chainHeadMatches,
    live_membership_ok: liveMembershipOk,
    signed_merkle_root: recordedRoot,
    recomputed_merkle_root: rebuiltRoot,
    event_count: eventHashes.length,
    problems,
  };
}

// PER-EVENT NON-REPUDIATION. Given a signed batch + a single event's hash + its
// Merkle inclusion proof, confirm: (1) the batch signature is valid (the signer
// vouched for the root), and (2) the event's leaf is INCLUDED under the SIGNED
// merkle_root via the proof. Together these prove the key-holder signed a batch
// that provably contains this exact event — per-event non-repudiation, with NO
// per-event signature stored.
//
// COMPOSES WITH THE EXISTING CHAIN-VERIFY: this never weakens verifyGovernanceChain.
// The hash-chain still independently proves order/integrity; the inclusion proof
// adds the signed-existence (non-repudiation) layer ON TOP. A caller proves an
// event's full provenance by running BOTH: chain-verify (order/integrity) AND
// verifyEventInclusion (signed non-repudiation).
function verifyEventInclusion(batch, eventHash, proof, options = {}) {
  const subject = (batch && batch.subject) || {};
  const sig = (batch && batch.signature) || {};
  const recordedDigest = (batch && batch.subject_digest) || null;
  const signedRoot = subject.merkle_root || null;

  const problems = [];

  // (1) Signature over the signed subject (which contains the root we trust).
  const recomputedDigest = sha256Hex(canonicalJson(subject));
  if (recomputedDigest !== recordedDigest) {
    problems.push({ code: "subject_digest_mismatch", detail: "subject_digest does not match subject" });
  }
  const publicKeyPem = options.publicKeyPem || sig.public_key_pem || null;
  let signatureValid = false;
  let signatureChecked = false;
  if (recordedDigest && sig.value && publicKeyPem) {
    signatureChecked = true;
    try {
      signatureValid = crypto.verify(
        null,
        Buffer.from(recordedDigest, "hex"),
        crypto.createPublicKey(publicKeyPem),
        Buffer.from(sig.value, "base64")
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      problems.push({ code: "signature_invalid", detail: "batch signature does not verify" });
    }
  } else {
    problems.push({ code: "unverifiable_signature", detail: "no public key material to verify the batch signature" });
  }

  // (2) Inclusion: recompute the root from the leaf + proof; must equal the
  // SIGNED root. A tampered event (different hash) or a fabricated proof yields a
  // different root and fails here.
  const recomputedRoot = rootFromProof(eventHash, proof);
  const included = recomputedRoot === signedRoot;
  if (!included) {
    problems.push({
      code: "not_included",
      detail: "event is not provably included under the signed merkle_root",
      recomputed_root: recomputedRoot,
      signed_root: signedRoot,
    });
  }

  const ok = signatureChecked && signatureValid && included && recomputedDigest === recordedDigest;
  return {
    ok,
    event_hash: eventHash,
    included,
    signature_checked: signatureChecked,
    signature_valid: signatureValid,
    signed_merkle_root: signedRoot,
    recomputed_root: recomputedRoot,
    problems,
  };
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  SIGNATURE_ALGORITHM,
  LEAF_ALGORITHM,
  EMPTY_ROOT,
  BATCH_VERDICT,
  // hashing / tree
  eventHashFromLine,
  hashLeaf,
  hashNode,
  buildMerkleTree,
  buildInclusionProof,
  rootFromProof,
  // key custody seam
  localKeyProvider,
  staticKeyProvider,
  // journal read
  readJournalEvents,
  chainHeadOf,
  // build + verify
  buildSignedBatch,
  verifySignedBatch,
  verifyEventInclusion,
};
