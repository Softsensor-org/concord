# Do — Primary Governed Ticket Wrapper

Use this as the primary Claude entry point for a ticket. It should align with `coord/scripts/agent do`, not invent a second lifecycle.

## Step 1: Prepare the governed context

```bash
coord/scripts/agent do $ARGUMENTS
```

This thin facade should:
- claim or assign the current session
- start the ticket
- bind the governed worktree / lock
- return the canonical `coord/scripts/gov explain $ARGUMENTS` payload

If `agent do` is blocked by startup-attestation or prompt-waiver issues, repair those through the governed CLI and retry. Do not hand-edit board or plan state.

## Step 2: Re-enter the implementation context

Read:
- `coord/GOVERNANCE.md`
- `coord/AGENT_STARTUP_CHECKLIST.md`
- `coord/board/tasks.json`
- `coord/active/$ARGUMENTS.md` if it exists
- the mapped prompt in `coord/prompts/`
- the target repo `AGENTS.md`
- `coord/docs/IDENTITY_RUNTIME_EXTRACT.md` if identity or resume semantics are relevant

If the ticket is repo-backed and a governed worktree was created, rebase onto the canonical integration branch before editing:

```bash
cd <worktree-path>
git fetch origin dev && git rebase origin/dev
```

## Step 3: Implement inline in this session

- Write the code or docs directly for this ticket
- Run targeted verification
- Commit with:
  ```bash
  coord/scripts/gov commit $ARGUMENTS --message "<message>"
  coord/scripts/gov heartbeat $ARGUMENTS
  ```

## Step 4: Prepare review evidence

Before submission, record the governed evidence through the shared CLI:

```bash
coord/scripts/gov update-plan $ARGUMENTS --invariant "<invariant>"
coord/scripts/gov set-requirement-closure $ARGUMENTS --ticket-ask "<ask>" --implemented "<what>" --closeout-verdict complete
coord/scripts/gov set-review-cycles $ARGUMENTS \
  --review-cycle "lens=...; diff=...; risks=...; findings=...; verification=...; verdict=pass"
coord/scripts/gov add-feature-proof $ARGUMENTS --proof-path <repo-relative-path>
coord/scripts/gov add-repo-gate $ARGUMENTS --command "<gate-cmd>" --note "<result>"
coord/scripts/gov explain $ARGUMENTS
```

## Step 5: Stop or continue explicitly

- If the ticket is not ready for review, stop and report the blockers
- If it is ready, submit via `coord/scripts/gov submit $ARGUMENTS --fill`
- Landing remains a separate explicit action: `/land <ticket>`

Rules:
- do not recursively invoke `/planner`, `/code-writer`, `/code-reviewer`, or another `/do`
- do not start another ticket in the same session
- do not merge to `dev` manually
- use `coord/scripts/gov` for lifecycle detail and evidence capture; `/do` is the primary wrapper, not a replacement governance engine
