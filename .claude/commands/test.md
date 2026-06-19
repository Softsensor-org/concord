# Test — Coverage Health

Quick testing maturity check. For a deep audit, use `/test-strategy`.

1. Run the default gate for each repo that has one:
   ```bash
   coord/scripts/gov gate frontend --lane default 2>&1 | tail -5
   coord/scripts/gov gate backend --lane default 2>&1 | tail -5
   ```

2. Check `coord/TEST_MATURITY.md` — when was it last updated? What's the score?

3. Report:
   - Gate results (pass/fail per repo)
   - Maturity score and age
   - If maturity is stale or never run: suggest `/test-strategy`
   - If gates fail: show which tests failed
