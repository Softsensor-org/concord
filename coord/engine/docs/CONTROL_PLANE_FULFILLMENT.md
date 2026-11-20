# Closing a control-plane ticket with an existing implementation

A Repo-X ticket whose work already landed can use one explicit selector:
`--fulfilled-by-commit <commit>` or `--fulfilled-by-ticket <ticket>` on the
normal governed closeout command. Review, ownership, plan and workspace checks
still apply. Do not make an empty merge to manufacture new delivery evidence.

The commit selector resolves in the control-plane repository. The ticket
selector requires a different ticket in Repo X with a structured
`fulfilled_by_commit_sha` or `commit_sha` landing field. A reviewed source field
or a SHA mentioned in prose does not establish delivery. For historical records
without a structured landing, independently verify the implementation and use
the explicit commit selector. Existing historical landing records are preserved.

The implementation must be an ancestor of the local integration branch. If
`origin` is configured, governance refreshes its integration branch and requires
remote ancestry too. Missing branches, unavailable remotes and unpublished
commits refuse closeout, even with `--push-before-closeout`. Fulfillment does not
publish an unlanded implementation. Without a configured remote, valid local
ancestry is explicitly recorded as `local_only`; it is not remote publication.

An optional `--source-commit` remains the separately recorded reviewed source
and must resolve to an ancestor of the fulfillment commit. Validation occurs
before workspace integration and worktree cleanup. A new landing uses the
existing schema's `method: manual`, `provenance_status: fulfilled_by`, resolved
`commit_sha` and `fulfilled_by_commit_sha`, and, when selected, the referenced
`fulfilled_by_ticket`. The plan's closeout method is `fulfilled_by`.

Use the existing normal landing path when implementation still needs merging or
publication. Ordinary governed merge closeouts retain their existing behavior.
This applies to both donor-root and independent control-plane Git layouts under
ADR-0008, and preserves ADR-0002's canonical board authority.
