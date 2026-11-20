"use strict";

// Explicit dependency injection for isolated ADR 0031 tests. Production
// approval selection never reads fixture paths or NODE_TEST_CONTEXT.
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function createApprovalTestClient({ anchorPath, signArgv }) {
  if (typeof anchorPath !== "string" || !path.isAbsolute(anchorPath)) {
    throw new TypeError("approval test client requires an absolute fixture anchor path");
  }
  if (!Array.isArray(signArgv) || signArgv.length === 0 || !signArgv.every((part) => typeof part === "string")) {
    throw new TypeError("approval test client requires a fixture signer argv array");
  }
  const verifier = require("../approval-verifier.js");
  const anchor = verifier.loadTrustAnchor(anchorPath);
  if (!anchor.ok) throw new Error(`invalid approval test anchor: ${anchor.detail}`);

  const runSign = (requestText) => {
    const [command, ...args] = signArgv;
    const result = spawnSync(command, args, {
      input: requestText,
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH || "/usr/bin:/bin" },
      shell: false,
    });
    if (result.error || result.status !== 0) {
      let refused = "store-unavailable";
      try { refused = JSON.parse((result.stderr || "").trim().split("\n").pop()).refused || refused; } catch { /* malformed refusal */ }
      return { ok: false, refused, detail: `fixture sign exited ${result.status}` };
    }
    return { ok: true, stdout: result.stdout };
  };
  return Object.freeze({ anchor, runSign });
}

// Patch only the verifier module graph explicitly named by the test harness,
// and restore it synchronously when that isolated command finishes.
function installApprovalTestClient(coordDir, client) {
  if (!path.isAbsolute(coordDir) || !client || typeof client.runSign !== "function" || !client.anchor?.ok) {
    throw new TypeError("withApprovalTestClient requires an isolated coord root and fixture client");
  }
  const engineScripts = path.join(coordDir, "engine", "scripts");
  const verifierPath = path.join(engineScripts, "approval-verifier.js");
  const verifier = require(verifierPath);
  const originals = Object.fromEntries(["requestApproval", "requireHumanAdminApproval", "requireHumanAdminApprovalForState", "requireSignedOverride"]
    .map((name) => [name, verifier[name]]));
  verifier.requestApproval = (options) => originals.requestApproval({ ...options, ...client });
  verifier.requireHumanAdminApproval = (options) => originals.requireHumanAdminApproval({ ...options, ...client });
  verifier.requireHumanAdminApprovalForState = (options) => originals.requireHumanAdminApprovalForState({ ...options, approvalClient: client });
  verifier.requireSignedOverride = (options) => originals.requireSignedOverride({ ...options, approvalClient: client });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, original] of Object.entries(originals)) verifier[name] = original;
  };
}

function withApprovalTestClient(coordDir, client, callback) {
  if (typeof callback !== "function") throw new TypeError("withApprovalTestClient requires a callback");
  const restore = installApprovalTestClient(coordDir, client);
  try { return callback(); } finally { restore(); }
}

module.exports = { createApprovalTestClient, installApprovalTestClient, withApprovalTestClient };
