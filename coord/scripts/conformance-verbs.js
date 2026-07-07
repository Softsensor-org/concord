"use strict";

// COORD-107: the ENT conformance / engine-integrity CLI verb surface extracted
// from lifecycle.js — the `gov conform` (ENT-002 journal hash-chain self-verify
// + ENT-010 signed conformance attestation emit/verify) and `gov verify-engine`
// (ENT-011 engine version-pin + drift-check) command handlers, together with
// the two factory objects they format output over (createConformanceAttestation
// + createEnginePin).
//
// These two verbs are a cohesive read-only* self-verification cluster: both
// derive a deterministic engine-integrity surface (reusing the SAME
// TEMPLATE_SYNC_MANIFEST.json fingerprint computation so a pin and an
// attestation agree on the surface hash), both are READ-ONLY except for writing
// their own gitignored/committed artifact, and neither enters
// withGovernanceMutation. They are pure presentation glue over their injected
// factories, so this module is a thin dependency-injected wrapper: the journal
// chain verifier, the GovernanceError `fail`, the coord dir, and the two factory
// CREATORS are all injected rather than re-required here, keeping lifecycle.js
// the single composition root. The `commands` dispatch entry, the cli.js case,
// and any __testing re-export stay in lifecycle.js / cli.js.
//
// (* "conform --attest" writes a gitignored attestation artifact + first-run
//  keypair; "verify-engine --pin" writes the committed coord/engine-pin.json.)

module.exports = function createConformanceVerbs(deps = {}) {
  const {
    coordDir,
    fail,
    verifyGovernanceChain,
    repairGovernanceChain,
    migrateGovernanceChainHash,
    resolveRepairIdentity,
    createConformanceAttestation,
    createEnginePin,
  } = deps;

  // ENT-010: conformance attestation emit + local self-verify factory. Derives
  // the deterministic engine-integrity subject, signs it with a LOCAL ed25519
  // keypair (private key gitignored under coord/.runtime/), and re-verifies.
  const conformanceAttestation = createConformanceAttestation({
    coordDir,
    verifyGovernanceChain: (...args) => verifyGovernanceChain(...args),
    fail,
    // COORD-300: forward the optional sandboxable runtime-dir resolver so the
    // lazily-generated conformance keypair + attestation artifacts follow a
    // RUNTIME_DIR override (test sandbox) instead of writing the live .runtime tree.
    resolveRuntimeDir: deps.resolveRuntimeDir,
  });

  // ENT-002 / ENT-010: read-only conformance self-verification.
  //   - default:                journal hash-chain self-verify (ENT-002) — verifies
  //                             the live journal end-to-end + prints the chain head.
  //   - --attest:               ALSO emit a signed (local ed25519 keypair) attestation
  //                             over the engine-integrity inputs (ENT-010).
  //   - --verify-attestation F: re-derive the inputs, recompute the digest, check the
  //                             signature, and flag drift/tamper (ENT-010).
  // This is the LOCAL (Community-tier) self-verify; the signed attestation is also
  // the exact input a future central re-hash service (ENT-007) would re-compute.
  // Read-only except writing the attestation artifact + (first-run) the keypair.
  function conform(options = {}) {
    if (options.verifyAttestation) {
      // COORD-272: thread the OPTIONAL pinned trust anchor (CLI --trust-anchor)
      // through to verify so anchored runs reject an untrusted signing key.
      const report = conformanceAttestation.verify(options.verifyAttestation, {
        trustAnchor: options.trustAnchor,
      });
      if (options.json === true) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Attestation verification: ${report.ok ? "PASS" : "FAIL"}`);
        console.log(`  file:              ${report.path}`);
        // COORD-272: signature validity is integrity-vs-the-embedded-key ONLY;
        // authenticity is reported SEPARATELY and never conflated with it.
        console.log(`  signature valid:   ${report.signature_valid} (integrity vs embedded key only)`);
        console.log(
          `  authenticity:      ${report.authenticity}` +
          (report.trust_anchor_configured ? "" : " (no trust anchor configured — unverified)")
        );
        console.log(`  trusted:           ${report.trusted}`);
        console.log(`  digest matches:    ${report.digest_matches_subject}`);
        console.log(`  matches live:      ${report.matches_live_inputs}`);
        console.log(`  attested digest:   ${report.attested_digest || "(none)"}`);
        if (!report.ok) {
          console.log(`  problems (${report.problems.length}):`);
          for (const p of report.problems) {
            console.log(`    - ${p.code}: ${p.detail}`);
          }
        }
      }
      if (!report.ok) {
        fail(
          `Attestation verification FAILED: ${report.problems.length} problem(s) ` +
          `(${report.problems.map((p) => p.code).join(", ")}). ` +
          `The attestation was tampered with or the engine surface drifted.`
        );
      }
      return report;
    }

    const chain = verifyGovernanceChain();
    const report = {
      verdict: chain.ok ? "pass" : "fail",
      chain_head: chain.head,
      // COORD-289: name the era of the head explicitly (sha1 = pre-migration,
      // sha256 = post hash-alg-migration).
      chain_head_alg: chain.headAlg || null,
      total_events: chain.total,
      chained_events: chain.chainedCount,
      // COORD-289: per-era breakdown + the migration boundary.
      sha1_chained_events: chain.sha1ChainedCount,
      sha256_chained_events: chain.sha256ChainedCount,
      migration_index: chain.migrationIndex,
      pre_chain_events: chain.preChainCount,
      broken_links: chain.broken,
    };
    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Journal hash-chain conformance: ${report.verdict.toUpperCase()}`);
      console.log(
        `  chain head: ${report.chain_head || "(no chained events yet)"}` +
        `${report.chain_head_alg ? ` [${report.chain_head_alg}]` : ""}`
      );
      console.log(
        `  events: ${report.total_events} total, ${report.chained_events} chained, ` +
        `${report.pre_chain_events} pre-chain (legacy, unverified)`
      );
      // COORD-289: show the SHA-1 vs SHA-256 era split + migration boundary.
      console.log(
        `  eras: ${report.sha1_chained_events} sha1-chained, ` +
        `${report.sha256_chained_events} sha256-chained` +
        `${report.migration_index !== null && report.migration_index !== undefined
          ? ` (migration boundary @ event #${report.migration_index})`
          : " (no hash-alg-migration yet — dormant)"}`
      );
      if (!chain.ok) {
        console.log(`  broken links (${chain.broken.length}):`);
        for (const b of chain.broken) {
          console.log(
            `    #${b.index} ${b.reason}${b.command ? ` [${b.command}]` : ""}` +
            `${b.ts ? ` @ ${b.ts}` : ""}`
          );
        }
      }
    }
    if (!chain.ok) {
      fail(
        `Journal hash-chain verification FAILED: ${chain.broken.length} broken link(s). ` +
        `The journal was reordered, tampered, or had an event dropped.`
      );
    }

    // ENT-010: --attest emits a signed attestation over the engine-integrity
    // inputs after the chain self-verify passes. Read-only except writing the
    // attestation artifact + (first-run) the local keypair (both gitignored).
    if (options.attest === true) {
      const emitted = conformanceAttestation.emit();
      report.attestation = {
        path: emitted.path,
        subject_digest: emitted.subjectDigest,
        issued_at: emitted.attestation.issued_at,
      };
      if (options.json !== true) {
        console.log(`Attestation emitted:`);
        console.log(`  path:   ${emitted.path}`);
        console.log(`  digest: ${emitted.subjectDigest}`);
      }
    }
    return report;
  }

  // COORD-124: guarded, auditable journal hash-chain repair.
  //   - default (no --confirm):  DRY-RUN. Reports the broken links that WOULD be
  //                              repaired (offending indices/ids + claimed-vs-expected
  //                              prev-hash) and writes NOTHING. No-ops cleanly when the
  //                              chain is already valid.
  //   - --confirm --reason "…":  APPLY. Backs the pre-repair journal up to a timestamped
  //                              `.pre-repair-<ts>` sidecar (gitignored off-chain evidence),
  //                              appends an explicit on-chain `chain-repair` marker capturing
  //                              the broken-link evidence + the human reason + actor + ts, and
  //                              re-stamps prev_event_hash for every chained event from the
  //                              first broken link forward (reusing the canonical hasher) so
  //                              the chain is GENUINELY re-linked. After it runs, `gov conform`
  //                              PASSES and the verified chain permanently contains the marker.
  // The repair is the ONLY way a broken chain validates: a break WITHOUT a recorded repair
  // (one nobody re-stamped) still FAILS conform, so this cannot become a tamper-laundering tool.
  function repairChain(options = {}) {
    const confirm = options.confirm === true;
    const reason = typeof options.reason === "string" ? options.reason : "";
    const identity =
      typeof resolveRepairIdentity === "function" ? resolveRepairIdentity() : null;
    const result = repairGovernanceChain({ confirm, reason, identity });

    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === "already-valid") {
      console.log(`Chain repair: NO-OP (chain already valid).`);
      console.log(`  chain head: ${result.chain_head || "(no chained events yet)"}`);
    } else if (result.status === "dry-run") {
      console.log(`Chain repair: DRY-RUN (no --confirm; nothing written).`);
      console.log(`  broken links (${result.broken_link_count}) that WOULD be re-linked:`);
      for (const link of result.broken_links) {
        console.log(
          `    #${link.index} ${link.reason}${link.command ? ` [${link.command}]` : ""}` +
          `${link.ts ? ` @ ${link.ts}` : ""}`
        );
        console.log(`        claimed prev:  ${link.claimed_prev_event_hash || "(none)"}`);
        console.log(`        expected prev: ${link.expected_prev_event_hash || "(none)"}`);
      }
      console.log(`  re-link would begin at event #${result.first_broken_index}.`);
      console.log(`  Re-run with: gov repair-chain --confirm --reason "<why>" to apply.`);
    } else if (result.status === "repaired") {
      console.log(`Chain repair: APPLIED.`);
      console.log(`  re-linked ${result.broken_link_count} broken link(s) from event #${result.first_broken_index}.`);
      console.log(`  reason:        ${result.reason}`);
      console.log(`  repair marker: event #${result.marker_index} [${result.marker_command}]`);
      console.log(`  backup:        ${result.backup_path}`);
      console.log(`  new chain head: ${result.chain_head}`);
    }
    return result;
  }

  // COORD-289: the governed `hash-alg-migration` verb — the SINGLE, human-only
  // hinge that migrates the live journal hash-chain from the SHA-1 era to the
  // SHA-256 era WITHOUT re-hashing or re-chaining any historical event.
  //   - default (no --confirm): DRY-RUN. Reports the SHA-1 head that WOULD be
  //                             bridged + writes nothing.
  //   - --confirm:              APPLY (irreversible). Under the runtime lock,
  //                             preconditions the chain verifies `ok`, refuses if a
  //                             migration already exists (idempotent), signs the
  //                             transition payload with the conformance keypair, and
  //                             appends the single SHA-1-linked, sha256-checkpoint
  //                             bridge event. After it runs, `gov conform` reports a
  //                             non-zero SHA-256 era and headAlg=sha256, while the
  //                             full SHA-1 history still verifies as historical fact.
  function migrateChainHash(options = {}) {
    const confirm = options.confirm === true;
    const identity =
      typeof resolveRepairIdentity === "function" ? resolveRepairIdentity() : null;
    const result = migrateGovernanceChainHash({ confirm, identity, ticket: options.ticket });

    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.status === "already-migrated") {
      console.log(`Hash-alg migration: NO-OP (chain already migrated).`);
      console.log(`  migration boundary: event #${result.migration_index}`);
      console.log(`  chain head:         ${result.head || "(none)"} [${result.head_alg || "?"}]`);
    } else if (result.status === "dry-run") {
      console.log(`Hash-alg migration: DRY-RUN (no --confirm; nothing written).`);
      console.log(`  sha1 chain head:  ${result.sha1_chain_head}`);
      console.log(`  verifier version: ${result.verifier_version}`);
      console.log(`  chained events:   ${result.chained_events} of ${result.total_events} total`);
      console.log(`  Re-run with: gov migrate-chain-hash --confirm to apply (IRREVERSIBLE).`);
    } else if (result.status === "migrated") {
      console.log(`Hash-alg migration: APPLIED.`);
      console.log(`  sha1 chain head (bridged): ${result.sha1_chain_head}`);
      console.log(`  migrated at:               ${result.migrated_at}`);
      console.log(`  verifier version:          ${result.verifier_version}`);
      console.log(`  signer fingerprint:        ${result.signature_fingerprint}`);
      console.log(`  migration boundary:        event #${result.migration_index}`);
      console.log(`  new chain head:            ${result.head} [${result.head_alg}]`);
      console.log(
        `  eras: ${result.sha1_chained} sha1-chained, ${result.sha256_chained} sha256-chained`
      );
    }
    return result;
  }

  // ENT-011: engine version-pin + drift-check factory (COMMUNITY half of ENT-008).
  // Reuses the same TEMPLATE_SYNC_MANIFEST.json fingerprint computation as ENT-010's
  // conformance attestation so a pin and an attestation agree on the surface hash.
  const enginePin = createEnginePin({
    coordDir,
    fail,
  });

  // ENT-011: pin the engine surface to a known-good version + detect drift from it.
  //   - --pin:   (re)pin to the CURRENT surface (manifest version + fingerprint +
  //              per-file checksum snapshot). The ONLY mutation — writes
  //              coord/engine-pin.json.
  //   - default: READ-ONLY drift check — re-derive the live surface and compare it
  //              against the pin; report in-sync or DRIFTED (which files / whether
  //              the manifest fingerprint changed). NO signing (that is ENT-008).
  // Complementary to check-template-sync: that verifies manifest-vs-files internal
  // consistency; this verifies drift from a FROZEN pinned version.
  function verifyEngine(options = {}) {
    if (options.pin === true) {
      const result = enginePin.pin();
      if (options.json === true) {
        console.log(JSON.stringify(result.pin, null, 2));
      } else {
        console.log(`Engine surface pinned:`);
        console.log(`  path:    ${result.path}`);
        console.log(`  version: ${result.pin.manifest_version || "(none)"}`);
        console.log(`  manifest fingerprint: ${result.pin.manifest_fingerprint.sha256}`);
        console.log(`  tracked files: ${Object.keys(result.pin.files).length}`);
      }
      return result;
    }

    const report = enginePin.verify();
    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else if (!report.pinned) {
      console.log(`Engine pin: NONE`);
      for (const p of report.problems) {
        console.log(`  - ${p.code}: ${p.detail}`);
      }
    } else {
      console.log(`Engine drift check: ${report.ok ? "IN-SYNC" : "DRIFTED"}`);
      console.log(`  pin file:        ${report.path}`);
      console.log(`  pinned version:  ${report.pinned_version || "(none)"}`);
      console.log(`  live version:    ${report.live_version || "(none)"}`);
      console.log(`  manifest drift:  ${report.manifest_fingerprint_drift}`);
      if (!report.ok) {
        console.log(`  problems (${report.problems.length}):`);
        for (const p of report.problems) {
          console.log(`    - ${p.code}: ${p.detail}`);
          if (Array.isArray(p.files)) {
            for (const f of p.files) {
              console.log(`        [${f.kind}] ${f.path}`);
            }
          }
        }
      }
    }
    if (report.pinned && !report.ok) {
      fail(
        `Engine drift detected: ${report.problems.length} problem(s) ` +
        `(${report.problems.map((p) => p.code).join(", ")}). ` +
        `The local engine surface drifted from the pinned version. ` +
        `If this was an intentional engine upgrade, re-pin with \`gov verify-engine --pin\`.`
      );
    }
    return report;
  }

  return {
    conformanceAttestation,
    enginePin,
    conform,
    repairChain,
    migrateChainHash,
    verifyEngine,
  };
};
