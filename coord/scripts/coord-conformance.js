"use strict";

// COORD-117: `coord conformance` — the PRODUCT-facing conformance command.
//
// This is a PACKAGING command, not a new engine: it is one clean entrypoint that
// composes the EXISTING conformance / engine-integrity engine and returns a clear
// pass/fail + exit code. There is ZERO crypto / hashing / conformance / attestation
// logic reimplemented here — every verdict and every digest is produced by the
// engine modules:
//   - conformance-verbs.js  → createConformanceVerbs(...).conform(...)  (the
//                             ENT-002 journal hash-chain self-verify + ENT-010
//                             signed-attestation emit/verify),
//   - conformance-attestation.js → the signed ed25519 attestation producer,
//   - engine-pin.js         → createEnginePin(...).verify()  (ENT-011 drift check).
//
// Flag surface (everything routes through the engine above):
//   coord conformance              run the chain self-verify, print a human
//                                  summary, exit 0 on pass / non-zero on fail.
//   coord conformance --json       machine-readable JSON result (same verdict).
//   coord conformance --attest     ALSO emit a signed attestation over the
//                                  engine-integrity inputs (reuses gov attest path).
//   coord conformance --verify [F] verify an existing attestation (path F, or the
//                                  most recent emitted one) AND the engine pin
//                                  drift-check; fail-closed on tamper/drift.
//   coord conformance --help       usage.
//
// Fail-closed: any conformance / drift / attestation failure returns a non-zero
// exit code. DI-factory convention (matches coord-init.js / conformance-verbs.js):
//   module.exports = function createCoordConformance(deps = {}) { ... }
// so tests inject the engine + an ephemeral keypair coordDir and never touch real
// git / global state.

const nodeFs = require("node:fs");
const nodePath = require("node:path");

// Lazy production composition root. We REUSE the same already-composed
// verifyGovernanceChain that the `gov` engine uses (lifecycle.js is the
// composition root) and instantiate the conformance verb cluster with the SAME
// deps lifecycle injects (COORD_DIR + the GovernanceError fail). This is the
// only place the real engine is wired; tests bypass it entirely via deps.
function defaultEngine() {
  // Required lazily so unit tests (which inject deps) never load the heavy
  // lifecycle/journal graph.
  const { COORD_DIR } = require("./governance-context.js");
  const lifecycle = require("./lifecycle.js");
  const verifyGovernanceChain = lifecycle.__testing.verifyGovernanceChain;
  const createConformanceVerbs = require("./conformance-verbs.js");
  const createConformanceAttestation = require("./conformance-attestation.js");
  const createEnginePin = require("./engine-pin.js");

  // fail closes the command: throw a tagged error the dispatcher turns into a
  // non-zero exit. Mirrors the GovernanceError fail semantics without exiting
  // the process here (the wrapper owns the exit code).
  const fail = (message) => {
    const err = new Error(message);
    err.isConformanceFailure = true;
    throw err;
  };

  return createConformanceVerbs({
    coordDir: COORD_DIR,
    fail,
    verifyGovernanceChain: (...args) => verifyGovernanceChain(...args),
    createConformanceAttestation,
    createEnginePin,
  });
}

module.exports = function createCoordConformance(deps = {}) {
  const fs = deps.fs || nodeFs;
  const log = deps.log || ((line) => console.log(line));
  // The conformance engine (conform/verifyEngine/conformanceAttestation/enginePin).
  // Injected by tests; lazily composed in production.
  let engineRef = deps.engine || null;
  const engine = () => {
    if (!engineRef) engineRef = defaultEngine();
    return engineRef;
  };

  function parseArgs(args = []) {
    const parsed = {
      json: false,
      attest: false,
      verify: false,
      verifyPath: null,
      help: false,
      unknown: [],
    };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--json") {
        parsed.json = true;
      } else if (arg === "--attest") {
        parsed.attest = true;
      } else if (arg === "--verify") {
        parsed.verify = true;
        // Optional following value: a file path (not another flag).
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          parsed.verifyPath = next;
          i += 1;
        }
      } else if (arg.startsWith("--verify=")) {
        parsed.verify = true;
        parsed.verifyPath = arg.slice("--verify=".length) || null;
      } else if (arg === "-h" || arg === "--help") {
        parsed.help = true;
      } else {
        parsed.unknown.push(arg);
      }
    }
    return parsed;
  }

  // Find the most recently emitted attestation under the engine's attestation dir
  // when --verify is given without an explicit path.
  function latestAttestationPath() {
    const dir = engine().conformanceAttestation.paths.ATTEST_DIR;
    if (!fs.existsSync(dir)) return null;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const abs = nodePath.join(dir, f);
        return { abs, mtime: fs.statSync(abs).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].abs : null;
  }

  function printUsage() {
    log("Usage: coord conformance [--json] [--attest] [--verify [<file>]]");
    log("");
    log("Verify this engine's conformance: the governance journal hash-chain");
    log("self-verifies end-to-end (ENT-002), and optionally emit/verify a signed");
    log("conformance attestation (ENT-010) + engine-pin drift check (ENT-011).");
    log("");
    log("Options:");
    log("  --json            Machine-readable JSON result.");
    log("  --attest          Also emit a signed attestation over the engine inputs.");
    log("  --verify [<file>] Verify an existing attestation (path, or the most");
    log("                    recent one) AND the engine-pin drift check.");
    log("  -h, --help        Show this help text.");
    log("");
    log("Exits 0 on pass; non-zero on a conformance / drift / attestation failure.");
  }

  // Run the command. Returns { code, report } — never calls process.exit so it
  // stays unit-testable. Fail-closed: a thrown engine failure → non-zero exit.
  function run(args = []) {
    const opts = parseArgs(args);
    if (opts.help) {
      printUsage();
      return { code: 0 };
    }
    if (opts.unknown.length > 0) {
      log(`coord conformance: unexpected argument(s): ${opts.unknown.join(", ")}`);
      log("Run `coord conformance --help` for usage.");
      return { code: 1 };
    }

    try {
      if (opts.verify) {
        return runVerify(opts);
      }
      return runConform(opts);
    } catch (error) {
      // The engine's fail() throws to close the command; surface a clean
      // non-zero exit + reason instead of an uncaught stack.
      if (!opts.json) {
        log(`coord conformance: FAIL — ${error.message}`);
      } else {
        log(JSON.stringify({ verdict: "fail", error: error.message }, null, 2));
      }
      return { code: 1, error: error.message };
    }
  }

  // Default + --attest path: run the engine's chain self-verify (and optional
  // attestation emit). The engine prints its own summary/JSON; we only own the
  // exit code. A failure throws (fail) and is caught in run().
  function runConform(opts) {
    const report = engine().conform({
      json: opts.json === true,
      attest: opts.attest === true,
    });
    // conform() returns the report and only throws on failure, so reaching here
    // means the verdict passed. Keep the human header consistent with the wrapper.
    if (!opts.json) {
      log(
        opts.attest
          ? "coord conformance: PASS (chain verified, attestation emitted)."
          : "coord conformance: PASS (chain verified)."
      );
    }
    return { code: 0, report };
  }

  // --verify path: verify an existing attestation (proves the signed digest +
  // live-input match) AND the engine-pin drift check. Both come from the engine.
  function runVerify(opts) {
    const target = opts.verifyPath || latestAttestationPath();
    if (!target) {
      const message =
        "no attestation found to verify — run `coord conformance --attest` first " +
        "or pass an explicit path.";
      if (!opts.json) {
        log(`coord conformance: FAIL — ${message}`);
      } else {
        log(JSON.stringify({ verdict: "fail", error: message }, null, 2));
      }
      return { code: 1, error: message };
    }

    // (1) Attestation verification — re-derives inputs, recomputes the digest,
    // checks the ed25519 signature, flags drift/tamper. This is the LOAD-BEARING,
    // fail-closed gate: it throws (fail) on tamper/drift and is caught in run().
    const attestationReport = engine().conform({
      json: opts.json === true,
      verifyAttestation: target,
    });

    // (2) Engine-pin drift check (ENT-011), read-only + INFORMATIONAL here. We
    // call enginePin.verify() directly (not verifyEngine, which fails-closed on
    // drift) so a stale pin from in-flight engine evolution does not mask a
    // PASSING attestation. The attestation already captures the manifest
    // fingerprint, so surface tamper relative to the attestation is caught in (1).
    const pinReport = engine().enginePin.verify();
    if (!opts.json) {
      if (!pinReport.pinned) {
        log("Engine pin: NONE (informational).");
      } else if (pinReport.ok) {
        log("Engine pin: IN-SYNC.");
      } else {
        log(
          `Engine pin: DRIFTED (informational — ${pinReport.problems.length} ` +
          `problem(s); re-pin with \`gov verify-engine --pin\` if intentional).`
        );
      }
      log("coord conformance: PASS (attestation verified).");
    }
    return { code: 0, report: { attestation: attestationReport, pin: pinReport } };
  }

  return { parseArgs, run, printUsage, latestAttestationPath };
};
