# Managed-auto policy and action events

COORD-489 defines a provider-neutral, versioned description for one bounded
ticket execution profile. A policy binds the ticket, owner, provider adapter,
worktree and base SHA to explicit read/write roots, denied paths, command
classes, child-process egress, provider control-plane traffic, secret
references, Git/remote actions, approval boundaries, limits and evidence
coverage. `managed-auto` is an operating label, not a security certification.

The policy and event validators describe evidence; they do not enforce an OS
sandbox, provider hook, secret broker, or final ledger. Those controls belong to
COORD-490 through COORD-492. Provider adapters report what they can observe or
enforce and must use `complete`, `partial`, `interrupted`, `bypassed`, or
`unmanaged` rather than implying coverage.

Routine source reads, bounded worktree edits, local tests/lint/builds, governed
plan updates, ticket-branch commits and submit preparation are covered by one
policy approval. A boundary expansion is a separate, ticket-correlated policy
decision. Provider control-plane traffic is recorded separately from child
process egress. Event resources are worktree-relative and summaries are
redacted or represented by a digest; raw prompts, source, environment values,
tool output and secret values are never policy or event data.

Validate or render a JSON policy/event with:

```sh
node coord/engine/scripts/auto-mode-policy.js validate path/to/policy.json
node coord/engine/scripts/auto-mode-policy.js render path/to/policy.json
```

COORD-491 adds policy helpers, but runtime containment is **unimplemented**.
No production command launcher or provider tool hook invokes
`managed-auto-runner.js` or `auto-mode-containment.js`; the runner accepts
caller-provided control claims and an optional spawn callback. Its
`runtime_enforcement` result is therefore `unimplemented`, even when a caller
reports complete evidence coverage. Do not treat these helpers or the
`managed-auto` label as an active sandbox boundary.

The helper refuses to prepare a managed session unless the caller reports
provider hooks, an OS sandbox, and an allowlisted environment.
`sensitive-path-policy.js` denies
home, credential, provider-settings, keychain, browser-profile, and configured
sensitive paths while allowing only explicit example environment files.
Helper-evaluated commands deny destructive, remote, credential,
and integration-branch operations. The policy design assigns approved remote
SCM or registry effects to `capability-broker.js`, which returns a
ticket-correlated redacted receipt without exposing its credential. That
design is not yet enforced across production tool execution.
