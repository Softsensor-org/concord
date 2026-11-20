# Land — Merge and Close

Land ticket **$ARGUMENTS**. Merges the PR, records evidence, closes the ticket.

1. Verify the ticket is in `review`:
   ```bash
   coord/scripts/gov explain $ARGUMENTS
   ```

2. Land:
   ```bash
   coord/scripts/agent land $ARGUMENTS --method squash --delete-branch
   ```

3. Report the PR URL and landed commit.
