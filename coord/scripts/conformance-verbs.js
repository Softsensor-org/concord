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
      const report = conformanceAttestation.verify(options.verifyAttestation);
      if (options.json === true) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Attestation verification: ${report.ok ? "PASS" : "FAIL"}`);
        console.log(`  file:              ${report.path}`);
        console.log(`  signature valid:   ${report.signature_valid}`);
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
      total_events: chain.total,
      chained_events: chain.chainedCount,
      pre_chain_events: chain.preChainCount,
      broken_links: chain.broken,
    };
    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Journal hash-chain conformance: ${report.verdict.toUpperCase()}`);
      console.log(`  chain head: ${report.chain_head || "(no chained events yet)"}`);
      console.log(
        `  events: ${report.total_events} total, ${report.chained_events} chained, ` +
        `${report.pre_chain_events} pre-chain (legacy, unverified)`
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
    verifyEngine,
  };
};
