# Business Discovery Protocol

Status: design contract · Owner: Softsensor · Ticket: COORD-301 · Delivery:
COORD-301..311 are `done` on the board (checked 2026-09-21, COORD-760); board
state only — enforcement levels are in `POLICY_ENFORCEMENT_MATRIX.md`

Adoption boundary: for what business discovery, context packs, memory, ADRs,
identity, and continuity can do today versus what remains backlog, see
`coord/product/CONTINUITY_CAPABILITY_MATRIX.md`. Policy enforcement status is
summarized in `coord/product/POLICY_ENFORCEMENT_MATRIX.md`.

## Purpose

Business discovery is the governed process for reverse-engineering an existing
repo without turning implementation accidents into business truth.

Concord must help agents discover and preserve business intent before they
refactor, modernize, generalize, or add features. The protocol is domain-neutral:
it can represent an ERP customization, a menu/POS converter, a regulated workflow,
an ecommerce storefront, a data pipeline, or a simple SaaS app without forcing a
domain ontology too early.

The output is a source-backed knowledge structure that later feeds requirements,
memory, context packs, reviews, and tickets. It is not a replacement for human
business ownership.

Business discovery is a **producer** for the **Concord Knowledge Compiler**. It
emits source-backed proposed claims; the claim compiler classifies whether each
claim is `accepted`, `candidate`, `review-required`, `rejected`, `conflicted`,
`superseded`, or `stale` before memory, recall, context packs, requirements,
ADRs, or ticket synthesis consume it.

## Core Principle

> Implementation is evidence, not always intent.

Existing code, data, UI, and configuration can reveal real business behavior,
but they can also contain workarounds, bugs, temporary patches, abandoned flows,
or customer-specific exceptions. Concord records what was observed, classifies
confidence, and asks for decision authority before treating a claim as a rule.

## Relationship To Existing Concord Surfaces

| Surface | Relationship |
| --- | --- |
| Requirements assurance | Business discovery produces candidate source-backed facts, questions, contradictions, and requirement candidates. Requirements assurance decides which become governed PRD/URS/SRS/REQ records. |
| Governed memory | Discovery records are semantic-memory inputs only after compiler gating and promotion. Derived memory indexes remain rebuildable. |
| ADRs and decisions | Discovery can identify decisions needed or decisions already implied by sources; accepted decisions live in ADR/decision records. |
| Tickets | Discovery findings become tickets only through a governed synthesizer. Read-only reviewers do not mutate the board directly. |
| Existing repo adoption | Discovery is the deeper pass after setup/readiness: it explains why the repo behaves the way it does before agents change it. |
| Cockpit/readout surfaces | Cockpits render derived discovery artifacts, context packs, and promotion status. They are read-only and must not execute discovery, synthesize new artifacts, promote records, create tickets, or mutate files. |

The governed memory relationship is deliberately one-way:

```text
business discovery / ticket execution -> source-backed claims -> Concord Knowledge Compiler -> memory / recall / context packs
```

Memory recommends with citations. Governance decides whether a claim becomes a
requirement, ADR, accepted memory record, or ticket. Vectors and summaries are
retrieval/readout views only; they cannot create authority.

## Read-Only Cockpit Contract

Business discovery can feed product cockpits and ticket readouts, but the web/UI
tier is an observer. A cockpit may load existing derived JSON/markdown artifacts
and present:

- discovery runs and source inventory;
- adapter signals, probes, risks, and suggested questions;
- fact confidence and status distribution;
- contradictions and stale/superseded history;
- open questions and pending decisions;
- accepted decisions, waivers, and approval requirements;
- known workarounds, reflections, and preservation harness candidates;
- ticket context-pack refs and behavior-change gate status.

Rules:

- UI/web code must not call discovery scanners, synthesizers, context-pack
  generators, governance promotion commands, or board mutation commands.
- UI/web code must not write `coord/.runtime`, `coord/product`, board files,
  requirements, ADRs, memory, prompts, or rendered artifacts.
- The only mutation path is an explicit CLI/governance workflow outside the
  cockpit. The cockpit can show the exact command or context-pack ref an
  operator may run elsewhere.
- Readouts must preserve uncertainty labels. `observed`, `inferred`,
  `hypothesis`, `contradicted`, `unknown`, stale, superseded, rejected, and
  candidate records are not active policy.
- Context-pack links are pointers for tickets and plans; loading a pack must not
  implicitly approve, promote, schedule, or mutate anything.

## Artifact Classes

Business discovery uses one envelope with typed records. All records are
source-cited and versioned.

The active record-kind catalog below has 13 kinds. The version-1 schema still
accepts `contradiction` records when reading older runs, but new scans do not
emit that kind: an explicit `CONTRADICTION:` or `CONFLICT:` source marker is
only emitted as a `hypothesis` for human review. The scanner does not compare
claims across sources and absence of a marker is not evidence that sources
agree. A `contradictions` envelope ledger is retained for compatibility and
future reviewed workflows; it is not populated by automatic cross-source
analysis in this implementation.

| Kind | Purpose |
| --- | --- |
| `fact` | A source-backed observation about code, UI, data, configuration, docs, runtime, or process. |
| `business_object` | A domain object or operational entity, such as Invoice, MenuItem, WorkOrder, Patient, Tenant, OptionGroup, TaxRule, or ProductionLine. |
| `field_rule` | A field-level constraint, format, enum, validation, mapping, limit, or derived value. |
| `business_rule` | A policy, invariant, eligibility rule, lifecycle rule, approval rule, exception, or customer-specific behavior. |
| `workflow` | A user/system process with actors, states, handoffs, triggers, approvals, and failure states. |
| `integration_contract` | API, event, import/export, adapter, file, POS, ERP, queue, or external-system contract. |
| `configuration_surface` | Feature flag, tenant setting, ERP/POS/admin configuration, seeded data, or generated metadata that changes behavior. |
| `data_dependency` | Table, view, migration, seed, lookup, report, analytics fact, lineage edge, or row-shape dependency. |
| `ux_behavior` | Screen/form/navigation behavior, role-specific journey, rendered-state expectation, or HITL editing rule. |
| `decision` | Accepted, rejected, pending, or implied decision with options and consequences. |
| `hypothesis` | Plausible but unconfirmed interpretation that needs more evidence or a human answer. |
| `question` | Human/business/technical question needed before a claim can govern work. |
| `reflection` | Post-discovery or post-ticket learning about false starts, missing context, reviewer feedback, or repeated risk. |

### Source Registration Evidence

Route, workflow, and component records come from bounded static parsing of
JavaScript and TypeScript source. Each carries a `resolution_status` in its
evidence note. Only `resolved` means the parser proved the binding; every other
status is an explicit unknown and must not be read as a confirmed surface.

| Status | Meaning |
| --- | --- |
| `resolved` | The receiver is declared exactly once in the file, is never reassigned, and provably comes from the framework or scheduler package. |
| `unresolved_framework` | The receiver is redeclared, reassigned, shadowed by a parameter, or created through an `express`/`Router` name the file never binds. |
| `unresolved_mount` | The router's mount prefix is dynamic, missing, conditional, or passes through an unproven binding, or the application it ends at is not proven to be served (see below). |
| `unresolved_conditional` | The registration sits under a conditional, loop, or `try` construct, after an exit that can be taken, or inside a function, method, or instance class field that the file does not prove runs, or in a class whose definition is not proven to run (see below). Applies to `workflow` records as well as routes. |
| `unresolved_path` | The route path is not a static literal. |
| `unresolved_scheduler` | A scheduler-shaped call whose receiver is not provably bound from a scheduler or queue package. Emitted as `hypothesis`, never `workflow`. |
| `timer_only` | A recurring `setInterval`. Emitted as `hypothesis`; a one-shot `setTimeout` is not reported. |

An Express application anchors a resolved path only when the file proves it
is served: an unconditional, reached `app.listen(...)`, or `app` passed to
`createServer` from a stable `http`/`https` (or `node:` prefixed) binding
whose returned server is itself listened on by an unconditional, reached
`.listen(...)`, either chained (`http.createServer(app).listen(80)`) or on a
stable `const`/`let` binding of that server. A server that is created but
never listened on, exported, or listened on only conditionally proves nothing
is served. Any other application, including one only exported, may be mounted elsewhere, so
it composes like a router: a mounted application contributes its prefix, and
an unmounted one leaves its routes `unresolved_mount`.

Code is proven to run when it is at module level, inside an immediately
invoked non-generator function, inside a static block or static field of a
class whose definition is proven to run, or inside a non-generator function
declared at module level under a stable name and called directly (or
constructed with `new`, or called with `?.()`), by that name and
unconditionally, from code already proven to run. A function bound by a
`const`, `let`, or `var` declaration counts only when that call comes after
the declaration in the source (an earlier call throws); a call made from
inside another function counts only when every proven call into that
function, directly or through others, comes after the declaration. A
`function` declaration is hoisted. A call under a conditional or after an
exit that can be taken proves nothing, even one that invokes a function in
place. Callbacks (`forEach`, `listen` callbacks), exported setup functions such as
`module.exports = (app) => { ... }`, methods, constructors, instance fields,
and nested helper functions are not proven to run; their registrations, mounts, and `listen` calls are
treated as conditional.

A proven body does not run top to bottom past an exit that can be taken.
Within the module or a proven function body, every statement after one that
holds a `return`, `throw`, `break`, `continue`, or `process.exit(...)` (or
`process["exit"](...)`, or a template key with no expressions) call (guarded or not) is conditional, until control
returns to the loop, `switch`, or labelled statement a `break` or `continue`
targets. A `throw` counts even inside `try`. A `for`, `while`, or `do` loop
with no test or a constant truthy literal test (`true`, a non-zero number, a
non-empty string or expression-free template) and no
`break` that targets it never completes, so the code after it is conditional
in the same way; a loop that can exit leaves later code proven. An exit inside a
nested function, callback, or method does not affect the code around it, and
a function declaration after an exit still runs when it is called before it.
`await` is not an exit: code after it in a proven `async` function stays
proven, because the parser proves only that the code is reached, not when.

Two kinds of call are exits in the same way, guarded or not. A call (or
`new`) that can run before the declarator of a `const`, `let`, or `var`
function, or before the declaration of a module-level class, that it calls
or constructs, directly or through the bodies it calls, throws there
(`new Svc(); class Svc {}`), so the code after it
is conditional and the function is not proven by that call (for example
`function a() { setup(); } a(); const setup = () => {}; b();` leaves `b()`
unproven). A call into a function whose body can never return to its caller
(every path throws, calls `process.exit(...)`, loops forever with no
`break` or `return` that can leave it, or calls another such function in an
expression the statement always evaluates first, as listed below) hides the
code after it the same way; a body with a takeable `return` or `break` out of
its loop can return. A static block or static field that can never complete
hides the code after its class the same way. A call that leaves out an
argument whose parameter default never returns (`function f(a = fail()) {}`
called as `f()`) never returns either; in an `async` function a default
that throws rejects the promise, which is returned, but one that never ends
(`async function f(a = spin()) {}`) still never returns. Functions that call
each other with no path that returns (`function f() { f(); }`), and defaults
that make the same call again (`function f(a = f()) {}` called as `f()`)
through synchronous functions only, overflow the stack, so they throw;
defaults that make the same call again through an `async` function never
return (see Limits). A tagged template (``fail`x` ``) is a call
of its tag. A literal constant test (`true`, `false`, a number, `null`, a string
or expression-free template) of an `if`, `?:`, `&&`, `||`, or `??` decides
which branch or operand runs (`if (true) throw e;` always throws), and a
`do ... while` loop reaches its test only when its body can end normally or
continue it. An `async` function returns its promise when it throws or
reaches an `await`, so neither a throw inside it nor a call it makes before a
declarator stops its caller; an `await` counts unless it is proven not to be
reached: after a statement that cannot end (`for (;;) {} await x;`), in the
branch a constant test never takes, in a `finally` block whose `try` block
and `catch` clause cannot end, in the test of a `do ... while` loop whose
body cannot reach it, or after a call in the same expression that never
returns (`await spin()`).

Within one expression, a call that the expression always makes and that
never returns also hides the parts evaluated after it (by the order listed
below): `spin(), cron.schedule(...)`, `[spin(), app.listen(1)]`, and
`cron.schedule(spin())` leave the schedule and listen calls conditional. A
never-returning call in a part that may not run (`port || die()`) is still an
exit that can be taken: every call that encloses it and every part evaluated
after the part that holds it is conditional, as are the statements after it,
so `app.listen(process.env.PORT || die())` is as conditional as
`if (!port) die(); app.listen(port);`. A call in a part that a literal
constant test or left operand rules out (`app.listen(1 || die())`,
`cron.schedule("*", false ? spin() : run)`) is never made, so it leaves the
expression around it alone.

The parser keeps the analysis linear in practice: each function is analysed
after the functions it calls, once, and functions that call each other are
settled together.

#### Never-returning calls

The expressions a statement always evaluates first are exactly these
statement positions, and an arrow function's expression body
(`() => (log(), fail())` never returns):

- `ExpressionStatement`: the expression.
- `VariableDeclaration`: each declarator, in order.
- `ClassDeclaration`: the class definition (see below).
- `ReturnStatement`: the argument.
- `IfStatement`: the test.
- `SwitchStatement`: the discriminant.
- `ForStatement`: the init, then the test.
- `ForInStatement` and `ForOfStatement`: the right side.
- `WhileStatement`: the test.
- `DoWhileStatement`: the test, when the body can reach it.

Inside such an expression the parser looks into exactly these parts, in
evaluation order:

- `CallExpression` and `NewExpression`: the callee, then each argument.
- `OptionalCallExpression`: the callee only (`fail?.()`); its arguments may
  not run.
- `MemberExpression`: the object, then the key.
- `OptionalMemberExpression`: the object only.
- `BinaryExpression`: both operands.
- `AssignmentExpression`: a member target's object and key (`o[fail()] = 1`),
  then the right side of `=` or of an arithmetic, bitwise, or shift compound
  operator; only the target of `&&=`, `||=`, or `??=`, whose right side may
  not run.
- `LogicalExpression`: the left operand of `&&`, `||`, or `??`, and the right
  operand too when a literal constant left operand makes it run
  (`false || fail()`).
- `ConditionalExpression`: the test of `?:`, and the branch a literal
  constant test selects.
- `SequenceExpression`: every comma operand.
- `UnaryExpression`: the operand (`void`, `typeof`, `delete`, `!`, `-`, `+`,
  `~`).
- `AwaitExpression`: the operand.
- `TemplateLiteral`: each `${}` expression.
- `TaggedTemplateExpression`: the tag, then the template, then the call of
  the tag.
- `ArrayExpression`: each element, in order.
- `ObjectExpression`: each property, in order.
- `ObjectProperty`: a computed key, then the value.
- `SpreadElement`: the spread operand (`[...fail()]`, `f(...fail())`).
- `ClassDeclaration` and `ClassExpression`: the `extends` expression, then
  the class body.
- `ClassBody`: each computed member key, then each static block and static
  field, in order.
- `VariableDeclarator`: the initializer.

Any other expression or statement position is not modelled: a never-returning
call there leaves the code after it proven (see the limits below).

### Limits of the reachability analysis

The rules above are the whole model. The analysis reads one file at a time
and follows only direct calls (including tagged templates) of a module-level
function by its stable name and functions invoked in place. It does not follow calls through objects,
arrays, aliases, callbacks, promises, events, or any dynamic dispatch, and it
has no value analysis beyond literal constant tests and static
`process.exit` keys. Exception flow is modelled only as stated: a `throw`, a
call before a declarator, a call into a function that can never return, and
unbounded recursion.
A `catch` clause is assumed to be able to run. Statements nested more than
256 levels deep inside a function are assumed to be able to complete or
return, so a function holding them can always return (a recursive function
whose base case sits that deep is not assumed to overflow the stack). Wherever the file
does not prove that a registration, mount, or `listen` call runs, the record
is `unresolved_conditional` or `unresolved_mount`. The known gaps below are
deliberate. The first two keep records conditional that could be resolved;
the rest are cases where the model is too coarse to see a path that cannot
run, so a record there can stay `resolved`:

- An exit that fires only on missing configuration is still a takeable
  exit: `if (!port) die(); app.listen(port);` and
  `const port = process.env.PORT || die(); app.listen(port);` leave the
  `listen` call, and so every route of that application, unresolved; so does
  `app.listen(process.env.PORT || die())`. This is a deliberate limit, decided
  by the human admin on 2026-10-19 (COORD-845): the rule stays strict, and a
  guarded exit that fires only on missing configuration is not special-cased,
  because the parser cannot tell a configuration guard from any other guard.

- Constant tests are folded only where the analysis asks whether a body can
  return, and inside the expression that holds an exit (see above). The
  statement-level exit marking and the guard rule do not fold them:
  `if (false) return;` and `false ? spin() : 0;` still make the code after
  them conditional, and `if (true) app.get(...)` is still a guarded
  registration. This is
  deliberate: folding there could only turn conditional records into
  resolved ones, and a literal constant guard around a registration is rare.
- Exits reached through aliases, methods, or callbacks are not seen:
  `const s = spin; s();`, `o.go()`, `[1].forEach(() => process.exit(0))`.
  Following them needs value and alias analysis, which the parser
  deliberately does not do.
- Runtime errors other than a `throw` statement, a call before a
  declarator, and stack overflow are not modelled: `null.x`, calling
  `undefined`, calling a class without `new`, `new` on an arrow, async, or
  generator function, or destructuring a missing argument. Any property read
  or call can throw on the wrong value, so treating these as takeable exits
  would make nearly every later registration conditional; only literal
  cases (`null.x`) could be proven, and they do not occur in real code.
- Reading a `const`, `let`, or class value before its declaration
  (`log(port); const port = 1;`) is not modelled; only calling or
  constructing one is. Telling a read from a property key, a type, or a
  declaration needs the scope analysis the parser does not do.
- Class constructors are not followed: `new Svc()` does not prove that the
  constructor's registrations run, and a constructor that always throws does
  not hide the code after the `new`. A constructor's instance fields and a
  derived class's `super()` call run first, so following it soundly needs
  more than a function call does.
- A default parameter value is evaluated only for a call that passes fewer
  arguments than the parameter's position; a call passing `undefined`
  explicitly, or spreading its arguments, is assumed not to evaluate it.
- Defaults that make the same call again through an `async` function
  (`async function f(a = g()) {} function g(b = f()) { for (;;) {} }`) are
  taken to never return, and so is every call whose defaults reach such a
  cycle. The `async` function turns the stack overflow into a rejected
  promise at whatever depth the stack runs out, and the calls below it then
  go on, so the real outcome (return, throw, or never return) depends on the
  runtime's stack size. This is fail-closed: code after such a call is never
  proven, even when every function on the cycle would return.
- Within one expression, only a never-returning call the expression always
  makes hides the parts after it; an `await` whose position the analysis
  does not look into is assumed to be reached.
- Optional chains are assumed to stop at their first `?.`: the arguments of
  `a?.b(fail())` are not looked into, and neither is the tail of the chain.
- Expressions in positions not listed under "Never-returning calls" are not
  looked into, so a never-returning call there leaves the code after it
  proven. These include TypeScript wrappers (`fail() as T`, `fail()!`), JSX
  attribute and child expressions, `yield`, `import()`, and destructuring
  defaults (`const { a = fail() } = o`).

A `workflow` record requires a receiver bound by import or `require` from
`node-cron`, `node-schedule`, `cron`, `agenda`, `bull`, `bullmq`, or
`bee-queue`, or an instance constructed from such a binding. The parser has no
scope or flow analysis, so it downgrades certainty rather than guess.

Source kinds the parser does not read (Python, Ruby, Go, Rust, Java, Kotlin,
C#, PHP, Vue, Svelte) produce one `hypothesis` per kind with predicate
`unsupported_source_kind` and the file count. Folder names such as `jobs/` or
`routes/` are never evidence on their own.

### Record Caps

File-derived records are bounded so one generated or very large file cannot
dominate a run. The defaults are exported as `RECORD_LIMITS` from
`coord/engine/scripts/business-discovery.js`.

| Bound | Default | When reached |
| --- | --- | --- |
| Records per file | 500 | The first 500 records from the file are kept; the rest are counted. |
| Component relationships per file | 500 | Further edges, and edges whose endpoint record was not emitted, are counted. |
| File-derived records per run | 10,000 | The file that crosses the bound is cut and later files are inventoried by language only, not analysed. |

A bound is never applied silently. Each affected file gets one `hypothesis`
record with predicate `record_cap` (object `per_file` or `total`) stating how
many records and relationships were not emitted, and a run that stops
analysing files gets one more with subject `discovery_run` and the count of
files skipped. `summary.truncated` is then `true` and the cold-start baseline
lists the gap. Truncation records and run-level records are not counted
against the bounds.

## Human-Light Ledgers

Discovery must not turn every uncertainty into a human interview. The run emits
three ledgers that preserve continuity while asking humans only high-impact
questions.

| Ledger | Purpose | Promotion behavior |
| --- | --- | --- |
| `question_ledger` | Open questions with owner, priority, impact, source evidence, blocked record ids, and the reason the question is worth asking. | Questions are advisory until answered, deferred, or waived by the owner. |
| `decision_ledger` | Pending or accepted decisions and waivers, including options, evidence, owner, consequences, and waiver scope/revisit condition. | Accepted decisions can promote into ADRs, requirements, or memory through governance. Waivers guide work only inside their explicit scope. |
| `reflection_ledger` | Lessons about assumptions disproved, patterns confirmed/rejected, adapter improvements, and future-run tuning. | Reflections are continuity inputs; they do not become rules without later promotion. |

Rules:

- ask only when a decision would change implementation, ticket synthesis,
  adapter selection, or promotion eligibility;
- cite evidence for every question, decision, waiver, and reflection;
- route questions and decisions to an owner or owning role;
- keep unanswered decisions non-governing;
- preserve waivers with owner, scope, reason, and revisit condition;
- use reflections to improve future discovery runs without silently changing
  business rules or adapter behavior.

## Domain Discovery Adapters

Discovery can activate domain adapters as investigation lenses. Adapters detect
signals, add probes, classify risks, and suggest evidence/questions. They do not
declare truth.

Adapter findings, domain facts, and observed behavior are **semantic-memory
subtypes** once compiled and promoted. Domain knowledge describes objects,
rules, workflows, fields, contracts, configuration, and lineage. Behavioral
knowledge describes observed or intended system behavior. Neither subtype is
procedural memory; learned agent-operating rules still require the governed
procedural-memory promotion path.

Starter adapters:

- generic existing repo;
- POS/menu;
- ERP/configuration;
- manufacturing;
- finance;
- regulated;
- integration/API;
- ecommerce.

Adapter output remains `confidence=observed|inferred` and `status=candidate`
until promoted. A POS/menu signal, for example, can suggest that item/modifier,
tax, price, import/export, or downstream contract rules need review; it cannot
assert that the observed implementation is intended business behavior.

## Evidence Reference

Every record must cite evidence. Summaries are not evidence.

```json
{
  "type": "file|test|git|ticket|plan|journal_event|runtime_receipt|database|ui_screenshot|external_pointer|human_note",
  "path": "backend/src/invoices/approvalPolicy.ts",
  "commit": "abc123",
  "line_start": 42,
  "line_end": 91,
  "event_hash": null,
  "chain_head": null,
  "source_hash": "sha256:...",
  "authority": "implementation|test_proof|approved_policy|accepted_decision|requirement|runtime_observation|review_comment|legacy_note|summary",
  "freshness": "current|stale|unknown",
  "sensitivity": "public|internal|private_pointer_only|sensitive|secret_prohibited",
  "visibility": "public|internal|private_pointer_only|sensitive|secret_prohibited"
}
```

Rules:

- `summary` evidence can help navigation, but cannot prove a claim.
- `secret_prohibited` evidence must not be copied into discovery artifacts.
- Private sources may be represented by pointer, hash, and owner without copying
  the body.
- Runtime/database evidence must be redacted before becoming a shared artifact.

## Confidence And Status

Discovery separates confidence from lifecycle status.

Every record also carries an `authority` decision block. This block is the
machine-readable guardrail that later context packs, reviews, and ticket
synthesizers must consult before using a discovery record to guide
implementation.

### Confidence

| Confidence | Meaning | Can govern tickets? |
| --- | --- | --- |
| `confirmed` | Supported by an authoritative intent source and enforcement/test evidence. | Yes |
| `observed` | Current system behavior is visible, but intent is not proven. | No, unless explicitly accepted |
| `inferred` | Agent deduced a likely rule from patterns or partial evidence. | No |
| `hypothesis` | Plausible interpretation needing investigation. | No |
| `contradicted` | Accepted or observed sources disagree. | No |
| `unknown` | Relevant field/object/process exists but meaning is not known. | No |
| `deprecated` | Previously useful claim is no longer active. | No |
| `waived` | Explicit owner waiver allows limited use despite unresolved confidence. | Only within waiver scope |

### Status

| Status | Meaning |
| --- | --- |
| `scratch` | Captured during exploration; useful for continuity only. |
| `candidate` | Proposed for review or further evidence gathering. |
| `accepted` | Promoted by a human owner or deterministic verifier. |
| `rejected` | Considered and rejected with reason. |
| `superseded` | Replaced by newer knowledge. |
| `stale` | Source changed or freshness expired. |
| `deprecated` | Retained for history but not active. |
| `waived` | Not resolved, but explicitly accepted with owner/revisit condition. |

The safe default is `confidence=observed` and `status=candidate` for code-only
findings.

## Cold-Start Baseline Output

When an existing repo has sparse confirmed knowledge, discovery must still
produce an honest baseline instead of staying silent or inventing authority.
The baseline is a navigation artifact for the next agent, not accepted memory.

The run artifact includes `cold_start_baseline` with:

- `inventory_coverage`: files scanned, repo codes seen, detected languages,
  package managers, adapter signals, scan truncation, high-signal records, and
  coverage gaps;
- `observed_workflows`: workflow and UX records visible from current sources;
- `inferred_rules`: path, adapter, configuration, contract, data, and hypothesis
  signals that may be rules but are not confirmed intent;
- `known_unknowns`: open questions emitted by the run;
- `risky_workaround_candidates`: hypotheses, reflections, and adapter risks
  that might be intentional exceptions, bugs, or temporary patches;
- `required_human_questions`: high-impact questions needed before promotion or
  behavior-changing implementation;
- `initial_preservation_test_candidates`: candidate harness targets that require
  review before becoming tests or implementation constraints.

Rules:

- If no `accepted` + `confirmed` records are present, set
  `sparse_memory=true` and include an authority warning.
- A sparse baseline must not claim confirmed memory. It must separate observed
  context, inferred context, unknowns, and required human questions.
- Context packs generated from sparse cold-start data must surface the sparse
  memory warning and coverage gaps near the top of the pack.
- Preservation candidates from sparse baselines are prompts for review, not
  proof that the current behavior is intended.

### Record Authority

```json
{
  "confidence": "observed",
  "source_authorities": ["implementation"],
  "freshness": "unknown",
  "sensitivity": "internal",
  "can_guide_implementation": false,
  "approval_required": true,
  "reason": "Observed behavior is evidence, not proven business intent."
}
```

Rules:

- `inferred`, `hypothesis`, `contradicted`, `unknown`, and `deprecated` records
  must not guide implementation without an accepted owner approval or waiver.
- `candidate`, `scratch`, `stale`, `superseded`, `rejected`, and `deprecated`
  records must not guide implementation.
- Implementation-only evidence can show current behavior, but it does not prove
  intended policy.
- A `waived` record can guide implementation only within the waiver scope and
  must preserve the waiver owner/revisit condition in the promoted artifact.

## Authority Model

Authority depends on the question.

For intended business behavior:

```text
approved_policy > accepted_decision > requirement > human_review_comment > test_proof > implementation > summary
```

For observed system behavior:

```text
runtime_observation > implementation > test_result > summary
```

If policy and implementation appear to disagree, discovery may emit a
source-backed hypothesis or question for human review. The scanner does not
compare sources to determine that they conflict. It does not silently promote
implementation to policy.

## Relationship Model

Records may link to each other through typed relationships.

| Relationship | Meaning |
| --- | --- |
| `has_property` | object -> field rule |
| `constrained_by` | object/field/workflow -> business rule |
| `enforced_by` | rule -> code/test/config/runtime evidence |
| `participates_in` | object/actor/system -> workflow |
| `maps_to` | canonical concept -> adapter/export/import field |
| `configured_by` | behavior -> configuration surface |
| `depends_on` | rule/workflow/data -> dependency |
| `conflicts_with` | record -> record |
| `supersedes` | newer record -> older record |
| `raises_question` | record -> question |
| `decided_by` | record -> decision |
| `promotes_to` | discovery record -> requirement/memory/ADR/ticket |

Relationships are evidence pointers, not proof by themselves.

## History And Supersession

Discovery must preserve history:

- never overwrite an accepted record in place without `supersedes`;
- record `effective_from`, `effective_to`, and `applies_when` when known;
- mark stale records when a source hash changes;
- keep rejected hypotheses and failed interpretations when they prevent repeated
  bad advice;
- record contradictions until resolved, not just the winning answer.

## Discovery Run Envelope

Derived discovery artifacts should use this top-level shape:

```json
{
  "kind": "concord.business_discovery.run",
  "schema_version": 1,
  "project": {
    "name": "example",
    "scope": "existing-repo",
    "repos": ["backend", "frontend"]
  },
  "generated_at_utc": "2026-06-27T00:00:00.000Z",
  "generator": {
    "name": "business-discovery",
    "version": "0.1.0",
    "command": "coord discovery run --json"
  },
  "sources": [],
  "records": [],
  "relationships": [],
  "contradictions": [],
  "questions": [],
  "question_ledger": [],
  "decision_ledger": [],
  "reflection_ledger": [],
  "promotion_candidates": [],
  "adapter_signals": []
}
```

Artifacts under `coord/.runtime/discovery/` are derived and rebuildable. Accepted
knowledge must be promoted through governed docs, requirements, ADRs, or memory
records rather than silently mutating the derived run.

## Record Shape

```json
{
  "id": "BD-REC-000001",
  "kind": "business_rule",
  "subject": "Invoice",
  "predicate": "requires_approval_before_posting",
  "object": "amount > customer.approval_threshold",
  "statement": "Invoices above the customer-specific approval threshold appear to require manager approval before posting.",
  "scope": {
    "repos": ["backend", "frontend"],
    "bounded_context": "billing",
    "tenants": [],
    "applies_when": "customer.approval_policy = 'threshold_based'"
  },
  "confidence": "observed",
  "status": "candidate",
  "classification": "internal",
  "evidence": [],
  "authority": {
    "confidence": "observed",
    "source_authorities": ["implementation"],
    "freshness": "unknown",
    "sensitivity": "internal",
    "can_guide_implementation": false,
    "approval_required": true,
    "reason": "Observed behavior is evidence, not proven business intent."
  },
  "relationships": [],
  "history": {
    "effective_from": null,
    "effective_to": null,
    "supersedes": [],
    "superseded_by": null,
    "source_hashes": []
  },
  "review": {
    "owner": "business-domain-owner",
    "review_required": true,
    "reason": "implementation-only claim asserts possible intent"
  }
}
```

## Promotion Rules

Discovery can propose; governance promotes.

| Promotion target | Required before promotion |
| --- | --- |
| Requirement | Stable id, authoritative source or human acceptance, acceptance criteria or gap note. |
| Memory claim | Evidence citations, confidence/status classification, no active contradiction, permission classification. |
| ADR/decision | Decision question, options, chosen answer or pending owner, consequences, source context. |
| Ticket | Clear outcome, risk, dependencies, verification path, and source-backed rationale. |
| Question | Owner or role, why it matters, blocking/non-blocking status, source pointers. |

Promotion must preserve the source record id and evidence refs so later context
packs can cite why the item exists.

Promotion into memory must also preserve the compiler outcome. `accepted`
claims can become active memory when the target process accepts them.
`candidate` and `review-required` claims may appear as advisory context with
their uncertainty labels. `conflicted`, `superseded`, `stale`, `rejected`, and
secret-tainted claims must not enter active context packs.

## Synthesis Readout Shape

The synthesizer emits a read-only cockpit model inside the synthesis artifact:

```json
{
  "read_only_contract": {
    "ui_tier": "read_only",
    "discovery_execution_allowed": false,
    "file_mutation_allowed": false,
    "mutation_path": "Run discovery, synthesis, context-pack generation, and promotions through explicit governed CLI commands; cockpit/readout surfaces only render existing derived artifacts."
  },
  "cockpit_readout": {
    "kind": "concord.business_discovery.cockpit_readout",
    "schema_version": 1,
    "discovery_runs": [],
    "adapter_signals": [],
    "fact_confidence": {
      "by_confidence": {},
      "by_status": {},
      "facts": []
    },
    "contradictions": [],
    "open_questions": [],
    "decisions": [],
    "workarounds": [],
    "preservation_candidates": [],
    "ticket_context_packs": {
      "command": "coord/scripts/coord business-context-pack --ticket <ticket-id> --input coord/.runtime/discovery/synthesis.json --scope <scope> --json",
      "default_json_ref": "coord/.runtime/context-packs/<ticket-id>.json",
      "default_markdown_ref": "coord/.runtime/context-packs/<ticket-id>.md"
    }
  }
}
```

This model is a derived readout, not a command surface. It exists so a UI can
show business discovery state without needing to know how to execute discovery
or governance workflows.

## Preservation Harness Candidates

Business discovery may propose preservation harnesses from discovered rules,
contracts, workflows, defects, workarounds, configuration surfaces, and data
dependencies. These are candidate guardrails, not implementation tests.

Candidate harness types include:

- golden fixtures for uncertain but high-value examples;
- validators for business rules and field rules;
- workflow simulations for user/system process behavior;
- schema, lineage, or row-shape checks for data dependencies;
- adapter contract checks for imports, exports, APIs, events, and integrations;
- regression reproductions for contradictions, defects, and known workarounds.

Rules:

- candidates must cite the source discovery record and evidence;
- candidates default to `status=candidate` and `approval_required=true`;
- the synthesizer must not silently create implementation tests, validators, or
  fixtures;
- a governed ticket must approve, scope, and implement any candidate harness;
- uncertain, inferred, unknown, or contradicted discoveries may propose
  candidates, but they must not become active preservation tests until the
  underlying business question is resolved, approved, or explicitly waived.

## What Agents Must Not Do

- Do not infer business intent from implementation alone.
- Do not treat frontend field limits, backend validators, tests, or migrations as
  mutually consistent without checking for drift.
- Do not hide contradictions to make the plan look cleaner.
- Do not collapse tenant/customer-specific exceptions into global rules.
- Do not store secrets or private customer data in public artifacts.
- Do not mutate tickets, requirements, ADRs, or memory from a reviewer pass; a
  governed synthesizer must accept changes.

## Initial Derived Paths

Recommended paths for implementation:

| Artifact | Path | Mutability |
| --- | --- | --- |
| Discovery run | `coord/.runtime/discovery/run.json` | derived |
| Discovery synthesis | `coord/.runtime/discovery/synthesis.json` | derived |
| Discovery synthesis docs | `coord/.runtime/discovery/docs/*.md` | derived drafts |
| Discovery index | `coord/.runtime/discovery/index.json` | derived |
| Accepted promoted records | `coord/product/BUSINESS_DISCOVERY_PROTOCOL.md` or domain docs | governed |
| Discovery schema | `coord/product/business-discovery.schema.json` | governed template contract |

## Minimal Definition Of Done For Discovery Runs

A future `coord discovery run` should be considered useful only when it emits:

- source inventory;
- object/field/workflow/configuration candidates;
- evidence refs for every claim;
- confidence/status classification;
- contradictions and open questions;
- human-light question, decision, and reflection ledgers with evidence and
  owners where applicable;
- promotion candidates with target type and required reviewer;
- no secret-prohibited literals;
- deterministic output for identical inputs.

The current product CLI command is:

```bash
coord/scripts/coord business-discovery --json
coord/scripts/coord business-discovery --json --output coord/.runtime/discovery/run.json
coord/scripts/coord business-discovery --write-default
```

The command is read-only by default. It writes only when `--output` or
`--write-default` is explicit, and that output is a derived artifact.
Relative output paths (including the `--write-default` destination) resolve
from the invoking workspace, while absolute paths are used as supplied. When
`--dir` selects a different scanned root, the output must resolve outside that
root; the command refuses destinations inside it, including destinations
reached through symlinked directories. When the invoking workspace and scanned
root are the same location, the conventional default output inside that
workspace remains supported.

The synthesis command consumes a discovery run and builds context graph plus
draft promoted documents:

```bash
coord/scripts/coord business-discovery-synthesize --input coord/.runtime/discovery/run.json --json
coord/scripts/coord business-discovery-synthesize --input coord/.runtime/discovery/run.json --json --output coord/.runtime/discovery/synthesis.json
coord/scripts/coord business-discovery-synthesize --input coord/.runtime/discovery/run.json --output-dir coord/.runtime/discovery/docs
coord/scripts/coord business-discovery-synthesize --write-default
```

The synthesizer drafts:

- `BUSINESS_CONTEXT.md`
- `WORKFLOW_INVENTORY.md`
- `DOWNSTREAM_CONTRACTS.md`
- `BUSINESS_RULES.md`
- `KNOWN_WORKAROUNDS.md`
- `DECISION_LOG.md`
- `PRESERVATION_HARNESS_CANDIDATES.md`
- `OPEN_BUSINESS_QUESTIONS.md`

These documents are context-pack inputs and review aids. They are not accepted
policy, requirements, ADRs, or memory until promoted through governance.

Ticket-specific packs are generated from synthesis artifacts:

```bash
coord/scripts/coord business-context-pack --ticket COORD-123 --input coord/.runtime/discovery/synthesis.json --scope "invoice posting" --json
coord/scripts/coord business-context-pack --ticket COORD-123 --input coord/.runtime/discovery/synthesis.json --touched-file backend/src/invoices/post.ts --output coord/.runtime/context-packs/COORD-123.json --output-md coord/.runtime/context-packs/COORD-123.md
coord/scripts/coord business-context-pack --ticket COORD-123 --input coord/.runtime/discovery/synthesis.json --write-default
```

The pack selects only relevant cited facts, workflows, field rules, contracts,
workarounds, contradictions, open questions, and approval/promotion cues. It
stores lightweight refs to `coord/.runtime/context-packs/<ticket>.json` and
`.md` in the artifact itself so plans/tickets can point at the pack without
loading the full discovery graph.

Each context pack includes `read_only_contract` and `ticket_context` fields for
cockpit/readout consumers. `ticket_context` groups the relevant discovery run,
adapter signals, fact-confidence summary, contradictions, open questions,
decisions, workarounds, preservation candidates, proposed ticket
recommendations, and selected record refs for the ticket. It is still derived
context only; it does not approve behavior changes or mutate ticket state.

## Business-Context Gate

Behavior-changing tickets that touch business rules, schema meaning, workflows,
reports, downstream contracts, integrations, workarounds, or high-risk domains
must not move to review with business context left implicit. Before closeout,
their plan must include at least one of:

- a business-context pack reference, e.g.
  `business-context: coord/.runtime/context-packs/<ticket>.json`;
- an explicit owner approval or waiver, e.g.
  `business-context approval: <owner/reason>` or
  `business-context waiver: <owner/scope/revisit>`;
- an investigation status, e.g.
  `business-context investigation: <owner/status/question>`.

The gate is fail-closed only for risk-signaled behavior changes. It is not meant
to block ordinary docs, mechanical cleanup, or tickets that do not touch business
meaning.

Context packs expose a machine-readable `gate.behavior_change_gate` summary:

```json
{
  "gate": {
    "behavior_change_gate": {
      "has_business_context_refs": true,
      "has_approval_or_waiver": false,
      "has_investigation_status": true,
      "unresolved_uncertain_count": 2,
      "proposed_ticket_recommendation_count": 2,
      "status": "investigation_required"
    }
  }
}
```

`inferred`, `unknown`, `hypothesis`, `contradicted`, `stale`, and
implementation-only `observed` findings are not active backlog. When a context
pack produces `proposed_ticket_recommendations`, those findings must be filed as
`proposed` tickets for human triage before they can become schedulable `todo`
work. This preserves the central rule:

> Implementation is evidence, not always intent.
