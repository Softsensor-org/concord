# Fleet Golden Path

This is the default operating model for teams running multiple humans and
multiple agents on Concord.

## Rule

Do not run multiple governed writers from one shared checkout/runtime. Each
agent gets a ticket worktree and its own runtime. The canonical checkout is for
integration, final governance sync, and release.

## Steps

1. Register or bind the operator identity.

   ```bash
   coord/scripts/gov agentid --owner <agent-handle>
   ```

2. Create prompt coverage before work starts.

   ```bash
   coord/scripts/gov register-prompt <ticket-id> --create --template ticket
   ```

3. Start the ticket. This creates the isolated worktree.

   ```bash
   coord/scripts/gov start <ticket-id> --owner <agent-handle>
   ```

4. Run prework before coding.

   ```bash
   coord/scripts/gov gate-plan <ticket-id> --write
   coord/scripts/coord business-context-pack --ticket <ticket-id> --write-default
   coord/scripts/gov explain <ticket-id>
   ```

5. Record closeout evidence before submit.

   ```bash
   coord/scripts/gov update-plan <ticket-id> --repo-gate "<executed checks>"
   coord/scripts/gov set-review-cycles <ticket-id> --review-cycle "lens=...; diff=...; risks=..., ...; findings=...; verification=...; verdict=pass"
   coord/scripts/gov set-requirement-closure <ticket-id> --ticket-ask "..." --implemented "..." --closeout-verdict complete
   coord/scripts/gov add-feature-proof <ticket-id> --proof-path <path>
   ```

6. Submit, integrate, verify, finalize.

   ```bash
   coord/scripts/gov submit <ticket-id> --pr "local-review (no PR)"
   # merge source commit into main
   # rerun canonical gates on main
   coord/scripts/gov finalize <ticket-id> --no-pr --source-commit <sha> --landed "<merge-sha> <summary>"
   ```

7. Use dry-run recovery first.

   ```bash
   coord/scripts/gov doctor
   coord/scripts/gov doctor --repair-all
   coord/scripts/gov doctor --repair-all --confirm
   ```

For an interactive command summary, run:

```bash
coord/scripts/gov fleet-golden-path <ticket-id>
```
