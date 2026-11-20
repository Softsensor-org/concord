# Discovery, Knowledge, and Requirements Runbook

This runbook shows how to inspect a repository, review the claims the tools
produce, and build a requirements registry. The tools keep evidence and
proposals organized; an operator or designated reviewer still decides what
becomes accepted policy, requirements, ADRs, or shared memory.

Use the steps that apply. Workspace onboarding is an adoption/configuration
step, not a prerequisite for every ticket. Reconciliation is for actual
governance drift, not routine setup.

## 1. Reconcile and bind the operator

If `gov explain` or `gov doctor` reports a specific board/runtime mismatch,
inspect it and reconcile only that known drift with a reason. For example:

```bash
coord/scripts/gov explain COORD-123
coord/scripts/gov reconcile COORD-123 --reason "Accepted the verified board/runtime state after reviewing the reported mismatch."
```

For a new governed session, assign an agent identity and note the returned
handle. Existing bound sessions should keep their current identity:

```bash
coord/scripts/gov agentid --assign
```

The command prints the assigned `handle` and session identity. Use that handle
as the ticket owner when filing or starting work.

## 2. Configure an existing workspace when needed

For an existing repository family that has not yet been configured, preview the
adoption decisions first:

```bash
coord/scripts/coord onboard . --dry-run --json
```

Review the repo map, branch and gate choices, setup decisions, proposed starter
tickets, and `plan_digest`. The preview is read-only. If the operator approves
the exact plan, apply only that digest:

```bash
coord/scripts/coord onboard . --write --approve <reviewed-plan-digest>
```

Onboarding writes configuration and setup records; it does not approve
discovered business claims. Skip this section when the workspace is already
configured.

## 3. File or select a ticket, then start it

Use an existing ticket if it already represents the work. File a new one only
when needed; `--with-prompt` creates and registers its prompt as part of the
governed transaction. Put the ticket's `Acceptance:` text in the description so
it is copied into the prompt's acceptance criteria; without it `gov start`
refuses the generated prompt until the criteria are authored with
`coord/scripts/gov register-prompt <ticket-id> --body-file <file>`:

```bash
coord/scripts/gov file-ticket --repo X --type docs --pri P1 \
  --with-prompt \
  --description "Review discovered invoice behavior and update its approved requirements. Acceptance: each discovered invoice rule is recorded as approved, rejected, or an open question."
```

After the command returns the ticket ID, start that ticket under the assigned
handle. Starting creates the governed worktree and execution plan:

```bash
coord/scripts/gov start <ticket-id> --owner <agent-handle>
```

For an existing ticket, omit `file-ticket` and use its ID. Do not reconcile or
onboard simply because a ticket is starting.

## 4. Run business discovery

Choose the repository subtree to scan. Keep the explicit output outside that
subtree so the derived artifact is not mistaken for source input or written
into the repository being analyzed. From the workspace root, for a workspace
with a `backend/` repository:

```bash
WORKSPACE_ROOT="$(pwd)"
DISCOVERY_RUN="$WORKSPACE_ROOT/coord/.runtime/discovery/run.json"
coord/scripts/coord business-discovery \
  --dir backend --json --output "$DISCOVERY_RUN"
```

The scan is read-only unless an output option is supplied. With `--output`, the
command writes one derived JSON run at the requested path. The run has kind
`concord.business_discovery.run`, schema version `1`, source references,
records, relationships, contradictions, questions and ledgers, promotion
candidates, adapter signals, and a `summary` with scan counts. Inspect the
summary and sample evidence before using any candidate:

```bash
node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({kind:r.kind,schema_version:r.schema_version,project:r.project,summary:r.summary},null,2))' "$DISCOVERY_RUN"
```

An empty or truncated scan is a cue to confirm the selected root and scan
limits. Observed or inferred discovery records are evidence for review, not
accepted business intent. The artifact under `.runtime/discovery/` is derived
and rebuildable; do not edit it to declare a claim accepted. If the scan root
is the entire workspace and that includes `coord/.runtime`, choose an output
outside the scan root (for example, a temporary directory) to avoid scanning
your output back in.

## 5. Compile reviewed claim candidates

Create a JSON input with a top-level `claims` array. Each claim should have an
ID, a concise statement, and evidence that points to the source material. A
claim with only implementation evidence is an observation, not proof of
business intent:

```json
{
  "claims": [
    {
      "id": "KC-001",
      "kind": "fact",
      "subject": "Invoice",
      "statement": "The posting handler checks approval status before posting.",
      "evidence": [
        {
          "type": "file",
          "path": "backend/src/invoices/post.ts",
          "authority": "implementation",
          "visibility": "internal"
        }
      ]
    }
  ]
}
```

Replace the example path and statement with evidence you have actually
inspected. Save the input, for example as
`coord/.runtime/discovery/claims.json`, then compile it:

```bash
CLAIMS_FILE="$WORKSPACE_ROOT/coord/.runtime/discovery/claims.json"
CLAIM_RUN="$WORKSPACE_ROOT/coord/.runtime/discovery/claim-review.json"
coord/scripts/coord knowledge-claim-compile \
  --input "$CLAIMS_FILE" --json --output "$CLAIM_RUN"
```

The compiler accepts either a JSON array or an object with `claims` and
optional `policy` and `context`. Its result reports outcome buckets such as
`accepted`, `candidate`, `review-required`, `rejected`, `conflicted`, `stale`,
and `superseded`, plus reasons and evidence references. Missing evidence,
secret-tainted material, and unauthoritative policy claims are rejected. A
candidate or an `accepted` compiler outcome still does not write a canonical
artifact or independently grant authority.

## 6. Review and promote through the destination owner

Review each outcome against its cited sources. Resolve conflicts, stale
references, sensitivity, scope, and whether the source proves intent or only
observed behavior. Then route a reviewed claim to the artifact that owns that
kind of decision:

- A requirement belongs in the maintained requirements source, such as
  `coord/product/REQUIREMENTS.md`, after its product owner accepts the wording.
- An architectural decision follows the ADR proposal and review process.
- Shared memory follows the applicable memory-claim review and promotion
  workflow.
- Unresolved questions or work belong in their governed question or ticket
  workflow.

There is no universal `promote` command that turns arbitrary discovery or
compiler output into authority. Preserve citations and review disposition in
the destination record. Leave unaccepted proposals in derived or review
artifacts.

## 7. Import requirements into a registry

The importer recognizes explicit requirement headings with IDs such as
`REQ-`, `URS-`, `PRD-`, `SRS-`, `FR-`, `NFR-`, `SEC-`, and `DONOR-REQ-`. Metadata
must be written as non-empty bullet items immediately below the heading,
before the statement. A bare `Key: value` line for a known metadata key, an
unknown bullet key, or an unsupported classification or coverage enum fails the
import with a source location. Omitted classification fields retain the
documented defaults: functional, P2, and medium.

```markdown
## REQ-101: Invoice approval before posting
- Kind: functional
- Priority: P1
- Risk: high
- Persona: accounts-payable
- Workflow: invoice-posting
- Evidence: approved_policy, test_gate

Invoices above the approved threshold require approval before posting.

Acceptance Criteria:
- A posting attempt above the threshold is held until approval is recorded.
```

Import one or more explicit Markdown sources. Paths are relative to `--dir`
(which defaults to the current directory). The command writes the registry to
stdout; this example deliberately redirects it to derived runtime storage:

```bash
mkdir -p "$WORKSPACE_ROOT/coord/.runtime/requirements"
coord/scripts/coord requirements-import \
  --dir "$WORKSPACE_ROOT" --project billing \
  --source coord/product/REQUIREMENTS.md \
  --source docs/URS.md --json \
  > "$WORKSPACE_ROOT/coord/.runtime/requirements/registry.json"
```

Check the artifact kind, source count, requirement count, and IDs. Duplicate
IDs across sources fail the import; use globally unique IDs and correct the
source documents before retrying. The output kind is
`concord.requirements.registry`; it contains source hashes and parsed
requirements. Import reads its sources and emits a registry. It does not write
or approve `REQUIREMENTS.md`, merge imported content into it, or make a
requirement authoritative.

## 8. Finalize the governed ticket separately

Once the ticket work and review evidence are complete, submit it for review,
then use the normal ticket closeout. For a local change with no PR:

```bash
coord/scripts/gov explain <ticket-id>
coord/scripts/gov submit <ticket-id> --pr "local-review (no PR)"
coord/scripts/gov finalize <ticket-id> --no-pr \
  --landed "Reviewed runbook change; focused documentation checks passed."
```

For PR-backed work, use the repository's governed submit/review/land path.
The local-review marker records that the change is ready for review without
claiming a hosted PR exists. Finalize is the ticket lifecycle closeout: it records review/landing evidence
and moves an eligible ticket to `done`. It does not finalize the discovery
artifact, promote a knowledge claim, or import requirements. A successful
requirements import is shown by a valid registry output; accepted authority is
shown by the reviewed canonical destination record.
