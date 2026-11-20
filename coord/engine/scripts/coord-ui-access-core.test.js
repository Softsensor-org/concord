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

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const UI_DIR = path.join(REPO_ROOT, "frontend", "apps", "coord-ui");

// --- (A) decision function ---------------------------------------------------

test("SEC-001: localhost-dev → ergonomic full local access, no auth, no redaction", () => {
  for (const address of ["127.0.0.1", "127.2.3.4", "::1", "::ffff:127.0.0.1"]) {
    const d = core.decideAccess({ host: "arbitrary.example", socket: { remoteAddress: address } }, { nodeEnv: "development" });
    assert.equal(d.allowed, true, `loopback ${address} allowed`);
    assert.equal(d.role, "local");
    assert.equal(d.redact, false, "local dev is unredacted/ergonomic");
  }
});

test("SEC-001: production + no auth → FAIL CLOSED (deny)", () => {
  const missing = core.decideAccess();
  assert.equal(missing.allowed, false);
  assert.equal(missing.role, null);
  assert.equal(missing.redact, true);
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
    { host: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
    { nodeEnv: "production" }
  );
  assert.equal(d.allowed, false, "prod does not trust a (spoofable) loopback host by default");
});

test("SEC-001: production loopback trust honored only when explicitly opted in", () => {
  const d = core.decideAccess(
    { host: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" } },
    { nodeEnv: "production", trustLoopback: true }
  );
  assert.equal(d.allowed, true);
  assert.equal(d.role, "local");
});

test("SEC-001: trusted role header → exactly that role (prod proxy mode)", () => {
  // COORD-940: the header is honoured only when proxy-header mode is explicitly configured.
  const viewer = core.decideAccess(
    { host: "coord.example.com", roleHeader: "viewer" },
    { nodeEnv: "production", authMode: "proxy-header" }
  );
  assert.equal(viewer.allowed, true);
  assert.equal(viewer.role, "viewer");
  assert.equal(viewer.redact, true, "viewer is a low-privilege, redacted role");

  const operator = core.decideAccess(
    { host: "coord.example.com", roleHeader: "operator" },
    { nodeEnv: "production", authMode: "proxy-header" }
  );
  assert.equal(operator.role, "operator");
  assert.equal(operator.redact, false, "operator sees sensitive fields");

  const admin = core.decideAccess(
    { host: "coord.example.com", roleHeader: "ADMIN" },
    { nodeEnv: "production", authMode: "proxy-header" }
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
    { nodeEnv: "production", authMode: "proxy-header" }
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
  // COORD-940: the bearer grants COORD_UI_DEFAULT_ROLE (or viewer); the request header is not trusted here.
  const ok = core.decideAccess({ host: "h", authToken: "s3cret-token", roleHeader: "operator" }, env);
  assert.equal(ok.allowed, true);
  assert.equal(ok.role, "viewer");
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

test("COORD-682: spoofed Host and forwarding headers cannot grant remote or missing peers local access", () => {
  for (const address of [undefined, "198.51.100.5", "0.0.0.0", "::", "::ffff:198.51.100.5"]) {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]) {
      const req = { host, socket: { remoteAddress: address }, headers: { "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost" } };
      for (const env of [{}, { nodeEnv: "development" }, { nodeEnv: "production", trustLoopback: true }]) {
        const result = core.decideAccess(req, env);
        assert.equal(result.allowed, false, `${address}/${host}`);
        assert.equal(result.redact, true);
      }
    }
  }
});

test("COORD-682: explicit auth modes cannot be bypassed even by actual loopback peers", () => {
  const req = { host: "localhost", socket: { remoteAddress: "127.0.0.1" } };
  for (const nodeEnv of [undefined, "development", "production"]) {
    const env = { nodeEnv, trustLoopback: true, authMode: "shared-token", sharedToken: "fixture-secret" };
    for (const authToken of [undefined, "wrong"]) assert.equal(core.decideAccess({ ...req, authToken }, env).allowed, false);
    assert.equal(core.decideAccess({ ...req, authToken: "fixture-secret" }, env).role, "viewer");
    assert.equal(core.decideAccess(req, { ...env, authMode: "proxy-header" }).allowed, false);
    assert.equal(core.decideAccess({ ...req, roleHeader: "operator" }, { ...env, authMode: "proxy-header" }).role, "operator");
    assert.equal(core.decideAccess({ ...req, roleHeader: "admin", authToken: "fixture-secret" }, { ...env, authMode: "typo" }).allowed, false);
    assert.equal(core.decideAccess(req, { ...env, authMode: "localhost-dev" }).role, "local");
  }
  assert.equal(core.decideAccess(req, { trustLoopback: false }).allowed, false);
});

test("COORD-682: socket address parsing accepts only loopback IPs, including IPv4-mapped IPv6", () => {
  for (const address of ["127.0.0.1", "127.255.255.255", "::1", "::0001", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7fff:ffff"])
    assert.equal(core.isLoopbackAddress(address), true, address);
  for (const address of [null, 127, "", "localhost", "[::1]", "::1:3002", "127.0.0.1:3002", "127.0.0.1 ", "127.1", "0177.0.0.1", "127.0.0.256", "::", "0.0.0.0", "192.168.1.1", "::ffff:192.168.1.1", "2001:db8::1", ":::1", "::1::", "0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0:1", "::1%lo"])
    assert.equal(core.isLoopbackAddress(address), false, String(address));
});

// --- COORD-940: trusted role header, peer address and bind scope -------------

test("COORD-940: localhost-dev ignores a role header from a remote peer (header alone never grants)", () => {
  for (const role of ["viewer", "operator", "admin"]) {
    const d = core.decideAccess(
      { host: "localhost", roleHeader: role, socket: { remoteAddress: "198.51.100.5" } },
      { nodeEnv: "development" }
    );
    assert.equal(d.allowed, false, `remote dev peer with ${role} header is denied`);
    assert.equal(d.role, null);
    assert.equal(d.redact, true);
  }
});

test("COORD-940: localhost-dev ignores a role header even from a loopback peer (loopback gets local, not the header role)", () => {
  const d = core.decideAccess(
    { roleHeader: "viewer", socket: { remoteAddress: "127.0.0.1" } },
    { nodeEnv: "development" }
  );
  assert.equal(d.allowed, true);
  assert.equal(d.role, "local", "loopback local role, not the spoofable header value");
});

test("COORD-940: a missing peer address is denied in dev, even with a role header or spoofed loopback host", () => {
  for (const req of [
    { host: "127.0.0.1", roleHeader: "admin" },
    { host: "localhost", roleHeader: "operator", socket: {} },
    { host: "localhost", roleHeader: "operator", socket: { remoteAddress: "" } },
  ]) {
    const d = core.decideAccess(req, { nodeEnv: "development" });
    assert.equal(d.allowed, false, JSON.stringify(req));
  }
});

test("COORD-940: proxy-header mode still honours the trusted role header from any peer", () => {
  const viewer = core.decideAccess(
    { roleHeader: "viewer", socket: { remoteAddress: "10.0.0.7" } },
    { nodeEnv: "production", authMode: "proxy-header" }
  );
  assert.equal(viewer.allowed, true);
  assert.equal(viewer.role, "viewer");
  const operator = core.decideAccess(
    { roleHeader: "operator" },
    { authMode: "proxy-header" }
  );
  assert.equal(operator.role, "operator", "explicit proxy-header honours the header without a socket");
});

test("COORD-940: production without an explicitly configured proxy-header mode does not honour the header", () => {
  const d = core.decideAccess({ roleHeader: "admin" }, { nodeEnv: "production" });
  assert.equal(d.allowed, false, "header is not trusted unless the operator configures proxy-header");
});

test("COORD-940: shared-token mode does not take its role from the spoofable header", () => {
  const env = { nodeEnv: "production", authMode: "shared-token", sharedToken: "s3cret-token" };
  const d = core.decideAccess({ authToken: "s3cret-token", roleHeader: "admin" }, env);
  assert.equal(d.allowed, true);
  assert.equal(d.role, "viewer", "role comes from COORD_UI_DEFAULT_ROLE, never the request header");
  const withDefault = core.decideAccess(
    { authToken: "s3cret-token", roleHeader: "admin" },
    { ...env, defaultRole: "operator" }
  );
  assert.equal(withDefault.role, "operator");
});

test("COORD-940: runtime peer is loopback only when the launcher bind-scope marker says loopback", () => {
  assert.deepEqual(core.resolveRuntimePeer({ bindScope: "loopback" }), { remoteAddress: "127.0.0.1" });
  assert.equal(core.resolveRuntimePeer({ bindScope: "remote" }), null);
  assert.equal(core.resolveRuntimePeer({ bindScope: "" }), null, "unknown bind scope yields no peer");
  assert.equal(core.resolveRuntimePeer({}), null);
  assert.equal(core.resolveRuntimePeer(undefined), null);
});

test("COORD-940: with no runtime peer, a dev request is denied even though the middleware exists", () => {
  const d = core.decideAccess({ host: "localhost", socket: core.resolveRuntimePeer({ bindScope: "remote" }) }, { nodeEnv: "development" });
  assert.equal(d.allowed, false);
});

test("COORD-940: middleware and server guard hand the runtime peer to the core (no header-derived peer)", () => {
  for (const f of [path.join(UI_DIR, "middleware.ts"), path.join(UI_DIR, "lib", "access.ts")]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /resolveRuntimePeer\(/, `${path.basename(f)} resolves the runtime peer`);
    assert.match(src, /decideAccess\(\{[^}]*\bsocket\b/, `${path.basename(f)} passes a socket to decideAccess`);
    assert.doesNotMatch(src, /x-forwarded-for|x-real-ip/i, `${path.basename(f)} never trusts forwarding headers`);
  }
});
