# Agent Q&A Log

Async communication channel for blockers, decisions, and handoff questions.

## Format

| Date | From | To | Question | Answer | Resolved |
|------|------|----|----------|--------|----------|

## Instructions

Governance verbs (closeout notes, drift questions) insert new rows of the
table above immediately before this section, so the most recent context stays
grouped with the log. Keep this `## Instructions` heading in place — it is the
canonical insertion anchor that `gov` uses; removing it makes the lifecycle
fall back to appending rows at end of file.

- Add a row to the table above for any blocker, decision, or handoff question.
- Set **Resolved** to `yes` once the question has a recorded answer.
- Do not hand-edit rows that governance verbs wrote; reconcile through `gov`.

- Queue maintenance: follow [the handoff debt rules](AGENTS.md#plan-and-question-debt-at-handoff). Use `&#124;` for a literal pipe in cell content until COORD-695 corrects parsing. Preserve one original row per question and link its resolution evidence.

