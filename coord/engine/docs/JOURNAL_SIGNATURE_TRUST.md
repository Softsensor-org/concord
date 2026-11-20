# Journal signature trust

Journal batches and migration signatures use the conformance signing-key
fingerprint model. Verification reports signature integrity separately from
signer authenticity:

| Authenticity | Meaning | Verification |
|---|---|---|
| `self-signed` | No trust anchor was configured. The artifact's key proves internal signature integrity only. | Integrity checks may pass; `trusted` is false. |
| `trusted` | The signature verifies and its signing-key fingerprint matches an independently configured anchor. | Integrity and trust checks pass. |
| `untrusted-key` | Configured trust requirements are not satisfied, including malformed anchors. | Verification fails. |

An embedded public key or embedded fingerprint never establishes trust by
itself. An attacker can replace the journal and re-sign it under a new key;
pinning the expected signer makes that replacement fail verification.

For the batch CLI, configure anchors with one or more `--trust-anchor` options,
the comma-separated `CONFORMANCE_TRUST_ANCHOR` environment variable, or
`conformance.trustedAttestationKeys` in the installation's `project.config.js`.
Entries accept public-key PEM files, PEM strings, or SHA-256 public-key
fingerprints, using the same normalization as conformance attestations. The
configured sources form an allowlist. Invalid entries fail closed.

```bash
coord/scripts/gov sign-journal verify batch.json --trust-anchor /trusted/team.pem --json
coord/scripts/gov sign-journal verify batch.json --trust-anchor /trusted/team.pem --event <event-hash> --json
```

Keep the trust configuration outside the artifact author's authority. Copying
an artifact's embedded key into the allowlist provides no independent identity
check. Protect signing private keys separately; this change adds no key
distribution, rotation, or KMS service.

Event reports retain `ok` for signature-and-inclusion verification and add
`authenticity`, `trusted`, and `non_repudiation_proven`. An unanchored event can
pass integrity while `non_repudiation_proven` remains false. Batch CLI JSON
`status` and `verdict` now report `self-signed` or `trusted` instead of the
ambiguous successful `valid` label. Failure verdicts for digest, signature,
Merkle, and chain mismatches remain distinct.

The migration helper retains its `trustAnchors` API and its existing
`signature_valid`, `trust_checked`, and `trusted` fields, with an explicit
`authenticity` label. Existing chain verification still rejects a migration
whose supplied anchors do not trust its signer. `gov conform --trust-anchor`
and the same environment/project settings now reach that verifier, and its JSON
reports `migration_authenticity` and `migration_trusted` separately from chain
integrity. These checks do not rewrite
historical events or replace hash-chain and Merkle verification.
