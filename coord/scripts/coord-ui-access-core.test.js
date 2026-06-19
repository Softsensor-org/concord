"use strict";

// SEC-001 — unit tests for the coord-ui access-control + redaction core.
//
// Two contracts are pinned here:
//   (A) the decision function: localhost-dev → ergonomic full access; production
//       without auth → fail-closed deny; a trusted role header → exactly that role;
//       a low-privilege (viewer) view is flagged for redaction.
//   (B) the redaction helpers: sensitive fields (abs paths, PIDs, cmdlines,
//       session/owner identifiers, PR refs, cost) are redacted for low-privilege
//       roles and preserved for privileged ones.
//   (C) read-only invariant: the core never exposes any mutation/spawn verb and
//       the coord-ui server access guard / middleware carry no write surface.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const core = require("./coord-ui-access-core.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UI_DIR = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");

// --- (A) decision function ---------------------------------------------------

test("SEC-001: localhost-dev → ergonomic full local access, no auth, no redaction", () => {
  for (const host of ["localhost", "localhost:3002", "127.0.0.1:3002", "[::1]:3002"]) {
    const d = core.decideAccess({ host }, { nodeEnv: "development" });
    assert.equal(d.allowed, true, `loopback ${host} allowed`);
    assert.equal(d.role, "local");
    assert.equal(d.redact, false, "local dev is unredacted/ergonomic");
  }
});

test("SEC-001: production + no auth → FAIL CLOSED (deny)", () => {
  const d = core.decideAccess(
    { host: "coord.example.com" },
    { nodeEnv: "production" }
  );
  assert.equal(d.allowed, false, "unauthenticated prod is denied");
  assert.equal(d.role, null);
  assert.equal(d.redact, true, "denied requests are redact-by-default");
});

test("SEC-001: production loopback trust is OFF by default (no host-header trust in prod)", () => {
  const d = core.decideAccess(
    { host: "127.0.0.1" },
    { nodeEnv: "production" }
  );
  assert.equal(d.allowed, false, "prod does not trust a (spoofable) loopback host by default");
});

test("SEC-001: production loopback trust honored only when explicitly opted in", () => {
  const d = core.decideAccess(
    { host: "127.0.0.1" },
    { nodeEnv: "production", trustLoopback: true }
  );
  assert.equal(d.allowed, true);
  assert.equal(d.role, "local");
});

test("SEC-001: trusted role header → exactly that role (prod proxy mode)", () => {
  const viewer = core.decideAccess(
    { host: "coord.example.com", roleHeader: "viewer" },
    { nodeEnv: "production" }
  );
  assert.equal(viewer.allowed, true);
  assert.equal(viewer.role, "viewer");
  assert.equal(viewer.redact, true, "viewer is a low-privilege, redacted role");

  const operator = core.decideAccess(
    { host: "coord.example.com", roleHeader: "operator" },
    { nodeEnv: "production" }
  );
  assert.equal(operator.role, "operator");
  assert.equal(operator.redact, false, "operator sees sensitive fields");

  const admin = core.decideAccess(
    { host: "coord.example.com", roleHeader: "ADMIN" },
    { nodeEnv: "production" }
  );
  assert.equal(admin.role, "admin", "header role is case-insensitive");
  assert.equal(admin.redact, false);
});

test("SEC-001: an unknown/garbage role header is NOT honored (fail-closed)", () => {
  const d = core.decideAccess(
    { host: "coord.example.com", roleHeader: "superuser" },
    { nodeEnv: "production" }
  );
  assert.equal(d.allowed, false, "unknown role → denied");
});

test("SEC-001: the implicit 'local' role can never be claimed via a header", () => {
  const d = core.decideAccess(
    { host: "coord.example.com", roleHeader: "local" },
    { nodeEnv: "production" }
  );
  assert.equal(d.allowed, false, "'local' is loopback-only, never header-grantable");
});

test("SEC-001: shared-token mode denies without/with-wrong token, grants with the right one", () => {
  const env = { nodeEnv: "production", authMode: "shared-token", sharedToken: "s3cret-token" };
  assert.equal(core.decideAccess({ host: "h" }, env).allowed, false, "no token → deny");
  assert.equal(
    core.decideAccess({ host: "h", authToken: "wrong" }, env).allowed,
    false,
    "wrong token → deny"
  );
  const ok = core.decideAccess({ host: "h", authToken: "s3cret-token", roleHeader: "operator" }, env);
  assert.equal(ok.allowed, true);
  assert.equal(ok.role, "operator");
});

test("SEC-001: shared-token mode with no configured token fails closed", () => {
  const d = core.decideAccess(
    { host: "h", authToken: "anything" },
    { nodeEnv: "production", authMode: "shared-token" }
  );
  assert.equal(d.allowed, false, "misconfiguration must fail closed, not open");
});

// --- (B) redaction helpers ---------------------------------------------------

test("SEC-001: low-privilege (viewer) view redacts the sensitive field set", () => {
  const role = "viewer";
  assert.equal(core.redactField("path", "/srv/app/coord/secret.json", role), ".../secret.json");
  assert.equal(core.redactField("pid", 48317, role), core.REDACTED);
  assert.equal(core.redactField("cmdline", "node gate.js --full", role), core.REDACTED);
  assert.equal(core.redactField("identity", "coord-sec-001", role), core.REDACTED);
  assert.equal(core.redactField("pr", "https://github.com/x/y/pull/35", role), core.REDACTED);
  assert.equal(core.redactField("cost", 12.34, role), core.REDACTED);
});

test("SEC-001: privileged roles (operator/admin/local) see sensitive fields unredacted", () => {
  for (const role of ["operator", "admin", "local"]) {
    assert.equal(core.redactField("path", "/abs/path", role), "/abs/path");
    assert.equal(core.redactField("pid", 1234, role), 1234);
    assert.equal(core.redactField("identity", "claudea126", role), "claudea126");
    assert.equal(core.shouldRedactForRole(role), false);
  }
});

test("SEC-001: redaction is fail-safe for null/unknown role (redacts)", () => {
  assert.equal(core.shouldRedactForRole(null), true);
  assert.equal(core.shouldRedactForRole("nope"), true);
  assert.equal(core.redactField("identity", "owner-x", null), core.REDACTED);
});

test("SEC-001: redactPath keeps relative paths, basenames absolute ones", () => {
  assert.equal(core.redactPath("coord/board/tasks.json"), "coord/board/tasks.json");
  assert.equal(core.redactPath("/srv/u/coord/.runtime/locks/x.lock"), ".../x.lock");
  assert.equal(core.redactPath("C:\\\\Users\\\\u\\\\coord\\\\x.json"), ".../x.json");
});

test("SEC-001: redactField is a no-op for empty/null inputs (no '[redacted]' noise)", () => {
  assert.equal(core.redactField("cmdline", null, "viewer"), null);
  assert.equal(core.redactField("pid", null, "viewer"), null);
});

// --- (C) read-only invariant -------------------------------------------------

test("SEC-001: access core exposes NO mutation/spawn/exec verb", () => {
  const keys = Object.keys(core);
  const forbidden = /(write|spawn|exec|kill|signal|mutat|delete|remove|record|reap|child_process)/i;
  for (const k of keys) {
    assert.equal(forbidden.test(k), false, `core export "${k}" must not be a mutation verb`);
  }
});

test("SEC-001: the access core has no fs/child_process/network imports (edge-safe, pure)", () => {
  const src = fs.readFileSync(path.join(__dirname, "coord-ui-access-core.js"), "utf8");
  for (const banned of ["node:fs", "node:child_process", "child_process", "node:net", "node:http", "fetch("]) {
    assert.equal(src.includes(banned), false, `access core must not reference ${banned}`);
  }
});

test("SEC-001: coord-ui middleware + server access guard carry no write/spawn surface", () => {
  const files = [
    path.join(UI_DIR, "middleware.ts"),
    path.join(UI_DIR, "lib", "access.ts"),
  ];
  const forbidden = [
    "writeFileSync",
    "writeFile(",
    "child_process",
    "execSync",
    "execFileSync",
    "spawn(",
    "spawnSync",
    ".unlink",
    "rmSync",
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(f), `${f} must exist`);
    const src = fs.readFileSync(f, "utf8");
    for (const bad of forbidden) {
      assert.equal(src.includes(bad), false, `${path.basename(f)} must not contain "${bad}"`);
    }
  }
});
