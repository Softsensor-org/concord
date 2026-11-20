"use strict";

// COORD-922: `--dry-run` is a global boolean flag (cli.js BOOL_FLAGS), so every
// verb parsed it and most ignored it. `claim <t> --transfer-to <h> --dry-run`
// exited 0 and performed the real transfer: owner, board, sessions, journal and
// rendered views all changed. A flag that promises "nothing is written" must
// never be accepted by a handler that does not read it.
//
// The ONE declaration of which dispatched verbs honour (command-declaration.js dryRun rows)
// `--dry-run` with a read-only preview. The router (cli.js dispatchCommand)
// refuses the flag for every other verb before any handler, identity binding,
// lock or journal step runs. dry-run-policy.test.js enforces both directions:
// every verb here is a dispatched verb and is proven byte-identical against a
// fixture, and every undeclared dispatched verb refuses the flag with no write.
// Declaring a verb there without that proof fails the suite.
// The --dry-run allowlist DERIVES from the one declaration (command-declaration.js, COORD-934).
const { DRY_RUN_VERBS } = require("./command-declaration.js");

function supportsDryRun(command) {
  return Object.prototype.hasOwnProperty.call(DRY_RUN_VERBS, command);
}

// guard:dry-run-unsupported
// Refuse `--dry-run` for a verb with no declared read-only preview. Runs in the
// router before the handler, so a refused call has no effect at all.
function assertDryRunSupported(command, args, fail) {
  if (!Array.isArray(args) || !args.includes("--dry-run") || supportsDryRun(command)) return;
  fail(
    `${command} does not support --dry-run: it has no read-only preview, so the flag is refused and nothing ran. ` +
    `Rerun without --dry-run to perform it, or use a read verb (ticket, explain, recent) to inspect state. ` +
    `Verbs with a declared --dry-run preview: ${Object.keys(DRY_RUN_VERBS).join(", ")}.`
  );
}

module.exports = { DRY_RUN_VERBS, supportsDryRun, assertDryRunSupported };
