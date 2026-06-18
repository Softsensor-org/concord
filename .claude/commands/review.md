# Review — Code Review (self or cross-agent)

Review ticket **$ARGUMENTS**. By default, performs self-review. Add `--codex` to delegate review to Codex.

---

## Mode: Self-Review (default)

1. Read the ticket's PR diff:
   ```bash
   coord/scripts/agent review $ARGUMENTS
   ```
   Get the PR URL, then:
   ```bash
   gh pr diff <pr-number> --repo <owner/repo>
   ```

2. Read `coord/active/$ARGUMENTS.md` for the implementation plan.

3. Review against 4 lenses:
   - **Contract**: Do APIs match contracts? Types consistent?
   - **Security**: Injection, auth, data exposure, error handling?
   - **Tests**: New behaviors covered? Which dimensions?
   - **Closure**: Does implementation match ticket ask?

4. Report findings as HIGH/MEDIUM/LOW with file:line evidence.

5. If findings exist, offer to record them:
   ```bash
   coord/scripts/gov add-finding $ARGUMENTS --summary "<finding>" --severity <HIGH|MED|LOW> --qref "<file:line>"
   ```

---

## Mode: Cross-Agent Review (`--codex`)

Parse the arguments. If the user said `--codex` or `codex` or `ask codex`:

1. Get the PR diff and ticket context:
   ```bash
   TICKET_INFO=$(coord/scripts/gov explain $ARGUMENTS 2>&1)
   PR_URL=$(echo "$TICKET_INFO" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pr_refs',[''])[0])" 2>/dev/null)
   ```

2. Get the diff:
   ```bash
   gh pr diff <pr-number> --repo <owner/repo> > /tmp/review-diff-$ARGUMENTS.txt
   ```

3. Read the plan:
   ```bash
   PLAN=$(cat coord/active/$ARGUMENTS.md 2>/dev/null || echo "No plan file")
   ```

4. Send to Codex for review:
   ```bash
   codex --approval-mode full-auto "You are a code reviewer. Review this PR diff for ticket $ARGUMENTS.

   Ticket plan:
   $(cat coord/active/$ARGUMENTS.md 2>/dev/null)

   Review against these lenses:
   1. Contract/state invariants — do APIs match contracts?
   2. Security — injection, auth, data exposure?
   3. Tests — are new behaviors covered? which testing dimensions?
   4. Requirement closure — does implementation match the ticket ask?

   For each finding, provide: severity (HIGH/MED/LOW), file:line, description, and suggested fix.

   PR diff:
   $(cat /tmp/review-diff-$ARGUMENTS.txt)

   Output your findings as a structured list. Be specific, cite lines."
   ```

5. Collect Codex's response and present the findings.

6. Offer to record findings via governance:
   ```bash
   coord/scripts/gov add-finding $ARGUMENTS --summary "<finding>" --severity <HIGH|MED|LOW> --qref "<file:line>"
   ```

---

## Mode: Cross-Agent Review (`--gemini`)

Same as `--codex` but use the Gemini CLI:

```bash
gemini "You are a code reviewer. Review this PR diff for ticket $ARGUMENTS. ..."
```

---

## Hard Rules

- **No landing.** Review does not land the ticket. Use `/do` or `gov land` separately.
- **No code changes.** Review only produces findings. Fixes are a separate action.
- **Cross-agent review is advisory.** The other agent's findings are presented to you — you decide what to act on.
- **Do not invoke `/do`, `/code-writer`, or `/planner`.** Review is read-only.
