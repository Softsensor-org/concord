const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function createAgentHarness(statusByTicket = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-agent-facade-"));
  const agentSourcePath = path.join(__dirname, "agent");
  const agentPath = path.join(tempDir, "agent");
  const govPath = path.join(tempDir, "gov");
  const logPath = path.join(tempDir, "gov-calls.ndjson");

  fs.copyFileSync(agentSourcePath, agentPath);
  fs.chmodSync(agentPath, 0o755);

  fs.writeFileSync(govPath, `#!/usr/bin/env node
const fs = require("fs");

const logPath = process.env.AGENT_FACADE_LOG_PATH;
const statusByTicket = JSON.parse(process.env.AGENT_FACADE_STATUS_MAP || "{}");
const [,, command, ...args] = process.argv;

if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ command, args }) + "\\n", "utf8");
}

if (command === "ticket") {
  const ticket = args[0];
  const status = statusByTicket[ticket];
  if (!status) {
    console.error(\`unknown test ticket \${ticket}\`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    ticket: {
      ID: ticket,
      Status: status,
    },
  }));
  process.exit(0);
}

if (command === "start" || command === "resume") {
  process.stdout.write(\`\${command} \${args[0]}\\n\`);
  process.exit(0);
}

if (command === "explain") {
  process.stdout.write(JSON.stringify({
    ticket: {
      ID: args[0],
    },
  }));
  process.exit(0);
}

console.error(\`unexpected governance command: \${command}\`);
process.exit(70);
`, "utf8");
  fs.chmodSync(govPath, 0o755);

  return { tempDir, agentPath, logPath, statusByTicket };
}

function readGovCalls(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs.readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runAgent(agentPath, args, statusByTicket, logPath) {
  return spawnSync(agentPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_FACADE_STATUS_MAP: JSON.stringify(statusByTicket),
      AGENT_FACADE_LOG_PATH: logPath,
    },
  });
}

test("agent do starts todo tickets via gov start without pre-claim side effects", () => {
  const harness = createAgentHarness({ "GOV-052": "todo" });
  const result = runAgent(harness.agentPath, ["do", "GOV-052"], harness.statusByTicket, harness.logPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "ticket", args: ["GOV-052"] },
    { command: "start", args: ["GOV-052"] },
    { command: "explain", args: ["GOV-052"] },
  ]);
});

test("agent do prepare resumes in-flight tickets via gov resume", () => {
  const harness = createAgentHarness({ "GOV-052": "doing" });
  const result = runAgent(harness.agentPath, ["do", "prepare", "GOV-052"], harness.statusByTicket, harness.logPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "ticket", args: ["GOV-052"] },
    { command: "resume", args: ["GOV-052"] },
    { command: "explain", args: ["GOV-052"] },
  ]);
});

test("agent resume does not pre-assign before gov resume", () => {
  const harness = createAgentHarness({ "GOV-052": "doing" });
  const result = runAgent(harness.agentPath, ["resume", "GOV-052"], harness.statusByTicket, harness.logPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "resume", args: ["GOV-052"] },
    { command: "explain", args: ["GOV-052"] },
  ]);
});

test("agent do prepare falls back to explain for non-runnable statuses", () => {
  const harness = createAgentHarness({ "GOV-043": "done" });
  const result = runAgent(harness.agentPath, ["do", "prepare", "GOV-043"], harness.statusByTicket, harness.logPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readGovCalls(harness.logPath), [
    { command: "ticket", args: ["GOV-043"] },
    { command: "explain", args: ["GOV-043"] },
  ]);
});

// GOV-070 — facade identity-write lint
//
// The facade at coord/scripts/agent dispatches to governance CLI verbs. It
// MUST NOT invoke identity-state-writing commands (claim, agentid --assign,
// agents register, takeover, lock-abandon, agent-rebind) because those
// manufacture handle/session churn ahead of the core lifecycle verb's
// decision. GOV-052 fixed one such instance in `agent do`; this lint exists
// to catch any future regression.
//
// The allow-list below names only commands whose identity-state effects are
// either read-only (ticket, explain, pick, doctor, counts) or gated by an
// explicit ticket-lifecycle verb decision (start, resume, submit, finalize,
// land, recover).
const FACADE_ALLOWED_GOV_COMMANDS = new Set([
  "ticket",
  "explain",
  "pick",
  "doctor",
  "counts",
  "start",
  "resume",
  "submit",
  "finalize",
  "land",
  "recover",
]);

const FACADE_FORBIDDEN_GOV_COMMANDS = new Set([
  "claim",
  "agentid",
  "agents",
  "takeover",
  "lock-abandon",
  "agent-rebind",
  "release-lock",
  "reconcile",
  "mark-done",
  "break-runtime-lock",
]);

function collectFacadeGovInvocations(source) {
  // Match bash invocations of the form `"$GOV" <command>` or `$GOV <command>`,
  // including lines that start the command after other shell tokens.
  const pattern = /"\$GOV"\s+([a-zA-Z][a-zA-Z0-9_-]*)/g;
  const invocations = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    invocations.push(match[1]);
  }
  return invocations;
}

test("GOV-070 facade lint: coord/scripts/agent only invokes allowed governance commands", () => {
  const facadeSource = fs.readFileSync(path.join(__dirname, "agent"), "utf8");
  const invocations = collectFacadeGovInvocations(facadeSource);

  assert.ok(invocations.length > 0, "facade should invoke at least one governance command");

  const unexpected = invocations.filter((cmd) => !FACADE_ALLOWED_GOV_COMMANDS.has(cmd));
  assert.deepEqual(
    unexpected,
    [],
    `facade is invoking governance commands outside the allow-list: ${unexpected.join(", ")}. ` +
    `If a new command must be dispatched from the facade, add it to FACADE_ALLOWED_GOV_COMMANDS ` +
    `only after confirming it is either read-only or gated by an explicit ticket-lifecycle verb.`
  );
});

test("GOV-070 facade lint: coord/scripts/agent never invokes identity-state-writing governance commands", () => {
  const facadeSource = fs.readFileSync(path.join(__dirname, "agent"), "utf8");
  const invocations = collectFacadeGovInvocations(facadeSource);

  const forbidden = invocations.filter((cmd) => FACADE_FORBIDDEN_GOV_COMMANDS.has(cmd));
  assert.deepEqual(
    forbidden,
    [],
    `facade is invoking identity-state-writing governance commands: ${forbidden.join(", ")}. ` +
    `These manufacture handle/session churn ahead of the core lifecycle verb's decision ` +
    `(see GOV-052 / GOV-070). Route identity mutations through the core verb that needs them, ` +
    `or expose an explicit user-facing repair command (e.g., agent recover).`
  );
});

test("GOV-070 facade lint: coord/scripts/agent never writes runtime identity files directly", () => {
  const facadeSource = fs.readFileSync(path.join(__dirname, "agent"), "utf8");
  const forbiddenPaths = [
    ".runtime/agents.json",
    ".runtime/agent_sessions.json",
    "agents.json",
    "agent_sessions.json",
    "session-owners/",
  ];

  const hits = forbiddenPaths.filter((p) => facadeSource.includes(p));
  assert.deepEqual(
    hits,
    [],
    `facade references canonical runtime identity files: ${hits.join(", ")}. ` +
    `Only coord/scripts/gov may read or write these files; the facade must delegate.`
  );
});

test("GOV-070 facade lint: collectFacadeGovInvocations catches forbidden and missed commands in synthetic input", () => {
  const clean = '"$GOV" start "$1"\n"$GOV" resume "$1"\n';
  assert.deepEqual(collectFacadeGovInvocations(clean), ["start", "resume"]);

  const dirty = '"$GOV" claim --owner claudea11\n"$GOV" explain "$1"\n';
  const calls = collectFacadeGovInvocations(dirty);
  assert.ok(calls.includes("claim"), "linter must surface forbidden claim invocation");
  assert.ok(calls.includes("explain"), "linter must also surface allowed invocations");
});
