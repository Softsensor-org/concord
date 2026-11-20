# Recovering an unavailable journal baseline

The latest journal event's snapshot digest determines which checkpoint can
represent current governed state. An older checkpoint is never substituted when
the latest artifact has been pruned. A checkpoint without an event digest remains
supported for legacy installations.

`gov doctor` distinguishes an unavailable baseline from detected file drift:

- If current governed bytes exactly match the recorded digest, doctor warns that
  the cache is missing. The next mutation can restore the baseline automatically
  and records a `snapshot-pruned-recovery` journal event.
- If the bytes cannot be verified, doctor reports an error and ordinary mutations
  refuse. An empty drift list in this state does not mean there were no changes;
  the missing artifact prevents a file-level comparison.

Inspect the expected and current digests:

```sh
gov reconcile --reason "baseline recovery" --dry-run
```

Review current governed files against trusted Git history,
backups, and the intended changes. The dry run lists every path the recovery
would adopt with its sha256 (`expect_paths_packet`). After the human
administrator approves exactly that packet, save it to a file and run:

```sh
gov reconcile --reason "reviewed baseline recovery" \
  --human-admin-override "<approval for these exact changes>" \
  --expect-paths-file <approved packet>
```

The packet is required: an override without it is refused, and any added,
missing or changed path refuses with no writes. Recovery binds approval to the
inspected current digest and checks it again under the mutation lock. A successful `manual-reconcile` event records the old expected
digest, approved digest, and approval reason. A failed recovery does not advance
the baseline; repeating a completed recovery is a no-op. Later out-of-band edits
remain subject to the normal provenance guard.

Malformed current checkpoint or artifact JSON is reported as corruption, rather
than treated as a clean or merely pruned baseline. Restore the affected cache from
a trusted copy and retry diagnostics. Do not delete or rewrite the journal to
hide drift or establish a new baseline.
