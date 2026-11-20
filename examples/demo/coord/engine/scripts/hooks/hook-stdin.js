"use strict";

// COORD-660 — the hook payload acquisition seam.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Every shipped hook used to acquire its payload through one shared helper:
//
//     function readStdinSafe() {
//       try {
//         if (process.stdin.isTTY) return "";      // (a)
//         return nodeFs.readFileSync(0, "utf8");   // (b)
//       } catch { return ""; }                     // (c)
//     }
//
// Three separate defects compound there, and together they turned the
// COORD-476 protected-branch guard — a REQUIRED, fail-closed control — into a
// permit whenever the harness happened to write the hook JSON a few
// milliseconds after spawn:
//
//   (a) reading `process.stdin.isTTY` MATERIALIZES the stdin stream. Creating
//       that stream puts fd 0 into O_NONBLOCK.
//   (b) the subsequent SYNCHRONOUS `readFileSync(0)` on a now-non-blocking fd
//       returns EAGAIN the instant no bytes have arrived yet. It is a one-shot
//       poll wearing the costume of a blocking read: it never waits for the
//       writer and it never waits for EOF.
//   (c) the bare catch turns that EAGAIN into `""` — indistinguishable from
//       "the caller sent an empty payload".
//
// The hook therefore did not hang. It proceeded with an EMPTY PAYLOAD, saw no
// command to classify, and ALLOWED the operation. Measured against a fixture
// with `integrationBranch: "main"` and a protected-branch push payload,
// varying ONLY when the harness writes stdin after spawn:
//
//     0ms   -> exit=2   (correctly blocked)
//     100ms -> exit=0   (FAIL-OPEN, payload lost, stderr empty)
//     300ms -> exit=0
//     800ms -> exit=0
//
// The existing spawnSync-driven test could not see it: spawnSync pre-buffers
// `input` into the pipe before the child runs, so the read always succeeded
// instantly. The test pinned a timing case the real harness does not
// guarantee.
//
// This is the class closed under COORD-635, 642, 656 and 626 and re-diagnosed
// under COORD-645: ABSENCE OF EVIDENCE READ AS PERMISSION.
//
// THE RULE THIS MODULE IMPLEMENTS
// -------------------------------
//  1. LAZY. fd 0 is a last resort. If the environment payload already answers
//     everything the caller needs, the stdin stream is never opened, never
//     materialized, and fd 0 is never touched. A read that never happens
//     cannot race.
//  2. NO SYNCHRONOUS ONE-SHOT READ, EVER. When stdin genuinely is the only
//     source it is consumed as a STREAM, through the event loop, which waits
//     for the writer instead of sampling it. Late delivery is delivery.
//  3. BOUNDED. The wait carries an explicit deadline, so a writer that never
//     writes and never closes cannot wedge a hook forever (the failure mode
//     reported as a suite-wide deadlock in COORD-658). Reaching the deadline
//     is a RESULT, not a fallback: it is reported as `timeout`, and `ok` is
//     false.
//  4. FAIL CLOSED IS THE CALLER'S DECISION, BUT IT IS AN INFORMED ONE. This
//     module never returns a bare `""`. It reports WHY there is no payload —
//     `not-consulted` / `no-stdin` / `empty` / `timeout` / `too-large` /
//     `error:<code>` — so a caller can distinguish "the actor sent nothing"
//     from "we failed to read what the actor sent". Neither may be read as
//     "the actor ran an empty command".
//
// PURE AND INJECTABLE. Nothing here calls `process.exit`, reads
// `process.env`, or touches the filesystem. The stream opener, the clock and
// the completeness predicate are all injectable, so the wired hooks stay thin
// adapters (gather inputs -> call this -> act) and every proof runs against
// this module rather than against a live, wired safety hook.

// A hook payload is small. These bounds exist to keep a stuck or hostile
// writer from wedging or exhausting a hook, not to shape normal behaviour.
const DEFAULT_STDIN_TIMEOUT_MS = 5000;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

// Environment payload values are only "present" when they carry content.
// An empty string is ABSENT, never "an empty command".
function envText(env, key) {
  const value = env ? env[key] : undefined;
  return typeof value === "string" && value.trim() !== "" ? value : "";
}

function envSatisfies(env, needs) {
  const keys = Array.isArray(needs) ? needs : [];
  if (keys.length === 0) return false;
  return keys.every((key) => envText(env, key) !== "");
}

// Stop-early predicate: a hook envelope is a single JSON document, so once the
// accumulated text parses we already have the whole payload and do not need to
// wait for the writer to close the pipe. This is what makes the common case
// fast without reintroducing a "give up early" read — failing to parse does
// NOT end the read, it keeps waiting until EOF or the deadline.
function looksComplete(text) {
  const trimmed = String(text || "").trim();
  if (trimmed === "") return false;
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume a readable stream to EOF (or to a complete JSON document) under an
 * explicit deadline.
 *
 * @returns {Promise<{ok: boolean, text: string, reason: string, bytes: number}>}
 *   `ok` is true ONLY when a non-empty payload was actually obtained. Every
 *   other outcome carries the reason it failed, and none of them means
 *   "empty command".
 */
function readStreamBounded(stream, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_STDIN_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_STDIN_BYTES;
  const isComplete = typeof options.isComplete === "function" ? options.isComplete : looksComplete;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;

  return new Promise((resolve) => {
    if (!stream || typeof stream.on !== "function") {
      resolve({ ok: false, text: "", reason: "no-stdin", bytes: 0 });
      return;
    }

    let text = "";
    let bytes = 0;
    let settled = false;
    let timer = null;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      for (const [event, handler] of [
        ["data", onData],
        ["end", onEnd],
        ["error", onError],
      ]) {
        try {
          if (typeof stream.removeListener === "function") stream.removeListener(event, handler);
        } catch {
          /* detaching is best effort; the decision below is not */
        }
      }
      try {
        if (typeof stream.pause === "function") stream.pause();
      } catch {
        /* ditto */
      }
      const empty = text.trim() === "";
      if (reason === "eof" || reason === "complete") {
        resolve({ ok: !empty, text, reason: empty ? "empty" : reason, bytes });
        return;
      }
      resolve({ ok: false, text, reason, bytes });
    };

    function onData(chunk) {
      const part = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      text += part;
      bytes += Buffer.byteLength(part);
      if (bytes > maxBytes) {
        finish("too-large");
        return;
      }
      if (isComplete(text)) finish("complete");
    }
    function onEnd() {
      finish("eof");
    }
    function onError(error) {
      finish(`error:${(error && (error.code || error.message)) || "unknown"}`);
    }

    // The deadline is NOT unref'd: it must be able to fire and produce a
    // refusal, rather than letting the process quietly fall off the end of the
    // event loop with no payload and no verdict.
    timer = setTimer(() => finish("timeout"), timeoutMs);

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    try {
      if (typeof stream.resume === "function") stream.resume();
    } catch (error) {
      finish(`error:${(error && (error.code || error.message)) || "unknown"}`);
    }
  });
}

// Default opener. A terminal is an interactive session, not a hook payload
// channel: returning null there keeps a hand-run hook from blocking on a human
// who has nothing to type. Touching `isTTY` is safe HERE — unlike the defect
// this module replaces — precisely because what follows is a stream read, not
// a synchronous fd read that the resulting O_NONBLOCK would break.
function openProcessStdin(proc) {
  const target = proc || process;
  const stream = target.stdin;
  if (!stream) return null;
  if (stream.isTTY) return null;
  return stream;
}

/**
 * Acquire a hook payload, environment first and stdin only if required.
 *
 * @param {object}   options.env        the process environment (never read directly)
 * @param {string[]} options.needs      env keys that, if all present, make stdin unnecessary
 * @param {function} [options.openStdin] injectable stream opener
 * @returns {Promise<{
 *   envValues: object, envSatisfied: boolean, envAny: boolean,
 *   stdinText: string, stdinConsulted: boolean, stdinReason: string,
 *   ok: boolean, source: string
 * }>}
 */
async function acquireHookPayload(options = {}) {
  const env = options.env || {};
  const needs = Array.isArray(options.needs) && options.needs.length ? options.needs : ["TOOL_INPUT"];

  const envValues = {};
  for (const key of needs) envValues[key] = envText(env, key);
  const envAny = Object.values(envValues).some((value) => value !== "");
  const envSatisfied = envSatisfies(env, needs);

  // (1) LAZY: fd 0 is never touched when the environment already answers.
  if (envSatisfied) {
    return {
      envValues,
      envSatisfied,
      envAny,
      stdinText: "",
      stdinConsulted: false,
      stdinReason: "not-consulted",
      ok: true,
      source: "env",
    };
  }

  const open = typeof options.openStdin === "function" ? options.openStdin : openProcessStdin;
  let stream = null;
  try {
    stream = open();
  } catch (error) {
    stream = null;
  }

  const result = await readStreamBounded(stream, options);
  return {
    envValues,
    envSatisfied,
    envAny,
    stdinText: result.text,
    stdinConsulted: true,
    stdinReason: result.reason,
    ok: envAny || result.ok,
    source: result.ok ? (envAny ? "env+stdin" : "stdin") : envAny ? "env" : "none",
  };
}

// Human-readable explanation of a failed acquisition, for refusal messages.
// A refusal an operator cannot act on is only marginally better than a permit.
function explainStdinReason(reason) {
  switch (reason) {
    case "not-consulted":
      return "stdin was not consulted (the environment payload was sufficient)";
    case "no-stdin":
      return "no readable stdin was attached to this hook (fd 0 is a terminal, closed, or unavailable)";
    case "empty":
      return "stdin closed without sending any payload";
    case "timeout":
      return `stdin was still open but sent nothing within the ${DEFAULT_STDIN_TIMEOUT_MS}ms deadline`;
    case "too-large":
      return "the stdin payload exceeded the hook payload size limit";
    default:
      return reason && reason.startsWith("error:")
        ? `reading stdin failed (${reason.slice("error:".length)})`
        : `stdin could not be read (${reason || "unknown"})`;
  }
}

module.exports = {
  DEFAULT_STDIN_TIMEOUT_MS,
  MAX_STDIN_BYTES,
  envText,
  envSatisfies,
  looksComplete,
  readStreamBounded,
  openProcessStdin,
  acquireHookPayload,
  explainStdinReason,
};
