# Check — Governance Health

Run governance health diagnostics and report issues.

1. Run:
   ```bash
   coord/scripts/agent status
   coord/scripts/agent check
   node coord/board/board.js validate
   ```

2. Check for orphaned worktrees:
   ```bash
   ls -d frontend/.worktrees/*/* backend/.worktrees/*/* 2>/dev/null
   ```

3. Report:
   - `agent check` result (pass/fail with details)
   - `agent status` result (current counts and active work)
   - Orphaned worktrees (if any)
   - Suggested fix commands for each issue
