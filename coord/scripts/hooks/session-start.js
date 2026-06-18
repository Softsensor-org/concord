#!/usr/bin/env node
// GCV-1 — SessionStart hook: durable governance identity.
//
// Claude Code runs SessionStart on startup, resume, /clear, AND compaction,
// passing JSON on stdin: { session_id, transcript_path, cwd, source }.
// Vars written to $CLAUDE_ENV_FILE persist into later Bash commands in the
// same Claude session — that is the durable channel governance was missing.
//
// Exports:
//   COORD_PROVIDER=claude-code
//   COORD_PROVIDER_SESSION_ID=<session_id>     (durable identity)
//   COORD_TRANSCRIPT_PATH=<transcript_path>    (audit/forensics)
//   COORD_INSTANCE_ID=<uuid>                   (live-exclusivity token)
//   CLAUDE_SESSION_ID=<session_id>             (bridges existing engine)
//
// Source-aware (the trap GCV-1 must avoid): a fresh COORD_INSTANCE_ID is
// minted ONLY for a genuine new live attach (source=startup|resume). For
// source=clear|compact the prior instance id is PRESERVED — otherwise one
// live terminal manufactures a false split-brain against itself on every
// compaction.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const NEW_INSTANCE_SOURCES = new Set(["startup", "resume"]);
// clear | compact (and anything unknown) preserve the existing instance.

// Pure: given the hook input and the prior instance registry, decide the
// env to export and the next registry state. No IO — unit-tested directly.
function computeSessionEnv(input, registry) {
  const sessionId = String(input && input.session_id ? input.session_id : "").trim();
  const transcriptPath = String(
    input && input.transcript_path ? input.transcript_path : ""
  ).trim();
  const source = String(input && input.source ? input.source : "startup").trim();
  const reg = registry && typeof registry === "object" ? { ...registry } : {};
  const prior = sessionId && reg[sessionId] ? reg[sessionId] : null;

  let instanceId;
  if (NEW_INSTANCE_SOURCES.has(source) || !prior || !prior.instance_id) {
    instanceId = crypto.randomUUID();
  } else {
    // clear / compact / unknown -> keep the live instance id.
    instanceId = prior.instance_id;
  }

  const nextRegistry = { ...reg };
  if (sessionId) {
    nextRegistry[sessionId] = {
      instance_id: instanceId,
      transcript_path: transcriptPath || (prior && prior.transcript_path) || "",
      last_source: source,
      updated_at: new Date().toISOString(),
    };
  }

  const env = {
    COORD_PROVIDER: "claude-code",
    COORD_PROVIDER_SESSION_ID: sessionId,
    COORD_TRANSCRIPT_PATH: transcriptPath,
    COORD_INSTANCE_ID: instanceId,
    CLAUDE_SESSION_ID: sessionId,
  };
  return { env, nextRegistry, source, reusedInstance: instanceId === (prior && prior.instance_id) };
}

function envFileBody(env) {
  return (
    Object.entries(env)
      .filter(([, v]) => v !== "" && v != null)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const runtimeDir = path.resolve(__dirname, "..", "..", ".runtime");
  const registryPath = path.join(runtimeDir, "session-instances.json");

  let input = {};
  const raw = readStdin();
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
  }

  const registry = readJsonSafe(registryPath, {});
  const { env, nextRegistry } = computeSessionEnv(input, registry);

  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify(nextRegistry, null, 2) + "\n", "utf8");
  } catch {
    /* runtime dir unavailable: still export env below (best-effort) */
  }

  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    try {
      fs.appendFileSync(envFile, envFileBody(env), "utf8");
    } catch {
      /* env-file unwritable: nothing else we can safely do */
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { computeSessionEnv, envFileBody, NEW_INSTANCE_SOURCES };
