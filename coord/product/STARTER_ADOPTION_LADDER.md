# Starter adoption ladder

Fresh `coord init` seeds SETUP-001 through SETUP-009 and their registered
prompt files. The rows are an additive, dependency-ordered worklist: SETUP-001
binds the project configuration, SETUP-002 through SETUP-005 establish the
pilot baseline, and SETUP-006 through SETUP-009 cover standard and enterprise
readiness. The starter board does not seed SAMPLE-001 or any product ticket.

An existing installation keeps its board and adopter-authored prompts. Running
`coord init` creates only missing starter files, so the ladder can be adopted
incrementally without overwriting a board or replacing a prompt. Existing
installations may copy the model rows through a reviewed, governed plan when
they want the ladder; no upgrade silently inserts work into a populated board.

Readiness doctor findings point at the model step that resolves them, such as
`stub-requirements` to SETUP-002 and `missing-test-command` to SETUP-005.
