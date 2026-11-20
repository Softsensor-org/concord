# Runbook: set up the human-admin approval account (ADR 0031)

> **HUMAN-RUN ONLY.** A human admin runs every command in this file, on a terminal, once.
> Agents never run these commands, never run `sudo`, `useradd`, `visudo`, `chown` or `chmod`
> on this host, and never create a key or credential. Do not paste these commands into an
> agent session or a script an agent can run.

This runbook sets up the account, store, signing key, wrapper and sudo rule that ADR 0031
(separate OS user) describes. Until it is done, human-only verbs (`approve`, `reject`, the
`--human-admin-override` paths, `config approve`) refuse. That is the intended fail-closed state.

## 0. Choose the names

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<AGENT_OS_USER>` | The login the engine and agents run under | the worker login |
| `<HUMAN_OS_USER>` | Your login, used for `login`, `logout`, `enroll`, `status` | your login |

If `<AGENT_OS_USER>` and `<HUMAN_OS_USER>` are the same login, both lines of the sudo rule
(step 6) apply to that login. That is expected. The password on the human line is then what
separates `login` from `sign`. Read ADR 0031 section 6 before you choose this.

`coordapprove` is the approval account. It is a system account with no login shell and no home.

## 1. Create the account

Run as root (`sudo -i`):

```
groupadd --system coordapprove
useradd --system --gid coordapprove --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin coordapprove
```

## 2. Create the directories

Run as root:

```
install -d -o coordapprove -g coordapprove -m 0700 /var/lib/coord-approval
install -d -o coordapprove -g coordapprove -m 0700 /var/lib/coord-approval/keys
install -d -o coordapprove -g coordapprove -m 0755 /etc/coord-approval
install -d -o root -g root -m 0755 /usr/local/libexec/coord-approval
```

## 3. Install the wrapper

The wrapper `coord-approve` is delivered by the implementation ticket (COORD-1034). It is not
in the tree at the time of this runbook. Install the released file, from a path you have checked
by hand, as root:

```
install -o coordapprove -g coordapprove -m 0750 <PATH_TO_RELEASED_coord-approve> /usr/local/libexec/coord-approval/coord-approve
install -o coordapprove -g coordapprove -m 0644 <PATH_TO_RELEASED_allowed-verbs.json> /etc/coord-approval/allowed-verbs.json
```

Do not edit `allowed-verbs.json` by hand to add a verb. A verb is added by a released change.
The released allowlist must include each signed action that operators need. For this change,
that includes `integration recover --resume` for remote-executor recovery and
`agent claim --human-admin-override` for forced live-session rebind. The existing transition
window does not apply to either verb. Do not add them to a deployed allowlist until the
corresponding change is released and approved for rollout.

## 4. Create the signing key

Run as root. The key is created by the approval account and never leaves the store:

```
runuser -u coordapprove -- openssl genpkey -algorithm ed25519 -out /var/lib/coord-approval/keys/approval-ed25519.pem
chmod 0400 /var/lib/coord-approval/keys/approval-ed25519.pem
chown coordapprove:coordapprove /var/lib/coord-approval/keys/approval-ed25519.pem
runuser -u coordapprove -- openssl pkey -in /var/lib/coord-approval/keys/approval-ed25519.pem -pubout -out /etc/coord-approval/approval-public.pem
chmod 0644 /etc/coord-approval/approval-public.pem
chown coordapprove:coordapprove /etc/coord-approval/approval-public.pem
```

Record the `key_id` that `coord-approve status` prints in step 7. Do not write the private key
anywhere else.

## 5. Check the store is closed to the agent

Run from the `<AGENT_OS_USER>` login, to confirm the agent cannot read the store (this is a check,
not an approval):

```
ls /var/lib/coord-approval
cat /var/lib/coord-approval/keys/approval-ed25519.pem
```

Both must fail with "Permission denied".

## 6. Install the sudo rule

Run as root. Edit the file with `visudo`, so a syntax error cannot lock sudo:

```
visudo -f /etc/sudoers.d/coord-approval
```

Paste exactly this text, with the two placeholders replaced. Then save and check it with
`visudo -cf /etc/sudoers.d/coord-approval`.

```
Defaults:<HUMAN_OS_USER> timestamp_timeout=0
<AGENT_OS_USER> ALL=(coordapprove) NOPASSWD: /usr/local/libexec/coord-approval/coord-approve sign
<HUMAN_OS_USER> ALL=(coordapprove) /usr/local/libexec/coord-approval/coord-approve login, /usr/local/libexec/coord-approval/coord-approve logout, /usr/local/libexec/coord-approval/coord-approve enroll, /usr/local/libexec/coord-approval/coord-approve status
```

What the rule allows:

- `<AGENT_OS_USER>` may run `coord-approve sign` as `coordapprove`, with no password and no
  other arguments. It may run nothing else as `coordapprove`.
- `<HUMAN_OS_USER>` may run `login`, `logout`, `enroll` and `status` as `coordapprove`, each time
  with the account password.
- `timestamp_timeout=0` makes every human sudo use ask for the password again.

## 7. Enrol the passphrase and check the state

Run from your own login, on a terminal (not from an agent process). This sets the wrapper
passphrase. It is entered twice, with echo off:

```
sudo -u coordapprove /usr/local/libexec/coord-approval/coord-approve enroll
sudo -u coordapprove /usr/local/libexec/coord-approval/coord-approve status
```

`status` prints the `key_id`. It must match the fingerprint of `/etc/coord-approval/approval-public.pem`.
It must show no session.

## 8. Check the agent cannot approve on its own

Run from the `<AGENT_OS_USER>` login, with no terminal (for example `ssh -T` or `setsid`). Each
must fail, and neither may print a record:

```
sudo -n -u coordapprove /usr/local/libexec/coord-approval/coord-approve login --verb approve --ticket COORD-1 --subject 0000000000000000000000000000000000000000000000000000000000000000
sudo -n -u coordapprove /usr/local/libexec/coord-approval/coord-approve login --verb 'integration recover --resume' --ticket COORD-1 --subject 0000000000000000000000000000000000000000000000000000000000000000
sudo -n -u coordapprove /usr/local/libexec/coord-approval/coord-approve login --verb 'agent claim --human-admin-override' --ticket COORD-1 --subject 0000000000000000000000000000000000000000000000000000000000000000
sudo -n -u coordapprove /usr/local/libexec/coord-approval/coord-approve sign < /dev/null
```

Each `login` request is refused because the agent has no password for `login`. The final command is refused with
`no-session`, which is the correct result when no human session exists.

## 9. Approving one request (human, per request)

When the engine refuses a human-only verb, it prints the subject digest and the login command.
Read the refusal and the board row first. Then, on a terminal, run the printed command:

```
sudo -u coordapprove /usr/local/libexec/coord-approval/coord-approve login --verb <verb> --ticket <COORD-n> --subject <sha256> --ttl-minutes 15
```

Enter the wrapper passphrase when asked. The session is single-use. The agent then re-runs the
verb, and the engine calls `sign` once. If you do not want the request to go ahead, run
`logout` and do nothing else.

## 10. Logout, rotation and undo

- End a live session: `sudo -u coordapprove /usr/local/libexec/coord-approval/coord-approve logout`.
- Rotate the passphrase: `sudo -u coordapprove /usr/local/libexec/coord-approval/coord-approve enroll --rotate`.
  This also ends any session.
- Rotate the key: stop, then repeat step 4 with a new key. Every existing approval record then fails
  verification, which is the intended effect. Record the new `key_id` in the ticket that changes it.
- Remove the agent's access: delete the `<AGENT_OS_USER>` line from `/etc/sudoers.d/coord-approval`
  with `visudo -f`. Human-only verbs then refuse again.

## Notes

- This runbook does not create a human-admin session, approve anything, or change the board.
- No secret is stored in this file. The passphrase is typed on the terminal and stored only as a
  scrypt verifier in the `coordapprove` store.
