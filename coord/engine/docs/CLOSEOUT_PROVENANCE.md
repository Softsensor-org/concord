# Operator notes and landing provenance

`gov update-plan <ticket> --provenance-note <text>` records operator evidence in
`governance.expected_closeout.provenance_note`. An explicit invocation replaces
the existing note. Use it for an authorship correction or other evidence that
must remain visible when the ticket closes.

Closeout preserves the note for `pr`, `no_pr` and `fulfilled_by` methods. If
landing contributes more evidence, closeout appends a separate paragraph:

```text
Authorship correction: implementation belongs to the original author.

Landing provenance:
abc1234 landed on the canonical integration branch
```

Without `--landed`, no-PR and fulfilled-by closeout retain the existing note.
PR landing appends its existing `PR-backed landing via <url>` text. With no
prior note, each method records exactly the provenance text it recorded before
this repair. This does not change the landing evidence stored on the board.

Repeating the same closeout does not duplicate the final landing paragraph.
A different subsequent landing note appends new evidence. An explicit later
operator edit still replaces the field; closeout is the operation that
preserves and appends it.

The merge happens inside the canonical plan writer, after loading the current
record and before its compare-and-swap write. Closeout selects this internal
write mode while holding its existing governance mutation boundary. There is
no new public flag, record field or alternate authority writer. The extracted
governance-option setter retains the existing method, base, review profile and
explicit note behavior.

`closeout-provenance.test.js` drives the real closeout functions and persisted
plan writer, with external landing services isolated. It checks absent notes,
all three methods, retries, explicit edits, rendered evidence and verb-specific
help. The original code fails the note-preservation cases while ordinary
landings without prior notes pass.
