# ADR 0031: Human-only verbs require a live human-admin session approved by a separate OS user

- **Status:** Accepted
- **Ticket:** COORD-1032 (P0 security follow-up of the 2026-11-16 human-admin decision; the COORD-1003 worker ran `gov approve` under its own agent identity). Implementation: COORD-1034. Acceptance and amendment: COORD-1035.
- **Date:** 2026-11-16
- **Decision status:** Accepted by the human admin on 2026-11-16 in the orchestrator session, with the separate OS user mechanism (option 5 below), not the TTY-login-only mechanism of the first draft. Recorded as a human-admin decision.
- **Linked scope:** `gov approve` and `gov reject` (`coord/engine/scripts/ticket-transitions.js`, `approveTicket` and `rejectTicket`, wired from `cli.js` and `command-declaration.js`); the override resolver `resolveHumanAdminOverride` (`coord/engine/scripts/agent-commands.js`) and its callers; the direct `humanAdminOverride` readers (`runtime-cleanup.js`, `correct-finding-severity.js`, `lock-head-repair.js`, `identity-v2.js`, `doctor-recovery.js`, `landing-corrections.js`, `governance-session.js`, `ticket-commands.js`, `integration-commands.js`, `session-lifecycle-mutations.js`, `test-policy-run.js`, `amend-ticket.js`, `plan-command.js`, `managed-evidence-command.js`, `set-requirement-ids.js`, `context-pack-ack-commands.js`); the journal (`coord/engine/scripts/journal.js`); ADR 0003 (identity) and ADR 0029 section 2 (the future `config approve`, which assumes a bound human-admin session).

## Context

Two human-only controls are not enforced by the engine today.

1. `gov approve` and `gov reject` are documented as human-only (`lifecycle-help.js`: "human-only: promote a quarantined proposed ticket"). `approveTicket` and `rejectTicket` in `ticket-transitions.js` take no identity check beyond the normal bound agent session. On 2026-11-16 a worker bound as its own agent handle ran `gov approve`.
2. `--human-admin-override` is the human-admin path for transfers, lock abandonment, reconcile, test-policy exceptions, integration recovery and similar verbs. `resolveHumanAdminOverride` (`agent-commands.js`, lines 595-614) returns success for any non-empty string, and it accepts the legacy bare `--force` alias. Any agent can type the flag.

ADR 0029 section 2 approves configuration changes through `config approve --human-admin-override "<reason>"` and says it "requires a bound human-admin session ... A `--human-admin-override` string alone ... is refused". That session did not exist when this ADR was drafted, so the condition ADR 0029 relies on could not be met.

The human admin decided on 2026-11-16 that agents must not be able to satisfy the human-admin condition, and accepted the separate OS user mechanism. This ADR records that mechanism, its threat model and the transition. Implementation (COORD-1034) builds against it.

## Linked Scope

- Ticket COORD-1032 (decision) and COORD-1034 (implementation). Companion decisions: ADR 0003 (human identity is a trusted actor, not a request field), ADR 0005 (owner leases), ADR 0021 (integration authority), ADR 0029 (governed configuration proposals).
- No new `gov` verb is added by this ADR. The human-only commands live in a wrapper, `coord-approve`, owned by a dedicated OS user. They are not on the `gov` surface and are not documented as `gov` commands. Engine-side checks that call the wrapper are proposed and do not exist yet.
- Changes this ADR governs, when implemented: the wrapper, the sudo rule, the engine verifier of approval records, and the check that `approve`, `reject`, every `--human-admin-override` path and the future `config approve` run before they mutate. The verifier records the session id and the approval record id in the journal.
- Out of scope: the hardware-key and out-of-band confirmation options (named below as stronger options, not chosen); the SSO actor path of ADR 0003 for hosted deployments.

## Decision Criteria

- The credential that proves a human approved must not be something an agent can obtain by typing a flag, a string, or an argument.
- The agent OS user cannot read or write the credential, the signing key, the session or the nonce log.
- Creating a session requires an interactive terminal and the human account's password. A non-TTY caller is refused before any secret is read.
- A session is short-lived, single-use and bound to one verb, one ticket and one request digest. It expires without renewal. Logout ends it early.
- The session id and the approval record id are written to the journal with every approval and override, so an approval made without a human is traceable after the fact.
- The threat model is stated as it is. Where a same-login process or root can defeat a control, the ADR says so, and does not describe the control as a barrier against it.
- The change is testable without a real OS user or a real key on the host. Tests use a fixture keypair created inside the test only.

## Options Evaluated

1. **Keep the override string and add a reason check** (rejected). A reason is text an agent can write. It adds nothing.
2. **Bound CLI session, credential in a file under the user's config directory, token from a TTY login** (first draft; superseded by option 5 on 2026-11-16). It defeats an agent that does not read the store, the token or the terminal. It does not defeat a same-user process that writes the store.
3. **OS keyring entry for the credential** (rejected for the first version, kept as a follow-up). Keyring access is also granted to the login user, so it adds little against a same-user process on this host.
4. **Hardware key (FIDO2 or ssh-sk) with a touch confirmation for each login** (stronger option, not chosen). A same-user process cannot press the key. It needs a key and a library.
5. **Separate OS user owns the approval store and the signing wrapper** (adopted 2026-11-16). Agents run as the main OS user and cannot read or write the store, the key or the wrapper. The main user can invoke one sudo rule that asks the wrapper for a signed approval record, and only while a human session exists for that exact request. This is the only option here that a same-host agent cannot defeat with file access alone.
6. **Out-of-band confirmation** (stronger option, not chosen). The engine prints an approval digest, and the human confirms it on another device before the approval is written. It needs a second channel.

## Decision

Adopt option 5. Agents run as the main OS user (the login the engine runs under). A dedicated system user, `coordapprove`, owns the approval store, the Ed25519 signing key, the human passphrase verifier and the wrapper `coord-approve`. The main user can run only `coord-approve sign`, through one sudo rule, with no password. Signing succeeds only when the human has run `coord-approve login` for that exact request. The engine accepts a human-only mutation only with an approval record that verifies against a public key the main user cannot replace.

### 1. Accounts, store and trust anchor

| Path | Owner:group | Mode | Contents |
| --- | --- | --- | --- |
| `/var/lib/coord-approval/` | coordapprove:coordapprove | 0700 | Store root. The main user has no access. |
| `/var/lib/coord-approval/keys/approval-ed25519.pem` | coordapprove:coordapprove | 0400 | Ed25519 private key. The only signing key. |
| `/var/lib/coord-approval/credential.json` | coordapprove:coordapprove | 0600 | scrypt salt, cost parameters and verifier of the human passphrase. No passphrase. |
| `/var/lib/coord-approval/session.json` | coordapprove:coordapprove | 0600 | The live session, when one exists: session id, scope, issue and expiry times, uses remaining. Absent when there is no session. |
| `/var/lib/coord-approval/nonces.jsonl` | coordapprove:coordapprove | 0600 | Append-only log of signed nonces and record ids. |
| `/var/lib/coord-approval/events.jsonl` | coordapprove:coordapprove | 0600 | Append-only log of login, logout, refusal and signing events. No secrets. |
| `/var/lib/coord-approval/attempts.json` | coordapprove:coordapprove | 0600 | Failed-login counter and time of the last failure. |
| `/etc/coord-approval/` | coordapprove:coordapprove | 0755 | Directory. The main user cannot create, rename or replace anything in it. |
| `/etc/coord-approval/approval-public.pem` | coordapprove:coordapprove | 0644 | Ed25519 public key. The engine's trust anchor. |
| `/etc/coord-approval/allowed-verbs.json` | coordapprove:coordapprove | 0644 | The verbs the wrapper will sign. |
| `/usr/local/libexec/coord-approval/` | root:root | 0755 | Directory holding the wrapper. |
| `/usr/local/libexec/coord-approval/coord-approve` | coordapprove:coordapprove | 0750 | The wrapper. The main user is not in the group and cannot read or modify it. |

The main user is not a member of group `coordapprove`, so every mode above denies it access. The store path is fixed. Nothing in the engine or the environment changes it in production.

The engine reads one trust anchor: the fixed path `/etc/coord-approval/approval-public.pem`. Its key identifier (`key_id`, the SHA-256 of the DER public key) is printed by `coord-approve status` and written to the journal with each verification.

### 2. Wrapper interface

`coord-approve` runs as `coordapprove`. Its verbs are:

**`sign`** (the only verb the main user may call, through the sudo rule in section 3). No TTY is needed.

- stdin: one JSON request, at most 4096 bytes:

  ```json
  {"schema":"coord.approval-request/v1","verb":"<verb>","ticket":"COORD-<n>","subject_sha256":"<64 hex>","nonce":"<32 hex>","requested_at":"<UTC ISO-8601>"}
  ```

- `subject_sha256` is computed by the engine as the SHA-256 of the canonical JSON of `{verb, ticket, reason_sha256, state_sha256}`. `state_sha256` is the digest of the ticket's board row at request time. The engine prints this digest, and the exact login command, in its refusal. The human approves that digest.
- Checks, in order: the request is well formed; `verb` is in `allowed-verbs.json`; `session.json` exists, is unexpired and has one use remaining; the session's verb, ticket and subject equal the request's; the nonce is not in `nonces.jsonl`. On success the wrapper sets uses remaining to 0 and appends the nonce and record id before it signs. The use is consumed even if the engine later fails to read the record.
- stdout, on success: one record, exit 0:

  ```json
  {"schema":"coord.approval-record/v1","record_id":"<32 hex>","verb":"<verb>","ticket":"COORD-<n>","subject_sha256":"<64 hex>","nonce":"<32 hex>","session_id":"<32 hex>","issued_at":"<UTC ISO-8601>","expires_at":"<issued_at + 5 min>","key_id":"<64 hex>","signature":"<base64 Ed25519 over the canonical JSON of the record without this field>"}
  ```

- On refusal: exit 3, nothing on stdout, and one line on stderr, `{"refused":"<code>"}`, where `<code>` is one of `bad-request`, `verb-not-allowed`, `no-session`, `session-expired`, `session-used`, `scope-mismatch`, `nonce-reused`, `store-unavailable`. No key material or secret is printed in any case.

**`login`** (human only; not in the agent's sudo rule).

- `coord-approve login --verb <verb> --ticket <COORD-n> --subject <sha256> [--ttl-minutes <n>]`. The default TTL is 15 minutes; the maximum is 60.
- Refuses unless stdin and stdout are terminals, before it reads anything. Then it prompts for the passphrase with echo off, re-derives the scrypt verifier and compares it in constant time. A failed attempt increments `attempts.json`, applies a delay and writes `login_refused` to `events.jsonl` with no secret.
- On success it writes `session.json` with a random session id, the scope, `issued_at`, `expires_at` and `uses_remaining: 1`. A new login replaces any live session. Only the human runs it.

**`logout`** deletes `session.json` and writes `logout` to `events.jsonl`. Human only.

**`enroll`** sets the passphrase: a TTY is required, the passphrase is entered twice with echo off, and the scrypt verifier is written to `credential.json`. It refuses when `credential.json` exists. `enroll --rotate` replaces it and also deletes `session.json`. Human only.

**`status`** prints `key_id`, whether a credential exists, and whether a session exists with its scope and expiry. It prints no secret. Human only.

### 3. Sudo rule

The human admin installs the following text once, as `/etc/sudoers.d/coord-approval`, after `visudo -cf` passes. It is also in the runbook (`coord/docs/runbooks/human-admin-approval-user.md`), with the two placeholders filled in.

```
Defaults:<HUMAN_OS_USER> timestamp_timeout=0
<AGENT_OS_USER> ALL=(coordapprove) NOPASSWD: /usr/local/libexec/coord-approval/coord-approve sign
<HUMAN_OS_USER> ALL=(coordapprove) /usr/local/libexec/coord-approval/coord-approve login, /usr/local/libexec/coord-approval/coord-approve logout, /usr/local/libexec/coord-approval/coord-approve enroll, /usr/local/libexec/coord-approval/coord-approve status
```

- The agent line allows the `sign` command with no further argument, and no password. It allows nothing else in `coordapprove`'s name.
- The human line requires the human account's password for each use (no `NOPASSWD`). An agent running `sudo -n` cannot use it.
- `timestamp_timeout=0` stops a cached sudo credential from letting a later process use a human password prompt that was answered minutes before.
- When the agent login and the human login are the same OS account, both lines apply to that account. The password requirement on the human line is then the only thing that separates `login` from `sign`.

### 4. What the engine does

- Builds the request (`verb`, `ticket`, `subject_sha256`, a fresh 128-bit `nonce`, `requested_at`) and runs `sudo -n -u coordapprove /usr/local/libexec/coord-approval/coord-approve sign` with the request on stdin. It uses a timeout of 10 seconds, a reset environment and no shell.
- Verifies the returned record before it mutates anything:
  - `schema`, `verb`, `ticket`, `subject_sha256` and `nonce` equal the request's;
  - `key_id` equals the fingerprint of the trust anchor in section 1;
  - the Ed25519 signature verifies over the canonical record;
  - the current time is not after `expires_at`, and `issued_at` is within 60 seconds of the current time;
  - `record_id` is not already in the journal.
- On any failure, the engine refuses and journals `approval.refused` with the refusal code and no secret.
- On success, it performs the mutation and journals `human_admin_session: <session_id>`, `approval_record: <record_id>` and `approval_verified: key_id=<key_id>`.
- `--human-admin-override "<reason>"` is no longer an approval. The reason is still required and journaled, but it is not evidence. The bare `--force` alias is refused.
- A refusal prints the subject digest and the exact `login` command for the human to run. The human reads the refusal and the board row before running `login`.

### 5. Fixtures for tests (no real OS user)

- No test creates an OS user, runs `sudo`, or writes under `/var/lib`, `/etc` or `/usr/local`.
- A test generates an Ed25519 keypair with `node:crypto` inside its own `mkdtemp` directory, writes the public key there, and writes a fixture wrapper (a Node script in the same directory) that implements the `sign` contract against a fixture store and signs with the fixture private key. The fixture never touches the real store.
- Two environment variables point the engine at the fixture trust anchor and at the fixture invocation command. They are honoured only when the process runs under `node --test`. Outside a test runner they are ignored and the production path is used. A test asserts that the production trust path is `/etc/coord-approval/approval-public.pem`.
- Required cases: no session refused; expired session refused; session used (replay) refused; verb, ticket or subject mismatch refused; tampered signature, subject or nonce refused; a record signed by a different key refused; oversize stdin refused; verb not in the allow-list refused; the override string alone refused; the journal records the session id and record id on success.
- A static test checks that the sudo rule text in the runbook contains exactly one `NOPASSWD` line, and that it names only `sign`.

### 6. Threat model (honest)

Agents run as the main OS user on this host. The mechanism is judged against that user, and against the human admin's own login when it is the same account.

**What the mechanism defends against:**

- Reading or writing the store, the signing key, the verifier, the session file, the event log or the nonce log. All are owned by `coordapprove` with modes that deny the main user.
- Modifying the wrapper or the trust anchor. `/usr/local/libexec/coord-approval/coord-approve` and `/etc/coord-approval/` are owned by `coordapprove`, not writable by the main user.
- Creating a session. `login` needs a terminal, the wrapper passphrase, and the human account's password. The agent's sudo rule does not cover `login`, and the agent has no TTY.
- Forging a record. It needs the Ed25519 private key.
- Replaying a record or a session. A session has one use, the nonce log refuses reuse, and the engine checks `record_id` against the journal.
- Using a string or a flag. The engine does not accept an override string, and the wrapper signs nothing without a session.
- Using a session for another request. The scope binds verb, ticket and subject digest.
- Unrecorded use. Every verified approval journals the session id and the record id. A use without a matching login appears in `events.jsonl` and the journal as an entry without a session.
- Fallback use of a cached sudo credential. `timestamp_timeout=0` for the human account.

**What is not defended by this mechanism:**

1. **Root compromise.** Root can read the key, edit the sudo rule, replace the wrapper or the trust anchor, or edit the journal. No file mode defends against root. Host hardening and the human admin's own care are the only defence here.
2. **The human approving a malicious or mistaken request.** `login` binds the approval to a digest, not to the request's content. The human must read the refusal and the board row before running `login`. No mechanism can judge the human's decision for them. The journal records who approved what, after the fact.
3. **Same-login credential theft or terminal injection.** When the agent and the human share one OS account, a process running as that account can obtain the human's password or passphrase (for example from a password manager unlocked in the session, from a file, or by reading the terminal), or inject keystrokes into the terminal (`TIOCSTI` where the kernel allows it). The mechanism needs both the password and the passphrase, and it makes the attacker do more, but it does not stop an attacker who has both. Mitigation: run `login` from a terminal that no agent process runs in, and do not keep the password in a place the agent can read.
4. **Editing the check.** The engine's verifier and its call to `sign` are code in the repository, and each worker edits its own worktree. A branch can remove or bypass the check and land. Review, the engine pin and the template manifest catch it, and the journal records the change. They do not prevent it.
5. **The request window.** While a live session exists for one request, the main user can make that one request. The session is single-use and expires within 15 minutes by default (60 at most). That window is the approval the human gave, and the scope limits it to that request.
6. **Journal integrity.** A same-login process can edit the journal. The chain and the signed-journal controls are separate and are not changed here.
7. **Test-only variables.** Under `node --test`, the environment variables in section 5 point the engine at a fixture trust anchor. A same-login test runner can use them. This is the residual risk of the test path.

The honest summary: this mechanism stops an agent that does not have the human's password, the wrapper passphrase or the signing key. It does not stop root, does not stop a same-login process that obtains the password and the passphrase, and does not judge the human's decision. It makes each human-only approval a single-use, short-lived act tied to one request, signed by a key the agent cannot use, and journaled.

### 7. Journal

Each verified approval writes `human_admin_session: <session id>`, `approval_record: <record id>`, `approval_verified: key_id=<key id>`, the command name and the override reason into its journal event. `approve` and `reject` events gain the same fields. Refusals write `approval.refused` with the refusal code. Login, logout and refused logins are written to the wrapper's `events.jsonl`, with no secrets, and are referenced by session id in the journal.

## Transition Plan

1. **This ADR.** Accepted 2026-11-16 by the human admin (COORD-1035).
2. **Implementation (COORD-1034)** builds the wrapper, the verifier in the engine and the tests in section 5 against this design. Human-only verbs stay refused, failing closed, until the human admin has run the setup runbook (`coord/docs/runbooks/human-admin-approval-user.md`). Agents do not run the runbook.
3. **Migration window.** On landing, overrides without a valid approval record are refused, with one named exception: until a date set by the human admin (carried forward as proposed: 14 days after landing), `gov integration recover --abandon` and `gov integration handoff` may proceed on a reason alone, and each such use is journaled as `override_without_session` so the window is visible. `approve`, `reject`, `reconcile`, `claim --transfer-to`, `lock-abandon` and `config approve` get no window. Those are the paths the COORD-1003 incident and ADR 0029 depend on.
4. **Existing fixtures.** The fixtures that pass `--human-admin-override` strings move to the fixture approach in section 5. No assertion is weakened.
5. **Operator procedure.** The human admin runs the runbook once, on a terminal, before any approval depends on the wrapper. The runbook is HUMAN-RUN ONLY. Agents run no admin verb and no wrapper verb other than `sign`, which only the engine calls.

## Alternatives Rejected

- **Reason-only override.** A reason is free text an agent can supply. It is what exists today.
- **Checking the bound agent identity for `approve`.** An agent can bind an identity that passes a label check. The ADR 0003 identity model describes humans through SSO claims, which this host does not have.
- **Storing the passphrase, a token or a signing key in the repository, a config file in the repo, or an environment file.** Each is readable from the repository or by the agent's checkout, which violates the "outside the repo" rule.
- **A session token exported to the environment (first draft).** A process running as the same user can read it from `/proc/<pid>/environ`. The separate-user design keeps no token in the human's environment at all.
- **A single long-lived approval with no expiry.** It can be used months after the human stopped working.
- **Hardware key or out-of-band confirmation as the first mechanism.** Both are stronger. Neither is available on this host today. They remain options 4 and 6 and can be layered on later.

## Adopted Instead

- Separate OS user with a signing wrapper, a single-use session and a sudo rule that allows only `sign` (option 5), adopted 2026-11-16.

## Rationale

The first draft kept the store in the agent's own account, so the agent could replace the verifier, the session or the store. Moving the store, the key and the session to a second account is the only change on this host that stops an agent by file access alone. The engine's check then needs a signature it cannot produce, and a session the human creates by typing a password and a passphrase on a terminal.

## Consequences

- Approval is a deliberate human act. It needs a terminal, the human account's password, the wrapper passphrase, and a fresh single-use session for one request.
- Human-only verbs fail closed. Until the human admin has run the runbook, `approve`, `reject`, the overrides and `config approve` refuse.
- Routine agent work does not change.
- The engine gains one verifier module. Its failure modes are the refusal codes in section 2.
- The residual risks in section 6 remain. Root, same-login credential theft and the human's own decisions are not defended by this mechanism.
- ADR 0029's `config approve` depends on this mechanism. Its implementation waits for COORD-1034.

## Revisit Trigger

- The human admin adds a hardware key (option 4) or out-of-band confirmation (option 6) on top of this mechanism.
- The journal shows an approval that has no matching login.
- The agent and the human admin stop sharing an OS account, or the agent gains a path to the human account.
- A hosted deployment needs the SSO actor path from ADR 0003 instead of a local account.

## Waiver Policy

No waiver. A human-only verb that runs without a live approval is a governance violation. The migration window in the Transition Plan is the only time-limited exception, and it is named here and journaled.

## Open Questions (carried forward)

The 2026-11-16 acceptance settles the mechanism. It does not settle the items below, which the implementation ticket or the human admin decides.

1. **Session length.** The default is 15 minutes with 60 as the ceiling, as carried forward. Not changed by the acceptance.
2. **Migration window.** 14 days after landing, limited to `gov integration recover --abandon` and `gov integration handoff`, as carried forward.
3. **Identity of the human admin.** A local approval is not an ADR 0003 SSO actor. Whether approvals must also satisfy ADR 0003 is open. Until decided, the approval is a local human-admin approval only.
4. **Test-only variables.** Section 5 honours them only under `node --test`. If the human admin requires function parameters only, the implementation changes it. Not decided by the acceptance.
5. **Keyring.** Not used. The credential stays in the `coordapprove` store.
6. **Second account on this host.** Answered in principle by the acceptance (separate OS user). The human admin confirms the account exists by running the runbook.

## Approval State

Accepted 2026-11-16 by the human admin, with the separate OS user mechanism (section 1 to section 3). Nothing in this ADR authorizes an agent to create accounts, sudo rules, keys, stores or wrapper installations. Those are human-run per the runbook. Implementation (COORD-1034) may proceed against this record.
