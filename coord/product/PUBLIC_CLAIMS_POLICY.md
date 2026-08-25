# Public Claims and Technical-Language Policy

Status: authoritative for adopter-facing and services-facing documents
Enforced by: a release-blocking claims check that runs against the generated
release artifact, not only against the sources it was built from.

This project ships under the Apache License 2.0. Section 7 of that licence
supplies the AS-IS disclaimer and Section 8 the limitation of liability.
Documentation that promises an outcome on top of that quietly replaces the
licence with something nobody agreed to. So the rule is simple: **describe
observed behaviour, its prerequisites, and its limits. Do not promise results.**

This is a policy about **public product promises**. It is deliberately *not* a
word ban. `contract`, `guarantee`, `safe` and `invariant` all have precise
meanings inside source code, schemas, and internal specifications, and those uses
must survive — a checker that flags legitimate internal usage gets switched off,
which is worse than no checker.

---

## 1. The five registers

Every capability sentence in a public document belongs to exactly one of these,
and should read as though it does.

| Register | What it means | How to write it |
|---|---|---|
| **Implemented and tested** | The behaviour exists in this version and a test holds it. | Name the behaviour, the command, and the version. "As of v0.1.8, `gov submit` refuses a ticket with no plan record (`plan-records.test.js`)." |
| **Planned** | On the backlog. No shipped behaviour. | Say "planned" or "not implemented", in the same sentence. Never in the future tense alone — "will" reads as a commitment. |
| **Observed verification output** | What a check printed on a specific tree at a specific time. | Quote the command, the scope, and the result. "`release/build-release-artifacts.sh --skip-binary` exited 0 on commit `<sha>`, hygiene gate 8/8." |
| **Known limitation** | Something the design does not do. | State it plainly and in the same place as the capability it bounds. Do not relegate limits to a separate page. |
| **Legal / commercial** | Warranty, liability, support, indemnity, certification. | Do not write these. Point at `LICENSE`. |

The most common defect is a sentence that starts in *implemented* and finishes in
*observed verification output* — "Concord validates every clone" when what
happened is "we ran a validation script once, on this repo".

## 2. Preferred vocabulary

| Prefer | Instead of | Why |
|---|---|---|
| `behavior specification` | `contract` (when you mean promised behaviour) | Reserve `contract` for its schema/interface sense: a data contract, an API contract, `VERB_CONTRACT.md`. |
| `tested invariant` | `guarantee` | Names the thing that holds it. If no test holds it, it is not an invariant either. |
| `verification check` | `proof`, `certification` | A check is something the reader can re-run. |
| `reduces <X>` | `eliminates <X>`, `<X>-free` | Almost every governance property is a reduction, because a bypass exists. |
| `repository separation` | `isolation`, `sandbox` | A Git worktree is a second checkout, nothing more. |
| `records supported lifecycle operations` | `complete audit trail`, `records every action` | The journal covers `gov` verbs, not agent activity. |
| `detectable` | `impossible`, `prevented` | The design makes bypasses visible; it does not make them unavailable. |

`safe`, `secure` and `risk-free` should not appear as product adjectives at all.
Inside code and internal specs — `isSafeToRetry()`, "the safe ordering" — they are
precise and stay.

## 3. The four standing statements

These are true of every shipped version, and any document that touches the topic
must not contradict them.

1. **Coordination, not enforcement.** Concord coordinates the actions taken
   through it — ticket ownership, lifecycle locks, per-ticket worktrees, gates,
   review cycles, and recorded lifecycle evidence. It reduces collisions for
   supported actions. An agent or a human with local access can bypass
   governance; the design makes that detectable, not unavailable.
2. **Worktrees are repository separation.** Not OS process, filesystem, network,
   provider, or secret isolation.
3. **The journal is scoped.** It records supported Concord lifecycle operations —
   not every provider tool call, shell command, file read, or network request.
4. **Secrets are not Concord's to hold.** Concord does not require secrets in
   governance artifacts, and the release build refuses to ship secret-shaped
   payload paths. What an agent can reach at runtime is decided by the
   developer's environment and provider configuration.

## 4. Implemented today vs planned

Written for the release this document ships in. The rule for maintaining it: a
capability moves from the right column to the left only when it has shipped code
**and** a test, and the sentence that describes it names both.

**Implemented, with tests, in this release:**

- Transactional no-clobber install (`concord.install/v2`): a write-free plan, a
  consent digest, a receipt, backups and rollback, an install mutex and a
  write-ahead ledger. A collision exits non-zero having written zero bytes.
- A portable POSIX-sh bootstrap and configuration-aware hooks.
- Consent-based root Git bootstrap, with diagnostics for an unborn root.
- Provider-neutral cold start (Claude, Codex, Gemini, or a plain shell).
- One authoritative recursive serial test runner, used by npm, CI, the binary
  verification, and the release hygiene gate alike.
- Fail-closed npm and Linux-binary distribution built from one verified cut.
- A spec-compliant newline-delimited JSON-RPC MCP transport.
- A local-only, network-free default `.mcp.json`.

**Planned. Not implemented. No shipped behaviour:**

- Managed auto-mode profiles, and provider-side interception of agent actions.
- Local containment controls: protected product roots, worktree-only writes,
  secret-path denial, environment filtering, network/egress policy.
- A redacted action ledger covering non-lifecycle agent activity, with
  complete/partial/unmanaged audit-coverage reporting.
- Hosted or multi-tenant operation of the cockpit.
- Any managed-auto conformance, telemetry, or enforcement reporting built on the
  above.

Anything in the second list must read as future work everywhere it is mentioned.
A planned capability described in the present tense is the same defect as a
false test assertion.

## 5. Publication state

Being **publishable** and being **published** are different claims.

The release pipeline can be run end to end locally and the artifact it produces
can pass its own hygiene gate. That makes the artifact publishable. It does not
establish that a given version is installable from a public registry: the live
registry-availability check and the standalone binary build require network
access and are exercised at publish time, not at build time. No document may
imply a verified published or installable-from-registry state that has not
actually been observed.

## 6. Enforcement

The check described here runs in the **maintainer repository that produces this
artifact**; the release tooling directory is not part of the distributed
artifact, so the paths named below exist there and not in an installed workspace.
It is a deterministic, release-blocking check wired into the pre-publish hygiene
gate, and it runs against the **generated cut** as well as against the donor
sources — the bytes that are scanned are the bytes that are published.

- **The inventory is derived, not listed.** Against a built artifact it is every
  document present — the builder already decided what ships. Against the donor it
  is every document minus the paths the builder removes, stubs, or regenerates
  (all parsed out of `release/build-public-release.sh` and the board renderer at
  run time), plus the services package, taken as the transitive closure of
  documents the services package index references. There is no maintained list to
  fall out of date.
- **The pattern set is small and targets unqualified outcome promises.** A phrase
  is not reported when the surrounding sentence already frames it as a limitation.
- **Exceptions are explicit and reviewed.** `release/public-claims-exceptions.json`
  requires a path, a pattern id, the matched text, and a written reason. The
  checker reports exceptions that no longer match, so stale ones surface.
- **Findings name file, line, column, pattern, the matched text, and why.**

Run it directly:

```bash
node release/check-public-claims.js --root .        # the donor
node release/check-public-claims.js --root <cut>    # a generated artifact
node release/check-public-claims.js --list          # the derived inventory
node release/check-public-claims.js --root . --registry-check # publish-time live channel proof
env -u COORD_SESSION_ID node --test release/check-public-claims.test.js
```

The offline scan proves wording and scope. The publish-time `--registry-check`
additionally derives every advertised `npx create-*` command from that same
document inventory and refuses success until the exact package version resolves
on the public registry. A publishable tarball therefore cannot be mistaken for
an installable channel.
