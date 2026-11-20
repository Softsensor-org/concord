# Concord demo payload

This directory holds the demo's committed data: the board (`coord/board/tasks.json`),
`coord/project.config.js`, `coord/product/`, the runtime fixture `coord/.runtime/`,
and the gate-artifact fixtures under `*/artifacts/gates/`.

The demo's engine code is not committed here. Its `scripts` and `engine` directories
come from `coord/` in one of two ways; see
[coord/product/DEMO_PACKAGING.md](../../coord/product/DEMO_PACKAGING.md):

- a source checkout links them to `coord/scripts` and `coord/engine` when you run
  `npm --prefix frontend/apps/coord-ui run demo`;
- a release cut contains generated copies, made from that cut's own engine by the
  release builder (`release/materialize-demo-coord.js`).
