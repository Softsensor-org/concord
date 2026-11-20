# Demo packaging contract

The bundled demo's engine code is not committed to git. Its two engine directories
are provided in one of two ways.

## Source checkout

`npm --prefix frontend/apps/coord-ui run demo` creates two untracked symlinks in
`examples/demo/coord` when they are missing:

- `scripts` -> `../../../coord/scripts`
- `engine` -> `../../../coord/engine`

Both paths are listed in `.gitignore`. The cockpit loads its engine modules from
`COORD_DIR/scripts` and `COORD_DIR/engine/scripts`, so both links are required.

## Release cut

`release/build-public-release.sh` runs `release/materialize-demo-coord.js` after its
scrubs and prunes (step 6f). The generator writes ordinary files, copied from the
cut's own `coord/` tree:

- `examples/demo/coord/scripts` from `coord/scripts`
- `examples/demo/coord/engine` from `coord/engine` (tests excluded; fixture
  directories shipped whole)
- `examples/demo/coord/paths.js`, `project-owned-state.js`, `board/board.js` and the
  board schemas

The builder force-adds the two directories so the cut's single commit carries them.
The npm, SEA and git channels are built from the cut, so they carry the same bytes.

The demo's own data stays committed: `examples/demo/coord/board/tasks.json`,
`project.config.js`, `product/` and `.runtime/`.

## Checks

- `release/demo-coord-drift.test.js`: git tracks no demo engine directory, the
  generator maps the engine layout exactly, and stale files are removed.
- `release/public-cut-demo.test.js`: a built cut's generated demo tree equals a
  regeneration from that cut's engine, and `coord-cli.js` ships in the cut.
- `frontend/apps/coord-ui/lib/demo-links.test.js`: every `COORD_DIR` module the
  cockpit loads is linked by `DEMO_LINKS` or committed under `examples/demo/coord`.
