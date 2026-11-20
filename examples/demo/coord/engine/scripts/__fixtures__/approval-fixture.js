"use strict";

// ADR 0031 section 5: test-only approval fixture. A keypair and a fixture wrapper live in
// a fresh mkdtemp directory per test. Nothing here touches /etc, /var/lib, /usr/local or sudo.
// The fixture is consumed only through explicit test-harness dependency injection.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");
const { createApprovalTestClient, withApprovalTestClient } = require("./approval-test-client.js");

const VERIFIER_PATH = path.resolve(__dirname, "..", "approval-verifier.js");

const WRAPPER_SOURCE = `"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { canonicalJson } = require(${JSON.stringify(VERIFIER_PATH)});
const dir = __dirname;
const refuse = (code) => { process.stderr.write(JSON.stringify({ refused: code }) + "\\n"); process.exit(3); };
const [, , command] = process.argv;
if (command !== "sign") refuse("bad-request");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (input.length > 4096) refuse("bad-request"); });
process.stdin.on("end", () => {
  let request;
  try { request = JSON.parse(input); } catch { refuse("bad-request"); }
  if (request.schema !== "coord.approval-request/v1") refuse("bad-request");
  const allowed = JSON.parse(fs.readFileSync(path.join(dir, "allowed-verbs.json"), "utf8"));
  if (!allowed.includes(request.verb)) refuse("verb-not-allowed");
  const sessionPath = path.join(dir, "session.json");
  if (!fs.existsSync(sessionPath)) refuse("no-session");
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  if (Date.now() > Date.parse(session.expires_at)) refuse("session-expired");
  if (session.uses_remaining < 1) refuse("session-used");
  if (session.verb !== request.verb || session.ticket !== request.ticket || session.subject_sha256 !== request.subject_sha256) refuse("scope-mismatch");
  const noncePath = path.join(dir, "nonces.jsonl");
  const nonces = fs.existsSync(noncePath) ? fs.readFileSync(noncePath, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (nonces.some((n) => n.nonce === request.nonce)) refuse("nonce-reused");
  const recordId = crypto.randomBytes(16).toString("hex");
  session.uses_remaining = 0;
  fs.writeFileSync(sessionPath, JSON.stringify(session));
  fs.appendFileSync(noncePath, JSON.stringify({ nonce: request.nonce, record_id: recordId }) + "\\n");
  const issued = new Date();
  const unsigned = {
    schema: "coord.approval-record/v1",
    record_id: recordId,
    verb: request.verb,
    ticket: request.ticket,
    subject_sha256: request.subject_sha256,
    nonce: request.nonce,
    session_id: session.session_id,
    issued_at: issued.toISOString(),
    expires_at: new Date(issued.getTime() + 5 * 60 * 1000).toISOString(),
    key_id: session.key_id,
  };
  const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(dir, "approval-private.pem")));
  const signature = crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64");
  process.stdout.write(JSON.stringify({ ...unsigned, signature }) + "\\n");
});
`;

// Creates an isolated fixture: keypair, trust anchor, allow-list and fixture wrapper.
function createApprovalFixture({ allowedVerbs = ["approve", "reject", "claim --transfer-to", "integration handoff"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-approval-fixture-"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const anchorPath = path.join(dir, "approval-public.pem");
  fs.writeFileSync(path.join(dir, "approval-private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(anchorPath, publicKey.export({ type: "spki", format: "pem" }));
  const keyId = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  fs.writeFileSync(path.join(dir, "allowed-verbs.json"), JSON.stringify(allowedVerbs));
  const wrapperPath = path.join(dir, "fixture-coord-approve.js");
  fs.writeFileSync(wrapperPath, WRAPPER_SOURCE);
  const signArgv = [process.execPath, wrapperPath, "sign"];

  // Test-only login: writes the fixture session that the fixture wrapper consumes once.
  function login({ verb, ticket, subject_sha256, ttlMinutes = 15, now = Date.now() }) {
    const session = {
      session_id: crypto.randomBytes(16).toString("hex"),
      verb,
      ticket,
      subject_sha256,
      key_id: keyId,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMinutes * 60 * 1000).toISOString(),
      uses_remaining: 1,
    };
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(session));
    return session;
  }

  function client() { return createApprovalTestClient({ anchorPath, signArgv }); }

  // Run a synthetic workspace's governance CLI through a generated `node -e`
  // bootstrap. The target coord root and fixture credentials are closed over in
  // the generated source along with the governance arguments. No shipped
  // executable accepts a coord root, anchor, or signer from argv.
  function runCli(coordDir, args, options = {}) {
    if (typeof coordDir !== "string" || !path.isAbsolute(coordDir) || !Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      throw new TypeError("approval fixture CLI requires an absolute synthetic coord root and string arguments");
    }
    const helperPath = path.join(coordDir, "engine", "scripts", "__fixtures__", "approval-test-client.js");
    const entry = path.join(coordDir, "scripts", "governance.js");
    const bootstrap = [
      `const helper = require(${JSON.stringify(helperPath)});`,
      `const coordDir = ${JSON.stringify(coordDir)};`,
      `const entry = ${JSON.stringify(entry)};`,
      `const client = helper.createApprovalTestClient({anchorPath:${JSON.stringify(anchorPath)},signArgv:${JSON.stringify(signArgv)}});`,
      `process.argv = [process.execPath, entry, ...${JSON.stringify(args)}];`,
      `helper.withApprovalTestClient(coordDir, client, () => require(entry).main());`,
    ].join("\n");
    return spawnSync(process.execPath, ["-e", bootstrap], options);
  }

  function cleanup() {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { dir, anchorPath, keyId, signArgv, login, client, runCli, cleanup };
}

// Test-only: runs one claim --transfer-to attempt. When it refuses for the missing signed record, the
// subject digest that refusal prints is logged in on the fixture (the same digest a human reads before
// `login`), and the attempt runs once more. Any other refusal is returned unchanged.
function retryTransferWithLogin(fixture, ticket, run) {
  const first = run();
  const failed = first.ok === false || (typeof first.status === "number" && first.status !== 0);
  const text = [first.stdout, first.stderr, first.error].filter(Boolean).map(String).join("\n");
  const digest = /Subject digest: ([0-9a-f]{64})/.exec(text);
  if (!failed || !digest) return first;
  fixture.login({ verb: "claim --transfer-to", ticket, subject_sha256: digest[1] });
  return run();
}

// Sign only the requested verb, ticket and subject reported by the real unsigned attempt.
// Only the isolated command under test receives the test signer.
function runFixtureApproval(verb, ticket, unsigned, retry) {
  const first = unsigned();
  const diagnostic = [first.error, first.stderr, first.stdout].filter(Boolean).join("\n");
  const subject = /Subject digest: ([0-9a-f]{64})/.exec(diagnostic);
  if (!(first.ok === false || first.status > 0) || !subject ||
      !diagnostic.includes(`${verb} on ${ticket} requires a signed human-admin approval`)) return first;
  const approval = createApprovalFixture({ allowedVerbs: [verb] });
  try {
    approval.login({ verb, ticket, subject_sha256: subject[1] });
    return retry(approval);
  } finally { approval.cleanup(); }
}

function runFixtureReconcile(unsigned, retry) {
  return runFixtureApproval("reconcile", "control-plane", unsigned, retry);
}

function invokeFixtureReconcile(coordDir, invoke, args) {
  return runFixtureReconcile(() => invoke(args), (approval) =>
    withApprovalTestClient(coordDir, approval.client(), () => invoke(args)));
}

module.exports = { createApprovalFixture, retryTransferWithLogin, runFixtureApproval, runFixtureReconcile, invokeFixtureReconcile };
