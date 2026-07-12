# Installer behavior and risk boundary

Concord's npm, standalone SEA, and `init.sh` entry points use the same versioned
plan/apply transaction (`concord.install/v1`). Installation is intentionally a
two-step operation:

1. Run with `--dry-run` (or without `--apply-plan` on the npm path) to produce a
   write-free plan and SHA-256 digest.
2. Review that plan and rerun with `--apply-plan <digest>`. Any target or plan
   drift causes a refusal before the affected file is replaced.

The plan lists every payload file as `add`, `identical`, `managed-update`, or
`collision`. A collision is an existing file not proven to be owned by an
earlier Concord install and is never overwritten. Managed updates are accepted
only when the target bytes still match the prior ownership manifest.

Configured product repositories are opaque protected roots. The installer does
not traverse them for payload planning, stage them, or run Git mutations in
them. When product repository paths are supplied, their HEAD and porcelain
status are compared before and after apply. Secret files are not installation
inputs; plans declare an empty secret-read and network manifest.

Apply holds an exclusive local lock, writes through same-directory temporary
files, and records backups before replacement. On failure it restores replaced
bytes and removes installer-created files. The machine receipt records relative
paths, content digests, rollback actions, artifact identity, and verification;
it excludes file contents, credential paths, environment values, and raw command
output.

The installer never initializes Git or creates a baseline commit. Those are
separate operator decisions after installation; no installer path runs
`git add .`, changes a product repository HEAD, or pushes to a remote.

These controls reduce installation risk for the tested artifact and local
environment. They are technical behavior, not a warranty, certification,
security guarantee, or promise that the host operating system or third-party
agent provider enforces controls outside Concord's observable execution path.
