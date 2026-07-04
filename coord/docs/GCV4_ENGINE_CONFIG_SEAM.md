# GCV-4 Engine / Config Seam

Status: design slice of record. No engine refactor is implied by this file
alone.

## Problem

Downstream `coord` repos currently carry mutable copies of the governance
engine. Each upstream improvement is replayed as a hand merge into every
consumer. That worked for small drift in acme-ops, but it breaks down for older
consumers such as acme where project config and engine code are interleaved.

The repeated merge loop is the bug. The engine must behave like a support
library: versioned, pinned, and upgraded through a declared path. Per-project
state must be data read by the engine, not edits inside engine files.

## Decision

Use a vendored engine bundle, pinned to a coord-template release, plus a
project-local config file.

Do not use an npm package for the first implementation. The engine includes
Node scripts, governance policy, schemas, hooks, prompts, MCP glue, and
operator docs; consumers also need local offline operation. A tagged bundle
copied by `gov upgrade` preserves the current repo shape while ending manual
merge propagation.

Do not use a git submodule for the first implementation. Submodules make the
source relationship explicit, but they complicate local edits, bootstrap, and
multi-repo agent workflows. The upgrade command should be the only mechanism
that changes engine-managed files.

## Target Layout

```text
coord/
|-- .coord-engine.json        # pinned upstream source/version
|-- project.config.js         # project-owned config
|-- paths.js                  # engine-managed adapter; reads project.config.js
|-- scripts/                  # engine-managed
|-- board/board.js            # engine-managed
|-- board/*.schema.json       # engine-managed
|-- prompts/                  # engine-managed defaults, project-overridable later
|-- product/                  # project-owned product docs
|-- board/tasks.json          # project-owned board state
|-- active/                   # project-owned ticket notes
`-- .runtime/                 # project-owned runtime, gitignored
```

The exact engine-managed path list is declared in the upstream release
manifest. Consumers must not hand-edit those files. Project-owned paths are
never overwritten by upgrade.

## Project Config Contract

`coord/project.config.js` is the project-owned seam. It exports plain data:

```js
module.exports = {
  repos: {
    B: {
      path: "backend",
      integrationBranch: "main",
      origin: null,
      legacyAliases: []
    },
    F: {
      path: "frontend",
      integrationBranch: "main",
      origin: null,
      legacyAliases: []
    }
  },
  requirements: {
    path: "product/REQUIREMENTS.md"
  }
};
```

Rules:

1. `X` remains reserved for coord/cross-repo work and is never listed in
   `repos`.
2. Each repo code is a single uppercase letter.
3. `path` is relative to the project root unless absolute.
4. `integrationBranch` is the per-repo integration base. The shipped template
   sets it to `main`; if the key is omitted entirely the engine resolution
   fallback is `dev`.
5. `origin` is optional metadata for audit/upgrade tools; it does not replace
   the local git remote.
6. `legacyAliases` are historical directory prefixes accepted in plan and
   feature-proof normalization.
7. `requirements.path` defaults to `product/REQUIREMENTS.md`.

acme should therefore be config, not a custom engine fork:

```js
module.exports = {
  repos: {
    B: {
      path: "acme-api",
      integrationBranch: "devx",
      origin: "git@github.com:acme-org/acme-api.git",
      legacyAliases: []
    },
    C: {
      path: "acme-cam",
      integrationBranch: "devx",
      origin: "git@github.com:acme-org/acme-cam.git",
      legacyAliases: []
    }
  },
  requirements: {
    path: "product/REQUIREMENTS.md"
  }
};
```

## Engine Adapter Contract

`coord/paths.js` becomes engine-managed. Its job is to:

1. load `coord/project.config.js`;
2. validate the config shape;
3. derive `repoRoots`, `repoIntegrationBranches`, `repoRegistry`,
   `legacyRepoAliases`, and any future repo metadata from config;
4. keep the existing `createCoordPaths()` and `allBoardRepoCodes()` API stable
   for `governance.js`, `board.js`, MCP, and tests.

During one migration release, `paths.js` may read legacy inline constants only
to generate a migration warning or a one-time `project.config.js`. After the
fleet is migrated, project-specific constants inside `paths.js` are invalid.

## Pin File

`.coord-engine.json` records both identity and channel. A SHA alone is not
enough because upgrade tooling must know what "latest" means.

```json
{
  "schema": 1,
  "engine_version": "0.4.0",
  "source": {
    "repo": "https://github.com/Softsensor-org/concord",
    "channel": "community",
    "ref": "coord-engine-v0.4.0",
    "sha": "<release-sha>"
  },
  "applied_at": "<ISO-8601>"
}
```

`source.channel` is the **distribution channel** — `community` (public,
Apache-2.0) or `enterprise` (private, licensed) — that `gov upgrade` resolves
"latest" against. Switching community→enterprise is the licensed in-place
upgrade: `gov upgrade --channel enterprise --entitlement <token>` (fail-closed
without the token). `source.ref` is the immutable release ref actually applied.
`source.sha` is the exact content provenance. This pin (identity/provenance) is
distinct from `engine-pin.json` (in-tree surface integrity fingerprint);
`gov upgrade --check` reports engine drift against the latter and the
version/channel from the former.

## Upgrade Contract

`coord/scripts/gov upgrade` is the only supported engine update path.

Minimum behavior:

1. fetch the configured upstream source;
2. resolve the requested release (`--to <ref>` or `--latest`);
3. read the release manifest;
4. refuse if the working tree has unrelated edits in engine-managed paths;
5. copy only engine-managed paths;
6. preserve `project.config.js`, board state, product docs, active notes, and
   `.runtime/`;
7. run declared migrations;
8. run the governance test suite;
9. update `.coord-engine.json`;
10. create one upgrade commit.

The upgrade command must report local project config separately from engine
drift. A dirty board or runtime journal is not an engine-modification signal.

## Migration Plan

1. Add `project.config.js` to coord-template with the default
   `B=backend`, `F=frontend` config.
2. Refactor template `paths.js` to read config while preserving its exported
   API and tests.
3. Add a migration helper that converts known legacy `paths.js` constants into
   `project.config.js`.
4. Add `.coord-engine.json` and the release manifest format.
5. Implement `gov upgrade --check` before `gov upgrade --apply`.
6. Migrate acme-ops from inline `REPO_REGISTRY` to `project.config.js`.
7. Migrate acme by writing config for `B=acme-api`, `C=acme-cam`,
   and `devx`; do not hand-merge engine code.

## Stop Rule

Do not perform additional downstream hand-sync PRs for acme or other older
consumers after acme-ops B6. The next downstream propagation should be a GCV-4
library adoption PR, not another manual copy/merge of engine files.

## Acceptance For GCV-4 Slice 1

- `coord-template` has a committed `project.config.js`.
- `paths.js` contains no project-specific repo constants beyond loading the
  config.
- Existing governance tests pass unchanged.
- A fixture proves a three-repo config with code `C` derives correct roots and
  integration branches.
- A fixture proves acme-ops-style `B=msrv`, `F=frontend` config derives the same
  values as the previous inline registry.
- `.coord-engine.json` includes repo, channel, ref, and sha.
- `gov upgrade --check` can distinguish engine drift from project config/state
  drift.
