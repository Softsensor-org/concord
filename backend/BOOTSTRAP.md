# backend Bootstrap Checklist

This repo follows the canonical
[`coord/product/BOOTSTRAP_CONTRACT.md`](../coord/product/BOOTSTRAP_CONTRACT.md).

The template ships skeletons. The derived project must fill them in before
substantive feature work begins.

## Checklist

- [ ] **Stack chosen.** Record the language, runtime, and primary framework
      in `README.md`.
- [ ] **Manifests added.** `package.json` / `pyproject.toml` / `go.mod` /
      `Cargo.toml` (whatever applies). Lockfile committed.
- [ ] **`.env.example` populated.** Replace the empty placeholder with the
      real variable list. Keep secrets out.
- [ ] **`scripts/gate.sh` implemented.** Replace the skeleton with a real
      gate runner that honors the `default | full | ci` lane contract and
      exits non-zero on failure.
- [ ] **Source layout.** `src/` and `tests/` exist and contain at least one
      smoke artifact so the gate runner has something to run.
- [ ] **CI wired.** Pipelines invoke `scripts/gate.sh ci` for this repo.
- [ ] **README updated.** Document how to run the app locally and how to run
      gates locally.

## What the template provides

- `AGENTS.md` — repo-local agent directives.
- `BOOTSTRAP.md` — this file.
- `README.md` — placeholder repo overview.
- `.env.example` — empty env template with header comments.
- `scripts/gate.sh` — skeleton gate runner that exits non-zero with a
  "not implemented in template" message.

## What governance expects after bootstrap

- `scripts/gate.sh default` returns 0 on a clean checkout.
- `scripts/gate.sh full` returns 0 before any landing.
- `scripts/gate.sh ci` is the single command CI invokes for this repo.
- `.env.example` is the authoritative list of environment variables.

## References

- [`coord/product/BOOTSTRAP_CONTRACT.md`](../coord/product/BOOTSTRAP_CONTRACT.md)
- [`coord/product/LOCAL_AUTOMATION_AND_GATES.md`](../coord/product/LOCAL_AUTOMATION_AND_GATES.md)
- [`coord/product/TESTING_AND_GATES.md`](../coord/product/TESTING_AND_GATES.md)
- [`AGENTS.md`](./AGENTS.md)
