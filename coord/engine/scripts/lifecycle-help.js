"use strict";

// COORD-281: the lifecycle CLI presentation + thin read-only command-wrapper
// surface, extracted from lifecycle.js to bring the composition root back under
// the arch monolith/size LOC budget. ONE cohesive boundary: functions that ONLY
// validate args, delegate to a (lazily required) standalone engine, and EMIT
// output — they carry NO governance-mutation logic and reach NO governance
// internals. Everything external is INJECTED via the createLifecycleHelp factory:
//   - printHelp / buildInitiateSummary / printInitiate (help text + session primer)
//   - recall / insights / coverage-rollup / prework / closeout-summary /
//     learned-rule / sign-journal (thin CLI wrappers over their own engines)
//
// BOUNDARY: the only injected collaborators are the GovernanceError `fail`
// thrower, ensureCurrentAgentIdentity (primer identity read), the GovernanceError
// class, the live mutable `state` (path config; injected BY REFERENCE so test
// path overrides propagate), and COORD_DIR. fs/path are node builtins required
// directly. lifecycle.js wires this factory and destructures the returned
// functions back into scope so the `commands` dispatch table and the `__testing`
// facade (buildInitiateSummary) resolve exactly as before the move.
//
// NOTE: the moved function declarations live at column 0 inside the factory body
// (not re-indented) so their template-literal help text stays BYTE-IDENTICAL to
// the pre-extraction output. Indentation inside a function body is not required.

// COORD-866 (COORD-589 batch 3): the memory-layer engines moved under
// coord/engine/scripts; resolve them through the engine resolver, never the
// injected COORD_DIR (tests inject fake directories).
const { resolveEngineModule } = require("../../paths.js");
const ENGINE_COORD_DIR = require("node:path").resolve(__dirname, "..", "..");

module.exports = function createLifecycleHelp(deps = {}) {
  const fs = require("fs");
  const path = require("path");
  const {
    fail,
    ensureCurrentAgentIdentity,
    GovernanceError,
    state,
    COORD_DIR,
  } = deps;
  // COORD-717: help prints the canonical finding-severity vocabulary instead of
  // re-declaring it; the rendered text is byte-identical to the prior literal.
  const { FINDING_SEVERITY_USAGE } = require(require("../../paths.js").resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/governance-constants.js"));

// COORD-612: the help TEXT is now built (not printed) so a second consumer —
// per-verb help (`gov <verb> --help`) — can filter the same single source of
// truth. printHelp keeps emitting byte-identical output.
function buildHelpText(options = {}) {
  if (!options.all) {
    return `Governance helper CLI

Preferred workflow:
  coord/scripts/gov initiate
  coord/scripts/gov pick [all] --mode <backend|frontend|design|general> --limit 3
  coord/scripts/gov agentid [--assign | --owner <handle|simple-id>]
  coord/scripts/gov claim [<ticket-id>]
  coord/scripts/gov claim <ticket-id> --transfer-to <handle> --human-admin-override "<reason>" [--dry-run]   # authorized ticket-owner transfer; --dry-run previews the owner, workspace and provenance changes and writes nothing
  coord/scripts/gov resume <ticket-id>
  coord/scripts/gov file-ticket --repo <code> --type <type> --pri <P#> --description "<text>"   # file a backlog ticket — the safe one-liner (atomic, lock-held, journaled; NO prompt/parent required; add --with-prompt for prompt coverage; it is start-ready when --description carries "Acceptance: <criteria>")
  coord/scripts/gov start <ticket-id>
  coord/scripts/gov block <ticket-id> (--reason "<why work is paused>"|--reason-file <path>)
  coord/scripts/gov unblock <ticket-id>
  coord/scripts/gov commit <ticket-id> {--message|-m} "Ticket commit message" [--all] [--files <path> ...] [--ack-outside-scope <exact Git-relative path> ...]
  coord/scripts/gov submit <ticket-id> [--fill]
  coord/scripts/gov guided-closeout <ticket-id> [--json] [--write]
  coord/scripts/gov publishability-check <ticket-id> [--json] [--files <path[,path]>]
  coord/scripts/gov finalize <ticket-id> --no-pr [--base <branch>] [--already-landed] [--merge-workspace [--expect-paths-file <approved ADR packet>]] (--landed "<evidence>" ...|--landed-file <path> ...) [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  coord/scripts/gov land <ticket-id> [--landed <evidence> ...|--landed-file <path> ...] [--method <merge|squash|rebase>] [--delete-branch] [--merge-workspace [--expect-paths-file <approved ADR packet>]] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  coord/scripts/gov supersede <ticket-id> [--reason "<why>"|--reason-file <path>] [--consolidated-into <ticket-id>]

If review/governance state needs repair:
  coord/scripts/gov explain <ticket-id>
  coord/scripts/gov resume <ticket-id>
  coord/scripts/gov recover <ticket-id>
  coord/scripts/gov unstart <ticket-id>   # guarded same-owner wrong-start revert: doing -> todo, fails closed on review/landing/plan/workspace evidence
  coord/scripts/gov reconcile [<ticket-id>] (--reason "<why the current drift is being accepted>"|--reason-file <path>) [--scope <governed|derived|runtime>] [--human-admin-override "<approval>" --expect-paths-file <approved packet>]   # --scope adopts only that drift scope and keeps the rest detectable; --dry-run reports drift_by_scope with the remedy per scope; semantic drift or a missing baseline needs BOTH; packet: one "<sha256|absent> <path>" per adopted path (see --dry-run expect_paths_packet) or a markdown table with path + sha256 columns (repo-relative coord/... paths); any added, missing or changed path refuses
  coord/scripts/gov open-followup [<new-ticket-id>|--prefix <PREFIX>] {--depends-on|--parent} <ticket-id> --repo <repo-code> --type <type> --pri <priority> --description <text> [--relation <blocking|related|closeout-blocker>] [--prompt <existing-path>]   # Creates a child-owned prompt by default; --prompt deliberately references an existing/shared prompt and records that choice.
  coord/scripts/gov file-ticket [<new-ticket-id>|--prefix <PREFIX>] --repo <repo-code> --type <type> --pri <priority> (--description <text>|--description-file <path>) [--status <todo|proposed>] [--depends-on <ticket-id>] [--prompt <path>] [--with-prompt] [--prompt-template ticket] [--owner <handle>] [--duplicate-of <ID>|--distinct-from <IDs> --reason <text>]   # alias: gov new. Low-ceremony backlog create through the locked transaction — NO mandatory prompt coverage, NO forced parent dependency (the differentiator from open-followup). Add --with-prompt to create/register coord/prompts/tickets/<ID>.md atomically in the same journaled mutation. --description-file preserves literal UTF-8 file contents up to 4 MiB; it cannot be combined with --description. Duplicate check (COORD-975): before filing, file-ticket scores the open and recently done tickets for overlap (description words, named file paths, camelCase functions, guard ids, gov verbs) and prints the candidates at or above the threshold with their shared evidence. --duplicate-of <ID> does not file the ticket and journals a note on <ID>; --distinct-from <IDs> --reason <text> files it and journals why it differs. Enforcement is off until ADR 0026 is accepted.
  Literal prose file inputs: --reason-file, --summary-file, and --human-admin-override-file replace their inline scalar flag and cannot be combined with it. --landed-file, --review-cycle-file, and --closure-file each append one exact bounded UTF-8 file value in argument order; they may be mixed with inline repeatable entries.
  coord/scripts/gov amend-ticket <ticket-id> [--description <text>] [--pri <P0|P1|P2|P3>] --reason <text> [--human-admin-override <approval>]
      (Correct description/priority only; at least one is required. Description: nonblank, at most 4 MiB UTF-8, preserved literally; pass multiline text as one argv value. Requires a registered active session, and the bound owner for assigned tickets or explicit admin approval. Preserves prompts, locks, sessions and lifecycle evidence; unchanged values produce no event.)
  coord/scripts/gov next-id <PREFIX>   # print the next free PREFIX-N ticket id
  coord/scripts/gov split-ticket <parent-ticket-id> --into <repo-codes> [--prefix <PREFIX>]   # one auto-allocated related followup per repo
  coord/scripts/gov set-followup-relation <ticket-id> [--depends-on <id[,id...]> ...] --relation <blocking|related|closeout-blocker|independent> [--replace]
      # edges ACCUMULATE: --depends-on takes a comma list and may repeat; every edge feeds readiness.blockedBy
      # --relation independent removes only the named --depends-on edges (all of them when none is named)
      # --replace is required to replace a recorded follow-up exception; without it the verb refuses rather than discarding it
  coord/scripts/gov set-priority <ticket-id> --pri <P0|P1|P2|P3>   # reprioritize a non-terminal ticket through gov (TASKS.md is a rendered view)
  coord/scripts/gov set-requirement-ids <ticket-id> (--ids <id[,id...]> | --clear) --reason <text> [--human-admin-override <approval>]
  coord/scripts/gov set-type <ticket-id> --type <feature|bug|chore|task|spike|refactor|docs|test>   # retype a non-terminal ticket through gov
  coord/scripts/gov approve <ticket-id>   # human-only: promote a quarantined "proposed" ticket to todo (proposed -> todo), one journal event
  coord/scripts/gov reject <ticket-id> (--reason "<why>"|--reason-file <path>)   # human-only: decline a "proposed" ticket (proposed -> superseded), reason recorded + journaled
  coord/scripts/gov repair <ticket-id> --summary <text> --severity ${FINDING_SEVERITY_USAGE} --qref <Lxx>

Clean-checkout gate execution:
  coord/scripts/gov gate <repo-code|repo-name> --lane <default|full|ci> [--branch <ref>] [--source <local|hook|ci>]
  coord/scripts/gov governance-tier [--json] [--tier <lite|standard|full>]

Code-quality automation (COORD-083):
  coord/scripts/gov quality-scan [--apply] [--root <dir>] [--severity-floor warn|fail] [--cap <n>] [--depends-on <ticket>] [--repo <code>] [--prefix <PREFIX>]
      (runs the arch-checks library over <root>, dedups findings against open board tickets, and DRY-RUNS by default; --apply files governed follow-ups via open-followup. A per-run cap prevents board flooding. Schedulable via cron/CI — see coord/product/QUALITY_AUTOMATION.md)

Structured plan helpers:
  coord/scripts/gov update-plan <ticket-id> [--summary <text>|--summary-file <path>] [--verify <cmd>] [--files <path>] [--drop-file <path>] [--security <yes|no>] [--startup <completed>] [--traceability <verified|closing-gap|exempt>] [--baseline <text>] [--invariant <text>] [--closure <text>|--closure-file <path>] [--feature-proof <text>] [--drop-feature-proof <text>] [--repo-gate <text>] [--rollback <text>] [--closeout-method <pr|no_pr|fulfilled_by>] [--closeout-base-ref <ref>] [--provenance-note <text>] [--review-profile <standard|bounded_repair>] [--context-pack-ack '<json>'|none] [--live-mcp '<json>'|none] [--gate-plan '<json>'|none] [--bootstrap-risk '<json>'|none] [--decision-required '<json>'|none] [--decision-context '<json>'|--decision-context-file <path>] [--review-cycle <text>|--review-cycle-file <path>] [--replace-review-cycle <N> --review-cycle <text>] [--drop-review-cycle <N>]
      (--context-pack-ack is the ONLY sanctioned writer for the context_pack_ack the review gate requires; NEVER hand-edit coord/.runtime/plans/<ticket>.json. It takes a JSON object, or the literal "none" to clear. Accepted shape (schema-validated example):
       coord/scripts/gov update-plan <ticket-id> --context-pack-ack '{"considered":{"active_constraints":["<constraint or none>"],"adrs":["none"],"business_rules":["none"],"conflicts":["none"],"stale_warnings":["none"],"open_questions":["none"]},"authority":{"constraints":["<authority actually relied on>"],"advisory_only":["<advisory item>"]},"closeout_learning":{"decision":"scratch-only","rationale":"<why>"}}'
       Keys are closed: only refs / considered / authority / closeout_learning. "refs" holds business-context PACK PATHS (not doc citations — cite docs under considered.active_constraints); considered.* and authority.* are arrays of strings; closeout_learning.decision is promote|demote|scratch-only|mixed|none.)
      --provenance-note <text> writes operator evidence and explicitly replaces the existing note. Closeout preserves that note and appends landing provenance once; without --landed the note is preserved. Applies to pr, no_pr and fulfilled_by closeout.
      --adr-ref <ADR-0001> is repeatable and appends validated references to plan adr_refs. It does not approve an ADR or change gov adr link metadata.
  coord/scripts/gov add-review-cycle <ticket-id> --lens <name> --diff <text> --risk <text> --risk <text> --findings <text> --verification <cmd> --verdict <pass|fail> [--replace-review-cycle <N>]
  coord/scripts/gov set-review-cycles <ticket-id> --replace --review-cycle "<structured cycle>" [--review-cycle "<structured cycle>" ...]
      (replaces the complete cycle collection only with --replace; use add-review-cycle for incremental evidence)
  coord/scripts/gov scan-context-pack-acks [--json]
  coord/scripts/gov repair-context-pack-ack <ticket-id> --context-pack-ack '<json>'|none [--confirm] [--human-admin-override "<reason>"]
  coord/scripts/gov set-context-pack-ack <ticket-id> [--considered <section>=<text> ... --learning <promote|demote|scratch-only|mixed|none> [--authority <text>] [--advisory-only <text>] [--rationale <text>] | --not-applicable --reason "<why>"]
  coord/scripts/gov set-requirement-closure <ticket-id> --ticket-ask <text> --implemented <text> [--not-implemented <text>] [--deferred-to <text>] --closeout-verdict <complete|incomplete> [--supersede]
  coord/scripts/gov add-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  coord/scripts/gov drop-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  coord/scripts/gov add-repo-gate <ticket-id> (--command <cmd> [--note <text>] [--result <pass|fail>] [--base-result <pass|fail>] [--audit <summary>] [--arch <summary>] | --selection-manifest <file> --base <ref> | --not-required)
  coord/scripts/gov supersede-plan-evidence <ticket-id> --kind <repo_gate|verification_command|critical_invariant> --entry <stable-ref|exact-value> (--replacement <text> | --disposition retracted) --reason <text>
  coord/scripts/gov record-independent-review <ticket-id> --commit <full-sha> --method <text> --verdict <pass|pass-with-findings|fail|inconclusive> [--repository <coord|repo>] [--finding <id> ...] [--summary <text>] [--review-key <key>] [--supersedes <review-id> | --corrects <review-id>] [--reason <text>]
      (run as the bound reviewer session, never the ticket owner; claims and changes nothing on the reviewed ticket; identical retry is a no-op and a conflicting reuse of a review id fails)
  coord/scripts/gov record-managed-evidence <ticket-id> [--base <commit>] [--dry-run] [--human-admin-override "<approval>" --reason <text> --risk <residual-risk> --gaps <code,...>]
      (COORD-860: reconciles a managed-auto ticket's local action ledger, its digest-bound policy, Git state and declared files; records only the redacted summary in the plan and journal; an unmanaged ticket is refused and stays unmanaged; the exception form binds a human-admin technical exception to exactly the current gaps and is not a legal waiver)
  coord/scripts/gov retire-stale-drift-notes [--dry-run]
  coord/scripts/gov promote --from <dev|staging|main> --to <staging|main|concord-public-release|concord-enterprise-release> --commit <sha> --gate-manifest <file> [--approval <file>] [--tag <name>] [--remote <name>] [--dry-run]   # ADR 0028: fast-forward promotion of one exact commit; only the four allowed edges; --dry-run previews and moves nothing

Additional lifecycle and recovery commands:
  coord/scripts/gov help [--all]   # show the quick command guide or complete prose help
  coord/scripts/gov adr <list|show|check|new|link|supersede> [options]
  coord/scripts/gov abandon-lock <ticket-id> --human-admin-override "<reason>"   # alias: lock-abandon; guarded release of an abandoned ticket lock
  coord/scripts/gov unstart-ticket <ticket-id>   # alias: unstart; guarded revert of a mistaken start
  coord/scripts/gov reopen <ticket-id>   # alias: reopen-ticket; retired compatibility command that refuses and directs callers to open-followup or return-doing
  coord/scripts/gov migrate-chain-hash [--ticket <ticket-id>] [--confirm] [--json]   # dry-run by default; --confirm applies legacy journal hash-chain migration
  coord/scripts/gov normalize-lock <ticket-id>   # normalize a ticket lock through guarded lifecycle repair
  coord/scripts/gov reap-gate-procs [--dry-run]   # inspect stale gate child-process records; --dry-run avoids reaping
  coord/scripts/gov repair-lock-head <ID> --dry-run   # COORD-978: preview the lock-head repair (read-only; always allowed)
  coord/scripts/gov repair-lock-head <ID> --to <sha> --expect <digest> [--human-admin-override "<reason>"]   # owner: containing commit only
  coord/scripts/gov orch [--fix] [--ticket <ticket-id>] [--scope-self]   # alias: orchestrator-cycle; report diagnostics and apply doctor repairs with --fix
  coord/scripts/gov orchestrator-cycle [--fix] [--ticket <ticket-id>] [--scope-self]   # alias: orch; report diagnostics and apply doctor repairs with --fix
  coord/scripts/gov run-ticket-cycle <ticket-id> [--owner <handle>]   # alias: ticket-cycle; report the governed ticket-cycle steps
  coord/scripts/gov ticket-cycle <ticket-id> [--owner <handle>]   # alias: run-ticket-cycle
  coord/scripts/gov integration status [--json]   # COORD-915: show this domain's integration-authority holder and any open operation
  coord/scripts/gov integration claim   # become the integration-authority holder of a domain with no holder
  coord/scripts/gov integration handoff --to <handle> --human-admin-override "<reason>"   # explicit, journaled transfer; an open operation is preserved
  coord/scripts/gov integration release   # holder gives up authority; the next holder must claim explicitly
  coord/scripts/gov integration begin <ticket-id>   # reserve the domain before an external merge; the ticket's terminal verb adopts and closes it
  coord/scripts/gov integration recover [--resume | --abandon --human-admin-override "<reason>"] [--json]   # verify an interrupted, expired or handed-over operation, then resume or abandon it

Runtime evidence receipts (these commands record or validate evidence; they do not run the underlying operation):
  coord/scripts/gov live-mcp-policy [--json]   # show operation classes, required evidence and receipt roots
  coord/scripts/gov live-mcp-record <ticket-id> --adapter <name> {--class|--operation-class} <read_safe|read_sensitive|write_low|write_prod|destructive> --operation <name> --scope <text> --evidence <text> [--approval <text>] [--redaction <text>] [--cleanup <text>] [--receipt-result <text>] [--result <pass|fail>] [--meta key=value ...] [--json]
      At least one --evidence is required. Approval, redaction, and cleanup requirements depend on the selected operation class; this records a receipt and does not perform the operation.
  coord/scripts/gov bootstrap-record <ticket-id> --job <name> --execution-mode <mode> --resource-envelope <text> --idempotency <text> --observability <text> {--disable-rollback|--rollback} <text> --evidence <text> [--query-shape <text>] [--receipt-result <text>] [--result <pass|fail>] [--meta key=value ...] [--json]
      At least one --evidence is required. api-startup is refused; idempotency cannot rely on a marker written only after work completes.
  coord/scripts/gov deploy-record <ticket-id> {--environment|--env} <name> --commit <sha> --artifact <ref> --deploy-id <id> --rollback <text> [--build-source <sha>] [--running-artifact <ref>] [--operator <name>] [--evidence <text>] [--receipt-result <text>] [--meta key=value ...] [--json]
      --build-source defaults to --commit and --running-artifact defaults to --artifact; supplied values must match their paired identities. This records a receipt, it does not deploy.
  coord/scripts/gov deploy-check [<ticket-id> | --receipt <file>] [--json]   # compare the recorded build and running artifact identities; no infrastructure query
  coord/scripts/gov verify <ticket-id> {--environment|--env} <name> --evidence-class <fixture|gate|runtime|mcp-oracle|deploy|bootstrap> --claim <text> --evidence <text> [--receipt-result <pass|fail|observed|blocked>] [--result <pass|fail>] [--meta key=value ...] [--json]   # record a verification claim; does not run a gate
      At least one --evidence is required. The command records the operator's verification claim and does not run a gate or probe.
  coord/scripts/gov falsify <ticket-id> --by <name> --reason <text> --evidence <text> [--meta key=value ...] [--json]   # record falsification evidence; does not run a probe
  coord/scripts/gov validate-receipt {--receipt|--path} <file> [--json]   # validate the parsed receipt schema and print its digest; digest is not an authenticity check

Code and memory inspection:
  coord/scripts/gov code-context <file> [<file> ...] [--json]
  coord/scripts/gov code-diff [<base-ref>] [--json]
  coord/scripts/gov code-index [--repo <path>] [--ext .js,.ts] [--git] [--force] [--json]
  coord/scripts/gov code-search <query> [--top <N>] [--json]
  coord/scripts/gov recall "<query>" [--role <role>] [--json]
  coord/scripts/gov prework [<ticket-id>] [--scope "<text>"] [--role <role>] [--json]
  coord/scripts/gov closeout-summary <ticket-id> [--json]   # report-only evidence summary; it does not close or finalize
  coord/scripts/gov coverage-rollup [--json] [--dry-run]   # refresh coverage maturity reporting; --dry-run computes without writing
  coord/scripts/gov learned-rule capture --rule "<rule>" --target <procedural-file> [--target <file> ...] --citation <source> [--citation <source> ...] --rationale "<why>" [--json]
  coord/scripts/gov learned-rule list [--json]
  coord/scripts/gov learned-rule promote <PRC-id> [--json]
  coord/scripts/gov sign-journal sign [--out <file>] [--json]
  coord/scripts/gov sign-journal verify <batch-file>|--file <batch-file> [--event <hash>] [--trust-anchor <pem|fingerprint>] [--json]

Ticket and gate option aliases:
  coord/scripts/gov file-ticket [<ticket-id>|--prefix <PREFIX>] --repo <code> --type <type> --pri <priority> --description <text> [--depends-on <ticket-id>|--parent <ticket-id>] [--with-prompt]
  coord/scripts/gov new [<ticket-id>|--prefix <PREFIX>] --repo <code> --type <type> --pri <priority> --description <text>   # alias: file-ticket
  coord/scripts/gov open-followup [<ticket-id>|--prefix <PREFIX>] --repo <code> --type <type> --pri <priority> --description <text> {--depends-on|--parent} <ticket-id> [--section-heading <heading>] [--closeout-blocker] [--relation <blocking|related|closeout-blocker>]
  coord/scripts/gov set-followup-relation <ticket-id> (--depends-on <id[,id...]> --relation <blocking|related|closeout-blocker> | --relation independent) [--replace]
  coord/scripts/gov add-repo-gate <ticket-id> (--command <cmd> [--coverage <summary>] [--note <text>] [--result <pass|fail>] | --not-required)
  coord/scripts/gov gate-plan <ticket-id> [--files <path> ...] [--track <track>] [--risk-class <R0|R1|R2|R3|R4>] [--full] [--base <ref>] [--write] [--json|--md]
  coord/scripts/gov start <ticket-id> [--worktree <path>] [--topic <slug>] [--base <branch>] [--dispatch-execution-id <id>]
  coord/scripts/gov agent-release <handle|simple-id|session-id>   # a foreign session that holds no lock: release it by exact session id with --human-admin-override "<reason>" (COORD-893)
  coord/scripts/gov doctor [--fix|--repair-all] [--ticket <ticket-id>] [--scope-self]
  coord/scripts/gov conform --verify-attestation <file> [--trust-anchor <pem|fingerprint>] [--json]
  coord/scripts/gov verify-engine [--pin | --regenerate] [--json]

Token-economics (TOKEN_ECONOMICS.md):
  coord/scripts/gov record-cost <ticket-id> --model <m> --input-tokens <n> --output-tokens <n> [--agent <h>] [--usd <amount>] [--phase start|plan|implement|review|land]
      (append-only cost.observed journal event; if --usd omitted and both usage counters are known, estimates from coord/product/model-prices.json. Evidence, not a gate.)
  coord/scripts/gov record-cost <ticket-id> --dispatch-execution-id <id> --attempt-id <id> --phase plan|implement|review [--model <m>] [--input-tokens <n>] [--output-tokens <n>] [--unknown-reason <text>] [--measurement-source provider_reported|explicit_measurement|lifecycle_boundary] [--usage-scope phase_delta|execution_cumulative|combined_only]
      (dispatch-attributed cost.observed entry; missing counters require explicit unknown reason; same execution/phase/attempt replay is idempotent, changed reuse refuses.)
  coord/scripts/gov report-prefix-use <ticket-id> --expected-prefix-hash <sha256> --used-prefix-hash <sha256>
      (append-only dispatch.prefix_used observation; prints match/mismatch and journals both hashes. The used hash is agent/harness-reported, not provider-verified.)

Temporal quality observations (COORD-710, coord/engine/docs/QUALITY_DIMENSIONS.md section 6):
  coord/scripts/gov observe ingest --format <node-test-tap|junit-xml|jest-json|pytest-json> --report <path> --repo <code> --suite <name> --commit <sha> --runtime <identity> [--attempt <n>] [--expect-measurement] [--source-root <dir>] [--store <dir>] [--ticket <id>]
      (normalizes one runner report into an immutable artifact under coord/evidence/observations and journals ONE compact digest+pointer event; repeat delivery is idempotent; malformed/truncated/duplicate/unsupported input is refused with a receipt; an expected-but-absent measurement is recorded non-passing and exits 1)
  coord/scripts/gov observe replay [--check] [--store <dir>]
      (re-verifies every artifact and journaled digest, then rebuilds the derived per-test series byte-for-byte; --check compares against the stored series without writing)
  coord/scripts/gov observe series [--store <dir>]
      (prints the derived series: per-test history, flake rate over comparable completed attempts, runtime trend, added/removed tests, quarantine state)
  coord/scripts/gov observe quarantine --repo <code> --suite <name> --test-id <id> --owner <handle> --reason <text> --expires-at <iso> --max-age-days <n> [--created-at <iso>]
      (records a governed quarantine object; it masks a test's effective outcome only until expiry and never hides it from flake measurement)
  coord/scripts/gov cost [--ticket <id>] [--by ticket|agent|model|phase] [--json]
      (read-only aggregate of the cost ledger: totals + breakdown + separate cumulative/combined scope totals; unknown values remain null; --json is deterministic/hash-stable.)
  coord/scripts/gov precheck <ticket-id> [--json] [--record] [--allow-command-probes]
      (cheap advisory probes -> verdict already-satisfied|partial|not-started|unknown; exit 0/10/20/30; NO required LLM call.
       Declare probes in coord/prompts/tickets/<ID>.precheck.json or a fenced 'precheck' JSON block in the prompt: types grep|test|file-exists, each with expect.
       grep patterns are bounded literal strings. test commands are disabled by default, including in dispatch-plan; a trusted operator can opt in with --allow-command-probes. Commands run as argv without a shell and can still have side effects.
       No probes declared -> unknown, never a false satisfied. --record writes an auditable journal note.)
  coord/scripts/gov context-pack <ticket-id> [--json | --md]
      (deterministic, hash-stable per-ticket context pack: STABLE shared-preamble pointers (place in a prompt-cache prefix)
       + TICKET-SPECIFIC files/acceptance-criteria/spec-sections and prior feature-proofs+invariants intersecting the ticket files.
       Degrades gracefully when there are no prior proofs.)
  coord/scripts/gov request-context <ticket-id> --path <relative-posix-path> --reason <text>
      (append-only, ownership-bound observation requesting a context supplement in pack_only mode; never reads the path or grants access.)
  coord/scripts/gov context-requests [<ticket-id>] [--limit <1-100>] [--json]
      (bounded read-only projection of successful context.requested journal observations; requests are not grants.)
  coord/scripts/gov gate-plan <ticket-id> [--files <path> ...] [--map <path>] [--risk-class <R0|R1|R2|R3|R4>] [--full] [--write] [--json | --md]
      (deterministic gate receipt: resolves track/lane/risk, affected-target slice or full fallback, selected/skipped gates,
       and required evidence. Dry-run by default; --write records the receipt in the canonical plan record and does not run gates.)
  coord/scripts/gov insights [--json]
      (COORD-147 strategic execution-insight report mined from REAL history (journal + board + plan records):
       repeated-failure-themes, architectural-debt-by-subsystem, churn-instead-of-value, gate/review/recovery health BY REPO.
       RECOMMENDS ONLY — mutates/gates nothing; every claim is source-cited (ticket ids + event_hash + chain_head); thin signal flagged.
       Deterministic (identical history -> identical report). --json emits the structured report; default emits the readable text report.)
  coord/scripts/gov tier <ticket-id>
      (resolves the ticket tier (explicit board Tier column, else derived from Pri, else standard), the suggested model class,
       and the tier-appropriate required evidence depth. Tier policy is data-driven in coord/product/tier-policy.json.
       Relax-only safety: standard/absent and critical keep TODAY's flat minimums byte-identical; only lower tiers relax.)
  coord/scripts/gov plan-waves [--status todo] [--repo <code>] [--json]
      (conflict-free parallel schedule: wave N = tickets sharing no declared file AND with all dependsOn satisfied by earlier waves/done.
       No-files tickets are treated as potentially-conflicting (scheduled alone); repo-X tickets can parallelize only with safe declared coord code/doc files and remain sequential for global coordination state.
       Deterministic (stable sort by ID); names per-ticket satisfied deps and lists any excluded ticket — no silent drops.)
  coord/scripts/gov sequencer-plan [--status review,doing] [--repo <code>] [--json]
      (read-only contention-triggered land-sequencer planner: groups active/review tickets that overlap by declared files,
       active dependency edges, missing file surfaces, or repo-X global-state risk. Disjoint tickets stay outside the queue;
       risky/unknown groups fall back to full-gate recommendations. Deterministic; mutates nothing.)
  coord/scripts/gov merge-queue [--status review,doing] [--repo <code>] [--json] [--record]
      (operational contention queue inspector/recorder: materializes sequencer-plan groups into deterministic queue state
       under coord/.runtime/merge-queue.json when --record is supplied. Ambiguous ordering is blocked; disjoint/single-agent
       land/finalize remains unchanged.)
  coord/scripts/gov dispatch-plan [--status todo] [--repo <code>] [--wave N] [--execution-id <id>] [--json | --md]
      (ONE deterministic dispatch manifest composing the levers: plan-waves schedule + per-ticket precheck verdict ->
       action skip (already-satisfied; includes the exact governed finalize-already-satisfied command) or spawn (everything else
       — unknown/no-probes NEVER yields a false skip); resolved tier -> suggested model class + tier-appropriate evidence depth;
       context-pack with its STABLE cacheable-prefix vs ticket-specific split preserved (--md emits a contextPackRef pointer).
       Read-only/additive; hash-stable (identical board -> byte-identical --json manifest).)

Observability (ENT-005):
  coord/scripts/gov otlp-export [--output <path> | --stdout] [--endpoint <https-url>] [--allow-insecure-transport]
      (emits the durable journal as OpenTelemetry OTLP/JSON: tickets-as-traces, lifecycle-verbs-as-spans,
       cost/tier/attribution as span attributes; non-ticket events as log records. Zero-dep + deterministic
       (identical journal -> byte-identical output). Default sink is stdout; --output writes a file; --endpoint
       opt-in POSTs to an HTTPS OTLP endpoint (OFF by default, degrades gracefully, no network otherwise).
       Plain HTTP requires --allow-insecure-transport; other URL schemes are rejected.
       READ-ONLY: never mutates the journal/board. Renders a fleet dashboard in Datadog/Grafana from journal export alone.)

Runtime lock repair:
  coord/scripts/gov runtime-lock-status [--kind <governance-runtime|agent-state|coord-state>]
  coord/scripts/gov break-runtime-lock --yes [--kind <governance-runtime|agent-state|coord-state>]
  coord/scripts/gov break-runtime-lock --yes --force-live  # human-admin break-glass only
  coord/scripts/gov break-runtime-lock --kind <kind> --yes  # removes a dangling lock link after re-checking it; writes a recovery receipt
  coord/scripts/gov break-runtime-lock --kind <kind> --sweep-staging [--yes]  # dry-run unless --yes: abandoned .acquire-*/.reclaim-* artifacts
  coord/scripts/gov clean-runtime [--yes] [--force] [--include-ticket-state]
  Agent/coord state locks are recovered only by explicit kind selection. Dead local owners may be reclaimed immediately; unknown owners require the 60s stale threshold; confirmed live local owners are never removed. Foreign-host owners are unknown, not presumed dead, and require --human-admin-override "<approval reason>" plus --yes. The existing governance-runtime selector and --force-live behavior are unchanged.

Deterministic regen of canonical derived artifacts:
  coord/scripts/gov sync [--commit "<message>"]
      (regenerates rendered/TASKS.md, rendered/PROMPT_INDEX.md, PLAN.md and reports drift;
       with --commit, creates a single commit limited to those paths — never sweeps with git add -A)

Publish canonical governance state while tickets are doing (integration authority holder):
  coord/scripts/gov publish-board [--commit "<message>"]
      (commits and publishes the board, rendered views and prompts; refuses with a precise list when a
       dirty path belongs to another live session or is not accounted for by the journal; a refused push
       keeps the commit local and a re-run publishes the same HEAD)

Test policy configuration:
  coord/scripts/gov config propose --target project.testPolicy --value-json <JSON> [--base-digest <sha256>]
  coord/scripts/gov config propose --target project.testPolicy --diff-file <path> [--base-digest <sha256>]
  coord/scripts/gov config approve --proposal-id <id> --human-admin-override "<reason>"

Useful inspection:
  coord/scripts/gov initiate
  coord/scripts/gov agentid [--assign | --owner <handle|simple-id>]
  coord/scripts/gov claim <ticket-id>
  coord/scripts/gov agent-status
  coord/scripts/gov ticket <ticket-id>
  coord/scripts/gov recent [<ticket-id>] --limit 10 [--full]
  coord/scripts/gov explain <ticket-id>
  coord/scripts/gov counts
  coord/scripts/gov surface [--json]   # GENERATED machine-facing inventory: every dispatched verb, alias groups, every accepted flag and the option key it parses to, the enum literals the parser advertises, and the snake_case/camelCase spellings of the JSON plan fields
  coord/scripts/gov doctor [--fix | --repair-all [--confirm]] [--ticket <ticket-id>] [--show-template-feedback] [--offline]
  coord/scripts/gov doctor --recover-runs [--yes]  # COORD-905: dry-run listing of dead-run manifests and lock staging dirs (age + remedy); --yes removes only what each manifest proves the run owned
  coord/scripts/gov conform [--json] [--attest] [--verify-attestation <file>]
  coord/scripts/gov repair-chain [--confirm --reason "<why>"] [--json]
  coord/scripts/gov verify-engine [--pin | --regenerate] [--json]
  coord/scripts/gov audit-landings [--repo <repo-code>] [--ticket <ticket-id>] [--write]
  coord/scripts/gov audit-landings --ticket <done-X-ticket> --correct-merge <full-sha> --source-commit <full-sha> --correction-ticket <active-X-ticket> (--human-admin-override "<approval>"|--human-admin-override-file <path>) (--reason "<disposition>"|--reason-file <path>) [--write]
      Correction mode defaults to read-only cached evidence. --write requires repair-ticket ownership and a successful fresh remote fetch; appends digest-linked superseding evidence without editing the original. Actual first-introduction merges only; no source-parent or prose inference.
  coord/scripts/gov reconcile-landings [--repo <repo-code>]

Notes:
  - "start" requires a claimed owner context (or explicit --owner) before ticket mutations begin.
  - "agentid" reports the current window's agent id when claimed, returns assignment guidance when unclaimed, and can assign explicitly via --assign or --owner.
  - "claim" is different from "start": it binds the current session to an agent, and only takes over an existing ticket owner/lock when --force is explicit.
  - "surface" prints the machine-facing CLI surface GENERATED from the live dispatch table and flag parser (COORD-572). Use it when a capability seems missing: absence from prose documentation is not absence from the product, and five wrongly-filed tickets in one session came from reading it that way. Unknown verbs and unknown flags also suggest near-matches ranked by shared word-parts, so a guessed name like "add-prompt" resolves to the shipped "register-prompt --create".
  - "set-waiver" records machine-readable prompt-coverage waivers in board state; free-text QUESTIONS.md notes are optional narrative context, not the start gate authority.
  - "resume" is the preferred same-owner session handoff for an already-started doing/review ticket; it rebinds the governed ticket lock into the current claimed session.
  - "commit" stages and commits inside the governed worktree for a doing ticket.
  - "submit" creates a PR when needed, records it, and moves the ticket to review after repo-gate, feature-proof, and structured self-review checks pass.
  - Repo-X --base selects the same branch for merge, landing verification, and pre-closeout push. origin/<branch> and refs/heads/<branch> are equivalent selectors. Invalid, conflicting, or missing explicit branches refuse before merge; omitting --base preserves the derived integration default.
  - "finalize" is the shortcut for the common no-PR local-review closeout path; it moves to review and marks done once landing evidence is provided. Use --already-landed only to repair a no-PR ticket that was merged to dev before move-review. If the repo has a remote, prefer PR-backed landing unless no-PR is intentional.
  - "land" merges the PR, records source-vs-landed provenance, removes the clean canonical ticket worktree, closes the ticket, and appends the standard governance closeout note.
  - "supersede" moves any ticket to superseded, removes active lock/worktree residue, and preserves its historical evidence without reopening it later. Pass --reason "<why>" and/or --consolidated-into <ticket-id> to record inline supersession provenance on the board row (Supersede Reason / Superseded By) so a retired ticket is never left without a reason or replacement pointer. It is not a substitute for review/done closeout when the work already landed on dev.
  - COORD-667: --merge-workspace (on "land" / "finalize" / the mark-done verbs) makes governance perform the Repo-X CONTROL-PLANE WORKSPACE MERGE itself, in-process, inside the closeout transaction, with --no-ff (the merge commit is what the COORD-591 engine-surface attribution reads) and the merge commit journaled as an external side effect. Without it, closeout still fails closed exactly as COORD-512 requires — it never auto-advances an adopter's live integration branch. Do not hand-run "git merge" instead: coord/scripts/hooks/pre-bash-guard.js refuses it whenever HEAD is on a protected integration branch (head-on-protected-branch, COORD-664), and that pairing was the COORD-667 deadlock in which no repo-X ticket could land by any sanctioned path.
  - COORD-839: a --merge-workspace landing whose integration changes any file under docs/decisions refuses, before the merge and before any move-review or set-pr write, unless --expect-paths-file <approved packet> lists exactly those decision files with their post-merge sha256 ("absent" for a deletion), in the same line or markdown-table shapes "gov reconcile" accepts (COORD-722); any added, missing or changed path refuses with nothing merged or written, and the refusal prints the packet lines to approve. Landings that change no decision file are unaffected.
  - COORD-612: "start" / "claim" fail closed when another governed writer already holds this checkout/runtime. --allow-shared-worktree is the sanctioned opt-out for the documented orchestrator-spawns-N-subagents topology (each sub-agent should still use its own worktree). Use it instead of breaking locks by hand.
  - the terminal verbs ("land", "finalize", "close", "finish", "mark-done", "finish-ticket") auto-sync canonical derived artifacts afterwards. --no-sync opts out of that sync; --push-after-sync (or COORD_PUSH_ON_FINALIZE=1) opts canonical history into a governed push to the configured upstream, including commits stranded by an earlier terminal attempt even when the current sync is a no-op. A terminal session is retained until the sync succeeds and the configured upstream is proven to contain local HEAD; divergence or an unverifiable remote fails closed. --push-before-closeout (or COORD_PUSH_BEFORE_CLOSEOUT=1) opts the LANDING commit into a governed push of the control-plane integration branch BEFORE the remote-ancestry check, which is the step a hand-run push cannot perform because pre-bash-guard refuses it (COORD-691). None is default; none ever force-pushes, and the governed pushes refuse outright when the remote has diverged rather than resolving it.
  - "recent" / "explain" / "recover" read from the append-only governance journal and are the supported way to diagnose or repair live drift.
  - "conform" is a read-only journal hash-chain self-verify: it verifies every event's prev_event_hash link end-to-end and prints the chain head plus a pass/fail verdict (--json for machine output). A broken link means the journal was reordered, tampered, or had an event dropped; legacy pre-chain events validate as accepted-but-unverified. "doctor" runs the same chain check board-wide and fails on a broken link. ENT-010: "conform --attest" ALSO emits a signed (local ed25519 keypair) conformance attestation over the engine-integrity inputs (engine version, TEMPLATE_SYNC_MANIFEST.json fingerprint, gate config + latest gate-artifact result/coverage/audit, RELEASE_PROVENANCE donor SHA when present, and the journal chain head) under coord/.runtime/attestations/ (private signing key stays gitignored under coord/.runtime/conformance-keys/). "conform --verify-attestation <file>" re-derives the live inputs, recomputes the digest, checks the signature, and flags drift/tamper. This is the Community per-team self-verify; the signed attestation is the exact input a future central re-hash service (ENT-007) would re-compute.
  - "repair-chain" (COORD-124) is a GUARDED, AUDITABLE repair for a journal hash-chain broken by crossed prev_event_hash links (e.g. an out-of-band writer that bypassed the governance runtime lock, or a bad merge of the journal file — NOT concurrent governed mutation, which the mkdir runtime mutex serializes; see COORD-224). With NO flags it is a DRY-RUN: it reports the broken links that WOULD be re-linked (offending indices/ids + claimed-vs-expected prev-hash) and writes NOTHING; it no-ops cleanly when the chain is already valid. With "--confirm --reason \"<why>\"" it APPLIES: it backs the pre-repair journal up to a timestamped .pre-repair-<ts> sidecar (gitignored off-chain evidence), appends an explicit on-chain "chain-repair" marker capturing the broken-link evidence + the human reason + actor + ts, and re-stamps prev_event_hash for every chained event from the first broken link forward (reusing the canonical hasher) so the chain is GENUINELY re-linked — after which "conform" PASSES and the verified chain permanently contains the marker (repair is visible, never silent). The marker does NOT relax the verifier: a chain broken WITHOUT a recorded repair still FAILS conform, so this cannot be used to launder tampering. (--json for machine output.)
  - "verify-engine" (ENT-011, Community per-team) PINS the engine surface to a known-good version and DETECTS drift from it WITHOUT signing (signing is the Enterprise half, ENT-008). "verify-engine --pin" snapshots the current surface (TEMPLATE_SYNC_MANIFEST manifest_version + its sha256 fingerprint, reusing ENT-010's conformance fingerprint, plus per-file checksums and POSIX modes where supported) into coord/engine-pin.json — the ONLY mutation. Windows omits POSIX mode enforcement. "verify-engine" (no flag) is READ-ONLY: it re-derives the live surface and reports IN-SYNC or DRIFTED with the offending file paths / whether the manifest fingerprint changed (--json for machine output). This is COMPLEMENTARY to check-template-sync: check-template-sync verifies internal manifest-vs-files consistency, while verify-engine verifies drift from a FROZEN pinned version (re-pin after an intentional engine bump). "verify-engine --regenerate" (COORD-958) is the one regenerate-and-verify step: from a ticket worktree it re-stamps coord/TEMPLATE_SYNC_MANIFEST.json, re-pins coord/engine-pin.json and verifies both surfaces again; it refuses to regenerate a ticket worktree from the canonical checkout.
  - "recent" omits full snapshot payloads by default; pass --full when you need the materialized snapshot body.
  - "gate" materializes a temporary clean worktree from the target repo's branch, runs the requested gate lane inside it, records branch and commit provenance in the artifact, and prevents branch-ref-only evidence from being treated as tested content. The worktree is removed after the run.
  - COORD-738: gate evidence uses a disposable checkout under the OS temporary directory, outside the source repository's .worktrees tree. Receipts record the exact checkout and scanned paths; isolation cannot be asserted when the checkout is inside the source root. Keep sibling agent worktrees out of evidence and remove abandoned temporary checkouts through the governed cleanup path.
  - structured plan helpers exist for the strict fields so different agents do not have to hand-format fragile 'update-plan' strings for review cycles, requirement closure, feature proof, or repo gates.
  - runtime lock repair is explicit: use 'runtime-lock-status' to inspect the current holder and 'break-runtime-lock --yes' when interrupted governance left 'coord/.runtime/governance.lock' wedged.
  - "clean-runtime" is the supported safe replacement for ad hoc 'git clean/reset' inside coord: it enumerates only regenerable runtime scratch under coord/.runtime and deletes NOTHING without --yes; it never removes locks/, plans/ (ticket-local state), session files, the governance journal/snapshots, or any git-tracked board/docs; ticket-local state needs --include-ticket-state AND --yes; it refuses on rollback drift unless --force.
  - "doctor --repair-all" is the operator-grade recovery wrapper. With no confirmation it is a DRY-RUN: it prints the composed repair plan and writes nothing. With "--confirm" it delegates to the same deterministic repair surface as "doctor --fix" (non-doing locks, stale locks 24h+, malformed locks on doing tickets, coord orphan worktrees, missing governed plan stubs, gate-proc orphans, and stale drift-note retirement) while preserving the existing unsafe-tree refusal. Journal hash-chain repair remains explicit via "repair-chain --confirm --reason".
  - "fleet-golden-path" is the read-only operator wrapper for multi-agent rollout: identity binding, prompt coverage, worktree start, prework context/gate receipts, closeout evidence commands, integration, and dry-run recovery.
  - "doctor --fix" applies deterministic repairs: non-doing locks, stale locks (24h+), malformed locks (missing required fields on doing tickets), coord orphan worktrees, missing governed plan stubs, and retirement of stale governance drift-note rows whose "since" timestamp predates the current journal baseline snapshot.
  - "retire-stale-drift-notes" is the standalone admin form of that retirement step; it marks drift-note QUESTIONS.md rows resolved with an audit note once a later journaled baseline snapshot has absorbed the reported drift. Pass --dry-run to preview.
  - "--dry-run" is honoured only by the verbs declared in coord/engine/scripts/dry-run-policy.js (claim --transfer-to, reconcile, record-managed-evidence, retire-stale-drift-notes, reap-gate-procs, coverage-rollup, resolve-question, quality-scan, repair-lock-head, promote); each writes nothing. Every other verb refuses the flag before it runs (COORD-922).
  - "add-repo-gate" accepts --result <pass|fail> and --base-result <pass|fail> to attribute a failing gate to new-on-ticket vs pre-existing-on-base vs fixed-on-ticket; attribution is encoded as an annotation on the recorded repo_gates entry. --audit <summary> records the dependency/security audit signal (QGATE-002) as an audit=... annotation on the same entry. --arch <summary> records the architecture summary (COORD-078) as an arch=... annotation on the same entry; it is recorded, not enforced. --selection-manifest <file> --base <ref> records a T0/T1 selected-suite run (affected-evaluation.js run-selected, COORD-924) after checking its run manifest: exact tree and base, current selection policy, a pass, and every required suite; T2, fallbacks and suspended categories are refused and need the full gate. "gate-plan --base <ref>" adds the required landing gate to the receipt.
  - Closed tickets are not reopened; use "open-followup" for post-close findings.
  - Run "node coord/scripts/governance.js help --all" for advanced/admin commands.
`;
  }
  return `${buildHelpText({ all: false })}

Advanced/admin usage:
  node coord/scripts/governance.js initiate
  node coord/scripts/governance.js agentid [--assign | --owner <handle|simple-id>]
  node coord/scripts/governance.js claim [<ticket-id>] [--owner <handle|simple-id>] [--handoff [--reason <text>|--reason-file <path>]] [--human-admin-override "<reason>"|--human-admin-override-file <path>] [--allow-shared-worktree]
      (same-owner recovery of a stale session: --handoff; displacing a session still live on another thread, or cross-owner takeover: --human-admin-override "<reason>" (COORD-893); bare --force is a deprecated legacy alias only)
  node coord/scripts/governance.js resume <ticket-id>
  node coord/scripts/governance.js agents list
  node coord/scripts/governance.js agents register [--handle <handle>] [--id <simple-id>] [--provider <provider>] [--lane <lane>] [--default-repo <repo-code>] [--notes <text>]
  node coord/scripts/governance.js agents disable <handle|simple-id>
  node coord/scripts/governance.js agents enable <handle|simple-id>
  node coord/scripts/governance.js agents recover-lease-registry --registry <file> --expect-sha256 <hex> (--restore-from <known-good copy> | --approve-empty) --human-admin-override "<reason>"
      (human-admin recovery of a v2 owner-lease registry every consumer refuses as unreadable/corrupt: keeps the corrupt bytes under <runtime>/identity/recovery/, accepts only a replacement the strict reader validates, journals the attributed event, and lists every lease dropped or changed)
  node coord/scripts/governance.js agent-claim <handle|simple-id> [--session-label <label>] [--host <host>] [--cwd <path>] [--force]
  node coord/scripts/governance.js agent-release <handle|simple-id|session-id> [--force]
  node coord/scripts/governance.js agent-rebind --fresh [--session-label <label>] [--host <host>] [--cwd <path>]
  node coord/scripts/governance.js rebuild-board <ticket-id> | --all
  node coord/scripts/governance.js agent-status [<handle|simple-id>]
  node coord/scripts/governance.js pick [all] [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js start <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>] [--dispatch-execution-id <id>] [--allow-shared-worktree]
  node coord/scripts/governance.js unstart <ticket-id> [--owner <owner>]
  node coord/scripts/governance.js block <ticket-id> [--owner <owner>] (--reason <text>|--reason-file <path>)
  node coord/scripts/governance.js unblock <ticket-id> [--owner <owner>]
  node coord/scripts/governance.js plan <ticket-id> [--seed] [update-plan flags...]
  node coord/scripts/governance.js gate-plan <ticket-id> [--files <path> ...] [--map <path>] [--risk-class <R0|R1|R2|R3|R4>] [--full] [--write] [--json | --md]
  node coord/scripts/governance.js commit <ticket-id> {--message|-m} <text> [--all] [--files <path> ...] [--ack-outside-scope <exact Git-relative path> ...] [--owner <owner>]
  node coord/scripts/governance.js submit <ticket-id> [--pr <ref> ...] [--base <branch>] [--title <text> --body <text> | --fill] [--draft]
  node coord/scripts/governance.js review <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js land <ticket-id> [--pr <ref> ...] [--landed <evidence> ...|--landed-file <path> ...] [--method <merge|squash|rebase>] [--delete-branch] [--merge-workspace] [--admin] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js finalize <ticket-id> [--no-pr] [--base <branch>] [--already-landed] [--merge-workspace [--expect-paths-file <approved ADR packet>]] [--pr <ref> ...] [--landed <evidence> ...|--landed-file <path> ...] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js supersede <ticket-id> [--reason <text>|--reason-file <path>]
  node coord/scripts/governance.js finish <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js close <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js repair <ticket-id> [--owner <owner>] --summary <text> --severity ${FINDING_SEVERITY_USAGE} --qref <Lxx>
  node coord/scripts/governance.js backfill-plan-records [--from <ticket-id>] [--status <review|done>] [--limit <n>]
  node coord/scripts/governance.js counts
  node coord/scripts/governance.js board-state
  node coord/scripts/governance.js surface [--json]
  node coord/scripts/governance.js recent [<ticket-id>] [--limit <n>] [--full]
  node coord/scripts/governance.js explain <ticket-id>
  node coord/scripts/governance.js recover <ticket-id> [--human-admin-override "<reason>"]
  node coord/scripts/governance.js reconcile [<ticket-id>] (--reason <text>|--reason-file <path>) [--scope <governed|derived|runtime>] [--human-admin-override <approval> --expect-paths-file <approved packet>] [--dry-run]
  node coord/scripts/governance.js list [--status <status>] [--repo <repo>] [--owner <owner>] [--pri <priority>]
  node coord/scripts/governance.js recommend [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js next-ticket [--repo <repo-code>] [--mode <backend|frontend|design|general>] [--owner <owner>] [--limit <n>] [--include-blocked] [--why <ticket-id>]
  node coord/scripts/governance.js run-ticket-cycle <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>]
  node coord/scripts/governance.js fleet-golden-path [<ticket-id>] [--json]
  node coord/scripts/governance.js guided-closeout <ticket-id> [--json] [--write]
  node coord/scripts/governance.js governance-tier [--json] [--tier <lite|standard|full>]
  node coord/scripts/governance.js publishability-check <ticket-id> [--json] [--files <path[,path]>]
  node coord/scripts/governance.js doctor [--fix | --repair-all [--confirm]] [--ticket <ticket-id>] [--show-template-feedback]
  node coord/scripts/governance.js audit-landings [--repo <repo-code>] [--ticket <ticket-id>] [--correct-merge <full-sha>] [--source-commit <full-sha>] [--correction-ticket <active-X-ticket>] [--human-admin-override <approval>|--human-admin-override-file <path>] [--reason <disposition>|--reason-file <path>] [--write]
  node coord/scripts/governance.js ticket <ticket-id>
  node coord/scripts/governance.js pr-view <ticket-id|pr-url>
  node coord/scripts/governance.js pr-create <ticket-id> [--base <branch>] [--title <text> --body <text> | --fill] [--draft] [--push]
  node coord/scripts/governance.js pr-merge <ticket-id|pr-url> [--method <merge|squash|rebase>] [--delete-branch] [--admin]
  node coord/scripts/governance.js mark-done <ticket-id> [--landed <evidence> ...|--landed-file <path> ...] [--source-commit <sha>] [--fulfilled-by-ticket <ticket-id> | --fulfilled-by-commit <sha>]
  node coord/scripts/governance.js finish-ticket <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js move-review <ticket-id> [--pr <ref> ...]
  node coord/scripts/governance.js reopen-ticket <ticket-id>   # deprecated compatibility alias; now errors with guidance
  node coord/scripts/governance.js return-doing <ticket-id> [--owner <owner>] --summary <text> --severity ${FINDING_SEVERITY_USAGE} --qref <Lxx>
  node coord/scripts/governance.js start-ticket <ticket-id> [--owner <owner>] [--topic <slug>] [--base <branch>] [--allow-shared-worktree]
  node coord/scripts/governance.js commit-ticket <ticket-id> --message <text> [--all] [--files <path> ...] [--ack-outside-scope <exact Git-relative path> ...] [--owner <owner>]
  node coord/scripts/governance.js open-followup [<new-ticket-id>|--prefix <PREFIX>] {--depends-on|--parent} <ticket-id> --repo <repo-code> --type <type> --pri <priority> --description <text> [--relation <blocking|related|closeout-blocker>] [--prompt <existing-path>]   # Creates a child-owned prompt by default; --prompt deliberately references an existing/shared prompt and records that choice.
  node coord/scripts/governance.js file-ticket [<new-ticket-id>|--prefix <PREFIX>] --repo <repo-code> --type <type> --pri <priority> (--description <text>|--description-file <path>) [--depends-on <ticket-id>] [--prompt <path>] [--with-prompt] [--prompt-template ticket] [--owner <handle>]   # alias: new
  node coord/scripts/governance.js amend-ticket <ticket-id> [--description <text>] [--pri <P0|P1|P2|P3>] --reason <text> [--human-admin-override <approval>]
      (Correct description/priority only; at least one is required. Description: nonblank, at most 4 MiB UTF-8, preserved literally; pass multiline text as one argv value. Requires a registered active session, and the bound owner for assigned tickets or explicit admin approval. Preserves prompts, locks, sessions and lifecycle evidence; unchanged values produce no event.)
  node coord/scripts/governance.js next-id <PREFIX>
  node coord/scripts/governance.js split-ticket <parent-ticket-id> --into <repo-codes> [--prefix <PREFIX>]
  node coord/scripts/governance.js set-followup-relation <ticket-id> [--depends-on <id[,id...]> ...] --relation <blocking|related|closeout-blocker|independent> [--replace]
  node coord/scripts/governance.js set-waiver <ticket-id> (--reason <text>|--reason-file <path>) [--clear]
  node coord/scripts/governance.js register-prompt <ticket-id> [<path>] [--path <path>] [--create] [--template ticket] [--force] [--replace] [--body-file <path>]
  node coord/scripts/governance.js set-pr <ticket-id> --pr <ref> [--pr <ref> ...] [--replace]
      (appends verified refs with stable deduplication by default; --replace explicitly replaces the full collection; success prints the complete resulting set)
  node coord/scripts/governance.js add-finding <ticket-id> --severity ${FINDING_SEVERITY_USAGE} --summary <text> --qref <Lxx> [--round <n>]
      (the finding is recorded under the round the ticket is CURRENTLY in, so every finding from ONE review shares one round. Rounds advance only through "return-doing"; an explicit --round that disagrees with lifecycle state is refused.)
  node coord/scripts/governance.js correct-finding-round <ticket-id> --id <finding-id> --round <n> (--human-admin-override "<reason>"|--human-admin-override-file <path>)
      (human-admin repair for a finding already filed under the wrong round — e.g. findings auto-incremented to rounds 1..N by one review before COORD-649. Journals the before and after round with the override reason; refuses a round above the round the ticket has actually reached. Hand-editing the board or coord/.runtime/plans/<ticket>.json is never the remedy.)
  node coord/scripts/governance.js update-finding <ticket-id> --id <finding-id> --status <resolved|deferred|consolidated> [--deferred-to <ticket>] [--consolidated-into <ticket>]
      (status only; --severity is refused. A recorded severity is changed with "correct-finding-severity", never by update-finding or a hand edit.)
  node coord/scripts/governance.js correct-finding-severity <ticket-id> --id <finding-id> --severity ${FINDING_SEVERITY_USAGE} --reason <text> [--human-admin-override <approval>]
      (The ticket owner or a recorded reviewer may raise a severity on their own authority; a recorded reviewer is a non-owner session the engine recorded as the added_by author of a finding on the ticket. Any other raise needs the human-admin override. Lowering always requires approval by an identity other than the requester: today the human-admin override; a governed reviewer role waits for COORD-718. The actor is the bound session. A finding records original_severity when added; the prior value, actor, time, reason and approval are appended to the finding's severity_history and journaled; a refusal writes nothing.)
  node coord/scripts/governance.js log-question --from <agent> --to <target> --question <text> [--answer <text>] --resolved <yes|no|n/a>   # --answer is required for yes or n/a; omit it for an unanswered question with no.
  node coord/scripts/governance.js resolve-question --dry-run [--expected-row-digest <sha256>]   # Read-only row inventory with exact selectors.
  node coord/scripts/governance.js resolve-question --expected-row-digest <sha256> --evidence <text>   # Resolve one original row; requires a bound agent. Preserve original fields and record resolution history. Identical replay is read-only; conflicting, stale, or ambiguous selections refuse.
  node coord/scripts/governance.js heartbeat <ticket-id>
  node coord/scripts/governance.js update-plan <ticket-id> [--summary <text>] [--verify <cmd>] [--files <path>] [--drop-file <path>] [--security <yes|no>] [--startup <completed>] [--traceability <verified|closing-gap|exempt>] [--baseline <text>] [--invariant <text>] [--closure <text>] [--feature-proof <text>] [--drop-feature-proof <text>] [--repo-gate <text>] [--rollback <text>] [--closeout-method <pr|no_pr|fulfilled_by>] [--closeout-base-ref <ref>] [--provenance-note <text>] [--review-profile <standard|bounded_repair>] [--context-pack-ack '<json>'|none] [--live-mcp '<json>'|none] [--gate-plan '<json>'|none] [--bootstrap-risk '<json>'|none] [--decision-required '<json>'|none] [--review-cycle <text>] [--replace-review-cycle <N> --review-cycle <text>] [--drop-review-cycle <N>]
      (--decision-context '<json>' (or --decision-context-file <path>) is the one versioned packet, schema_version 1, that expands into adr_refs (--adr-ref), decision_required, a business-context invariant and context_pack_ack; unknown keys or versions refuse the whole packet before any write, and a packet never duplicates a per-field flag for the same field. --context-pack-ack / --live-mcp / --gate-plan / --bootstrap-risk / --decision-required each take a JSON object, or the literal "none" to clear. The record spellings are the snake_case forms context_pack_ack / live_mcp / gate_plan / bootstrap_risk / decision_required — "coord/scripts/gov surface" prints both spellings against the writing flag. --context-pack-ack is the ONLY sanctioned writer for the context_pack_ack the review gate requires — run "coord/scripts/gov update-plan --help" for the accepted JSON shape and never hand-edit the canonical plan record.)
      --provenance-note <text> writes operator evidence and explicitly replaces the existing note. Closeout preserves that note and appends landing provenance once; without --landed the note is preserved. Applies to pr, no_pr and fulfilled_by closeout.
      --adr-ref <ADR-0001> is repeatable and appends validated references to plan adr_refs. It does not approve an ADR or change gov adr link metadata.
  node coord/scripts/governance.js add-review-cycle <ticket-id> --lens <name> --diff <text> --risk <text> --risk <text> --findings <text> --verification <cmd> --verdict <pass|fail> [--replace-review-cycle <N>]
  node coord/scripts/governance.js set-review-cycles <ticket-id> --replace --review-cycle "<structured cycle>" [--review-cycle "<structured cycle>" ...]
      (replaces the complete cycle collection only with --replace; use add-review-cycle for incremental evidence)
  node coord/scripts/governance.js scan-context-pack-acks [--json]
  node coord/scripts/governance.js repair-context-pack-ack <ticket-id> --context-pack-ack '<json>'|none [--confirm] [--human-admin-override "<reason>"]
  node coord/scripts/governance.js set-context-pack-ack <ticket-id> [--considered <section>=<text> ... --learning <promote|demote|scratch-only|mixed|none> [--authority <text>] [--advisory-only <text>] [--rationale <text>] | --not-applicable --reason "<why>"]
  node coord/scripts/governance.js set-requirement-closure <ticket-id> --ticket-ask <text> --implemented <text> [--not-implemented <text>] [--deferred-to <text>] --closeout-verdict <complete|incomplete> [--supersede]
  node coord/scripts/governance.js add-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  node coord/scripts/governance.js drop-feature-proof <ticket-id> (--proof-path <path> | --proof-symbol <file#symbol> | --proof-text <literal> | --proof-route <route>)
  node coord/scripts/governance.js add-repo-gate <ticket-id> (--command <cmd> [--note <text>] [--result <pass|fail>] [--base-result <pass|fail>] | --not-required)
  node coord/scripts/governance.js retire-stale-drift-notes [--dry-run]
  node coord/scripts/governance.js release-lock <ticket-id> [--force]
  node coord/scripts/governance.js lock-abandon <ticket-id> --human-admin-override "<reason>"
  node coord/scripts/governance.js runtime-lock-status
  node coord/scripts/governance.js break-runtime-lock --yes [--force-live]
  node coord/scripts/governance.js clean-runtime [--yes] [--force] [--include-ticket-state]
  node coord/scripts/governance.js audit-worktrees
  node coord/scripts/governance.js audit-architecture [--json] [--previous <report.json>] [--out <prefix>]
  node coord/scripts/governance.js cleanup-helpers <repo-code|repo-name> --yes [--delete-branch]
  node coord/scripts/governance.js gate <repo-code|repo-name> --lane <default|full|ci> [--branch <ref>] [--source <local|hook|ci>]
  node coord/scripts/governance.js cleanup-worktree <repo-code|repo-name> <ticket-id|path> --yes [--delete-branch]

Notes:
  - "initiate" is the session-start primer: it prints the current claim state, the do-not-edit rules, and the supported lifecycle commands for this board.
  - "agentid" reports the current window/thread identity when already claimed, returns structured assignment guidance when unclaimed, and can assign explicitly via --assign or --owner.
  - "claim" binds the current thread/session to an agent identity; with a ticket-id it only takes over another active owner/lock when --force is explicit.
  - "resume" is the preferred same-owner session rebind for an already-started doing/review ticket and avoids the common "claim --owner" vs ticket-lock confusion.
  - agent ownership is registry-backed and tied to the current governance board; mutating commands require explicit claim or --owner before lock/worktree mutation.
  - the same claimed agent identity may work across backend, frontend, and coord repos that share this board without changing names.
  - "pick" / "start" / "submit" / "land" / "repair" are the preferred top-level workflow verbs.
  - "unstart" is the guarded same-owner wrong-start exception: it reverts a doing/blocked ticket to todo and clears the owner, lock, and clean worktree. It fails closed once the ticket has accrued review, landing, plan, or workspace evidence that must remain auditable — use "move-review" or "supersede" instead. Foreign-owner cleanup stays an admin path ("lock-abandon").
  - "lock-abandon" is the foreign-owner admin counterpart of "unstart": with --human-admin-override "<reason>" it returns a stale foreign-locked doing ticket to todo and clears the owner, lock, and clean worktree. It rejects a ticket the current session owns (use "unstart") and fails closed on accrued review/landing/plan/workspace evidence (use "supersede" or "reconcile"). The override authorizes touching foreign ticket state, not destroying auditable work.
  - "block" / "unblock" toggle a doing ticket between "doing" and "doing (blocked: <reason>)" for the same owner; both are journaled lifecycle transitions and require the ticket to already be doing.
  - "pick" without arguments ranks work only for the current agent/session; "pick all" looks at idle active agent sessions and returns one option per agent.
  - "mark-done" is a guarded review -> done transition and re-checks review-plan gates, merged/manual landing evidence, source-vs-landed provenance, canonical-branch landing ancestry, feature-proof audit, clean worktree closeout, and any declared closeout-blocker follow-up tickets.
  - "recommend" / "next-ticket" ranks the best next open tickets from the canonical board.
  - "integration" (COORD-915) makes integrating canonical state a separate permission from registering an identity or owning a ticket. Integration verbs (sync, the terminal verbs and their post-finalize sync/push, supersede, reconcile, reconcile-landings, pr-merge, rebuild-board, repair-chain, migrate-chain-hash, backfill-plan-records, retire-stale-drift-notes, audit-landings --write) need the domain's holder; while an operation is open every other session's governed write is refused. Every grant, refresh, handoff, release, begin, operation close or interruption and recovery is journaled together with the record (a pending mark is completed or rolled back on the next read); a terminal verb journals its authority events only when it changed canonical state, so a refused closeout leaves the journal byte-identical. An SSH session in the canonical checkout is refused as a competing writer in the same domain. Not yet protected: hand-run git commit/push and code that bypasses both the CLI/MCP dispatch and withGovernanceMutation; unattributed callers before any holder exists; the first identified session in an empty domain becomes holder (run "gov integration claim" as the orchestrator right after upgrading); separate runtimes on other hosts or clones are separate domains. See coord/GOVERNANCE.md Section 11.0.
  - "run-ticket-cycle" scaffolds the governed planner -> worker -> reviewer -> closer flow for one ticket.
  - "fleet-golden-path" prints the read-only multi-agent operator path: identity binding, prompt coverage, isolated worktree start, gate/context prework, closeout evidence wrappers, integration, and dry-run recovery.
  - "guided-closeout" prints exact closeout gaps and ready-to-paste remediation commands before submit/finalize; --write stores a runtime receipt for handoff.
  - "governance-tier" reports the active progressive-disclosure tier. Existing repos default to full so current behavior is unchanged.
  - "publishability-check" tells closeout whether touched canonical/docs/release/engine surfaces need template-sync, prodloc, leak-scan, or dual-release evidence.
  - "set-context-pack-ack" is the per-section authoring verb over the same update-plan --context-pack-ack writer. With no flags it is READ-ONLY: it prints the context-pack refs found in the plan and every non-empty pack section with its item ids. To write, pass --considered <section>=<text> for ALL six sections (active_constraints, adrs, business_rules, conflicts, stale_warnings, open_questions; repeat a section for several entries) plus --learning; refs are machine-filled, but section text is never taken from the pack and a missing section is refused. "--not-applicable --reason <why>" records an explicit not-applicable acknowledgement as one journaled event carrying the reason; it is refused while a cited pack still lists conflicts, stale sources or open questions. Every write of a context_pack_ack (this verb or update-plan --context-pack-ack) runs the review gate's own acknowledgement checks and is refused, with nothing written, if the gate would reject it.
  - "scan-context-pack-acks" is a read-only scan of every plan record for a stored context_pack_ack that violates the canonical schema (for example a considered.* field sealed as a string by an older writer). It writes, normalizes and coerces nothing, lists tickets in sorted order with the violation and the repair command, and exits 1 when any record is malformed. "repair-context-pack-ack" replaces one malformed acknowledgement with an operator-authored '<json>' (or "none"): without --confirm it is a DRY-RUN that prints the stored value, the violation and the validated replacement; with --confirm it writes through the same journaled update-plan mutation. Nothing is derived from the stored value. A non-owner needs --human-admin-override. Until repaired, update-plan, guided-closeout, claim, claim --transfer-to, pr-create, submit and closeout all refuse the ticket with the same violation, before any lock, ownership, board, push or PR side effect.
  - "doctor" runs board validation plus extra governance audits; --fix applies only deterministic repairs and then prints what changed. --repair-all is dry-run by default and requires --confirm before delegating to those deterministic repairs.
  - "audit-landings" classifies done backend/frontend landing records into explicit, fulfilled-by, legacy, and unknown buckets, and can backfill provenance_status plus commit_sha for legacy records that already resolve cleanly to a landed dev ancestor.
  - active doing-ticket lock/worktree drift is reported by "doctor" but does not block unrelated governed lifecycle mutations.
  - governed lifecycle mutations are journaled under coord/.runtime; unrelated provenance drift is logged to coord/QUESTIONS.md for orchestrator follow-up instead of blocking agents, while duplicate claim conflicts and direct write conflicts still fail closed.
  - the journal keeps compact event rows plus a latest-snapshot checkpoint; use "recent --full" only when you need the materialized snapshot body.
  - "pr-view" / "pr-create" / "pr-merge" keep GitHub PR actions inside the same guarded governance CLI; PR creation now requires a clean committed governed worktree.
  - "commit" / "commit-ticket" stage and commit in the governed Git worktree, including Repo X. The canonical plan intended_files defines literal file or directory scope. Workspace-qualified paths naming the configured repository are converted to repository-relative paths; other paths are repository-relative. Omitted --files and --all stage all changes. Already-staged paths are checked too. Out-of-scope paths require one --ack-outside-scope per exact Git-relative filename; acknowledgements must match all and only the exceptions and are journaled. Git hooks still run; coordinate external Git writers and hooks that modify the index.
  - "submit" creates a PR when needed, records it, and moves the ticket to review after repo-gate, requirement-closure evidence, feature-proof evidence, and structured self-review checks pass.
  - "finalize" is the governed shortcut for local-review / no-PR closeout when you already have landing evidence; --already-landed is the repair path for a no-PR ticket that reached dev before move-review. Once a repo has a configured remote, prefer PR-backed landing unless no-PR is an intentional exception.
  - "land" merges the PR, records source-vs-landed provenance, removes the clean canonical ticket worktree, closes the ticket, and appends the standard governance closeout note.
  - "move-review" performs the guarded doing -> review closeout, requires recorded repo gates plus explicit ask-vs-implementation closure evidence, feature-proof evidence, and structured self-review evidence (critical invariants, 4 cycles, distinct deep-review lenses for product repos), and releases the lock. If --pr is omitted, it reuses existing pr_index or resolves a single branch PR. For no-PR tickets already landed on dev, use finalize --no-pr --already-landed instead of supersede.
  - "reopen" is a deprecated compatibility alias and now errors with guidance; closed tickets require follow-up tickets instead of reopen.
  - "finish-ticket" chains set-pr -> move-review -> mark-done when the gates pass. If --pr is omitted, it reuses existing pr_index or resolves a single branch PR.
  - "return-doing" performs the guarded review -> doing transition, records a new finding, reacquires the lock, preserves the canonical plan record, and resets only the round-specific self-review evidence that must be refreshed.
  - "start-ticket" requires canonical plan state with startup/traceability attestations (and baseline reproduction for test tickets), then updates the board, creates a lock, and creates a canonical worktree.
  - "set-waiver" records structured prompt-coverage waivers in board state so start gating does not depend on free-text QUESTIONS.md scans.
  - "register-prompt --create" writes the canonical prompt file and prompt_index mapping in one governed mutation; without --create it still requires the prompt file to exist first. "register-prompt --body-file <path>" writes literal UTF-8 bytes (up to 4 MiB) to the already-registered prompt inside coord/prompts and journals that file without changing its mapping; it cannot be combined with mapping/template options.
  - "backfill-plan-records" synthesizes canonical per-ticket plan records for historical governed tickets that predate the new plan store, using surviving PLAN.md blocks when present and board lifecycle evidence otherwise.
  - "cleanup-helpers" removes helper/temp worktrees that are not canonical ticket worktrees.
  - "cleanup-worktree" is destructive and requires --yes.
  - "clean-runtime" is the supported safe alternative to ad hoc 'git clean/reset' for coord: dry-run by default, requires --yes to delete, only touches regenerable runtime scratch under coord/.runtime, never touches ticket-local state (locks/, plans/), session files, the journal/snapshots, or git-tracked board/docs, and refuses on rollback drift unless --force.
  - "selection" (COORD-924) reads and changes the governed affected-selection state on the board, each change one journaled mutation: coord/scripts/gov selection <state | suspend --ref <ticket|run> [--category <c>] [--reason <text>] | resolve --category <c> --investigation <ref> | nightly --full-report <file> --base <ref> [--head <ref>] [--inventory <file>] [--ref <run>]>. A resolve needs the investigation and a raised policy_version.
  - "test-policy" (COORD-936) resolves and runs the one stage-aware test policy (coord/engine/test-policy.json plus the testPolicy block of coord/project.config.js); local commands and CI call the same verb: coord/scripts/gov test-policy <show | resolve --stage <s> [--base <ref>] [--head <ref>] [--ticket <id> | --repo <code>] [--trigger urgent-release] [--json] | run --stage <s> ... [--out <dir>] [--history <previous report>] | compare --full-report <runner report> --base <ref> [--head <ref>] [--selected-report <report>] [--inventory <file>]>. Runnable now, and active for landings: operating_mode.landing_gates is active in coord/engine/test-policy.json, so an eligible T0/T1 selected-run manifest is accepted as landing evidence; T2 and unknown-impact changes still need the full gate.
  - "config" (COORD-1027) proposes changes only to project.testPolicy as inert JSON data: use exactly one of --value-json or --diff-file; proposals bind the full config base digest and are journal-only until approved. Approval requires --proposal-id and a signed human-admin override; a reason string alone does not authorize it. Unsupported or stale config shapes refuse without changing the source.
`;
}

function printHelp(options = {}) {
  console.log(buildHelpText(options));
}

// COORD-612: `gov <verb> --help`. A supported-but-undocumented flag is not a
// cosmetic gap — `--context-pack-ack` was wired, required by the submit gate,
// and invisible in every help surface, so three agents concluded no CLI verb
// existed and hand-edited the canonical plan record instead. Per-verb help
// makes the flag list reachable at the point of use. It is a pure PROJECTION of
// the same help text printHelp emits (both cuts), never a second hand-maintained
// list: the lines are selected by matching the verb token, so any flag published
// in `gov help` is automatically published here too.
function buildVerbHelpText(verb) {
  const name = String(verb || "").trim();
  if (!name) {
    return null;
  }
  const usagePattern = new RegExp(`(?:^|[\\s/])${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?=\\s|$)`);
  const notePattern = new RegExp(`^\\s*-\\s*"${name}"`);
  const usage = [];
  const notes = [];
  for (const cut of [buildHelpText({ all: false }), buildHelpText({ all: true })]) {
    const lines = cut.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (notePattern.test(line)) {
        if (!notes.includes(line)) {
          notes.push(line);
        }
        continue;
      }
      if (!/^\s+(?:coord\/scripts\/gov|node coord\/scripts\/governance\.js)\s/.test(line)) {
        continue;
      }
      const invocation = line.replace(/^\s+(?:coord\/scripts\/gov|node coord\/scripts\/governance\.js)\s+/, "");
      if (!usagePattern.test(` ${invocation.split(/\s/)[0]}`)) {
        continue;
      }
      const block = [line];
      // Keep the indented continuation/explanation lines that belong to the entry.
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\s{6,}\S/.test(lines[j]) && !/^\s+(?:coord\/scripts\/gov|node coord\/scripts\/governance\.js)\s/.test(lines[j])) {
          block.push(lines[j]);
        } else {
          break;
        }
      }
      const rendered = block.join("\n");
      if (!usage.includes(rendered)) {
        usage.push(rendered);
      }
    }
  }
  if (usage.length === 0 && notes.length === 0) {
    return null;
  }
  const out = [`Governance helper CLI — ${name}`, ""];
  if (usage.length > 0) {
    out.push("Usage:", ...usage, "");
  }
  if (notes.length > 0) {
    out.push("Notes:", ...notes, "");
  }
  out.push(`Run "coord/scripts/gov help --all" for the full command surface.`);
  return out.join("\n");
}

function printVerbHelp(verb) {
  const text = buildVerbHelpText(verb);
  if (!text) {
    printHelp({ all: false });
    return null;
  }
  console.log(text);
  return text;
}

function buildInitiateSummary() {
  let claimStatus = "- No active claimed agent session is bound to this thread yet.";
  try {
    const identity = ensureCurrentAgentIdentity({ allowAutoClaim: false, touchSession: false });
    claimStatus =
      `- Current claimed session: ${identity.agent.handle} (${identity.agent.id})` +
      `${identity.session?.session_id ? ` via ${identity.session.session_id}` : ""}.`;
  } catch (error) {
    if (!(error instanceof GovernanceError)) {
      throw error;
    }
  }

  return [
    "Governance Session Primer",
    "",
    "Current session:",
    claimStatus,
    "",
    "Rules:",
    "- Use `coord/scripts/gov ...` for lifecycle mutations. Do not directly edit `coord/board/tasks.json`, `coord/PLAN.md`, `coord/.runtime/plans/*.json` (plan shards; legacy `coord/board/plans/*.json` is read-only compat), `coord/.runtime/agents.json`, `coord/agents.json`, lock files, or session files.",
    "- Start each session by claiming an owner with `coord/scripts/gov claim --owner <handle|simple-id>`, or use `coord/scripts/gov resume <ticket-id>` when you are re-entering an active ticket.",
    "- Normal flow is `pick` -> `plan --seed` or `start` -> `update-plan` -> `commit` -> `submit` -> `finalize` or `land`.",
    "- `coord/scripts/gov plan <ticket-id>` shows canonical plan readiness; `plan <ticket-id> --seed` creates the startup-ready plan state used by start. `start` auto-seeds the same fields, so `--seed` is mainly for previewing plan readiness before claiming.",
    "- Use `coord/scripts/gov update-plan <ticket-id> ...` (or `plan` with the same flags) for startup attestations, baseline evidence, invariants, requirement closure, repo gates, and review cycles. Do not patch plan JSON or PLAN.md by hand.",
    "- When governance blocks you, use `coord/scripts/gov explain <ticket-id>`, `coord/scripts/gov recent <ticket-id>`, and `coord/scripts/gov recover <ticket-id>` before considering any manual repair.",
    "",
    "Common commands:",
    "- `coord/scripts/gov pick --mode general --limit 3`",
    "- `coord/scripts/gov claim --owner <handle|simple-id>`",
    "- `coord/scripts/gov resume <ticket-id>`",
    "- `coord/scripts/gov explain <ticket-id>`",
    "- `coord/scripts/gov doctor`",
  ].join("\n");
}

function printInitiate(options = {}) {
  if (Object.keys(options).length > 0) {
    fail("initiate does not take options. Run it with no arguments to print the governance primer for this session.");
  }
  console.log(buildInitiateSummary());
}

// COORD-141: `gov recall "<query>"` — Phase 1 deterministic memory recall.
// Thin CLI wrapper over the standalone recall engine (coord/engine/scripts/recall.js):
// id/path -> BM25 -> provenance weighting, source-cited, permission-aware via
// ENT-012 (best-effort; community-cut safe). The query is the leading
// positional arg(s); --role <role> opts into RBAC redaction; --json emits the
// raw §7 contract. The engine is required lazily so the rest of lifecycle.js
// stays independent of the memory layer.
function recallCommand(query, options = {}) {
  const recallEngine = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/recall.js"));
  const text = query == null ? "" : String(query);
  if (!text.trim()) {
    fail('recall requires a query: coord/scripts/gov recall "<query>" [--role <role>] [--json]');
  }
  const result = recallEngine.recall(text, { role: options.role || null });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`Q: ${result.query}`);
  console.log("");
  console.log(result.answer);
  console.log("");
  console.log(`confidence=${result.confidence} staleness=${result.staleness}`);
  console.log("");
  console.log("Sources:");
  for (const s of result.sources) {
    console.log(
      `  - [${s.type}] ${s.id || ""} ${s.path || ""} ` +
        `verified=${s.verified} event_hash=${(s.event_hash || "").slice(0, 12)} ` +
        `chain_head=${(s.chain_head || "").slice(0, 12)}`
    );
  }
  return result;
}

// COORD-147: `gov insights` — Strategic execution-insight reports. Thin CLI
// wrapper over the standalone generator (coord/engine/scripts/insight-reports.js). It
// RECOMMENDS only: a pure read over the journal + board + plan records that
// mutates/gates nothing and emits only source-cited claims. --json emits the
// structured report; default emits the readable text report. The engine is
// required lazily so the rest of lifecycle.js stays independent of the memory
// layer.
function insightsCommand(options = {}) {
  const engine = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/insight-reports.js"));
  const report = engine.generateReport({ now: new Date().toISOString() });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(engine.renderText(report));
  return report;
}

// COORD-243: `gov coverage-rollup [--json] [--dry-run]` — the DO layer of the
// coverage-maturity DETECT/DO/TRIGGER split. SEPARATE from `gov doctor` (doctor
// only DETECTS): this verb DOES the minutes-scale work. It reads the REAL
// artifacts the governed lane already produces — the per-commit coverage gate
// signals recorded in plan records (QGATE-003) + the `gov insights` gate/recovery
// health rollup — and refreshes coord/TEST_MATURITY.md's `Last updated`, the
// gate-health-derived rows, and a History entry. IDEMPOTENT: re-running on
// unchanged inputs leaves the file byte-identical. `--dry-run` computes without
// writing. The TRIGGER (cadence) lives in coverage-rollup-cron.js + the runbook.
function coverageRollupCommand(options = {}) {
  const engine = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/coverage-maturity.js"));
  const result = engine.rollup({
    now: new Date().toISOString(),
    write: !options.dryRun,
  });
  if (options.json) {
    console.log(JSON.stringify({
      output: result.outputPath,
      changed: result.changed,
      dry_run: Boolean(options.dryRun),
      inputs: result.inputs,
    }, null, 2));
    return result;
  }
  const verb = options.dryRun ? "would refresh" : result.changed ? "refreshed" : "no change (idempotent)";
  console.log(
    `coverage-rollup: ${verb} coord/TEST_MATURITY.md — ` +
    `gate ${result.inputs.gate.failing_cycles}/${result.inputs.gate.total_cycles} review cycles failing, ` +
    `${result.inputs.recovery_events} recovery events` +
    (result.inputs.coverage ? `, coverage ${result.inputs.coverage.result}` : "") +
    (result.inputs.mutation ? `, mutation ${result.inputs.mutation.result}` : "") +
    "."
  );
  return result;
}

// COORD-148: `gov prework <ticket> [--scope "<text>"] [--role <role>] [--json]`
// — the [Memory] Solving pre-work CONTEXT PACK. Thin CLI wrapper over the
// standalone generator (coord/engine/scripts/prework-pack.js). It RECOMMENDS only: a
// pure read over governed memory (journal + board + plan records + decision
// records + indexed files) that surfaces, BEFORE an agent starts, the relevant
// prior work + already-failed approaches in the touched area + a recommended
// safe decomposition / test selection — every item source-cited, mutating and
// gating nothing. Complements `gov explain` start-readiness (advisory input the
// agent reads at work-start). Composes recall.js / decision-extractor.js /
// insight-reports.js; required lazily so lifecycle.js stays independent of the
// memory layer. The leading positional is the ticket id (optional when --scope
// supplies a free-text area); --scope adds free text; --role opts into ENT-012
// redaction; --json emits the structured pack.
function preworkCommand(ticketId, options = {}) {
  const engine = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/prework-pack.js"));
  const scope = options.scope || null;
  if ((ticketId == null || String(ticketId).trim() === "") && !scope) {
    fail(
      'prework requires a ticket id or --scope: coord/scripts/gov prework <ticket-id> [--scope "<text>"] [--json]'
    );
  }
  const pack = engine.buildPack({
    ticketId: ticketId && String(ticketId).trim() ? String(ticketId).trim() : null,
    scope,
    role: options.role || null,
    now: new Date().toISOString(),
  });
  if (options.json) {
    console.log(JSON.stringify(pack, null, 2));
    return pack;
  }
  console.log(engine.renderText(pack));
  return pack;
}

// COORD-149: `gov closeout-summary <ticket> [--json]` — the [Memory] Solving
// auto evidence-backed CLOSEOUT SUMMARY. Thin CLI wrapper over the standalone
// generator (coord/engine/scripts/closeout-summary.js). It REPORTS only: a pure read
// over the closing/landed ticket's REAL artifacts (its plan record, journal
// events, board row, and any anchoring conformance attestation) that produces a
// source-cited summary — what was asked + delivered, the evidence trail
// (repo-gate results, review cycles, source commit(s)/landing record,
// attestation), and key decisions + deferrals — every claim pinning event_hash +
// chain_head. It does NOT close, gate, finalize, or mutate the ticket: closeout
// stays governed by the normal finalize lane; this is an evidence artifact, not an
// authority. Composes decision-extractor.js + insight-reports.js; required lazily
// so lifecycle.js stays independent of the memory layer. --json emits the
// structured summary; default emits the readable text summary.
function closeoutSummaryCommand(ticketId, options = {}) {
  const engine = require(resolveEngineModule(require("node:path").resolve(__dirname, "..", ".."), "scripts/closeout-summary.js"));
  if (ticketId == null || String(ticketId).trim() === "") {
    fail(
      "closeout-summary requires a ticket id: coord/scripts/gov closeout-summary <ticket-id> [--json]"
    );
  }
  const summary = engine.buildSummary({
    ticketId: String(ticketId).trim(),
    now: new Date().toISOString(),
  });
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  console.log(engine.renderText(summary));
  return summary;
}

// COORD-145: `gov learned-rule capture|list|promote` — governed procedural-
// memory promotion. Thin CLI wrapper over the standalone engine
// (coord/engine/scripts/learned-rule-promotion.js). It RECOMMENDS / ROUTES only: a
// learned behavioral rule is CAPTURED as a candidate (the only write is an
// append to the derived, gitignored candidates queue), then PROMOTED into a
// governed-change SPEC routed to the FULL reviewed lane (asserted via the
// COORD-166 isProceduralDocPath). It NEVER edits a procedural file — the
// procedural surface (.claude/, AGENTS.md, CLAUDE.md, GOVERNANCE.md) changes
// ONLY through the reviewed/landed lifecycle. Every candidate carries §7
// citations (no uncited rule). The engine is required lazily so the rest of
// lifecycle.js stays independent of the memory layer.
function learnedRuleCommand(sub, args = []) {
  const engine = require(resolveEngineModule(ENGINE_COORD_DIR, "scripts/learned-rule-promotion.js"));
  if (!sub || !["capture", "list", "promote"].includes(sub)) {
    fail(
      'learned-rule requires a subcommand: capture | list | promote. ' +
        'e.g. coord/scripts/gov learned-rule promote <PRC-id> [--json]'
    );
  }
  return engine.runCli([sub, ...args]);
}

// COORD-146: `gov sign-journal sign|verify` — [Memory] cross-cutting per-event /
// batch signing for memory NON-REPUDIATION (folded into the KMS / key-custody
// roadmap). Thin CLI wrapper over the standalone engine
// (coord/engine/scripts/journal-signing.js). It EXTENDS — never replaces — the existing
// hash-chain + single chain-head attestation: it ed25519-signs ONE Merkle batch
// over the per-event leaf hashes (the same canonical event_hash the journal +
// decision-extractor already cite), binding the merkle_root to the journal
// chain_head, so any individual event's non-repudiation is provable via a compact
// Merkle inclusion proof WITHOUT a signature per line. Backward compatible:
// read-only over the journal, writes only its own signed-batch artifact under the
// gitignored coord/.runtime/ tree, never mutates events, never weakens
// verifyGovernanceChain. The signing key SOURCE is pluggable (a key provider) so
// an adopter backs it with a KMS/HSM; coord ships only the local-key default
// (private key gitignored) and does NOT reimplement a KMS (explicit non-goal).
//
//   sign   [--out <file>]              — sign the current journal as one batch,
//                                        write the signed-batch artifact (default
//                                        under coord/.runtime/journal-signatures/).
//   verify <batch-file> [--event <hash>] — verify the batch (signature + merkle_root
//                                        rebuild + chain-head bind to the live
//                                        journal); with --event, ALSO prove that
//                                        event's per-event non-repudiation
//                                        (signature valid + Merkle inclusion).
// The engine is required lazily so the rest of lifecycle.js stays independent of
// the memory layer.
function signJournalCommand(sub, options = {}) {
  // COORD-868 (COORD-589 batch 5): journal-signing moved under coord/engine/scripts;
  // resolve it through the engine resolver, never the injected COORD_DIR.
  const engine = require(require("../../paths.js").resolveEngineModule(path.resolve(__dirname, "..", ".."), "scripts/journal-signing.js"));
  if (!sub || !["sign", "verify"].includes(sub)) {
    fail(
      "sign-journal requires a subcommand: sign | verify. " +
        'e.g. coord/scripts/gov sign-journal sign [--out <file>] | ' +
        "coord/scripts/gov sign-journal verify <batch-file> [--event <hash>]"
    );
  }

  const journalPath = state.GOVERNANCE_EVENT_LOG_PATH;
  const events = engine.readJournalEvents(journalPath);
  const liveChainHead = engine.chainHeadOf(events);
  const liveEventHashes = events.map((e) => engine.eventHashFromLine(e.line));

  if (sub === "sign") {
    const { batch, tree } = engine.buildSignedBatch({
      events,
      coordDir: COORD_DIR,
    });
    const dir = path.join(state.RUNTIME_DIR, "journal-signatures");
    fs.mkdirSync(dir, { recursive: true });
    const tag = (batch.subject.chain_head || "no-chain-head").slice(0, 16);
    const outPath =
      options.out || path.join(dir, `${tag}.${batch.subject_digest.slice(0, 12)}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(batch, null, 2) + "\n");
    const result = {
      status: "signed",
      path: outPath,
      event_count: batch.subject.event_count,
      merkle_root: batch.subject.merkle_root,
      chain_head: batch.subject.chain_head,
      subject_digest: batch.subject_digest,
      // The root must round-trip from any leaf's inclusion proof.
      merkle_levels: tree.levels.length,
    };
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("Journal batch signed:");
      console.log(`  path:        ${result.path}`);
      console.log(`  events:      ${result.event_count}`);
      console.log(`  merkle_root: ${result.merkle_root}`);
      console.log(`  chain_head:  ${result.chain_head || "(empty journal)"}`);
      console.log(`  digest:      ${result.subject_digest}`);
    }
    return result;
  }

  // verify
  const batchFile = options.file;
  if (!batchFile) {
    fail(
      "sign-journal verify requires a batch file: " +
        "coord/scripts/gov sign-journal verify <batch-file> [--event <hash>]"
    );
  }
  if (!fs.existsSync(batchFile)) {
    fail(`Signed-batch file not found: ${batchFile}`);
  }
  let batch = null;
  try {
    batch = JSON.parse(fs.readFileSync(batchFile, "utf8"));
  } catch (error) {
    fail(`Signed-batch file is not valid JSON: ${batchFile} (${error.message})`);
  }

  const trustOptions = { coordDir: COORD_DIR, trustAnchor: options.trustAnchor };
  const report = engine.verifySignedBatch(batch, {
    ...trustOptions,
    liveChainHead,
    liveEventHashes,
  });

  // Optional per-event non-repudiation proof.
  let eventReport = null;
  if (options.event) {
    const targetHash = String(options.event);
    const index = (Array.isArray(batch.event_hashes) ? batch.event_hashes : []).indexOf(
      targetHash
    );
    if (index < 0) {
      eventReport = {
        ok: false,
        event_hash: targetHash,
        included: false,
        problems: [
          { code: "event_not_in_batch", detail: "event hash is not among the batch event_hashes" },
        ],
      };
    } else {
      const tree = engine.buildMerkleTree(batch.event_hashes);
      const proof = engine.buildInclusionProof(tree, index);
      eventReport = engine.verifyEventInclusion(batch, targetHash, proof, trustOptions);
    }
  }

  const result = {
    status: report.verdict,
    authenticity: report.authenticity,
    trusted: report.trusted,
    signing_key_fingerprint: report.signing_key_fingerprint,
    verdict: report.verdict,
    batch_ok: report.ok,
    signature_valid: report.signature_valid,
    merkle_root_matches: report.merkle_root_matches,
    chain_head_matches: report.chain_head_matches,
    event_count: report.event_count,
    problems: report.problems,
    event_inclusion: eventReport,
  };
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Journal batch verification: ${report.verdict.toUpperCase()}`);
    console.log(`  signature valid:    ${report.signature_valid}`);
    console.log(`  merkle_root match:  ${report.merkle_root_matches}`);
    console.log(`  chain_head bind:    ${report.chain_head_matches}`);
    console.log(`  events:             ${report.event_count}`);
    if (report.problems.length > 0) {
      console.log(`  problems (${report.problems.length}):`);
      for (const p of report.problems) {
        console.log(`    - ${p.code}: ${p.detail}`);
      }
    }
    if (eventReport) {
      console.log(`  event ${String(options.event).slice(0, 12)} signer-anchored evidence: ${eventReport.non_repudiation_proven ? "PROVEN" : "NOT PROVEN"}`);
      console.log(`    included under signed root: ${eventReport.included}`);
      if (eventReport.problems && eventReport.problems.length > 0) {
        for (const p of eventReport.problems) {
          console.log(`    - ${p.code}: ${p.detail}`);
        }
      }
    }
  }
  if (!report.ok || (eventReport && !eventReport.ok)) {
    fail(
      `Journal batch verification FAILED: verdict=${report.verdict}` +
        (eventReport && !eventReport.ok ? ", event non-repudiation could not be proven" : "") +
        ". The signed batch was tampered with, is stale, or the event is not provably included."
    );
  }
  return result;
}

return {
  printHelp,
  buildHelpText,
  buildVerbHelpText,
  printVerbHelp,
  buildInitiateSummary,
  printInitiate,
  recallCommand,
  insightsCommand,
  coverageRollupCommand,
  preworkCommand,
  closeoutSummaryCommand,
  learnedRuleCommand,
  signJournalCommand,
};
};
