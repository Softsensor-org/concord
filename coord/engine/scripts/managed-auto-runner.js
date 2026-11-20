"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TARGET_CLASSES } = require("./capability-broker.js");
const { createManagedAutoPolicy, evaluateManagedAction, sanitizeEnvironment } = require("./managed-auto-policy.js");
const { LedgerNormalizationError, createSessionRecorder, readManagedLedger, secretValuesFromEnvironment } = require("./managed-auto-ledger.js");

function canEstablishContainment(options = {}) {
  const controls = options.controls || {};
  return options.provider?.supported === true && controls.hooks === true && controls.sandbox === true && controls.environment === true;
}

function prepareManagedAuto(options = {}) {
  const policy = createManagedAutoPolicy(options);
  if (policy.evidence_coverage !== "complete") throw new Error("managed-auto containment cannot be established");
  const filtered = sanitizeEnvironment(options.environment || process.env, options.environment_allowlist || ["PATH", "LANG", "CI"]);
  // sanitizeEnvironment keeps only allowlisted keys.
  const allowlist = new Set(options.environment_allowlist || ["PATH", "LANG", "CI"]);
  filtered.removed = Object.keys(options.environment || process.env).filter((key) => !allowlist.has(key) || filtered.removed.includes(key));
  // This helper has no production tool hook. Caller-supplied control claims and
  // spawn callbacks do not establish an enforced runtime boundary.
  return { policy, environment: filtered.environment, removed_environment_keys: filtered.removed, runtime_enforcement: "unimplemented" };
}

function defaultSpawn(command, options) { return childProcess.execFileSync("/bin/sh", ["-c", command], { ...options, encoding: "utf8" }); }

// COORD-860: the local, ignored managed-auto evidence for one ticket: the
// existing action ledger and the declared policy it is bound to by digest.
function managedEvidencePaths(runtimeDir, ticket) {
  const dir = path.join(runtimeDir, "action-ledgers");
  return { ledger: path.join(dir, `${ticket}.ndjson`), policy: path.join(dir, `${ticket}.policy.json`) };
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fileDigest = (file) => (fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null);

// A managed session records every effect it dispatches as an attempt before
// dispatch and a terminal result after it, on the existing v2 chain. A replayed
// attempt never dispatches again; an attempt with no recorded result is an
// unknown outcome and is refused rather than relaunched.
function startManagedSession(options = {}) {
  const prepared = prepareManagedAuto(options);
  const { policy, environment } = prepared;
  const files = managedEvidencePaths(options.runtime_dir, policy.ticket);
  fs.mkdirSync(path.dirname(files.policy), { recursive: true });
  fs.writeFileSync(`${files.policy}.tmp`, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${files.policy}.tmp`, files.policy);
  const secrets = [...secretValuesFromEnvironment(options.environment || process.env), ...(options.secrets || [])];
  const recorder = createSessionRecorder({
    file: files.ledger, ticket: policy.ticket, session: policy.session, provider: policy.provider,
    policy_digest: policy.digest, worktree: policy.worktree, secrets, now: options.now, lock_wait_ms: 5000,
  });
  recorder.start(policy.adapter_version);
  const spawn = options.spawn || defaultSpawn;
  const clock = () => Date.now();

  function terminalFor(ids) {
    return readManagedLedger(files.ledger).entries.find((entry) => entry.session === policy.session
      && entry.action_id === ids.action_id && entry.attempt_id === ids.attempt_id && entry.phase === "result");
  }

  // Begin, then either replay the recorded outcome or dispatch exactly once.
  function governed(attempt, dispatch) {
    const ids = { action_id: attempt.action_id, attempt_id: attempt.attempt_id || "1" };
    const begun = recorder.beginAction({ ...attempt, ...ids });
    if (begun.replayed) {
      const terminal = terminalFor(ids);
      if (!terminal) throw new LedgerNormalizationError("unknown_outcome", "action_id");
      return { status: "replayed", result: terminal.result, entry: terminal };
    }
    if (attempt.decision !== "allow") {
      return { status: "denied", result: "denied", entry: recorder.completeAction({ ...ids, result: "denied" }).entry };
    }
    const started = clock();
    let outcome;
    try {
      outcome = dispatch();
    } catch (error) {
      const result = error && error.signal ? "interrupted" : "failed";
      recorder.completeAction({ ...ids, result, duration_ms: clock() - started });
      throw error;
    }
    if (outcome.unknown) return { status: "unknown", result: null, value: outcome.value, entry: begun.entry };
    const entry = recorder.completeAction({ ...ids, result: outcome.result || "completed", duration_ms: clock() - started, ...outcome.fields }).entry;
    return { status: entry.result, result: entry.result, value: outcome.value, entry };
  }

  const decisionOf = (action) => (evaluateManagedAction(policy, action).decision === "allow" ? "allow" : "deny");
  const carriesSecret = (value) => secrets.some((secret) => secret.length >= 6 && String(value).includes(secret));

  return {
    policy, files, environment, recorder,
    runCommand(command, { action_id, attempt_id, command_class = "other" } = {}) {
      const decision = decisionOf({ kind: "command", command });
      return governed({ kind: "command", tool: "managed-runner", decision, rule: "command-classes", command, command_class, action_id, attempt_id },
        () => ({ value: spawn(command, { cwd: policy.worktree, env: environment, shell: false }) }));
    },
    writeFile(relative, content, { action_id, attempt_id } = {}) {
      const target = path.resolve(policy.worktree, relative);
      const decision = decisionOf({ kind: "write", path: target });
      return governed({ kind: "file", tool: "managed-runner", decision, rule: "write-roots", path: target, before_digest: fileDigest(target), action_id, attempt_id }, () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        return { fields: { after_digest: fileDigest(target) } };
      });
    },
    commit(message, { action_id, attempt_id } = {}) {
      const git = (args) => childProcess.execFileSync("git", ["-C", policy.worktree, ...args], { encoding: "utf8", env: { ...process.env, ...environment } }).trim();
      return governed({ kind: "git", tool: "managed-runner", decision: "allow", rule: "git-local", operation: "commit", action_id, attempt_id }, () => {
        git(["commit", "-q", "-am", message]);
        return { fields: { commit: git(["rev-parse", "HEAD"]) } };
      });
    },
    egress(destination, perform, { action_id, attempt_id } = {}) {
      const decision = decisionOf({ kind: "network", target: destination });
      return governed({ kind: "network", tool: "managed-runner", decision, rule: "network-allow", destination, action_id, attempt_id }, () => ({ value: perform() }));
    },
    useSecretReference(secretRef, purpose, resolve, { action_id, attempt_id } = {}) {
      const declared = policy.secret_references.find((entry) => entry.ref === secretRef);
      const decision = declared && declared.purposes.includes(purpose) ? "allow" : "deny";
      // The resolved value stays with the caller; only the reference and purpose are recorded.
      return governed({ kind: "secret", tool: "managed-runner", decision, rule: "secret-references", secret_ref: secretRef, purpose, action_id, attempt_id },
        () => ({ value: resolve() }));
    },
    requestCapability(broker, request, { action_id, attempt_id } = {}) {
      const capability = String(request.capability || "");
      if (carriesSecret(request.target)) throw new LedgerNormalizationError("unsafe_value", "receipt_target");
      const declared = policy.broker_targets.some((entry) => entry.capability === capability && entry.target === String(request.target));
      const decision = policy.broker_capabilities.includes(capability) && declared ? "allow" : "deny";
      return governed({
        kind: capability.startsWith("scm.") ? "git" : "mcp", tool: "capability-broker", decision, rule: "broker-capabilities",
        operation: capability || "unknown", action_id, attempt_id,
      }, () => {
        const response = broker.request({ ...request, ticket: policy.ticket, idempotency_key: action_id });
        if (response.outcome === "unknown") return { unknown: true, value: response };
        if (response.decision !== "allow") return { result: "denied", value: response };
        const { receipt } = response;
        // The effect ran but its external id cannot be safely digested: the
        // outcome stays unattributed (no terminal result), never a success.
        if (carriesSecret(receipt.external_id || "")) return { unknown: true, value: response };
        return {
          result: receipt.result, value: response,
          fields: {
            receipt: {
              receipt_id: receipt.receipt_id, ticket: receipt.ticket, capability: receipt.capability,
              target_class: TARGET_CLASSES[receipt.capability] || "other", target_digest: sha256(String(receipt.target)), result: receipt.result,
              external_id_digest: receipt.external_id ? sha256(String(receipt.external_id)) : null,
            },
          },
        };
      });
    },
    heartbeat: () => recorder.heartbeat(),
    end: (reason) => recorder.end(reason),
    interrupt: (reason) => recorder.interrupt(reason),
  };
}

function runManagedAuto(options = {}) {
  if (options.runtime_dir) {
    // COORD-860: a recorded single-command session on the governed chain.
    const session = startManagedSession(options);
    try {
      const run = session.runCommand(options.command, { action_id: options.action_id || "command-1", command_class: options.command_class });
      if (run.status === "denied") throw new Error("managed-auto denied command: destructive or remote operation");
      return { policy: session.policy, environment: session.environment, status: run.status, result: run.value, evidence: "recorded" };
    } finally {
      session.end("runner-exit");
    }
  }
  const prepared = prepareManagedAuto(options);
  const decision = evaluateManagedAction(prepared.policy, { kind: "command", command: options.command });
  if (decision.decision !== "allow") throw new Error(`managed-auto denied command: ${decision.reason}`);
  if (typeof options.spawn !== "function") return { ...prepared, status: "prepared" };
  const result = options.spawn(options.command, { cwd: prepared.policy.worktree, env: prepared.environment, shell: false });
  // Without a runtime directory nothing is recorded: never managed evidence.
  return { ...prepared, status: "completed", result, evidence: "unrecorded" };
}

module.exports = { canEstablishContainment, defaultSpawn, managedEvidencePaths, prepareManagedAuto, runManagedAuto, startManagedSession };
